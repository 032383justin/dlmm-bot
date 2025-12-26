/**
 * Adaptive Bin Width — Per-Pool Oscillation-Driven Geometry Optimization
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Increase fee velocity without increasing tail risk by making bin width
 * adaptive per pool, driven by observed oscillation / crossing behavior.
 * 
 * ARCHITECTURE:
 * - Computes oscillation score from binVelRaw, swapVelRaw, entropy
 * - Maps oscillation to bin width multiplier (high osc → tighter, low osc → wider)
 * - Enforces hard safety overrides under directional risk
 * - Rate-limits changes to prevent abrupt width jumps
 * - Applies at position entry / rebalance only (not passive holding)
 * 
 * SAFETY OVERRIDES (NON-NEGOTIABLE):
 * - abs(migrationSlope) > 0.002 → force conservative
 * - priceMovementPctPerHour > 0.5 → force conservative
 * - insufficientSamples (< 3) → force conservative
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { Tier4EnrichedPool } from '../scoring/microstructureScoring';
import { getPoolHistory } from '../services/dlmmTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — DO NOT MODIFY WITHOUT APPROVAL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reference constants for oscillation score normalization
 */
const BIN_VEL_REF = 0.60;      // binVelocity reference (0-100 normalized → /100)
const SWAP_VEL_REF = 0.06;     // swapVelocity reference (0-100 normalized → /100)
const ENTROPY_REF = 0.60;      // entropy reference (0-1)

/**
 * Bin width multiplier constants
 */
const BASE_WIDTH_MULT = 0.70;  // Base multiplier
const MIN_WIDTH_MULT = 0.45;   // Minimum (tightest) multiplier
const MAX_WIDTH_MULT = 0.95;   // Maximum (widest) multiplier

/**
 * Rate limiter constant
 */
const MAX_WIDTH_DELTA_PER_CYCLE = 0.05;

/**
 * Safety override thresholds
 */
