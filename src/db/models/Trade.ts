/**
 * Trade Model - Structure for DLMM position entries
 * 
 * All trades are stored in-memory AND persisted to database.
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
    
    // Metadata
    timestamp: number;
    
    // Exit data (populated on exit)
    exitPrice?: number;
    exitTimestamp?: number;
    pnl?: number;
    exitReason?: string;
}

/**
 * In-memory trade registry for fast lookups
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
    }
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
        
        timestamp: Date.now(),
    };
    
    return trade;
}

/**
 * Save trade to database
 */
export async function saveTradeToDB(trade: Trade): Promise<boolean> {
    try {
        const { error } = await supabase.from('trades').insert({
            id: trade.id,
            pool_address: trade.pool,
            pool_name: trade.poolName,
            entry_price: trade.entryPrice,
            score: trade.score,
            liquidity: trade.liquidity,
            velocity: trade.velocity,
            entropy: trade.entropy,
            velocity_slope: trade.velocitySlope,
            liquidity_slope: trade.liquiditySlope,
            entropy_slope: trade.entropySlope,
            size: trade.size,
            mode: trade.mode,
            timestamp: new Date(trade.timestamp).toISOString(),
        });
        
        if (error) {
            logger.error(`Failed to save trade to DB: ${error.message}`);
            return false;
        }
        
        return true;
    } catch (err) {
        logger.error(`Trade DB save error: ${err}`);
        return false;
    }
}

/**
 * Add trade to in-memory registry
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
        if (trade.pool === poolAddress && !trade.exitTimestamp) {
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
        if (!trade.exitTimestamp) {
            trades.push(trade);
        }
    }
    return trades;
}

/**
 * Update trade with exit data
 */
export function closeTrade(
    tradeId: string,
    exitPrice: number,
    exitReason: string
): Trade | undefined {
    const trade = tradeRegistry.get(tradeId);
    if (!trade) return undefined;
    
    trade.exitPrice = exitPrice;
    trade.exitTimestamp = Date.now();
    trade.exitReason = exitReason;
    trade.pnl = (exitPrice - trade.entryPrice) * trade.size / trade.entryPrice;
    
    return trade;
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

