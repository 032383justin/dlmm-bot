/**
 * Expected Value (EV) Gating — Canonical Trade Expectancy Model
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 DOMINANT — EXPECTANCY-AWARE EXECUTION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Eliminate low-expectancy trades by computing expected net PnL
 * before entry. No trade is allowed if EV is negative.
 * 
 * FORMULA:
 * ExpectedNetPnLUSD = ExpectedFeeRevenueUSD − ExpectedTotalCostsUSD
 * 
 * WHERE:
 * ExpectedFeeRevenueUSD is derived from:
 *   - feeIntensity (fees per second normalized by TVL)
 *   - bin width (range of active bins)
 *   - expected volume within range
 *   - recent realized fee accrual rate
 * 
 * ExpectedTotalCostsUSD includes:
 *   - entry fees
 *   - exit fees
 *   - entry slippage
 *   - exit slippage
 *   - expected adverse selection penalty
 * 
 * REGIME-SPECIFIC EV MULTIPLIER REQUIREMENTS:
 *   BEAR:    ExpectedFeeRevenueUSD ≥ 1.5 × ExpectedTotalCostsUSD
 *   NEUTRAL: ExpectedFeeRevenueUSD ≥ 1.2 × ExpectedTotalCostsUSD
 *   BULL:    ExpectedFeeRevenueUSD ≥ 1.0 × ExpectedTotalCostsUSD
 * 
 * LOGS: [EV-GATE] with full breakdown for every evaluation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';
import { MicrostructureMetrics } from '../services/dlmmTelemetry';
import { Tier4EnrichedPool } from '../scoring/microstructureScoring';
import { isBootstrapMode, getBootstrapCyclesRemaining } from './feeBullyGate';
import { FEE_BULLY_MODE_ENABLED } from '../config/feeBullyConfig';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 VALIDATION FLAGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dev mode flag for strict validation assertions
 * Set via DEV_MODE=true environment variable
 */
const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

/**
 * Tolerance for detecting synthetic fee estimation
 * If expected fees are within this % of (notional * fee_rate), they may be synthetic
 */
const SYNTHETIC_FEE_TOLERANCE = 0.05; // 5%

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — ALL JUSTIFIED, NO MAGIC NUMBERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * EV Configuration constants with full justification
 */
