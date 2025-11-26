/**
 * Trading Module - Entry execution orchestration for DLMM bot
 * 
 * This module handles:
 * - Position sizing (standard vs aggressive)
 * - Trade object creation
 * - Database persistence
 * - In-memory registry management
 * 
 * Paper trading only. PnL calculated at exit.
 */

import { Pool } from './normalizePools';
import { 
    Trade, 
    SizingMode, 
    createTrade, 
    saveTradeToDB, 
    registerTrade,
    closeTrade,
    getTradesForPool
} from '../db/models/Trade';
import { logAction } from '../db/supabase';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION SIZING MODEL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sizing configuration - static and deterministic
 */
const SIZING_CONFIG = {
    standard: {
        percentOfBalance: 0.015,  // 1.5% of balance
        minSize: 200,             // $200 minimum
        maxSize: 2000,            // $2000 maximum
    },
    aggressive: {
        percentOfBalance: 0.035,  // 3.5% of balance
        minSize: 500,             // $500 minimum  
        maxSize: 3500,            // $3500 maximum
    },
    // Absolute minimum balance to trade
    minBalanceToTrade: 200,
};

/**
 * Calculate entry size based on balance and sizing mode
 * 
 * @param balance - Current available balance
 * @param mode - 'standard' or 'aggressive'
 * @returns Calculated position size or 0 if insufficient balance
 */
export function calculateEntrySize(balance: number, mode: SizingMode): number {
    // Check minimum balance requirement
    if (balance < SIZING_CONFIG.minBalanceToTrade) {
        logger.warn(`Balance $${balance.toFixed(2)} below minimum $${SIZING_CONFIG.minBalanceToTrade} - skipping entry`);
        return 0;
    }
    
    const config = SIZING_CONFIG[mode];
    
    // Calculate raw size as percentage of balance
    let size = balance * config.percentOfBalance;
    
    // Apply min/max constraints
    size = Math.max(size, config.minSize);
    size = Math.min(size, config.maxSize);
    
    // Final check: don't exceed available balance
    if (size > balance) {
        size = balance;
    }
    
    return Math.floor(size); // Round to whole dollars
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extended pool with transition telemetry attached
 */
interface PoolWithTelemetry extends Pool {
    entropy?: number;
    velocitySlope?: number;
    liquiditySlope?: number;
    entropySlope?: number;
}

/**
 * Entry result returned after position creation
 */
export interface EntryResult {
    success: boolean;
    trade?: Trade;
    reason?: string;
}

/**
 * Enter a position - full execution pipeline
 * 
 * Execution order:
 * 1. calculateEntrySize()
 * 2. createTradeObject()
 * 3. logTradeEvent()
 * 4. saveTradeToDB()
 * 5. pushToActivePositions (via registerTrade)
 * 
 * @param pool - Pool to enter (with attached telemetry)
 * @param sizingMode - 'standard' or 'aggressive'
 * @param balance - Current available balance
 * @returns EntryResult with trade object if successful
 */
export async function enterPosition(
    pool: PoolWithTelemetry,
    sizingMode: SizingMode,
    balance: number
): Promise<EntryResult> {
    
    // 1. Calculate entry size
    const size = calculateEntrySize(balance, sizingMode);
    
    if (size === 0) {
        return {
            success: false,
            reason: `Insufficient balance ($${balance.toFixed(2)}) for ${sizingMode} entry`,
        };
    }
    
    // Extract telemetry (with defaults for missing values)
    const telemetry = {
        entropy: pool.entropy ?? 0,
        velocitySlope: pool.velocitySlope ?? 0,
        liquiditySlope: pool.liquiditySlope ?? 0,
        entropySlope: pool.entropySlope ?? 0,
    };
    
    // 2. Create trade object
    const trade = createTrade(
        {
            address: pool.address,
            name: pool.name,
            currentPrice: pool.currentPrice,
            score: pool.score,
            liquidity: pool.liquidity,
            velocity: pool.velocity,
        },
        size,
        sizingMode,
        telemetry
    );
    
    // 3. Log trade event (console)
    logSuccessfulEntry(pool, trade, sizingMode);
    
    // 4. Save to database
    const dbSaved = await saveTradeToDB(trade);
    if (!dbSaved) {
        logger.warn(`Trade ${trade.id} saved to memory but DB save failed`);
    }
    
    // 5. Register in memory
    registerTrade(trade);
    
    // Also log to bot_logs for dashboard
    await logAction('TRADE_ENTRY', {
        tradeId: trade.id,
        pool: trade.pool,
        poolName: trade.poolName,
        entryPrice: trade.entryPrice,
        size: trade.size,
        mode: trade.mode,
        score: trade.score,
        velocitySlope: trade.velocitySlope,
        liquiditySlope: trade.liquiditySlope,
        entropySlope: trade.entropySlope,
    });
    
    return {
        success: true,
        trade,
    };
}

/**
 * Log successful entry in the required format
 */
function logSuccessfulEntry(pool: PoolWithTelemetry, trade: Trade, mode: SizingMode): void {
    const vSlope = ((pool.velocitySlope ?? 0) * 100).toFixed(1);
    const lSlope = ((pool.liquiditySlope ?? 0) * 100).toFixed(1);
    const eSlope = ((pool.entropySlope ?? 0) * 100).toFixed(1);
    
    logger.info(`🔥 ENTRY`);
    logger.info(`🚀 [ENTER] ${pool.name} @ ${trade.entryPrice.toFixed(8)}`);
    logger.info(`   mode=${mode} size=$${trade.size}`);
    logger.info(`   score=${trade.score.toFixed(2)}`);
    logger.info(`   vSlope=${vSlope}% lSlope=${lSlope}% eSlope=${eSlope}%`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exit execution data
 */
export interface ExitData {
    exitPrice: number;
    reason: string;
}

/**
 * Exit result returned after position close
 */
export interface ExitResult {
    success: boolean;
    trade?: Trade;
    pnl?: number;
    reason?: string;
}

/**
 * Exit a position - close trade and calculate PnL
 * 
 * @param tradeId - ID of trade to close
 * @param executionData - Exit price and reason
 * @returns ExitResult with closed trade and PnL
 */
export async function exitPosition(
    tradeId: string,
    executionData: ExitData
): Promise<ExitResult> {
    
    // Close trade in registry
    const trade = closeTrade(tradeId, executionData.exitPrice, executionData.reason);
    
    if (!trade) {
        return {
            success: false,
            reason: `Trade ${tradeId} not found in registry`,
        };
    }
    
    // Log exit
    logger.info(`📤 EXIT`);
    logger.info(`🔴 [EXIT] ${trade.poolName} @ ${executionData.exitPrice.toFixed(8)}`);
    logger.info(`   reason=${executionData.reason}`);
    logger.info(`   pnl=$${(trade.pnl ?? 0).toFixed(2)}`);
    
    // Log to database
    await logAction('TRADE_EXIT', {
        tradeId: trade.id,
        pool: trade.pool,
        poolName: trade.poolName,
        exitPrice: trade.exitPrice,
        pnl: trade.pnl,
        reason: trade.exitReason,
        holdTimeMs: (trade.exitTimestamp ?? Date.now()) - trade.timestamp,
    });
    
    return {
        success: true,
        trade,
        pnl: trade.pnl,
    };
}

/**
 * Check if pool already has an active trade
 */
export function hasActiveTrade(poolAddress: string): boolean {
    return getTradesForPool(poolAddress).length > 0;
}

/**
 * Get sizing mode based on expansion pulse
 */
export function getSizingMode(expansionPulse: boolean): SizingMode {
    return expansionPulse ? 'aggressive' : 'standard';
}

