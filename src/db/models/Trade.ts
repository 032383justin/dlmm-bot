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
 * PnL CALCULATION:
 * pnl = (exit_value_usd - entry_value_usd) - fees_paid
 * NOT: current oracle price minus entry
 * 
 * Must track:
 * - Actual execution quote (fill price)
 * - tokenIn / tokenOut amounts
 * - fee paid
 * - received tokens after slippage
 */

import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../supabase';
import logger from '../../utils/logger';
import { RiskTier } from '../../engine/riskBucketEngine';

/**
 * Sizing mode determines position size calculation
 */
export type SizingMode = 'standard' | 'aggressive';

/**
 * Execution data - captures actual fill details
 */
export interface ExecutionData {
    // Token amounts
    entryTokenAmountIn: number;      // Amount of token spent
    entryTokenAmountOut: number;     // Amount of token received
    
    // USD values at execution
    entryAssetValueUsd: number;      // Total value in USD at entry
    
    // Execution costs
    entryFeesPaid: number;           // Fees paid in USD
    entrySlippageUsd: number;        // Slippage cost in USD
    
    // Net received
    netReceivedBase: number;         // Net base token received
    netReceivedQuote: number;        // Net quote token received
    
    // Exit data (populated on exit)
    exitTokenAmountIn?: number;
    exitTokenAmountOut?: number;
    exitAssetValueUsd?: number;
    exitFeesPaid?: number;
    exitSlippageUsd?: number;
}

/**
 * Trade structure - Complete record of a position entry
 */
export interface Trade {
    id: string;
    pool: string;
    poolName: string;
    
    // Risk tier assignment
    riskTier: RiskTier;
    leverage: number;
    
    // Entry metrics (oracle/pool mid - for reference only)
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
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXECUTION DATA - TRUE FILL PRICES
    // ═══════════════════════════════════════════════════════════════════════════
    execution: ExecutionData;
    
    // Metadata
    timestamp: number;
    
    // Exit data (populated on exit)
    exitPrice?: number;              // Reference price (oracle/mid)
    exitTimestamp?: number;
    pnl?: number;                    // TRUE PnL: (exitValue - entryValue) - fees
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
    execution: ExecutionData,
    riskTier: RiskTier = 'C',
    leverage: number = 1.0,
    entryBin?: number
): Trade {
    const trade: Trade = {
        id: uuidv4(),
        pool: pool.address,
        poolName: pool.name,
        
        riskTier,
        leverage,
        
        entryPrice: pool.currentPrice,  // Reference only
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
        
        execution,
        
        timestamp: Date.now(),
        status: 'open',
    };
    
    return trade;
}

/**
 * Create default execution data when actual fill data is not available
 * This is a FALLBACK - should prefer actual execution data
 */