export const EV_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // FEE ESTIMATION PARAMETERS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Default expected hold time in hours
     * Justification: Based on historical Tier-4 trade duration analysis
     * showing median hold time of 4-8 hours for profitable exits
     */
    defaultHoldTimeHours: 6,
    
    /**
     * Fee revenue decay factor per hour
     * Justification: Fee intensity typically decays as market cools;
     * 0.92 = 8% decay per hour, calibrated from backtests
     */
    feeDecayPerHour: 0.92,
    
    /**
     * Minimum expected fee revenue to consider (USD)
     * Justification: Trades below $0.50 expected fee are not worth gas
     */
    minExpectedFeeUSD: 0.50,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COST ESTIMATION PARAMETERS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Base entry fee as percentage of position size
     * Justification: Meteora DLMM base fee is typically 0.05-0.30%,
     * using 0.15% as conservative median
     */
    baseEntryFeePct: 0.0015,
    
    /**
     * Base exit fee as percentage of position size
     * Justification: Same as entry, 0.15% median DLMM fee
     */
    baseExitFeePct: 0.0015,
    
    /**
     * Expected slippage as percentage of position size (entry)
     * Justification: DLMM slippage on $500 position in $500k TVL pool
     * is typically 0.05-0.10%, using 0.08% as realistic estimate
     */
    expectedEntrySlippagePct: 0.0008,
    
    /**
     * Expected slippage as percentage of position size (exit)
     * Justification: Exit slippage tends to be higher in adverse conditions,
     * using 0.12% as conservative estimate
     */
    expectedExitSlippagePct: 0.0012,
    
    /**
     * Adverse selection penalty — NEUTRALIZED (regime-independent)
     * 
     * NEUTRALIZED: Use static penalty regardless of regime.
     * Rationale: This is a fee-extraction system, not a directional trader.
     * Market regime must not affect economic behavior.
     */
    adverseSelectionPenalty: {
        BEAR: 0.0010,      // NEUTRALIZED: All use same penalty
        NEUTRAL: 0.0010,   // 0.10% static penalty
        BULL: 0.0010,      // NEUTRALIZED: All use same penalty
    } as Record<MarketRegime, number>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FEE:COST RATIO REQUIREMENTS — NEUTRALIZED (regime-independent)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Required fee:cost ratio — NEUTRALIZED
     * 
     * NEUTRALIZED: All regimes use the same requirement.
     * Rationale: Fee harvester mode is regime-blind.
     * Entry decision is based on payback time, not regime-adjusted EV.
     */
    requiredFeeCostRatio: {
        BEAR: 1.1,         // NEUTRALIZED: All use same ratio
        NEUTRAL: 1.1,      // 10% margin over costs
        BULL: 1.1,         // NEUTRALIZED: All use same ratio
    } as Record<MarketRegime, number>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // POSITION-SPECIFIC MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Volume capture rate - what % of pool volume we capture in fees
     * Justification: LP position typically captures 0.5-2% of volume
     * depending on bin width and competition
     */
    volumeCaptureRate: 0.01, // 1% of volume captured
    
    /**
     * Fee share per LP dollar in pool
     * Justification: Fee share is proportional to position/TVL ratio
     * This is applied as: (positionSize / poolTVL) * volumeCaptureRate
     */
    feeShareNormalization: 1.0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP EV OVERRIDE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bootstrap EV Override configuration
 * 
 * During bootstrap mode (first 2-3 cycles), we allow small "probe" positions
 * even with negative EV to seed telemetry and establish baseline metrics.
 * 
 * This is justified because:
 * 1. Initial EV estimates are unreliable without telemetry history
 * 2. Small probe positions have bounded downside
 * 3. We need real data to calibrate the fee models
 */
