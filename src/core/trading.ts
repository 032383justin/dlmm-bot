/**
 * Trading Module - Entry execution orchestration for DLMM bot
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: ALL TRADES MUST BE PERSISTED AND CAPITAL LOCKED
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * USD-NORMALIZED ACCOUNTING:
 * - All values stored and computed in USD, NOT token amounts
 * - Token decimals fetched from on-chain SPL metadata
 * - PnL = (exitValueUSD - entryValueUSD) - fees - slippage
 * - NO token-to-token comparisons allowed
 * 
 * This module handles:
 * - Position sizing (standard vs aggressive) in USD
 * - Trade object creation with normalized USD values
 * - Database persistence (MANDATORY - no graceful degradation)
 * - Capital allocation via capitalManager
 * - Capital safety guardrails
 * 
 * RULES:
 * 1. If database insert fails → ABORT TRADE
 * 2. If capital allocation fails → ABORT TRADE
 * 3. Capital must be locked BEFORE trade execution
 * 4. Capital must be released with P&L on exit
 * 5. If normalization fails → ABORT TRADE (NormalizationFailure)
 */

import { Pool } from './normalizePools';
import { 
    Trade,
    TradeInput,
    SizingMode, 
    createTradeInput, 
    saveTradeToDB, 
    registerTrade,
    closeTrade,
    getTradesForPool,
    getAllActiveTrades,
    updateTradeExitInDB,
    unregisterTrade,
    createDefaultExecutionData,
    ExecutionData,
    canExitTrade,
    acquireExitLock,
    markTradeClosed,
    releaseExitLock,
    getTrade,
} from '../db/models/Trade';
import { supabase } from '../db/supabase';
import { logAction } from '../db/supabase';
import { capitalManager } from '../services/capitalManager';
import { RiskTier } from '../engine/riskBucketEngine';
import logger from '../utils/logger';
import {
    computeEntryExecutionUSD,
    computeExitExecutionUSD,
    NormalizationFailure,
    validateTradeConditions,
    roundUSD,
    logEntryExecution,
    logExitExecution,
    PriceSource,
    EntryExecutionUSD,
    ExitExecutionUSD,
} from '../engine/valueNormalization';
import {
    computeExitMtmUsd,
    createDefaultPriceFeed,
    createPositionForMtm,
    logPnlUsdWithMtm,
    PoolStateForMTM,
    PriceFeed,
    MTMValuation,
} from '../capital/mtmValuation';
import {
    shouldSuppressNoiseExit,
    isRiskExit,
    recordSuppressionCheck,
    EXIT_CONFIG,
} from '../capital/exitHysteresis';

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
 * @param balance - Current available balance (from capitalManager)
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
    activeBin?: number;
    // Token mint addresses for on-chain decimal fetching
    baseMint?: string;
    quoteMint?: string;
    // Quote token price (defaults to 1.0 for stablecoins)
    quotePrice?: number;
    // Price source for audit trail
    priceSource?: PriceSource;
    // Price fetch timestamp for staleness check
    priceFetchedAt?: number;
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
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL EXECUTION ORDER:
 * 1. Check capital guardrails (liquid capital, max deployed)
 * 2. Check for existing active trade on pool
 * 3. Check migration direction
 * 4. Use provided size from risk bucket (NOT calculateEntrySize)
 * 5. ALLOCATE CAPITAL (via capitalManager) - MUST SUCCEED
 * 6. createTradeObject with execution data
 * 7. SAVE TO DATABASE - MUST SUCCEED (if fails, release capital)
 * 8. registerTrade() in memory cache
 * 9. logTradeEvent()
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * @param pool - Pool to enter (with attached telemetry)
 * @param sizingMode - 'standard' or 'aggressive'
 * @param requestedSize - Size from risk bucket engine (NOT balance-based calc)
 * @param totalCapital - Total starting capital for percentage calculations
 * @param riskTier - Risk tier from bucket engine (A, B, C, D)
 * @param leverage - Leverage multiplier from risk bucket
 * @returns EntryResult with trade object if successful
 */
