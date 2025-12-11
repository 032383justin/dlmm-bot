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
/**
 * Price source for audit trail
 */
export type PriceSource = 'birdeye' | 'jupiter' | 'pool_mid' | 'oracle' | 'cached';

export interface ExecutionData {
    // ═══════════════════════════════════════════════════════════════════════════
    // USD VALUES - Primary for trading logic (normalized)
    // ═══════════════════════════════════════════════════════════════════════════
    entryAssetValueUsd: number;      // Gross entry value in USD
    netEntryValueUsd?: number;       // Net entry value after fees/slippage
    entryFeesPaid: number;           // Entry fees in USD
    entrySlippageUsd: number;        // Entry slippage cost in USD
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TOKEN AMOUNTS - For audit only (NOT for trading logic)
    // ═══════════════════════════════════════════════════════════════════════════
    entryTokenAmountIn: number;      // Amount of token spent (audit only)
    entryTokenAmountOut: number;     // Amount of token received (audit only)
    netReceivedBase: number;         // Normalized base token amount
    netReceivedQuote: number;        // Normalized quote token amount
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TOKEN METADATA - On-chain verified decimals
    // ═══════════════════════════════════════════════════════════════════════════
    baseDecimals?: number;           // Base token decimals (from SPL metadata)
    quoteDecimals?: number;          // Quote token decimals (from SPL metadata)
    baseMint?: string;               // Base token mint address
    quoteMint?: string;              // Quote token mint address
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PRICE TRACKING
    // ═══════════════════════════════════════════════════════════════════════════
    priceSource?: PriceSource;       // Source of price data
    priceFetchedAt?: number;         // When price was fetched (for staleness)
    quotePrice?: number;             // Quote token price in USD (1.0 for stables)
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT DATA - Populated on exit (USD normalized)
    // ═══════════════════════════════════════════════════════════════════════════
    exitTokenAmountIn?: number;      // (audit only)
    exitTokenAmountOut?: number;     // (audit only)
    exitAssetValueUsd?: number;      // Gross exit value in USD
    netExitValueUsd?: number;        // Net exit value after fees/slippage
    exitFeesPaid?: number;           // Exit fees in USD
    exitSlippageUsd?: number;        // Exit slippage in USD
    exitPriceSource?: PriceSource;   // Source of exit price
}

/**
 * Trade exit state - used for single exit authority pattern
 */
export type TradeExitState = 'open' | 'closing' | 'closed';

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
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT STATE GUARD - SINGLE EXIT AUTHORITY PATTERN
    // Prevents duplicate exit events from multiple modules
    // ═══════════════════════════════════════════════════════════════════════════
    exitState: TradeExitState;       // 'open' | 'closing' | 'closed'
    pendingExit: boolean;            // true if exit is in progress
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
        
        // Exit state guard - initialized for single exit authority
        exitState: 'open',
        pendingExit: false,
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
        
        // ═══════════════════════════════════════════════════════════════════════
        // USD NORMALIZED VALUES - Primary for trading logic
        // ═══════════════════════════════════════════════════════════════════════
        entry_asset_value_usd: trade.execution.entryAssetValueUsd,
        net_entry_value_usd: trade.execution.netEntryValueUsd ?? trade.execution.entryAssetValueUsd,
        entry_fees_paid: trade.execution.entryFeesPaid,
        entry_slippage_usd: trade.execution.entrySlippageUsd,
        
        // ═══════════════════════════════════════════════════════════════════════
        // TOKEN METADATA - On-chain verified
        // ═══════════════════════════════════════════════════════════════════════
        base_mint: trade.execution.baseMint,
        quote_mint: trade.execution.quoteMint,
        base_decimals: trade.execution.baseDecimals,
        quote_decimals: trade.execution.quoteDecimals,
        
        // ═══════════════════════════════════════════════════════════════════════
        // NORMALIZED AMOUNTS - For audit only
        // ═══════════════════════════════════════════════════════════════════════
        normalized_amount_base: trade.execution.netReceivedBase,
        normalized_amount_quote: trade.execution.netReceivedQuote,
        net_received_base: trade.execution.netReceivedBase,
        net_received_quote: trade.execution.netReceivedQuote,
        
        // ═══════════════════════════════════════════════════════════════════════
        // PRICE TRACKING
        // ═══════════════════════════════════════════════════════════════════════
        entry_price_source: trade.execution.priceSource ?? 'birdeye',
        entry_price_timestamp: trade.execution.priceFetchedAt 
            ? new Date(trade.execution.priceFetchedAt).toISOString() 
            : new Date().toISOString(),
        quote_price_usd: trade.execution.quotePrice ?? 1.0,
        
        // Legacy fields (for backwards compatibility)
        entry_token_amount_in: trade.execution.entryTokenAmountIn,
        entry_token_amount_out: trade.execution.entryTokenAmountOut,
        
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
 * Buffered exit event for retry on failed DB writes
 */
