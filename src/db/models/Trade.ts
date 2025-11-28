/**
 * Trade Model - Structure for DLMM position entries
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: ALL TRADES MUST BE PERSISTED TO DATABASE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * If database insert fails → ABORT TRADE
 * No graceful degradation - persistence is MANDATORY
 * 
 * PnL is calculated at exit, not entry.
 */

import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../supabase';
import logger from '../../utils/logger';

/**
 * Sizing mode determines position size calculation
 */
export type SizingMode = 'standard' | 'aggressive';

/**
 * Trade structure - Complete record of a position entry
 */
export interface Trade {
    id: string;
    pool: string;
    poolName: string;
    
    // Entry metrics
    entryPrice: number;
    score: number;
    liquidity: number;
    velocity: number;
    entropy: number;
    
    // Transition telemetry at entry
    velocitySlope: number;
    liquiditySlope: number;
    entropySlope: number;
    
    // Position sizing
    size: number;
    mode: SizingMode;
    
    // Bin tracking
    entryBin?: number;
    
    // Metadata
    timestamp: number;
    
    // Exit data (populated on exit)
    exitPrice?: number;
    exitTimestamp?: number;
    pnl?: number;
    exitReason?: string;
    
    // Status
    status: 'open' | 'closed' | 'cancelled';
}

/**
 * In-memory trade registry for fast lookups
 * NOTE: This is a CACHE only - source of truth is database
 */
const tradeRegistry: Map<string, Trade> = new Map();

/**
 * Create a new Trade object with all required fields
 */
export function createTrade(
    pool: {
        address: string;
        name: string;
        currentPrice: number;
        score: number;
        liquidity: number;
        velocity: number;
    },
    size: number,
    mode: SizingMode,
    telemetry: {
        entropy: number;
        velocitySlope: number;
        liquiditySlope: number;
        entropySlope: number;
    },
    entryBin?: number
): Trade {
    const trade: Trade = {
        id: uuidv4(),
        pool: pool.address,
        poolName: pool.name,
        
        entryPrice: pool.currentPrice,
        score: pool.score,
        liquidity: pool.liquidity,
        velocity: pool.velocity,
        entropy: telemetry.entropy,
        
        velocitySlope: telemetry.velocitySlope,
        liquiditySlope: telemetry.liquiditySlope,
        entropySlope: telemetry.entropySlope,
        
        size,
        mode,
        entryBin,
        
        timestamp: Date.now(),
        status: 'open',
    };
    
    return trade;
}

/**
 * Verify database connection is available
 * 
 * @throws Error if database is unavailable
 */
async function verifyDatabaseConnection(): Promise<void> {
    try {
        const { error } = await supabase.from('trades').select('id').limit(1);
        
        if (error) {
            if (error.message.includes('does not exist') || error.code === '42P01') {
                throw new Error('Trades table does not exist - run SQL migration');
            }
            throw new Error(`Database health check failed: ${error.message}`);
        }
    } catch (err: any) {
        throw new Error(`Database unavailable: ${err.message || err}`);
    }
}

/**
 * Save trade to database - MANDATORY operation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: If this fails, the trade MUST NOT proceed
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * @throws Error if database insert fails
 */
export async function saveTradeToDB(trade: Trade): Promise<void> {
    // Verify database is available FIRST
    await verifyDatabaseConnection();
    
    const { error } = await supabase.from('trades').insert({
        id: trade.id,
        pool_address: trade.pool,
        pool_name: trade.poolName,
        entry_price: trade.entryPrice,
        size: trade.size,
        bin: trade.entryBin,
        score: trade.score,
        v_slope: trade.velocitySlope,
        l_slope: trade.liquiditySlope,
        e_slope: trade.entropySlope,
        liquidity: trade.liquidity,
        velocity: trade.velocity,
        entropy: trade.entropy,
        mode: trade.mode,
        status: 'open',
        created_at: new Date(trade.timestamp).toISOString(),
    });
    
    if (error) {
        // ═══════════════════════════════════════════════════════════════════════
        // NO GRACEFUL DEGRADATION - THROW ERROR TO ABORT TRADE
        // ═══════════════════════════════════════════════════════════════════════
        throw new Error(`Trade persistence failed — abort execution: ${error.message}`);
    }
    
    logger.info(`✅ Trade ${trade.id} saved to database`);
}

/**
 * Update trade with exit data in database
 * 
 * @throws Error if database update fails
 */