export async function enterPosition(
    pool: PoolWithTelemetry,
    sizingMode: SizingMode,
    requestedSize: number,
    totalCapital?: number,
    riskTier: RiskTier = 'C',
    leverage: number = 1.0
): Promise<EntryResult> {
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 0: Verify capital manager is ready
    // ═══════════════════════════════════════════════════════════════════════════
    if (!capitalManager.isReady()) {
        logger.error('❌ Capital manager not initialized - cannot execute trade');
        return {
            success: false,
            reason: 'Capital manager not initialized',
        };
    }
    
    // Get current balance from capital manager (source of truth)
    let currentBalance: number;
    try {
        currentBalance = await capitalManager.getBalance();
    } catch (err: any) {
        logger.error(`❌ Failed to get balance: ${err.message}`);
        return {
            success: false,
            reason: `Failed to get balance: ${err.message}`,
        };
    }
    
    // Get total equity for percentage calculations
    let startingCapital: number;
    try {
        startingCapital = totalCapital ?? (await capitalManager.getEquity());
    } catch {
        startingCapital = totalCapital ?? currentBalance;
    }
    
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
    
    if (currentBalance < minRequired) {
        logger.warn(`⚠️ Trade execution rejected: insufficient capital threshold`);
        logger.warn(`   Balance: $${currentBalance.toFixed(2)} < Required: $${minRequired.toFixed(2)}`);
        return {
            success: false,
            reason: `Insufficient capital threshold (balance $${currentBalance.toFixed(2)} < min $${minRequired.toFixed(2)})`,
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
    // NOTE: Migration penalty is already applied in risk bucket sizing
    // This is a hard rejection for severe migration
    // ═══════════════════════════════════════════════════════════════════════════
    const migrationDirection = (pool as any).migrationDirection as string | undefined;
    const liquiditySlope = pool.liquiditySlope ?? 0;
    
    if (migrationDirection === 'out' || liquiditySlope < -0.05) {
        logger.warn(`🚫 [MIGRATION REJECT] ${pool.name} - severe liquidity exit`);
        logger.warn(`   migrationDirection=${migrationDirection}, liquiditySlope=${(liquiditySlope * 100).toFixed(2)}%`);
        return {
            success: false,
            reason: `Migration reject: severe liquidity exit (dir=${migrationDirection}, liqSlope=${(liquiditySlope * 100).toFixed(2)}%)`,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // USE SIZE FROM RISK BUCKET ENGINE (not calculateEntrySize)
    // Size already includes: tier cap, leverage, migration penalty
    // ═══════════════════════════════════════════════════════════════════════════
    let adjustedSize = requestedSize;
    
    if (adjustedSize <= 0) {
        return {
            success: false,
            reason: `Invalid size from risk bucket: $${adjustedSize.toFixed(2)}`,
        };
    }
    
    // Final cap check against deployment limit
    const projectedDeployed = currentlyDeployed + adjustedSize;
    if (projectedDeployed > maxDeployable) {
        const availableRoom = Math.floor(maxDeployable - currentlyDeployed);
        if (availableRoom < SIZING_CONFIG.standard.minSize) {
            logger.warn(`⚠️ Trade execution rejected: insufficient room under deployment cap`);
            return {
                success: false,
                reason: `Insufficient room under deployment cap (would need $${adjustedSize} but only $${availableRoom} available)`,
            };
        }
        adjustedSize = availableRoom;
        logger.info(`📏 Position capped for deployment limit: $${requestedSize} → $${adjustedSize}`);
    }
    
    // Extract telemetry (with defaults for missing values)
    const telemetry = {
        entropy: pool.entropy ?? 0,
        velocitySlope: pool.velocitySlope ?? 0,
        liquiditySlope: pool.liquiditySlope ?? 0,
        entropySlope: pool.entropySlope ?? 0,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // USD NORMALIZATION PIPELINE - TRUE FILL PRICES
    // All values computed in USD using on-chain verified decimals
    // ═══════════════════════════════════════════════════════════════════════════
    let entryExecution: EntryExecutionUSD | null = null;
    let executionData: ExecutionData;
    
    // Check if we have mint addresses for full normalization
    const hasMintData = pool.baseMint && pool.quoteMint;
    const priceSource: PriceSource = pool.priceSource ?? 'birdeye';
    const priceFetchedAt = pool.priceFetchedAt ?? Date.now();
    const quotePrice = pool.quotePrice ?? 1.0; // Assume stablecoin quote
    
    if (hasMintData) {
        // ═══════════════════════════════════════════════════════════════════════
        // FULL NORMALIZATION: Use on-chain decimals
        // ═══════════════════════════════════════════════════════════════════════
        try {
            // Validate trade conditions before proceeding
            const priceAge = Date.now() - priceFetchedAt;
            
            entryExecution = await computeEntryExecutionUSD(
                adjustedSize,
                pool.baseMint!,
                pool.quoteMint!,
                pool.currentPrice,
                quotePrice,
                priceSource
            );
            
            // Validate computed entry
            validateTradeConditions(
                entryExecution.entryValueUSD,
                pool.currentPrice,
                quotePrice,
                entryExecution.baseDecimals,
                entryExecution.quoteDecimals,
                priceAge
            );
            
            // Create execution data from normalized values
            executionData = {
                entryTokenAmountIn: adjustedSize, // USD in
                entryTokenAmountOut: entryExecution.normalizedAmountBase,
                entryAssetValueUsd: entryExecution.netEntryValueUSD,
                entryFeesPaid: entryExecution.entryFeesUSD,
                entrySlippageUsd: entryExecution.entrySlippageUSD,
                netReceivedBase: entryExecution.normalizedAmountBase,
                netReceivedQuote: entryExecution.normalizedAmountQuote,
            };
            
            logger.info(`[NORMALIZATION] Entry computed with on-chain decimals: base=${entryExecution.baseDecimals}, quote=${entryExecution.quoteDecimals}`);
            
        } catch (error: any) {
            if (error instanceof NormalizationFailure) {
                // ═══════════════════════════════════════════════════════════════
                // HARD FAIL: Normalization failure halts trade execution
                // ═══════════════════════════════════════════════════════════════
                logger.error(`[NORMALIZATION_FAILURE] ${error.message}`);
                logger.error(`[NORMALIZATION_FAILURE] Context: ${JSON.stringify(error.context)}`);
                return {
                    success: false,
                    reason: `Normalization failure: ${error.reason}`,
                };
            }
            // For other errors, fall back to legacy execution
            logger.warn(`[NORMALIZATION] Failed to compute entry, falling back to legacy: ${error.message}`);
            executionData = createDefaultExecutionData(adjustedSize, pool.currentPrice);
        }
    } else {
        // ═══════════════════════════════════════════════════════════════════════
        // LEGACY MODE: No mint data, use estimated execution
        // TODO: Remove this fallback once all pools have mint data
        // ═══════════════════════════════════════════════════════════════════════
        logger.warn(`[NORMALIZATION] No mint data for ${pool.name}, using legacy execution`);
        executionData = createDefaultExecutionData(adjustedSize, pool.currentPrice);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: CREATE TRADE INPUT (NO ID - database generates it)
    // ═══════════════════════════════════════════════════════════════════════════
    const tradeInput: TradeInput = createTradeInput(
        {
            address: pool.address,
            name: pool.name,
            currentPrice: pool.currentPrice,
            score: pool.score,
            liquidity: pool.liquidity,
            velocity: pool.velocity,
        },
        adjustedSize,
        sizingMode,
        telemetry,
        executionData,
        riskTier,
        leverage,
        pool.activeBin
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: SAVE TO DATABASE FIRST - GET DB-GENERATED ID
    // ═══════════════════════════════════════════════════════════════════════════
    let dbGeneratedId: string;
    try {
        dbGeneratedId = await saveTradeToDB(tradeInput);
        logger.info(`[TRADE-ID] Assigned from DB: ${dbGeneratedId}`);
    } catch (err: any) {
        logger.error(`❌ Trade persistence failed: ${err.message}`);
        return {
            success: false,
            reason: `Trade persistence failed — abort execution: ${err.message}`,
        };
    }
    
    // Create full trade object with DB-assigned ID
    const trade: Trade = {
        ...tradeInput,
        id: dbGeneratedId,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: ALLOCATE CAPITAL (using DB-generated ID)
    // ═══════════════════════════════════════════════════════════════════════════
    let capitalAllocated = false;
    try {
        capitalAllocated = await capitalManager.allocate(trade.id, adjustedSize);
        
        if (!capitalAllocated) {
            logger.error(`❌ Capital allocation failed for trade ${trade.id.slice(0, 8)}... - insufficient balance`);
            // Trade already in DB - mark as cancelled
            try {
                await supabase.from('trades').update({ 
                    status: 'cancelled',
                    exit_reason: 'INSUFFICIENT_CAPITAL'
                }).eq('id', trade.id);
            } catch {
                logger.error(`❌ Failed to cancel trade ${trade.id.slice(0, 8)}... in DB`);
            }
            return {
                success: false,
                reason: `Capital allocation failed - insufficient balance`,
            };
        }
    } catch (err: any) {
        logger.error(`❌ Capital allocation error: ${err.message}`);
        // Trade already in DB - mark as cancelled
        try {
            await supabase.from('trades').update({ 
                status: 'cancelled',
                exit_reason: 'CAPITAL_ALLOCATION_ERROR'
            }).eq('id', trade.id);
        } catch {
            logger.error(`❌ Failed to cancel trade ${trade.id.slice(0, 8)}... in DB`);
        }
        return {
            success: false,
            reason: `Capital allocation error: ${err.message}`,
        };
    }
    
    // 5. Register in memory cache
    registerTrade(trade);
    
    // 6. Log trade event (console only - NO database logging here)
    // Database ENTRY log is emitted by ExecutionEngine AFTER full position registration
    logSuccessfulEntry(pool, trade, sizingMode, riskTier, leverage);
    
    return {
        success: true,
        trade,
    };
}

/**
 * Log successful entry in the required format
 */
function logSuccessfulEntry(
    pool: PoolWithTelemetry, 
    trade: Trade, 
    mode: SizingMode,
    riskTier: RiskTier,
    leverage: number
): void {
    const vSlope = ((pool.velocitySlope ?? 0) * 100).toFixed(1);
    const lSlope = ((pool.liquiditySlope ?? 0) * 100).toFixed(1);
    const eSlope = ((pool.entropySlope ?? 0) * 100).toFixed(1);
    
    logger.info(`🔥 ENTRY`);
    logger.info(`🚀 [ENTER] ${pool.name} @ ${trade.entryPrice.toFixed(8)}`);
    logger.info(`   mode=${mode} size=$${trade.size} tier=${riskTier} leverage=${leverage.toFixed(2)}x`);
    logger.info(`   score=${trade.score.toFixed(2)}`);
    logger.info(`   vSlope=${vSlope}% lSlope=${lSlope}% eSlope=${eSlope}%`);
    logger.info(`   fillValue=$${trade.execution.entryAssetValueUsd.toFixed(2)} fees=$${trade.execution.entryFeesPaid.toFixed(2)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exit execution data - TRUE FILL PRICES (USD NORMALIZED)
 * 
 * CRITICAL: Use actual execution values, NOT oracle/pool mid prices
 * All values must be in USD (normalized from token amounts)
 */
export interface ExitData {
    exitPrice: number;          // Reference price (for logging)
    reason: string;
    // TRUE FILL DATA - optional for backwards compatibility, but should be provided
    exitAssetValueUsd?: number; // Actual exit value in USD
    exitFeesPaid?: number;      // Exit fees in USD
    exitSlippageUsd?: number;   // Exit slippage in USD
    // Audit trail
    priceSource?: PriceSource;  // Source of price data
}

/**
 * Exit result returned after position close
 */
export interface ExitResult {
    success: boolean;
    trade?: Trade;
    pnl?: number;
    grossPnl?: number;
    totalFees?: number;
    reason?: string;
}

/**
 * Exit a position - close trade, update database, and apply P&L to capital
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * SINGLE EXIT AUTHORITY PATTERN
 * This function now checks guards before executing.
 * Only ONE exit will ever execute for a given trade.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * TRUE PnL CALCULATION:
 * pnl = (exit_value_usd - entry_value_usd) - fees_paid
 * NOT: current oracle price minus entry
 * 
 * @param tradeId - ID of trade to close
 * @param executionData - Exit execution data with TRUE fill prices
 * @param caller - Name of calling module (for audit trail)
 * @returns ExitResult with closed trade and TRUE PnL
 */
export async function exitPosition(
    tradeId: string,
    executionData: ExitData,
    caller: string = 'TRADING_MODULE'
): Promise<ExitResult> {
    
    // Get trade from registry
    const activeTrades = getAllActiveTrades();
    const trade = activeTrades.find(t => t.id === tradeId);
    
    if (!trade) {
        return {
            success: false,
            reason: `Trade ${tradeId} not found in registry`,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD 1: Check if trade can be exited
    // ═══════════════════════════════════════════════════════════════════════════
    if (!canExitTrade(tradeId)) {
        const state = trade.exitState;
        logger.info(`[GUARD] Skipping duplicate exit for trade ${tradeId.slice(0, 8)}... — already ${state || 'closing/closed'}`);
        return {
            success: false,
            reason: `Trade already ${state || 'closing/closed'}`,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MTM VALUATION — COMPUTE TRUE POSITION VALUE FOR EXIT
    // ═══════════════════════════════════════════════════════════════════════════
    const poolState: PoolStateForMTM = {
        address: trade.pool,
        name: trade.poolName,
        activeBin: trade.entryBin ?? 0,
        currentPrice: executionData.exitPrice,
        liquidityUSD: trade.liquidity ?? 0,
        feeIntensity: 0.05, // Default if not available
        swapVelocity: trade.velocity ?? 0,
    };
    
    const priceFeed: PriceFeed = createDefaultPriceFeed(poolState);
    const positionForMtm = createPositionForMtm(
        trade.id,
        trade.pool,
        trade.entryPrice,
        trade.size,
        trade.entryBin ?? 0,
        trade.timestamp,
        undefined
    );
    
    const mtm = computeExitMtmUsd(positionForMtm, poolState, priceFeed);

    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT HYSTERESIS — SUPPRESS NOISE EXITS IF NOT READY
    // NEVER suppress risk exits (kill switch, regime flip, etc.)
    // ═══════════════════════════════════════════════════════════════════════════
    if (!isRiskExit(executionData.reason)) {
        const suppressionResult = shouldSuppressNoiseExit(
            {
                tradeId: trade.id,
                poolName: trade.poolName,
                entryTime: trade.timestamp,
                entryNotionalUsd: trade.size,
                entryFeesUsd: trade.execution?.entryFeesPaid,
            },
            mtm,
            executionData.reason
        );
        
        recordSuppressionCheck(suppressionResult, executionData.reason);
        
        if (suppressionResult.suppress) {
            logger.info(
                `[EXIT-SUPPRESS] ${trade.poolName} reason=${suppressionResult.reason} ` +
                `${suppressionResult.details}`
            );
            return {
                success: false,
                reason: `Exit suppressed: ${suppressionResult.reason}`,
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD 2: Acquire exit lock
    // ═══════════════════════════════════════════════════════════════════════════
    if (!acquireExitLock(tradeId, caller)) {
        return {
            success: false,
            reason: `Could not acquire exit lock - another exit in progress`,
        };
    }

    logger.info(`[EXIT_AUTH] Exit granted for trade ${tradeId.slice(0, 8)}... via ${caller}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MTM-BASED EXIT VALUES — TIER-0 CORRECTNESS FIX
    // exitAssetValueUsd MUST equal mtmValueUsd at exit-time
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Use MTM value for exit (includes token value + accrued fees)
    const exitAssetValueUsd = executionData.exitAssetValueUsd ?? mtm.mtmValueUsd;
    
    // Use normalization engine for cost calculation
    const priceSource: PriceSource = executionData.priceSource ?? 'birdeye';
    const exitExecution = computeExitExecutionUSD(
        trade.execution.entryAssetValueUsd,
        exitAssetValueUsd,
        trade.execution.netReceivedBase ?? 0,
        trade.execution.netReceivedQuote ?? 0,
        priceSource,
        undefined, // Use default fee
        undefined  // Use default slippage
    );
    
    // Extract normalized values
    const exitFeesPaid = executionData.exitFeesPaid ?? exitExecution.exitFeesUSD;
    const exitSlippageUsd = executionData.exitSlippageUsd ?? exitExecution.exitSlippageUSD;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MTM-BASED PnL CALCULATION — TIER-0 CORRECTNESS FIX
    // grossPnL = mtmValueUsd - entryNotionalUsd (from MTM, NOT price change * size)
    // netPnL = grossPnL - (entryFees + exitFees)
    // ═══════════════════════════════════════════════════════════════════════════
    const totalFees = roundUSD(trade.execution.entryFeesPaid + exitFeesPaid);
    const totalSlippage = roundUSD(trade.execution.entrySlippageUsd + exitSlippageUsd);
    const grossPnl = roundUSD(mtm.unrealizedPnlUsd); // MTM-based gross PnL
    const netPnl = roundUSD(grossPnl - totalFees);
    
    // Log MTM-based PnL for observability
    logPnlUsdWithMtm(trade.id, trade.poolName, mtm, exitFeesPaid, trade.execution.entryFeesPaid);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Update trade in database with TRUE fill prices
    // CRITICAL: If this fails, release lock and abort
    // ═══════════════════════════════════════════════════════════════════════════
    try {
        await updateTradeExitInDB(tradeId, {
            exitPrice: executionData.exitPrice,
            exitAssetValueUsd,
            exitFeesPaid,
            exitSlippageUsd,
        }, executionData.reason);
    } catch (err: any) {
        logger.error(`❌ Failed to update trade exit in database: ${err.message}`);
        // Release lock - do not proceed with capital release
        releaseExitLock(tradeId);
        logger.warn(`[GUARD] DB write failed - exit aborted for trade ${tradeId.slice(0, 8)}...`);
        return {
            success: false,
            reason: `Database update failed: ${err.message}`,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Apply NET P&L to capital (after fees)
    // ═══════════════════════════════════════════════════════════════════════════
    try {
        await capitalManager.applyPNL(tradeId, netPnl);
    } catch (err: any) {
        logger.error(`❌ Failed to apply P&L to capital: ${err.message}`);
        // Continue - trade is already closed in DB
    }
    
    // STEP 3: Update trade in memory (pass execution data)
    try {
        await closeTrade(tradeId, {
            exitPrice: executionData.exitPrice,
            exitAssetValueUsd,
            exitFeesPaid,
            exitSlippageUsd,
        }, executionData.reason);
    } catch {
        // Already updated in DB, just log
    }
    
    // Update trade object with exit data
    trade.exitPrice = executionData.exitPrice;
    trade.exitTimestamp = Date.now();
    trade.exitReason = executionData.reason;
    trade.pnl = netPnl;
    trade.status = 'closed';
    trade.exitState = 'closed';
    trade.pendingExit = false;
    
    // Log exit with TRUE P&L breakdown
    const pnlSign = netPnl >= 0 ? '+' : '';
    const grossSign = grossPnl >= 0 ? '+' : '';
    logger.info(`📤 [TRADE_EXIT] via ${caller}`);
    logger.info(`🔴 [EXIT] ${trade.poolName} @ ${executionData.exitPrice.toFixed(8)}`);
    logger.info(`   reason=${executionData.reason}`);
    logger.info(`   entryValue=$${trade.execution.entryAssetValueUsd.toFixed(2)} → exitValue=$${exitAssetValueUsd.toFixed(2)}`);
    logger.info(`   grossPnl=${grossSign}$${grossPnl.toFixed(2)} - fees=$${totalFees.toFixed(2)} = netPnl=${pnlSign}$${netPnl.toFixed(2)}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Log SINGLE exit event to database (MTM-BASED VALUES)
    // All values in USD - MTM-based for accuracy
    // ═══════════════════════════════════════════════════════════════════════════
    try {
        await logAction('TRADE_EXIT', {
            tradeId: trade.id,
            pool: trade.pool,
            poolName: trade.poolName,
            // MTM-based USD values (TIER-0 correctness fix)
            entryValueUSD: trade.execution.entryAssetValueUsd,
            exitValueUSD: exitAssetValueUsd,
            mtmValueUSD: mtm.mtmValueUsd,
            feesAccruedUSD: mtm.feesAccruedUsd,
            unrealizedPnLUSD: mtm.unrealizedPnlUsd,
            entryFeesUSD: trade.execution.entryFeesPaid,
            exitFeesUSD: exitFeesPaid,
            slippageUSD: totalSlippage,
            grossPnLUSD: grossPnl,
            grossFromMtm: mtm.mtmValueUsd - trade.execution.entryAssetValueUsd,
            netPnLUSD: netPnl,
            totalFeesUSD: totalFees,
            // Normalized amounts (for audit only, not for logic)
            normalizedAmountBase: trade.execution.netReceivedBase,
            normalizedAmountQuote: trade.execution.netReceivedQuote,
            // Metadata
            exitPrice: trade.exitPrice,
            priceSource,
            reason: trade.exitReason,
            holdTimeMs: (trade.exitTimestamp ?? Date.now()) - trade.timestamp,
            riskTier: trade.riskTier,
            caller,
        });
    } catch (logErr) {
        logger.warn(`[TRADING] Failed to log TRADE_EXIT: ${logErr}`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: Mark trade as closed and remove from registry
    // CRITICAL: This must be LAST
    // ═══════════════════════════════════════════════════════════════════════════
    markTradeClosed(tradeId);
    unregisterTrade(tradeId);
    
    return {
        success: true,
        trade,
        pnl: netPnl,
        grossPnl,
        totalFees,
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
