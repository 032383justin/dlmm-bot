/**
 * Trading Module - Entry execution orchestration for DLMM bot
 * 
 * This module handles:
 * - Position sizing (standard vs aggressive)
 * - Trade object creation
 * - Database persistence
 * - In-memory registry management
 * - Capital safety guardrails
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
    getTradesForPool,
    getAllActiveTrades
} from '../db/models/Trade';
import { logAction } from '../db/supabase';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL SAFETY GUARDRAILS (MANDATORY)
// ═══════════════════════════════════════════════════════════════════════════════

const CAPITAL_GUARDRAILS = {
    // A. Max position size (per entry)
    maxPositionPctStandard: 0.10,    // 10% of total capital for standard mode
    maxPositionPctAggressive: 0.15,  // 15% of total capital for aggressive (expansion pulse only)
    
    // B. Max total deployed across all trades
    maxTotalDeployedPct: 0.40,       // 40% of total balance
    
    // C. Liquid capital requirements
    minRemainingBalance: 500,        // $500 absolute minimum
    minRemainingPct: 0.05,           // 5% of starting equity minimum
};

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
 * Calculate entry size based on balance and sizing mode with capital guardrails
 * 
 * @param balance - Current available balance
 * @param totalCapital - Total starting capital (for percentage calculations)
 * @param mode - 'standard' or 'aggressive'
 * @returns Calculated position size or 0 if insufficient balance
 */