interface BufferedExitEvent {
    tradeId: string;
    exitExecution: {
        exitPrice: number;
        exitAssetValueUsd: number;
        exitFeesPaid: number;
        exitSlippageUsd: number;
        exitPriceSource?: PriceSource;
    };
    exitReason: string;
    computedPnl: {
        grossPnl: number;
        netPnl: number;
        pnlPercent: number;
        totalFees: number;
        totalSlippage: number;
        netExitValueUsd: number;
    };
    failedAt: number;
    retryCount: number;
}

/**
 * In-memory buffer for failed exit writes
 */
const pendingExitWrites: Map<string, BufferedExitEvent> = new Map();

/**
 * Update trade with exit data in database (USD NORMALIZED)
 * 
 * TRUE PnL CALCULATION:
 * grossPnL = exitValueUSD - entryValueUSD
 * netPnL = grossPnL - (entryFees + exitFees)
 * 
 * FALLBACK: If DB write fails, buffers exit event for retry on next cycle
 * 
 * @throws Error if database update fails AND buffering fails
 */
export async function updateTradeExitInDB(
    tradeId: string,
    exitExecution: {
        exitPrice: number;              // Reference price
        exitAssetValueUsd: number;      // Gross exit value in USD
        exitFeesPaid: number;           // Exit fees in USD
        exitSlippageUsd: number;        // Exit slippage in USD
        exitPriceSource?: PriceSource;  // Source of exit price
    },
    exitReason: string
): Promise<number> {
    // Get trade to calculate PnL
    const trade = tradeRegistry.get(tradeId);
    if (!trade) {
        throw new Error(`Trade ${tradeId} not found in registry`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // USD NORMALIZED PnL CALCULATION (always compute before DB write)
    // grossPnL = exitValueUSD - entryValueUSD  
    // netPnL = grossPnL - fees - slippage
    // All values in USD - no token comparisons
    // ═══════════════════════════════════════════════════════════════════════════
    const totalFees = trade.execution.entryFeesPaid + exitExecution.exitFeesPaid;
    const totalSlippage = trade.execution.entrySlippageUsd + exitExecution.exitSlippageUsd;
    const grossPnl = exitExecution.exitAssetValueUsd - trade.execution.entryAssetValueUsd;
    // Net PnL = gross - fees - slippage (rounded to 2 decimals)
    const netPnl = Math.round((grossPnl - totalFees - totalSlippage) * 100) / 100;
    
    // Calculate net exit value (after fees and slippage)
    const netExitValueUsd = exitExecution.exitAssetValueUsd - exitExecution.exitFeesPaid - exitExecution.exitSlippageUsd;
    
    // Calculate PnL percentage
    const pnlPercent = trade.execution.entryAssetValueUsd > 0 
        ? (netPnl / trade.execution.entryAssetValueUsd) * 100 
        : 0;
    
    logger.info(
        `[PNL_USD] Trade ${tradeId.slice(0, 8)}... | ` +
        `Entry=$${trade.execution.entryAssetValueUsd.toFixed(2)} | ` +
        `Exit=$${exitExecution.exitAssetValueUsd.toFixed(2)} | ` +
        `Fees=$${totalFees.toFixed(2)} | ` +
        `Slippage=$${totalSlippage.toFixed(2)} | ` +
        `Gross=${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(2)} | ` +
        `Net=${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ATTEMPT DATABASE WRITE
    // ═══════════════════════════════════════════════════════════════════════════
    try {
        await verifyDatabaseConnection();
        
        const exitTime = new Date().toISOString();
        const priceSource = exitExecution.exitPriceSource ?? 'birdeye';
        
        const { error } = await supabase
            .from('trades')
            .update({
                // ═══════════════════════════════════════════════════════════════
                // EXIT PRICE TRACKING (always recorded)
                // ═══════════════════════════════════════════════════════════════
                exit_price: exitExecution.exitPrice,
                exit_price_source: priceSource,
                exit_asset_value_usd: exitExecution.exitAssetValueUsd,
                net_exit_value_usd: netExitValueUsd,
                
                // ═══════════════════════════════════════════════════════════════
                // EXIT COSTS
                // ═══════════════════════════════════════════════════════════════
                exit_fees_paid: exitExecution.exitFeesPaid,
                exit_slippage_usd: exitExecution.exitSlippageUsd,
                total_fees: totalFees,
                total_slippage: totalSlippage,
                
                // ═══════════════════════════════════════════════════════════════
                // PnL ACCOUNTING (all computed before commit)
                // ═══════════════════════════════════════════════════════════════
                pnl_gross: grossPnl,
                pnl_net: netPnl,
                pnl_usd: netPnl, // Legacy alias
                pnl_percent: pnlPercent,
                
                // ═══════════════════════════════════════════════════════════════
                // STATUS
                // ═══════════════════════════════════════════════════════════════
                exit_time: exitTime,
                exit_reason: exitReason,
                status: 'closed',
                exit_write_pending: false,
                exit_data_buffer: null,
            })
            .eq('id', tradeId);
        
        if (error) {
            throw new Error(error.message);
        }
        
        // Remove from pending if it was there
        pendingExitWrites.delete(tradeId);
        
        logger.info(`✅ Trade ${tradeId.slice(0, 8)}... exit recorded | Net PnL: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`);
        
        return netPnl;
        
    } catch (dbError: any) {
        // ═══════════════════════════════════════════════════════════════════════
        // DATABASE WRITE FAILED - BUFFER FOR RETRY
        // ═══════════════════════════════════════════════════════════════════════
        logger.error(`[EXIT_BUFFER] DB write failed for trade ${tradeId.slice(0, 8)}...: ${dbError.message}`);
        
        const bufferedEvent: BufferedExitEvent = {
            tradeId,
            exitExecution,
            exitReason,
            computedPnl: {
                grossPnl,
                netPnl,
                pnlPercent,
                totalFees,
                totalSlippage,
                netExitValueUsd,
            },
            failedAt: Date.now(),
            retryCount: (pendingExitWrites.get(tradeId)?.retryCount ?? 0) + 1,
        };
        
        pendingExitWrites.set(tradeId, bufferedEvent);
        
        // Try to mark as pending in DB (best effort)
        try {
            await supabase
                .from('trades')
                .update({
                    exit_write_pending: true,
                    exit_data_buffer: bufferedEvent,
                })
                .eq('id', tradeId);
        } catch {
            // Ignore - in-memory buffer is primary fallback
        }
        
        logger.warn(`[EXIT_BUFFER] Buffered exit for retry | Trade: ${tradeId.slice(0, 8)}... | Retry count: ${bufferedEvent.retryCount}`);
        
        // Return the computed PnL even though DB write failed
        // The trade will be retried on next cycle
        return netPnl;
    }
}

/**
 * Process pending exit writes (call on each main loop cycle)
 * 
 * Retries buffered exit events that failed to write to DB
 * 
 * @returns Number of successful retries
 */
export async function processPendingExitWrites(): Promise<number> {
    if (pendingExitWrites.size === 0) {
        return 0;
    }
    
    logger.info(`[EXIT_BUFFER] Processing ${pendingExitWrites.size} pending exit writes...`);
    
    let successCount = 0;
    const maxRetries = 5;
    const staleThresholdMs = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const [tradeId, buffered] of pendingExitWrites.entries()) {
        // Skip if too many retries
        if (buffered.retryCount > maxRetries) {
            logger.error(`[EXIT_BUFFER] Giving up on trade ${tradeId.slice(0, 8)}... after ${buffered.retryCount} retries`);
            pendingExitWrites.delete(tradeId);
            continue;
        }
        
        // Skip if too old
        if (Date.now() - buffered.failedAt > staleThresholdMs) {
            logger.error(`[EXIT_BUFFER] Discarding stale exit for trade ${tradeId.slice(0, 8)}... (${Math.round((Date.now() - buffered.failedAt) / 3600000)}h old)`);
            pendingExitWrites.delete(tradeId);
            continue;
        }
        
        try {
            const priceSource = buffered.exitExecution.exitPriceSource ?? 'birdeye';
            
            const { error } = await supabase
                .from('trades')
                .update({
                    exit_price: buffered.exitExecution.exitPrice,
                    exit_price_source: priceSource,
                    exit_asset_value_usd: buffered.exitExecution.exitAssetValueUsd,
                    net_exit_value_usd: buffered.computedPnl.netExitValueUsd,
                    exit_fees_paid: buffered.exitExecution.exitFeesPaid,
                    exit_slippage_usd: buffered.exitExecution.exitSlippageUsd,
                    total_fees: buffered.computedPnl.totalFees,
                    total_slippage: buffered.computedPnl.totalSlippage,
                    pnl_gross: buffered.computedPnl.grossPnl,
                    pnl_net: buffered.computedPnl.netPnl,
                    pnl_usd: buffered.computedPnl.netPnl,
                    pnl_percent: buffered.computedPnl.pnlPercent,
                    exit_time: new Date(buffered.failedAt).toISOString(),
                    exit_reason: buffered.exitReason,
                    status: 'closed',
                    exit_write_pending: false,
                    exit_data_buffer: null,
                })
                .eq('id', tradeId);
            
            if (error) {
                throw new Error(error.message);
            }
            
            pendingExitWrites.delete(tradeId);
            successCount++;
            
            logger.info(`[EXIT_BUFFER] ✅ Retry successful for trade ${tradeId.slice(0, 8)}...`);
            
        } catch (retryError: any) {
            buffered.retryCount++;
            logger.warn(`[EXIT_BUFFER] Retry ${buffered.retryCount} failed for trade ${tradeId.slice(0, 8)}...: ${retryError.message}`);
        }
    }
    
    if (successCount > 0) {
        logger.info(`[EXIT_BUFFER] ✅ Processed ${successCount}/${pendingExitWrites.size + successCount} pending exits`);
    }
    
    return successCount;
}

/**
 * Get count of pending exit writes
 */
export function getPendingExitWriteCount(): number {
    return pendingExitWrites.size;
}

/**
 * Load pending exit writes from database on startup
 */
export async function loadPendingExitWrites(): Promise<void> {
    try {
        const { data, error } = await supabase
            .from('trades')
            .select('id, exit_data_buffer')
            .eq('exit_write_pending', true);
        
        if (error || !data) {
            return;
        }
        
        for (const row of data) {
            if (row.exit_data_buffer) {
                pendingExitWrites.set(row.id, row.exit_data_buffer as BufferedExitEvent);
                logger.info(`[EXIT_BUFFER] Loaded pending exit for trade ${row.id.slice(0, 8)}...`);
            }
        }
        
        if (pendingExitWrites.size > 0) {
            logger.info(`[EXIT_BUFFER] Loaded ${pendingExitWrites.size} pending exit writes from database`);
        }
        
    } catch {
        // Ignore - not critical
    }
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
            
            // Exit state guard - initialized for recovered trades
            exitState: row.status === 'open' ? 'open' : 'closed',
            pendingExit: false,
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

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT GUARD FUNCTIONS - SINGLE EXIT AUTHORITY PATTERN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if trade can be exited (guard check)
 * Returns true ONLY if trade is in 'open' state and not pending exit
 * 
 * @param tradeId - Trade ID to check
 * @returns true if exit is allowed, false if already closing/closed
 */
export function canExitTrade(tradeId: string): boolean {
    const trade = tradeRegistry.get(tradeId);
    if (!trade) return false;
    
    return trade.exitState === 'open' && !trade.pendingExit;
}

/**
 * Acquire exit lock on a trade (atomic operation)
 * Sets pendingExit=true and exitState='closing'
 * 
 * @param tradeId - Trade ID to lock
 * @param caller - Name of the calling module (for logging)
 * @returns true if lock acquired, false if already locked
 */
export function acquireExitLock(tradeId: string, caller: string): boolean {
    const trade = tradeRegistry.get(tradeId);
    if (!trade) {
        logger.warn(`[GUARD] Cannot acquire exit lock - trade ${tradeId.slice(0, 8)}... not found`);
        return false;
    }
    
    // Check if already closing or closed
    if (trade.exitState !== 'open') {
        logger.info(`[GUARD] Skipping duplicate exit for trade ${tradeId.slice(0, 8)}... — already ${trade.exitState}`);
        return false;
    }
    
    if (trade.pendingExit) {
        logger.info(`[GUARD] Skipping duplicate exit for trade ${tradeId.slice(0, 8)}... — exit pending`);
        return false;
    }
    
    // Acquire lock
    trade.pendingExit = true;
    trade.exitState = 'closing';
    
    logger.info(`[EXIT_AUTH] Exit granted for trade ${tradeId.slice(0, 8)}... via ${caller}`);
    return true;
}

/**
 * Mark trade as fully closed after successful exit
 * Sets exitState='closed' and pendingExit=false
 * 
 * @param tradeId - Trade ID to mark closed
 */
export function markTradeClosed(tradeId: string): void {
    const trade = tradeRegistry.get(tradeId);
    if (!trade) return;
    
    trade.exitState = 'closed';
    trade.pendingExit = false;
    trade.status = 'closed';
}

/**
 * Release exit lock without completing exit (for error recovery)
 * Resets to 'open' state if exit failed
 * 
 * @param tradeId - Trade ID to release lock
 */
export function releaseExitLock(tradeId: string): void {
    const trade = tradeRegistry.get(tradeId);
    if (!trade) return;
    
    // Only release if still in closing state (not completed)
    if (trade.exitState === 'closing') {
        trade.exitState = 'open';
        trade.pendingExit = false;
        logger.warn(`[GUARD] Exit lock released for trade ${tradeId.slice(0, 8)}... — reverting to open`);
    }
}

/**
 * Get trade exit state
 * 
 * @param tradeId - Trade ID
 * @returns Exit state or undefined if trade not found
 */
export function getTradeExitState(tradeId: string): TradeExitState | undefined {
    const trade = tradeRegistry.get(tradeId);
    return trade?.exitState;
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