export function createDefaultExecutionData(
    sizeUsd: number,
    estimatedPrice: number
): ExecutionData {
    // Estimate token amounts based on size and price
    const tokenAmount = sizeUsd / estimatedPrice;
    
    return {
        entryTokenAmountIn: sizeUsd,          // Assuming USD in
        entryTokenAmountOut: tokenAmount,     // Token received
        entryAssetValueUsd: sizeUsd,
        entryFeesPaid: sizeUsd * 0.003,       // Estimate 0.3% fee
        entrySlippageUsd: sizeUsd * 0.001,    // Estimate 0.1% slippage
        netReceivedBase: tokenAmount * 0.996, // After fees/slippage
        netReceivedQuote: 0,
    };
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
        
        // Risk tier
        risk_tier: trade.riskTier,
        leverage: trade.leverage,
        
        // Reference price (oracle/mid)
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
        
        // Execution data - TRUE FILL PRICES
        entry_token_amount_in: trade.execution.entryTokenAmountIn,
        entry_token_amount_out: trade.execution.entryTokenAmountOut,
        entry_asset_value_usd: trade.execution.entryAssetValueUsd,
        entry_fees_paid: trade.execution.entryFeesPaid,
        entry_slippage_usd: trade.execution.entrySlippageUsd,
        net_received_base: trade.execution.netReceivedBase,
        net_received_quote: trade.execution.netReceivedQuote,
        
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
 * TRUE PnL: (exit_value_usd - entry_value_usd) - total_fees
 * 
 * @throws Error if database update fails
 */
export async function updateTradeExitInDB(
    tradeId: string,
    exitExecution: {
        exitPrice: number;              // Reference price
        exitAssetValueUsd: number;      // Actual exit value
        exitFeesPaid: number;           // Exit fees
        exitSlippageUsd: number;        // Exit slippage
    },
    exitReason: string
): Promise<number> {
    await verifyDatabaseConnection();
    
    // Get trade to calculate PnL
    const trade = tradeRegistry.get(tradeId);
    if (!trade) {
        throw new Error(`Trade ${tradeId} not found in registry`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRUE PnL CALCULATION
    // pnl = (exit_value_usd - entry_value_usd) - (entry_fees + exit_fees)
    // ═══════════════════════════════════════════════════════════════════════════
    const totalFees = trade.execution.entryFeesPaid + exitExecution.exitFeesPaid;
    const totalSlippage = trade.execution.entrySlippageUsd + exitExecution.exitSlippageUsd;
    const grossPnl = exitExecution.exitAssetValueUsd - trade.execution.entryAssetValueUsd;
    const netPnl = grossPnl - totalFees;
    
    logger.info(
        `[PNL] Trade ${tradeId.slice(0, 8)}... | ` +
        `Entry=$${trade.execution.entryAssetValueUsd.toFixed(2)} | ` +
        `Exit=$${exitExecution.exitAssetValueUsd.toFixed(2)} | ` +
        `Fees=$${totalFees.toFixed(2)} | ` +
        `Slippage=$${totalSlippage.toFixed(2)} | ` +
        `Gross=${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(2)} | ` +
        `Net=${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`
    );
    
    const { error } = await supabase
        .from('trades')
        .update({
            exit_price: exitExecution.exitPrice,
            exit_asset_value_usd: exitExecution.exitAssetValueUsd,
            exit_fees_paid: exitExecution.exitFeesPaid,
            exit_slippage_usd: exitExecution.exitSlippageUsd,
            pnl_usd: netPnl,
            pnl_gross: grossPnl,
            total_fees: totalFees,
            total_slippage: totalSlippage,
            exit_time: new Date().toISOString(),
            exit_reason: exitReason,
            status: 'closed',
        })
        .eq('id', tradeId);
    
    if (error) {
        throw new Error(`Trade exit update failed: ${error.message}`);
    }
    
    logger.info(`✅ Trade ${tradeId} exit recorded in database`);
    
    return netPnl;
}

/**
 * Legacy exit update - uses reference prices (DEPRECATED)
 * Prefer updateTradeExitInDB with execution data
 */
export async function updateTradeExitLegacy(
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
    
    logger.warn(`⚠️ Trade ${tradeId} exit recorded using LEGACY method (reference prices)`);
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
            
            riskTier: row.risk_tier || 'C',
            leverage: parseFloat(row.leverage || 1.0),
            
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
            
            execution: {
                entryTokenAmountIn: parseFloat(row.entry_token_amount_in || row.size),
                entryTokenAmountOut: parseFloat(row.entry_token_amount_out || 0),
                entryAssetValueUsd: parseFloat(row.entry_asset_value_usd || row.size),
                entryFeesPaid: parseFloat(row.entry_fees_paid || 0),
                entrySlippageUsd: parseFloat(row.entry_slippage_usd || 0),
                netReceivedBase: parseFloat(row.net_received_base || 0),
                netReceivedQuote: parseFloat(row.net_received_quote || 0),
            },
            
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
 * Update trade with exit data in memory and database using TRUE fill prices
 * 
 * @throws Error if database update fails
 */
export async function closeTrade(
    tradeId: string,
    exitExecution: {
        exitPrice: number;
        exitAssetValueUsd: number;
        exitFeesPaid: number;
        exitSlippageUsd: number;
    },
    exitReason: string
): Promise<Trade | undefined> {
    const trade = tradeRegistry.get(tradeId);
    if (!trade) return undefined;
    
    // Update in database FIRST (source of truth) and get true PnL
    const pnl = await updateTradeExitInDB(tradeId, exitExecution, exitReason);
    
    // Update in memory cache
    trade.exitPrice = exitExecution.exitPrice;
    trade.exitTimestamp = Date.now();
    trade.exitReason = exitReason;
    trade.pnl = pnl;
    trade.status = 'closed';
    
    // Update execution data
    trade.execution.exitTokenAmountIn = 0;
    trade.execution.exitTokenAmountOut = 0;
    trade.execution.exitAssetValueUsd = exitExecution.exitAssetValueUsd;
    trade.execution.exitFeesPaid = exitExecution.exitFeesPaid;
    trade.execution.exitSlippageUsd = exitExecution.exitSlippageUsd;
    
    return trade;
}

/**
 * Legacy close trade - uses reference prices (DEPRECATED)
 */
export async function closeTradeLegacy(
    tradeId: string,
    exitPrice: number,
    exitReason: string
): Promise<Trade | undefined> {
    const trade = tradeRegistry.get(tradeId);
    if (!trade) return undefined;
    
    // Calculate PnL using old method (WRONG - just for backwards compatibility)
    const pnl = (exitPrice - trade.entryPrice) * trade.size / trade.entryPrice;
    
    // Update in database FIRST
    await updateTradeExitLegacy(tradeId, exitPrice, pnl, exitReason);
    
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