export function calculateEntrySize(balance: number, totalCapital: number, mode: SizingMode): number {
    // Check minimum balance requirement
    if (balance < SIZING_CONFIG.minBalanceToTrade) {
        logger.warn(`Balance $${balance.toFixed(2)} below minimum $${SIZING_CONFIG.minBalanceToTrade} - skipping entry`);
        return 0;
    }
    
    const config = SIZING_CONFIG[mode];
    
    // Calculate raw size as percentage of balance
    let size = balance * config.percentOfBalance;
    
    // Apply min/max constraints from config
    size = Math.max(size, config.minSize);
    size = Math.min(size, config.maxSize);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CAPITAL GUARDRAIL: Cap position size based on mode
    // Standard: Max 10% of total capital
    // Aggressive: Max 15% of total capital (only on expansion pulse)
    // ═══════════════════════════════════════════════════════════════════════════
    const maxPositionPct = mode === 'aggressive' 
        ? CAPITAL_GUARDRAILS.maxPositionPctAggressive 
        : CAPITAL_GUARDRAILS.maxPositionPctStandard;
    const maxPositionSize = totalCapital * maxPositionPct;
    
    if (size > maxPositionSize) {
        logger.info(`📏 Position clamped: $${size.toFixed(0)} → $${maxPositionSize.toFixed(0)} (${(maxPositionPct * 100)}% cap for ${mode} mode)`);
        size = maxPositionSize;
    }
    
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
 * Enter a position - full execution pipeline with capital guardrails
 * 
 * Execution order:
 * 1. Check capital guardrails (liquid capital, max deployed)
 * 2. Check for existing active trade on pool
 * 3. Check migration direction
 * 4. calculateEntrySize()
 * 5. createTradeObject()
 * 6. logTradeEvent()
 * 7. saveTradeToDB()
 * 8. pushToActivePositions (via registerTrade)
 * 
 * @param pool - Pool to enter (with attached telemetry)
 * @param sizingMode - 'standard' or 'aggressive'
 * @param balance - Current available balance
 * @param totalCapital - Total starting capital for percentage calculations
 * @returns EntryResult with trade object if successful
 */
export async function enterPosition(
    pool: PoolWithTelemetry,
    sizingMode: SizingMode,
    balance: number,
    totalCapital?: number
): Promise<EntryResult> {
    
    // Use balance as totalCapital if not provided (backwards compatibility)
    const startingCapital = totalCapital ?? balance;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARDRAIL 1: Check for existing active trade on this pool
    // Never exceed 1 open trade per pool
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasActiveTrade(pool.address)) {
        logger.warn(`⚠️ Already have open trade on ${pool.name}`);
        return {
            success: false,
            reason: `Already have open trade on ${pool.name}`,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARDRAIL 2: Liquid capital requirement
    // No trade if remainingBalance < $500 OR < 5% of starting equity
    // ═══════════════════════════════════════════════════════════════════════════
    const minRequired = Math.max(
        CAPITAL_GUARDRAILS.minRemainingBalance,
        startingCapital * CAPITAL_GUARDRAILS.minRemainingPct
    );
    
    if (balance < minRequired) {
        logger.warn(`⚠️ Trade execution rejected: insufficient capital threshold`);
        logger.warn(`   Balance: $${balance.toFixed(2)} < Required: $${minRequired.toFixed(2)}`);
        return {
            success: false,
            reason: `Insufficient capital threshold (balance $${balance.toFixed(2)} < min $${minRequired.toFixed(2)})`,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARDRAIL 3: Max total deployed check
    // Hard cap = 40% of total balance
    // ═══════════════════════════════════════════════════════════════════════════
    const activeTrades = getAllActiveTrades();
    const currentlyDeployed = activeTrades.reduce((sum, t) => sum + t.size, 0);
    const maxDeployable = startingCapital * CAPITAL_GUARDRAILS.maxTotalDeployedPct;
    
    if (currentlyDeployed >= maxDeployable) {
        logger.warn(`⚠️ Trade execution rejected: max deployment cap reached`);
        logger.warn(`   Deployed: $${currentlyDeployed.toFixed(2)} >= Cap: $${maxDeployable.toFixed(2)} (${(CAPITAL_GUARDRAILS.maxTotalDeployedPct * 100)}%)`);
        return {
            success: false,
            reason: `Max deployment cap reached ($${currentlyDeployed.toFixed(2)} >= $${maxDeployable.toFixed(2)})`,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARDRAIL 4: Migration rejection
    // Stop entry when liquidity is exiting concentrated region
    // ═══════════════════════════════════════════════════════════════════════════
    const migrationDirection = (pool as any).migrationDirection as string | undefined;
    const liquiditySlope = pool.liquiditySlope ?? 0;
    
    if (migrationDirection === 'out' || liquiditySlope < -0.03) {
        logger.warn(`🚫 [MIGRATION REJECT] ${pool.name} - liquidity exiting concentrated region`);
        logger.warn(`   migrationDirection=${migrationDirection}, liquiditySlope=${(liquiditySlope * 100).toFixed(2)}%`);
        return {
            success: false,
            reason: `Migration reject: liquidity exiting (dir=${migrationDirection}, liqSlope=${(liquiditySlope * 100).toFixed(2)}%)`,
        };
    }
    
    // 1. Calculate entry size with capital guardrails
    const size = calculateEntrySize(balance, startingCapital, sizingMode);
    
    if (size === 0) {
        return {
            success: false,
            reason: `Insufficient balance ($${balance.toFixed(2)}) for ${sizingMode} entry`,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARDRAIL 5: Check if this trade would exceed max deployment
    // ═══════════════════════════════════════════════════════════════════════════
    const projectedDeployed = currentlyDeployed + size;
    if (projectedDeployed > maxDeployable) {
        // Clamp size to fit within cap
        const adjustedSize = Math.floor(maxDeployable - currentlyDeployed);
        if (adjustedSize < SIZING_CONFIG.standard.minSize) {
            logger.warn(`⚠️ Trade execution rejected: insufficient room under deployment cap`);
            return {
                success: false,
                reason: `Insufficient room under deployment cap (would need $${size} but only $${adjustedSize} available)`,
            };
        }
        logger.info(`📏 Position adjusted for deployment cap: $${size} → $${adjustedSize}`);
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
    
    // 4. Save to database (graceful degradation - don't fail on DB error)
    const dbSaved = await saveTradeToDB(trade);
    if (!dbSaved) {
        logger.warn(`⚠️ Trade ${trade.id} registered in memory but DB save failed (graceful degradation)`);
    }
    
    // 5. Register in memory
    registerTrade(trade);
    
    // Also log to bot_logs for dashboard (graceful - don't fail on error)
    try {
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
    } catch (logErr) {
        logger.warn(`⚠️ Failed to log trade entry to dashboard: ${logErr}`);
    }
    
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

