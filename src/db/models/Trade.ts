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

import { supabase, ensurePoolExists, PoolMeta } from '../supabase';
import logger from '../../utils/logger';
import { RiskTier } from '../../engine/riskBucketEngine';
import { getActiveRunId } from '../../services/runEpoch';
import {
    isReconciliationSealed,
    assertReconciliationSealed,
    getReconciliationSeal,
    isTradeAuthorizedBySeal,
    authorizePostSealTrade,
} from '../../state/reconciliationSeal';

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION COST BREAKDOWN — TIER-4 SEMANTIC CLARITY
// ═══════════════════════════════════════════════════════════════════════════════
// 
// This interface provides UNAMBIGUOUS cost semantics across all logs and events.
// Every field is explicitly labeled as entry/exit/total to prevent confusion.
// 
// INVARIANT: totalFeesUSD = entryFeesUSD + exitFeesUSD
// INVARIANT: totalSlippageUSD = entrySlippageUSD + exitSlippageUSD
// 
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execution Cost Breakdown — explicit entry/exit/total for fees and slippage
 * 
 * This object is the SINGLE SOURCE OF TRUTH for cost semantics.
 * Reused across entry/exit/update paths to avoid drift.
 */
export interface ExecutionCostBreakdown {
    // Entry costs (incurred on position open)
    entryFeesUSD: number;
    entrySlippageUSD: number;
    
    // Exit costs (incurred on position close)
    exitFeesUSD: number;
    exitSlippageUSD: number;
    
    // Totals (entry + exit)
    totalFeesUSD: number;
    totalSlippageUSD: number;
    
    // Combined total cost
    totalCostUSD: number;
}

/**
 * Compute execution cost breakdown from entry and exit data
 * 
 * This is the CANONICAL function for computing costs.
 * All logs and events should use this to ensure consistency.
 * 
 * @param entryFeesUSD - Fees paid on entry (0.3% default)
 * @param entrySlippageUSD - Slippage on entry (0.1% default)
 * @param exitFeesUSD - Fees paid on exit (0.3% default)
 * @param exitSlippageUSD - Slippage on exit (0.1% default)
 * @returns ExecutionCostBreakdown with all fields computed
 */
export function computeExecutionCostBreakdown(
    entryFeesUSD: number,
    entrySlippageUSD: number,
    exitFeesUSD: number,
    exitSlippageUSD: number
): ExecutionCostBreakdown {
    const totalFeesUSD = entryFeesUSD + exitFeesUSD;
    const totalSlippageUSD = entrySlippageUSD + exitSlippageUSD;
    const totalCostUSD = totalFeesUSD + totalSlippageUSD;
    
    return {
        entryFeesUSD,
        entrySlippageUSD,
        exitFeesUSD,
        exitSlippageUSD,
        totalFeesUSD,
        totalSlippageUSD,
        totalCostUSD,
    };
}

/**
 * DEV-ONLY: Verify cost breakdown semantics at startup
 * 
 * Given Entry=$379.04 and Exit=$379.04, verifies:
 * - entrySlippage = 0.37904 (0.1%)
 * - exitSlippage = 0.37904 (0.1%)
 * - totalSlippage = 0.75808
 * 
 * Only runs when NODE_ENV !== 'production'
 */