export async function updateTradeExitInDB(
    tradeId: string,
    exitPrice: number,
    pnlUsd: number,
    exitReason: string
): Promise<void> {
    await verifyDatabaseConnection();
    
    const { error } = await supabase
        .from('trades')
        .update({
            exit_price: exitPrice,
            pnl_usd: pnlUsd,
            exit_time: new Date().toISOString(),
            exit_reason: exitReason,
            status: 'closed',
        })
        .eq('id', tradeId);
    
    if (error) {
        throw new Error(`Trade exit update failed: ${error.message}`);
    }
    
    logger.info(`✅ Trade ${tradeId} exit recorded in database`);
}

/**
 * Load active trades from database on startup
 */
export async function loadActiveTradesFromDB(): Promise<Trade[]> {
    try {
        await verifyDatabaseConnection();
        
        const { data, error } = await supabase
            .from('trades')
            .select('*')
            .eq('status', 'open');
        
        if (error) {
            logger.error(`Failed to load active trades: ${error.message}`);
            return [];
        }
        
        if (!data || data.length === 0) {
            return [];
        }
        
        const trades: Trade[] = data.map((row: any) => ({
            id: row.id,
            pool: row.pool_address,
            poolName: row.pool_name || '',
            entryPrice: parseFloat(row.entry_price),
            score: parseFloat(row.score || 0),
            liquidity: parseFloat(row.liquidity || 0),
            velocity: parseFloat(row.velocity || 0),
            entropy: parseFloat(row.entropy || 0),
            velocitySlope: parseFloat(row.v_slope || 0),
            liquiditySlope: parseFloat(row.l_slope || 0),
            entropySlope: parseFloat(row.e_slope || 0),
            size: parseFloat(row.size),
            mode: row.mode || 'standard',
            entryBin: row.bin,
            timestamp: new Date(row.created_at).getTime(),
            status: row.status,
        }));
        
        // Populate registry cache
        for (const trade of trades) {
            tradeRegistry.set(trade.id, trade);
        }
        
        logger.info(`✅ Loaded ${trades.length} active trades from database`);
        return trades;
        
    } catch (err: any) {
        logger.error(`Failed to load trades: ${err.message || err}`);
        return [];
    }
}

/**
 * Add trade to in-memory registry (cache)
 */
export function registerTrade(trade: Trade): void {
    tradeRegistry.set(trade.id, trade);
}

/**
 * Get trade from registry by ID
 */
export function getTrade(tradeId: string): Trade | undefined {
    return tradeRegistry.get(tradeId);
}

/**
 * Get all active trades for a pool
 */
export function getTradesForPool(poolAddress: string): Trade[] {
    const trades: Trade[] = [];
    for (const trade of tradeRegistry.values()) {
        if (trade.pool === poolAddress && trade.status === 'open') {
            trades.push(trade);
        }
    }
    return trades;
}

/**
 * Get all active trades
 */
export function getAllActiveTrades(): Trade[] {
    const trades: Trade[] = [];
    for (const trade of tradeRegistry.values()) {
        if (trade.status === 'open') {
            trades.push(trade);
        }
    }
    return trades;
}

/**
 * Update trade with exit data in memory and database
 * 
 * @throws Error if database update fails
 */
export async function closeTrade(
    tradeId: string,
    exitPrice: number,
    exitReason: string
): Promise<Trade | undefined> {
    const trade = tradeRegistry.get(tradeId);
    if (!trade) return undefined;
    
    // Calculate PnL
    const pnl = (exitPrice - trade.entryPrice) * trade.size / trade.entryPrice;
    
    // Update in database FIRST (source of truth)
    await updateTradeExitInDB(tradeId, exitPrice, pnl, exitReason);
    
    // Update in memory cache
    trade.exitPrice = exitPrice;
    trade.exitTimestamp = Date.now();
    trade.exitReason = exitReason;
    trade.pnl = pnl;
    trade.status = 'closed';
    
    return trade;
}

/**
 * Remove trade from registry (after exit is complete)
 */
export function unregisterTrade(tradeId: string): void {
    tradeRegistry.delete(tradeId);
}

/**
 * Clear all trades from registry (for reset)
 */
export function clearTradeRegistry(): void {
    tradeRegistry.clear();
}

/**
 * Get trade registry size
 */
export function getTradeCount(): number {
    return tradeRegistry.size;
}

/**
 * Get all trade IDs from registry
 */
export function getAllTradeIds(): string[] {
    return Array.from(tradeRegistry.keys());
}