const SAFETY_THRESHOLDS = {
    maxMigrationSlopeMagnitude: 0.002,  // 0.2%
    maxPriceMovementPctPerHour: 0.5,    // 50%
    minSampleCount: 3,                   // Minimum telemetry samples
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE — PER-POOL WIDTH HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-pool previous bin width multiplier for rate limiting
 */
const prevWidthMultiplierMap = new Map<string, number>();

/**
 * Per-pool sample count tracking
 */
const poolSampleCountMap = new Map<string, number>();

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Input signals for adaptive bin width calculation
 */
export interface AdaptiveBinWidthInputs {
    poolAddress: string;
    poolName: string;
    
    // Core telemetry signals (already available)
    binVelRaw: number;          // binVelocity 0-100 normalized
    swapVelRaw: number;         // swapVelocity 0-100 normalized
    entropy: number;            // poolEntropy 0-1
    migrationSlope: number;     // liquiditySlope (can be negative)
    priceMovementPctPerHour: number;  // Price movement % per hour
    
    // Window validity
    sampleCount: number;        // Number of telemetry samples available
}

/**
 * Result of adaptive bin width calculation
 */
export interface AdaptiveBinWidthResult {
    poolAddress: string;
    poolName: string;
    
    // Oscillation analysis
    oscScore: number;           // 0-1 oscillation score
    
    // Input signals (for logging)
    binVel: number;
    swapVel: number;
    entropy: number;
    slope: number;
    pmh: number;                // priceMovementPctPerHour
    
    // Width output
    widthMult: number;          // Final bin width multiplier
    prev: number | null;        // Previous multiplier (if any)
    
    // Safety state
    forced: boolean;            // Was conservative forced?
    forceReason: string | null; // Reason for forcing if applicable
    
    // Metadata
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp value to 0-1 range
 */
function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/**
 * Clamp value to arbitrary range
 */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Compute oscillation score from telemetry signals
 * 
 * oscScore = 
 *   0.50 * clamp01(binVelRaw / BIN_VEL_REF)
 * + 0.30 * clamp01(swapVelRaw / SWAP_VEL_REF)
 * + 0.20 * clamp01(entropy / ENTROPY_REF)
 */
function computeOscillationScore(
    binVelRaw: number,
    swapVelRaw: number,
    entropy: number
): number {
    // Normalize inputs (binVel and swapVel come in 0-100, need 0-1)
    const binVelNorm = binVelRaw / 100;
    const swapVelNorm = swapVelRaw / 100;
    
    // Compute weighted oscillation score
    const oscScore = 
        0.50 * clamp01(binVelNorm / BIN_VEL_REF) +
        0.30 * clamp01(swapVelNorm / SWAP_VEL_REF) +
        0.20 * clamp01(entropy / ENTROPY_REF);
    
    return clamp01(oscScore);
}

/**
 * Map oscillation score to bin width multiplier
 * 
 * widthMult = clamp(BASE_WIDTH_MULT * (1.15 - 0.55 * oscScore), MIN, MAX)
 * 
 * High oscillation → tighter bins (lower multiplier)
 * Low oscillation → wider bins (higher multiplier)
 */
function computeRawWidthMultiplier(oscScore: number): number {
    const rawMult = BASE_WIDTH_MULT * (1.15 - 0.55 * oscScore);
    return clamp(rawMult, MIN_WIDTH_MULT, MAX_WIDTH_MULT);
}

/**
 * Apply rate limiting to prevent abrupt width changes
 */
function applyRateLimiter(
    poolAddress: string,
    proposedWidth: number
): { finalWidth: number; prevWidth: number | null } {
    const prevWidth = prevWidthMultiplierMap.get(poolAddress);
    
    if (prevWidth === undefined) {
        // First time — no rate limiting
        return { finalWidth: proposedWidth, prevWidth: null };
    }
    
    // Apply rate limiter
    const minAllowed = prevWidth - MAX_WIDTH_DELTA_PER_CYCLE;
    const maxAllowed = prevWidth + MAX_WIDTH_DELTA_PER_CYCLE;
    const finalWidth = clamp(proposedWidth, minAllowed, maxAllowed);
    
    return { finalWidth, prevWidth };
}

/**
 * Check if safety override conditions are met
 */
function checkSafetyOverrides(inputs: AdaptiveBinWidthInputs): {
    shouldForce: boolean;
    reason: string | null;
} {
    // Check migration slope
    if (Math.abs(inputs.migrationSlope) > SAFETY_THRESHOLDS.maxMigrationSlopeMagnitude) {
        return {
            shouldForce: true,
            reason: `migrationSlope=${inputs.migrationSlope.toFixed(4)} > ${SAFETY_THRESHOLDS.maxMigrationSlopeMagnitude}`,
        };
    }
    
    // Check price movement
    if (inputs.priceMovementPctPerHour > SAFETY_THRESHOLDS.maxPriceMovementPctPerHour) {
        return {
            shouldForce: true,
            reason: `pmh=${inputs.priceMovementPctPerHour.toFixed(4)} > ${SAFETY_THRESHOLDS.maxPriceMovementPctPerHour}`,
        };
    }
    
    // Check sample count
    if (inputs.sampleCount < SAFETY_THRESHOLDS.minSampleCount) {
        return {
            shouldForce: true,
            reason: `samples=${inputs.sampleCount} < ${SAFETY_THRESHOLDS.minSampleCount}`,
        };
    }
    
    return { shouldForce: false, reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTION — COMPUTE ADAPTIVE BIN WIDTH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute adaptive bin width multiplier for a pool
 * 
 * Called every scan cycle for active/eligible pools
 * Applies at position entry / rebalance only
 */
export function computeAdaptiveBinWidth(inputs: AdaptiveBinWidthInputs): AdaptiveBinWidthResult {
    const now = Date.now();
    
    // Check safety overrides first
    const safetyCheck = checkSafetyOverrides(inputs);
    
    let widthMult: number;
    let oscScore: number;
    let forced = false;
    let forceReason: string | null = null;
    
    if (safetyCheck.shouldForce) {
        // Force conservative width
        widthMult = BASE_WIDTH_MULT;
        oscScore = 0;  // N/A when forced
        forced = true;
        forceReason = safetyCheck.reason;
    } else {
        // Compute oscillation score
        oscScore = computeOscillationScore(
            inputs.binVelRaw,
            inputs.swapVelRaw,
            inputs.entropy
        );
        
        // Compute raw width multiplier
        const rawWidth = computeRawWidthMultiplier(oscScore);
        
        // Apply rate limiter
        const rateLimited = applyRateLimiter(inputs.poolAddress, rawWidth);
        widthMult = rateLimited.finalWidth;
    }
    
    // Get previous width for logging
    const prevWidth = prevWidthMultiplierMap.get(inputs.poolAddress) ?? null;
    
    // Update state for next cycle
    prevWidthMultiplierMap.set(inputs.poolAddress, widthMult);
    poolSampleCountMap.set(inputs.poolAddress, inputs.sampleCount);
    
    // Build result
    const result: AdaptiveBinWidthResult = {
        poolAddress: inputs.poolAddress,
        poolName: inputs.poolName,
        oscScore,
        binVel: inputs.binVelRaw,
        swapVel: inputs.swapVelRaw,
        entropy: inputs.entropy,
        slope: inputs.migrationSlope,
        pmh: inputs.priceMovementPctPerHour,
        widthMult,
        prev: prevWidth,
        forced,
        forceReason,
        timestamp: now,
    };
    
    // Log structured output (INFO level)
    logBinWidthResult(result);
    
    return result;
}

/**
 * Structured log output for bin width computation
 */
function logBinWidthResult(result: AdaptiveBinWidthResult): void {
    logger.info(
        `[BIN-WIDTH] ` +
        `pool=${result.poolAddress.slice(0, 8)}... ` +
        `oscScore=${result.oscScore.toFixed(3)} ` +
        `binVel=${result.binVel.toFixed(2)} ` +
        `swapVel=${result.swapVel.toFixed(2)} ` +
        `entropy=${result.entropy.toFixed(4)} ` +
        `slope=${result.slope.toFixed(6)} ` +
        `pmh=${result.pmh.toFixed(4)} ` +
        `widthMult=${result.widthMult.toFixed(3)} ` +
        `prev=${result.prev?.toFixed(3) ?? 'null'} ` +
        `forced=${result.forced}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION HELPERS — FOR USE AT ENTRY/REBALANCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute adaptive bin width for a Tier4EnrichedPool
 * 
 * Convenience wrapper that extracts signals from pool object
 */
export function computeAdaptiveBinWidthForPool(
    pool: Tier4EnrichedPool,
    priceMovementPctPerHour: number = 0
): AdaptiveBinWidthResult {
    // Get telemetry sample count
    const history = getPoolHistory(pool.address);
    const sampleCount = history.length;
    
    // Extract signals from pool
    const inputs: AdaptiveBinWidthInputs = {
        poolAddress: pool.address,
        poolName: pool.name,
        binVelRaw: pool.microMetrics?.binVelocity ?? 0,
        swapVelRaw: pool.microMetrics?.swapVelocity ?? 0,
        entropy: pool.microMetrics?.poolEntropy ?? 0,
        migrationSlope: pool.liquiditySlope ?? 0,
        priceMovementPctPerHour,
        sampleCount,
    };
    
    return computeAdaptiveBinWidth(inputs);
}

/**
 * Get the current adaptive bin width multiplier for a pool
 * Returns BASE_WIDTH_MULT if not computed yet
 */
export function getPoolBinWidthMultiplier(poolAddress: string): number {
    return prevWidthMultiplierMap.get(poolAddress) ?? BASE_WIDTH_MULT;
}

/**
 * Apply adaptive bin width to a base bin count
 * 
 * @param baseBinCount - The base number of bins (from tier4 config)
 * @param poolAddress - The pool address
 * @returns Adjusted bin count
 */
export function applyAdaptiveBinWidth(baseBinCount: number, poolAddress: string): number {
    const multiplier = getPoolBinWidthMultiplier(poolAddress);
    const adjustedBins = Math.round(baseBinCount * multiplier);
    
    // Ensure at least 3 bins and at most 2x base
    const minBins = 3;
    const maxBins = Math.round(baseBinCount * 2);
    
    return clamp(adjustedBins, minBins, maxBins);
}

/**
 * Clear adaptive bin width state for a pool (on position close)
 */
export function clearPoolBinWidthState(poolAddress: string): void {
    prevWidthMultiplierMap.delete(poolAddress);
    poolSampleCountMap.delete(poolAddress);
}

/**
 * Clear all adaptive bin width state (for testing/reset)
 */
export function clearAllBinWidthState(): void {
    prevWidthMultiplierMap.clear();
    poolSampleCountMap.clear();
    logger.info('[BIN-WIDTH] State cleared');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS — FOR OBSERVABILITY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get summary of all tracked pools' bin width state
 */
export function getBinWidthSummary(): {
    trackedPools: number;
    poolStates: Array<{ address: string; widthMult: number; samples: number }>;
    avgWidthMult: number;
} {
    const poolStates: Array<{ address: string; widthMult: number; samples: number }> = [];
    
    for (const [address, widthMult] of prevWidthMultiplierMap) {
        const samples = poolSampleCountMap.get(address) ?? 0;
        poolStates.push({ address, widthMult, samples });
    }
    
    const avgWidthMult = poolStates.length > 0
        ? poolStates.reduce((sum, p) => sum + p.widthMult, 0) / poolStates.length
        : BASE_WIDTH_MULT;
    
    return {
        trackedPools: poolStates.length,
        poolStates,
        avgWidthMult,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS — CONSTANTS FOR EXTERNAL REFERENCE
// ═══════════════════════════════════════════════════════════════════════════════

export const ADAPTIVE_BIN_WIDTH_CONFIG = {
    BIN_VEL_REF,
    SWAP_VEL_REF,
    ENTROPY_REF,
    BASE_WIDTH_MULT,
    MIN_WIDTH_MULT,
    MAX_WIDTH_MULT,
    MAX_WIDTH_DELTA_PER_CYCLE,
    SAFETY_THRESHOLDS,
};