export function verifyCostBreakdownSemantics(): void {
    if (process.env.NODE_ENV === 'production') {
        return; // Skip in production
    }
    
    const testEntryUSD = 379.04;
    const testExitUSD = 379.04;
    
    // Default slippage model: 0.1%
    const entrySlippage = testEntryUSD * 0.001;
    const exitSlippage = testExitUSD * 0.001;
    
    // Default fee model: 0.3%
    const entryFees = testEntryUSD * 0.003;
    const exitFees = testExitUSD * 0.003;
    
    const breakdown = computeExecutionCostBreakdown(
        entryFees,
        entrySlippage,
        exitFees,
        exitSlippage
    );
    
    // Verify invariants
    const feesMatch = Math.abs(breakdown.totalFeesUSD - (breakdown.entryFeesUSD + breakdown.exitFeesUSD)) < 0.0001;
    const slippageMatch = Math.abs(breakdown.totalSlippageUSD - (breakdown.entrySlippageUSD + breakdown.exitSlippageUSD)) < 0.0001;
    
    if (!feesMatch || !slippageMatch) {
        logger.error('[COST-SANITY] ❌ Cost breakdown invariant violation!');
        return;
    }
    
    logger.info(
        `[COST-SANITY] ✅ Verified | ` +
        `Entry=$${testEntryUSD.toFixed(2)} Exit=$${testExitUSD.toFixed(2)} | ` +
        `EntrySlip=$${breakdown.entrySlippageUSD.toFixed(4)} ` +
        `ExitSlip=$${breakdown.exitSlippageUSD.toFixed(4)} ` +
        `TotalSlip=$${breakdown.totalSlippageUSD.toFixed(4)} | ` +
        `EntryFees=$${breakdown.entryFeesUSD.toFixed(4)} ` +
        `ExitFees=$${breakdown.exitFeesUSD.toFixed(4)} ` +
        `TotalFees=$${breakdown.totalFeesUSD.toFixed(4)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE ID GENERATION - DB-FIRST PRIMARY KEY FLOW
// ═══════════════════════════════════════════════════════════════════════════════
// 
// CRITICAL: Trade IDs are now generated by the DATABASE using gen_random_uuid()
// 
// DO NOT generate UUIDs client-side for trades.
// 
// Flow:
// 1. Insert trade WITHOUT id field
// 2. Supabase uses gen_random_uuid() as default
// 3. Insert returns the generated ID
// 4. Attach ID to in-memory objects
// 
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @deprecated Trade IDs are now generated by the database.
 * This function is kept for backward compatibility but logs a warning.
 */
export function generateTradeId(): string {
    logger.warn('[ID-GEN] generateTradeId() called - IDs should come from DB, not client');
    // Return empty string to force errors if this is used incorrectly
    return '';
}

/**
 * @deprecated Position IDs should use the trade ID from the database.
 * This function is kept for backward compatibility but logs a warning.
 */
export function generatePositionId(): string {
    logger.warn('[ID-GEN] generatePositionId() called - IDs should come from DB');
    return '';
}

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
 * Trade structure for reading from database (id is required)
 * This is the canonical Trade type used throughout the application.
 */
export interface Trade {
    id: string;                      // Required - assigned by database
    pool: string;
    poolName: string;
    
    // Run epoch tracking (accounting correctness)
    runId?: string;                  // Run ID this trade belongs to
    
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
 * Trade structure for database writes (id is omitted - DB generates it)
 * Use this type when creating a new trade before DB insertion.
 */
export interface TradeInput extends Omit<Trade, 'id'> {
    // id is intentionally omitted - database generates it via gen_random_uuid()
}

/**
 * In-memory trade registry for fast lookups
 * NOTE: This is a CACHE only - source of truth is database
 */
const tradeRegistry: Map<string, Trade> = new Map();

/**
 * Create a new Trade object without ID (ID will be assigned by database)
 * 
 * Returns TradeInput which omits the id field.
 * After database insertion, the returned ID should be attached to create a full Trade.
 */
export function createTradeInput(
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
): TradeInput {
    // NO client-side ID generation - database generates it
    const trade: TradeInput = {
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
 * @deprecated Use createTradeInput() instead. This function is kept for backward compatibility.
 * Creates a Trade object - but ID should come from database, not client.
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
): TradeInput {
    // Delegate to createTradeInput - no ID generated client-side
    return createTradeInput(pool, size, mode, telemetry, execution, riskTier, leverage, entryBin);
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
 * Save trade to database - MANDATORY operation (DB-FIRST ID GENERATION)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: 
 * - If this fails, the trade MUST NOT proceed
 * - ID is generated by the database using gen_random_uuid()
 * - DO NOT pass an id field to the insert
 * - Returns the DB-generated ID
 * 
 * SEAL ENFORCEMENT:
 * - This is the ONLY legitimate path for new trade creation after seal
 * - Called from ExecutionEngine.executeEntry() via the ScanLoop entry path
 * - Other trade creation attempts are FORBIDDEN after seal
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * @param trade - TradeInput (without id)
 * @returns The database-generated trade ID
 * @throws Error if database insert fails or no ID returned
 */
export async function saveTradeToDB(trade: TradeInput): Promise<string> {
    // Verify database is available FIRST
    await verifyDatabaseConnection();
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // SEAL ENFORCEMENT: New trades are ONLY allowed via the ScanLoop entry path
    // This function is the legitimate entry path, so we allow it.
    // The seal check here is documentation - the actual gate is in ExecutionEngine.
    // ═══════════════════════════════════════════════════════════════════════════════
    if (isReconciliationSealed()) {
        logger.debug(`[SEAL] New trade creation via authorized entry path: ${trade.poolName}`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // AUTO-POOL REGISTRATION - Ensure pool exists before trade insert
    // This prevents FK violations when positions reference pools
    // ═══════════════════════════════════════════════════════════════════════════════
    const poolMeta: PoolMeta = {
        pool_address: trade.pool,
        tokenA: trade.poolName?.split('/')[0] ?? null,
        tokenB: trade.poolName?.split('/')[1] ?? null,
        tokenAMint: trade.execution.baseMint,
        tokenBMint: trade.execution.quoteMint,
        decimalsA: trade.execution.baseDecimals,
        decimalsB: trade.execution.quoteDecimals,
    };

    const poolRegistered = await ensurePoolExists(poolMeta);
    if (!poolRegistered) {
        throw new Error(`[DB-ERROR] Pool registration failed for ${trade.pool.slice(0, 8)}... - aborting trade persistence`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // INSERT WITHOUT ID - Let database generate via gen_random_uuid()
    // ═══════════════════════════════════════════════════════════════════════════════
    const currentRunId = getActiveRunId();
    
    const { data, error } = await supabase.from('trades').insert({
        // NO id field - database generates it
        pool_address: trade.pool,
        pool_name: trade.poolName,
        
        // Run epoch tracking (accounting correctness)
        run_id: currentRunId,
        
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
    }).select('id').single();
    
    if (error) {
        // ═══════════════════════════════════════════════════════════════════════
        // NO GRACEFUL DEGRADATION - THROW ERROR TO ABORT TRADE
        // ═══════════════════════════════════════════════════════════════════════
        throw new Error(`Trade persistence failed — abort execution: ${error.message}`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // CRITICAL: Ensure we got an ID back from the database
    // ═══════════════════════════════════════════════════════════════════════════════
    if (!data || !data.id) {
        throw new Error('Trade persistence failed — no ID returned from database');
    }
    
    const dbGeneratedId = data.id as string;
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // SEAL ENFORCEMENT: Authorize this new trade for post-seal processing
    // This allows the trade to be processed by exit watchers, harmonic monitoring, etc.
    // ═══════════════════════════════════════════════════════════════════════════════
    authorizePostSealTrade(dbGeneratedId);
    
    logger.info(`[TRADE-ID] Assigned from DB: ${dbGeneratedId}`);
    logger.info(`✅ Trade ${dbGeneratedId.slice(0, 8)}... saved to database`);
    
    return dbGeneratedId;
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
    // netPnL = grossPnL - totalFees - totalSlippage
    // All values in USD - no token comparisons
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Compute cost breakdown using canonical function (single source of truth)
    const costBreakdown = computeExecutionCostBreakdown(
        trade.execution.entryFeesPaid,
        trade.execution.entrySlippageUsd,
        exitExecution.exitFeesPaid,
        exitExecution.exitSlippageUsd
    );
    
    // Legacy aliases for DB writes (keep existing column names)
    const totalFees = costBreakdown.totalFeesUSD;
    const totalSlippage = costBreakdown.totalSlippageUSD;
    
    const grossPnl = exitExecution.exitAssetValueUsd - trade.execution.entryAssetValueUsd;
    // Net PnL = gross - fees - slippage (rounded to 2 decimals)
    const netPnl = Math.round((grossPnl - totalFees - totalSlippage) * 100) / 100;
    
    // Calculate net exit value (after fees and slippage)
    const netExitValueUsd = exitExecution.exitAssetValueUsd - exitExecution.exitFeesPaid - exitExecution.exitSlippageUsd;
    
    // Calculate PnL percentage
    const pnlPercent = trade.execution.entryAssetValueUsd > 0 
        ? (netPnl / trade.execution.entryAssetValueUsd) * 100 
        : 0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // [PNL_USD] LOG — EXPLICIT ENTRY/EXIT/TOTAL BREAKDOWN (Tier-4 Semantics)
    // ═══════════════════════════════════════════════════════════════════════════
    logger.info(
        `[PNL_USD] Trade ${tradeId.slice(0, 8)}... | ` +
        `Entry=$${trade.execution.entryAssetValueUsd.toFixed(2)} Exit=$${exitExecution.exitAssetValueUsd.toFixed(2)} | ` +
        `EntryFees=$${costBreakdown.entryFeesUSD.toFixed(2)} ExitFees=$${costBreakdown.exitFeesUSD.toFixed(2)} TotalFees=$${costBreakdown.totalFeesUSD.toFixed(2)} | ` +
        `EntrySlip=$${costBreakdown.entrySlippageUSD.toFixed(2)} ExitSlip=$${costBreakdown.exitSlippageUSD.toFixed(2)} TotalSlip=$${costBreakdown.totalSlippageUSD.toFixed(2)} | ` +
        `Gross=${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(2)} Net=${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`
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
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * SEAL ENFORCEMENT: After reconciliation seal is set, this function:
 * 1. MUST verify seal is set (assertReconciliationSealed)
 * 2. MUST only return trades authorized by the seal
 * 3. MUST drop any trade not in seal.openTradeIds
 * 
 * This prevents "zombie trades" from being resurrected after restart.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export async function loadActiveTradesFromDB(): Promise<Trade[]> {
    try {
        // ═══════════════════════════════════════════════════════════════════════════
        // SEAL ENFORCEMENT: Check seal status and gate hydration
        // ═══════════════════════════════════════════════════════════════════════════
        if (isReconciliationSealed()) {
            assertReconciliationSealed('loadActiveTradesFromDB');
            
            const seal = getReconciliationSeal();
            
            // If seal says 0 open trades, skip hydration entirely
            if (seal.openCount === 0) {
                logger.info('[SEAL] No open trades allowed — skipping hydration');
                return [];
            }
            
            logger.info(`[SEAL] Hydrating trades from seal: ${seal.openCount} authorized`);
        }
        
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
        
        const trades: Trade[] = [];
        const seal = getReconciliationSeal();
        
        for (const row of data) {
            const tradeId = row.id as string;
            
            // ═══════════════════════════════════════════════════════════════════════
            // SEAL ENFORCEMENT: Drop any trade not explicitly listed in seal
            // ═══════════════════════════════════════════════════════════════════════
            if (seal.sealed && !isTradeAuthorizedBySeal(tradeId)) {
                logger.warn(`[SEAL] Dropping unauthorized trade hydration`, {
                    tradeId: tradeId.slice(0, 8),
                });
                continue;
            }
            
            const trade: Trade = {
                id: tradeId,
                pool: row.pool_address,
                poolName: row.pool_name || '',
                
                // Run epoch tracking
                runId: row.run_id || undefined,
                
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
            };
            
            trades.push(trade);
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
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * SEAL ENFORCEMENT: Returns undefined for non-authorized trades
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function getTrade(tradeId: string): Trade | undefined {
    const trade = tradeRegistry.get(tradeId);
    if (trade && !isTradeAuthorizedBySeal(trade.id)) {
        return undefined; // Non-sealed trade is invisible
    }
    return trade;
}

/**
 * Get all active trades for a pool
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * SEAL ENFORCEMENT: Only returns trades authorized by the reconciliation seal
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function getTradesForPool(poolAddress: string): Trade[] {
    const trades: Trade[] = [];
    for (const trade of tradeRegistry.values()) {
        if (trade.pool === poolAddress && trade.status === 'open') {
            // SEAL ENFORCEMENT: Skip non-authorized trades
            if (!isTradeAuthorizedBySeal(trade.id)) {
                continue;
            }
            trades.push(trade);
        }
    }
    return trades;
}

/**
 * Get all active trades from in-memory registry
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * SEAL ENFORCEMENT: Only returns trades authorized by the reconciliation seal.
 * This prevents zombie trades from being processed by any component.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function getAllActiveTrades(): Trade[] {
    const trades: Trade[] = [];
    for (const trade of tradeRegistry.values()) {
        if (trade.status === 'open') {
            // SEAL ENFORCEMENT: Skip non-authorized trades
            if (!isTradeAuthorizedBySeal(trade.id)) {
                continue;
            }
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