export const BOOTSTRAP_EV_OVERRIDE = {
    /** Enable bootstrap EV override */
    enabled: true,
    
    /**
     * Maximum position size as % of equity for bootstrap override.
     * NOTE: We do NOT clamp finalSize here - we use the already computed
     * bootstrap size from the sizing engine. This threshold is only used
     * to verify the position qualifies as a "probe" entry.
     */
    maxBootstrapSizePct: 0.03, // 3% max (slightly above 2.5% to allow rounding)
    
    /** Whitelisted core pairs that always qualify for bootstrap override */
    whitelistedPairs: [
        'SOL-USDC', 'SOL/USDC', 'USDC-SOL', 'USDC/SOL',
        'JLP-SOL', 'JLP/SOL', 'SOL-JLP', 'SOL/JLP',
        'USD1-USDC', 'USD1/USDC', 'USDC-USD1', 'USDC/USD1',
        'USDT-USDC', 'USDT/USDC', 'USDC-USDT', 'USDC/USDT',
        'mSOL-SOL', 'mSOL/SOL', 'SOL-mSOL', 'SOL/mSOL',
        'jitoSOL-SOL', 'jitoSOL/SOL', 'SOL-jitoSOL', 'SOL/jitoSOL',
    ],
    
    /**
     * Cost safety limit - block if costs are insane
     * Even during bootstrap, don't enter if costs exceed this USD amount
     */
    maxCostUSD: 10,
    
    /**
     * Dead pool detection - block if all velocity signals are zero
     * swapVelocity=0 AND binVelocity=0 AND fees24h=0 = dead pool
     */
    deadPoolThreshold: {
        minSwapVelocity: 0.001,  // At least 0.001 swaps/sec
        minBinVelocity: 0.0001, // At least some bin movement
        minFees24h: 0.10,       // At least $0.10 in fees
    },
    
    /**
     * Catastrophic EV threshold - block even during bootstrap if EV is extremely negative
     * If expected loss > this USD amount, don't enter
     */
    catastrophicEVThreshold: -5.0, // Block if EV < -$5
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Expected Value computation result
 */
export interface EVResult {
    // Core EV metrics
    expectedFeeRevenueUSD: number;
    expectedTotalCostsUSD: number;
    expectedNetEVUSD: number;
    
    // Fee breakdown
    feeBreakdown: {
        feeIntensityPerHour: number;      // USD/hour from fee intensity
        volumeBasedFees: number;           // USD from expected volume
        feeDecayAdjustment: number;        // Decay factor applied
        totalExpectedFees: number;         // Final fee estimate
    };
    
    // Cost breakdown
    costBreakdown: {
        entryFeeUSD: number;
        exitFeeUSD: number;
        entrySlippageUSD: number;
        exitSlippageUSD: number;
        adverseSelectionUSD: number;
        totalCostsUSD: number;
    };
    
    // Gating decision
    evPositive: boolean;
    meetsRegimeThreshold: boolean;
    feeCostRatio: number;
    requiredRatio: number;
    
    // Final decision
    canEnter: boolean;
    blockReason?: string;
    
    // Bootstrap override info
    bootstrapOverrideApplied: boolean;
    bootstrapOverrideReason?: string;
    
    // Metadata
    regime: MarketRegime;
    positionSizeUSD: number;
    poolTVL: number;
    holdTimeHours: number;
    timestamp: number;
}

/**
 * Inputs for EV computation
 */
export interface EVInputs {
    pool: Tier4EnrichedPool;
    positionSizeUSD: number;
    regime: MarketRegime;
    holdTimeHours?: number;
    
    // Optional overrides for testing
    overrideFeeIntensity?: number;
    overrideVolume24h?: number;
    
    // Bootstrap context
    /** Total equity for size % calculation */
    totalEquity?: number;
    
    /** Force bootstrap override check (auto-detected if not provided) */
    forceBootstrapCheck?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE EV COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute Expected Value for a candidate trade
 * 
 * This is the canonical EV model for all entry decisions.
 * Returns full breakdown for observability.
 */
export function computeExpectedValue(inputs: EVInputs): EVResult {
    const { pool, positionSizeUSD, regime, holdTimeHours = EV_CONFIG.defaultHoldTimeHours } = inputs;
    const now = Date.now();
    
    const poolTVL = pool.liquidity || (pool as any).tvl || 0;
    const volume24h = inputs.overrideVolume24h ?? pool.volume24h ?? 0;
    const feeIntensity = inputs.overrideFeeIntensity ?? 
        (pool.microMetrics?.feeIntensity ?? 0) / 100; // Normalize from 0-100 to 0-1
    const fees24h = pool.fees24h ?? 0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: COMPUTE EXPECTED FEE REVENUE
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Method 1: Fee intensity based
    // IMPORTANT: feeIntensity is a NORMALIZED SCORE (0-100), NOT an actual fee rate!
    // We should NOT multiply by poolTVL as that creates $12,600/min bugs.
    // Instead, use it only as a weighting factor, prefer 24h fees when available.
    const holdTimeSeconds = holdTimeHours * 3600;
    const positionShare = poolTVL > 0 ? positionSizeUSD / poolTVL : 0;
    
    // Convert feeIntensity score to an approximate fee rate
    // Score of 100 = ~1 swap/sec at pool = roughly 1% daily fees
    // This is a rough approximation - prefer realizedFeeRate when available
    const feeIntensityAsRate = (feeIntensity / 100) * 0.01 * poolTVL; // ~1% daily at max intensity
    const feeIntensityPerHour = (feeIntensityAsRate / 24) * positionShare;
    
    // Method 2: Volume-based fee estimate
    // Expected volume during hold = (volume24h / 24) * holdTimeHours
    // Fee capture = volume * captureRate * feeRate
    const expectedVolumeDuringHold = (volume24h / 24) * holdTimeHours;
    const feeRate = (pool as any).feeRate ?? (pool.binStep ? pool.binStep / 10000 : 0.002); // Default 0.2%
    const volumeBasedFees = expectedVolumeDuringHold * positionShare * feeRate * EV_CONFIG.volumeCaptureRate;
    
    // Method 3: Realized fee accrual rate
    // If pool has 24h fees, extrapolate
    const realizedFeeRate = poolTVL > 0 && fees24h > 0
        ? (fees24h / 24) * holdTimeHours * positionShare
        : 0;
    
    // Combine methods with weighting (prefer realized if available)
    let rawExpectedFees: number;
    if (realizedFeeRate > 0) {
        // Weight: 50% realized, 30% intensity, 20% volume
        rawExpectedFees = realizedFeeRate * 0.5 + feeIntensityPerHour * 0.3 + volumeBasedFees * 0.2;
    } else if (feeIntensityPerHour > 0) {
        // Weight: 70% intensity, 30% volume
        rawExpectedFees = feeIntensityPerHour * 0.7 + volumeBasedFees * 0.3;
    } else {
        // Fallback to volume-based only
        rawExpectedFees = volumeBasedFees;
    }
    
    // Apply fee decay over hold time
    // Decay is compounded hourly: fees * (decayRate ^ hours)
    const feeDecayAdjustment = Math.pow(EV_CONFIG.feeDecayPerHour, holdTimeHours);
    const totalExpectedFees = rawExpectedFees * feeDecayAdjustment;
    
    const expectedFeeRevenueUSD = Math.max(0, totalExpectedFees);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: COMPUTE EXPECTED COSTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    const entryFeeUSD = positionSizeUSD * EV_CONFIG.baseEntryFeePct;
    const exitFeeUSD = positionSizeUSD * EV_CONFIG.baseExitFeePct;
    const entrySlippageUSD = positionSizeUSD * EV_CONFIG.expectedEntrySlippagePct;
    const exitSlippageUSD = positionSizeUSD * EV_CONFIG.expectedExitSlippagePct;
    const adverseSelectionUSD = positionSizeUSD * EV_CONFIG.adverseSelectionPenalty[regime];
    
    const expectedTotalCostsUSD = entryFeeUSD + exitFeeUSD + entrySlippageUSD + exitSlippageUSD + adverseSelectionUSD;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: COMPUTE NET EV AND GATING DECISION
    // ═══════════════════════════════════════════════════════════════════════════
    
    const expectedNetEVUSD = expectedFeeRevenueUSD - expectedTotalCostsUSD;
    const evPositive = expectedNetEVUSD > 0;
    
    // Check regime-specific fee:cost ratio requirement
    const feeCostRatio = expectedTotalCostsUSD > 0 
        ? expectedFeeRevenueUSD / expectedTotalCostsUSD 
        : 0;
    const requiredRatio = EV_CONFIG.requiredFeeCostRatio[regime];
    const meetsRegimeThreshold = feeCostRatio >= requiredRatio;
    
    // Standard EV gate decision
    let canEnter = evPositive && meetsRegimeThreshold && expectedFeeRevenueUSD >= EV_CONFIG.minExpectedFeeUSD;
    
    let blockReason: string | undefined;
    if (!canEnter) {
        if (!evPositive) {
            blockReason = `EV negative: $${expectedNetEVUSD.toFixed(2)} (fees: $${expectedFeeRevenueUSD.toFixed(2)}, costs: $${expectedTotalCostsUSD.toFixed(2)})`;
        } else if (!meetsRegimeThreshold) {
            blockReason = `Fee:cost ratio ${feeCostRatio.toFixed(2)} < ${requiredRatio.toFixed(1)}× required for ${regime}`;
        } else {
            blockReason = `Expected fees $${expectedFeeRevenueUSD.toFixed(2)} < $${EV_CONFIG.minExpectedFeeUSD} minimum`;
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: BOOTSTRAP EV OVERRIDE
    // During bootstrap mode, allow small probe positions even with negative EV
    // ═══════════════════════════════════════════════════════════════════════════
    
    let bootstrapOverrideApplied = false;
    let bootstrapOverrideReason: string | undefined;
    
    if (!canEnter && FEE_BULLY_MODE_ENABLED && BOOTSTRAP_EV_OVERRIDE.enabled) {
        const bootstrapCheck = evaluateBootstrapOverride(inputs, {
            expectedNetEVUSD,
            expectedTotalCostsUSD,
            poolName: pool.name || pool.address.slice(0, 8),
            swapVelocity: (pool.microMetrics?.swapVelocity ?? 0) / 100,
            binVelocity: pool.microMetrics?.binVelocity ?? 0,
            fees24h,
        });
        
        if (bootstrapCheck.override) {
            canEnter = true;
            bootstrapOverrideApplied = true;
            bootstrapOverrideReason = bootstrapCheck.reason;
            blockReason = undefined; // Clear block reason since we're overriding
            
            // Log the override
            logger.info(
                `[EV-GATE] ✅ BOOTSTRAP_OVERRIDE allow reason=${bootstrapCheck.reason} ` +
                `ev=$${expectedNetEVUSD.toFixed(2)} fees=$${expectedFeeRevenueUSD.toFixed(2)} ` +
                `costs=$${expectedTotalCostsUSD.toFixed(2)} finalSize=$${positionSizeUSD.toFixed(0)}`
            );
        } else if (bootstrapCheck.hardBlock) {
            // Bootstrap check found a hard safety block
            blockReason = bootstrapCheck.blockReason;
        }
    }
    
    const result: EVResult = {
        expectedFeeRevenueUSD,
        expectedTotalCostsUSD,
        expectedNetEVUSD,
        
        feeBreakdown: {
            feeIntensityPerHour,
            volumeBasedFees,
            feeDecayAdjustment,
            totalExpectedFees,
        },
        
        costBreakdown: {
            entryFeeUSD,
            exitFeeUSD,
            entrySlippageUSD,
            exitSlippageUSD,
            adverseSelectionUSD,
            totalCostsUSD: expectedTotalCostsUSD,
        },
        
        evPositive,
        meetsRegimeThreshold,
        feeCostRatio,
        requiredRatio,
        
        canEnter,
        blockReason,
        
        bootstrapOverrideApplied,
        bootstrapOverrideReason,
        
        regime,
        positionSizeUSD,
        poolTVL,
        holdTimeHours,
        timestamp: now,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MODULE 1 VALIDATION: Assert no realized PnL contamination
    // ═══════════════════════════════════════════════════════════════════════════
    assertNoRealizedPnLInEV('computeExpectedValue', inputs);
    
    // Validate EV inputs and log warnings for synthetic fee detection
    const validation = validateEVInputs(inputs, result);
    for (const warning of validation.warnings) {
        logger.warn(warning);
    }
    
    return result;
}

/**
 * Quick EV check without full breakdown
 */
export function passesEVGate(inputs: EVInputs): boolean {
    const result = computeExpectedValue(inputs);
    return result.canEnter;
}

/**
 * Get the minimum position size that would be EV-positive for a pool
 */
export function getMinEVPositiveSize(pool: Tier4EnrichedPool, regime: MarketRegime): number {
    // Binary search for minimum size
    let low = 10;
    let high = 5000;
    
    while (high - low > 10) {
        const mid = Math.floor((low + high) / 2);
        const result = computeExpectedValue({ pool, positionSizeUSD: mid, regime });
        
        if (result.canEnter) {
            high = mid;
        } else {
            low = mid;
        }
    }
    
    return high;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 1: EV GATING VALIDATION (TIER 4 CORRECTNESS PASS)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate that EV gating is based on observable market signal, not synthetic data.
 * 
 * CHECKS:
 * 1. Expected fees are NOT just (notional * fee_rate) - must have volume dependency
 * 2. No realized PnL values are used in EV estimation
 * 
 * @returns Validation result with warnings if synthetic patterns detected
 */
export function validateEVInputs(inputs: EVInputs, result: EVResult): {
    valid: boolean;
    warnings: string[];
    isSynthetic: boolean;
} {
    const warnings: string[] = [];
    let isSynthetic = false;
    
    const { pool, positionSizeUSD } = inputs;
    const feeRate = (pool as any).feeRate ?? (pool.binStep ? pool.binStep / 10000 : 0.002);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: Synthetic fee detection
    // If expectedFeeUSD is within ±5% of (notional * fee_rate) without volume,
    // the fee estimate may be synthetic (not based on actual market data)
    // ═══════════════════════════════════════════════════════════════════════════
    const naiveFeeEstimate = positionSizeUSD * feeRate;
    const feeDelta = Math.abs(result.expectedFeeRevenueUSD - naiveFeeEstimate);
    const feeDeviation = naiveFeeEstimate > 0 ? feeDelta / naiveFeeEstimate : 0;
    
    // Check if fee estimate lacks volume dependency
    const hasVolumeSignal = (pool.volume24h ?? 0) > 0 || 
                            (pool.fees24h ?? 0) > 0 ||
                            (pool.microMetrics?.feeIntensity ?? 0) > 0;
    
    if (feeDeviation < SYNTHETIC_FEE_TOLERANCE && !hasVolumeSignal) {
        isSynthetic = true;
        warnings.push(
            `[EV-WARN] Expected fees appear synthetic — ` +
            `expected=$${result.expectedFeeRevenueUSD.toFixed(2)} ≈ naive=$${naiveFeeEstimate.toFixed(2)} ` +
            `(${(feeDeviation * 100).toFixed(1)}% deviation) — verify volume-based source`
        );
        
        // In dev mode, this is a hard error
        if (DEV_MODE) {
            const error = new Error(
                `[EV-GATE-VALIDATION] SYNTHETIC_FEE_DETECTED: ` +
                `Fee estimate lacks volume dependency. Expected deviation >5%, got ${(feeDeviation * 100).toFixed(1)}%`
            );
            logger.error(error.message);
            throw error;
        }
    }
    
    return {
        valid: warnings.length === 0,
        warnings,
        isSynthetic,
    };
}

/**
 * Assert that no realized PnL values are used in EV estimation.
 * This is a compile-time documentation and runtime assertion.
 * 
 * CRITICAL: EV estimation must be FORWARD-LOOKING only.
 * Using realized PnL creates circular/self-fulfilling estimates.
 * 
 * @throws Error in dev mode if violation detected
 */
export function assertNoRealizedPnLInEV(
    _context: string,
    inputs: EVInputs
): void {
    // This function serves as a documented assertion point.
    // The EV computation in computeExpectedValue() uses:
    // - feeIntensity (forward-looking fee rate)
    // - volume24h (historical volume as proxy for future)
    // - fees24h (historical fees as proxy for future)
    // - pool TVL and position size (current state)
    // 
    // It does NOT use:
    // - realizedPnL from previous trades
    // - actual exit prices from closed positions
    // - any backward-looking P&L metrics
    
    // Runtime check for pool object contamination
    const pool = inputs.pool as any;
    if (pool.realizedPnL !== undefined || 
        pool.actualExitPrice !== undefined ||
        pool.closedTradePnL !== undefined) {
        const error = new Error(
            `[EV-GATE-VALIDATION] REALIZED_PNL_CONTAMINATION: ` +
            `Pool object contains realized PnL fields that should not be used in EV estimation`
        );
        
        if (DEV_MODE) {
            logger.error(error.message);
            throw error;
        } else {
            logger.warn(error.message);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP EV OVERRIDE LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

interface BootstrapOverrideInputs {
    expectedNetEVUSD: number;
    expectedTotalCostsUSD: number;
    poolName: string;
    swapVelocity: number;
    binVelocity: number;
    fees24h: number;
}

interface BootstrapOverrideResult {
    /** Should we override the EV block? */
    override: boolean;
    
    /** Is this a hard safety block even during bootstrap? */
    hardBlock: boolean;
    
    /** Reason for override or block */
    reason?: string;
    
    /** Block reason if hardBlock=true */
    blockReason?: string;
}

/**
 * Evaluate if bootstrap override should be applied.
 * 
 * ALLOWS entry if:
 * 1. Bootstrap mode is active
 * 2. Position size <= 2.5% equity (probe size)
 * 3. Pool is whitelisted OR has some activity signals
 * 4. Costs are not insane (< $10)
 * 5. EV is not catastrophically negative (> -$5)
 * 6. Pool is not dead (has some velocity/fees)
 * 
 * BLOCKS even during bootstrap if:
 * - Costs > $10 (insane costs)
 * - Pool is dead (zero velocity AND zero fees)
 * - EV < -$5 (catastrophic)
 */
function evaluateBootstrapOverride(
    inputs: EVInputs,
    metrics: BootstrapOverrideInputs
): BootstrapOverrideResult {
    const { pool, positionSizeUSD, totalEquity } = inputs;
    const { expectedNetEVUSD, expectedTotalCostsUSD, poolName, swapVelocity, binVelocity, fees24h } = metrics;
    
    // Check 1: Is bootstrap mode active?
    if (!isBootstrapMode()) {
        return { override: false, hardBlock: false };
    }
    
    const cyclesRemaining = getBootstrapCyclesRemaining();
    
    // Check 2: Safety - catastrophic EV
    if (expectedNetEVUSD < BOOTSTRAP_EV_OVERRIDE.catastrophicEVThreshold) {
        return {
            override: false,
            hardBlock: true,
            blockReason: `CATASTROPHIC_EV: $${expectedNetEVUSD.toFixed(2)} < $${BOOTSTRAP_EV_OVERRIDE.catastrophicEVThreshold} threshold`,
        };
    }
    
    // Check 3: Safety - insane costs
    if (expectedTotalCostsUSD > BOOTSTRAP_EV_OVERRIDE.maxCostUSD) {
        return {
            override: false,
            hardBlock: true,
            blockReason: `COST_INSANE: $${expectedTotalCostsUSD.toFixed(2)} > $${BOOTSTRAP_EV_OVERRIDE.maxCostUSD} max`,
        };
    }
    
    // Check 4: Safety - dead pool
    const isDeadPool = (
        swapVelocity < BOOTSTRAP_EV_OVERRIDE.deadPoolThreshold.minSwapVelocity &&
        binVelocity < BOOTSTRAP_EV_OVERRIDE.deadPoolThreshold.minBinVelocity &&
        fees24h < BOOTSTRAP_EV_OVERRIDE.deadPoolThreshold.minFees24h
    );
    
    if (isDeadPool) {
        return {
            override: false,
            hardBlock: true,
            blockReason: `DEAD_POOL: swapVel=${swapVelocity.toFixed(4)} binVel=${binVelocity.toFixed(4)} fees24h=$${fees24h.toFixed(2)}`,
        };
    }
    
    // Check 5: Position size must be probe-sized (use already computed finalSize, don't clamp)
    // We verify the size is reasonable (probe entry) but do NOT reduce it.
    // The sizing engine already computed the optimal bootstrap size (e.g., 2.5% = $246).
    // Reducing it would worsen EV since costs are fixed.
    const maxSizeByPct = (totalEquity ?? positionSizeUSD * 10) * BOOTSTRAP_EV_OVERRIDE.maxBootstrapSizePct;
    
    if (positionSizeUSD > maxSizeByPct) {
        // Size too large for bootstrap override - not a hard block, just don't override
        logger.debug(
            `[EV-GATE] Bootstrap override rejected: size $${positionSizeUSD.toFixed(0)} > ${(BOOTSTRAP_EV_OVERRIDE.maxBootstrapSizePct * 100).toFixed(1)}% equity ($${maxSizeByPct.toFixed(0)})`
        );
        return { override: false, hardBlock: false };
    }
    
    // Check 6: Pool eligibility (whitelisted OR has activity)
    const poolSymbol = pool.name || (pool as any).symbol || '';
    const isWhitelisted = BOOTSTRAP_EV_OVERRIDE.whitelistedPairs.some(
        pair => poolSymbol.toUpperCase().includes(pair.toUpperCase().replace(/[/-]/g, ''))
    );
    
    const hasActivitySignals = (
        swapVelocity >= BOOTSTRAP_EV_OVERRIDE.deadPoolThreshold.minSwapVelocity ||
        binVelocity >= BOOTSTRAP_EV_OVERRIDE.deadPoolThreshold.minBinVelocity ||
        fees24h >= BOOTSTRAP_EV_OVERRIDE.deadPoolThreshold.minFees24h
    );
    
    if (!isWhitelisted && !hasActivitySignals) {
        // Pool not eligible for bootstrap override
        return { override: false, hardBlock: false };
    }
    
    // All checks passed - allow override
    const reason = isWhitelisted 
        ? `probe_entry_whitelist cyclesRemaining=${cyclesRemaining}`
        : `probe_entry_activity cyclesRemaining=${cyclesRemaining}`;
    
    return {
        override: true,
        hardBlock: false,
        reason,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log EV gate DEBUG info — ONLY when Tier-4 score passes AND entry is rejected
 * Format: [EV-GATE-DEBUG] with full component breakdown
 */
export function logEVGateDebug(
    poolName: string, 
    pool: Tier4EnrichedPool,
    result: EVResult,
    tier4ScorePassed: boolean
): void {
    // Only log debug info when Tier-4 passes but EV rejects
    if (!tier4ScorePassed || result.canEnter) {
        return;
    }
    
    const feeIntensity = (pool.microMetrics?.feeIntensity ?? 0) / 100;
    const volumeInRangeUSD = pool.volume24h ?? 0;
    
    logger.warn(
        `[EV-GATE-DEBUG]\n` +
        `  pool=${poolName}\n` +
        `  feeIntensity=${feeIntensity.toFixed(6)}\n` +
        `  volumeInRangeUSD=$${volumeInRangeUSD.toFixed(2)}\n` +
        `  expectedFeeUSD=$${result.expectedFeeRevenueUSD.toFixed(4)}\n` +
        `  expectedEntryFeesUSD=$${result.costBreakdown.entryFeeUSD.toFixed(4)}\n` +
        `  expectedExitFeesUSD=$${result.costBreakdown.exitFeeUSD.toFixed(4)}\n` +
        `  expectedSlippageUSD=$${(result.costBreakdown.entrySlippageUSD + result.costBreakdown.exitSlippageUSD).toFixed(4)}\n` +
        `  adverseSelectionPenaltyUSD=$${result.costBreakdown.adverseSelectionUSD.toFixed(4)}\n` +
        `  expectedNetEVUSD=$${result.expectedNetEVUSD.toFixed(4)}\n` +
        `  regime=${result.regime}`
    );
}

/**
 * Log EV gate evaluation with full breakdown
 * Format: [EV-GATE] pool=XXX decision=PASS/BLOCK ev=$X.XX fees=$X.XX costs=$X.XX ratio=X.XX
 */
export function logEVGate(poolName: string, result: EVResult): void {
    // Skip logging if bootstrap override already logged this
    if (result.bootstrapOverrideApplied) {
        // Already logged in computeExpectedValue
        return;
    }
    
    const decision = result.canEnter ? 'PASS' : 'BLOCK';
    const emoji = result.canEnter ? '✅' : '❌';
    
    logger.info(
        `[EV-GATE] ${emoji} ${poolName} decision=${decision} ` +
        `ev=$${result.expectedNetEVUSD.toFixed(2)} ` +
        `fees=$${result.expectedFeeRevenueUSD.toFixed(2)} ` +
        `costs=$${result.expectedTotalCostsUSD.toFixed(2)} ` +
        `ratio=${result.feeCostRatio.toFixed(2)}/${result.requiredRatio.toFixed(1)}× ` +
        `regime=${result.regime}`
    );
    
    if (!result.canEnter) {
        logger.info(`[EV-GATE] └── Reason: ${result.blockReason}`);
    }
    
    // Detailed breakdown at debug level
    logger.debug(
        `[EV-GATE] └── Fees: intensity=$${result.feeBreakdown.feeIntensityPerHour.toFixed(2)}/h ` +
        `volume=$${result.feeBreakdown.volumeBasedFees.toFixed(2)} ` +
        `decay=${result.feeBreakdown.feeDecayAdjustment.toFixed(3)}`
    );
    logger.debug(
        `[EV-GATE] └── Costs: entry=$${result.costBreakdown.entryFeeUSD.toFixed(2)} ` +
        `exit=$${result.costBreakdown.exitFeeUSD.toFixed(2)} ` +
        `slip=$${(result.costBreakdown.entrySlippageUSD + result.costBreakdown.exitSlippageUSD).toFixed(2)} ` +
        `adv=$${result.costBreakdown.adverseSelectionUSD.toFixed(2)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// EV_CONFIG is already exported at declaration

