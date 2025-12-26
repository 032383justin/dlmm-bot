/**
 * Fee Velocity Exit Sensitivity — Dynamic Exit Timing Based on Fee Performance
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Increase realized fees per position by dynamically adapting exit 
 * sensitivity based on fee velocity, while preserving all existing safety logic.
 * 
 * KEY INVARIANTS (NEVER VIOLATED):
 *   - Entry logic unchanged
 *   - Bin width logic unchanged
 *   - Capital allocation unchanged
 *   - Global risk limits unchanged
 *   - Emergency exits never delayed
 * 
 * FEE VELOCITY FORMULA:
 *   feeVelocity = (currentAccruedFees - feesAtLastCheckpoint) / elapsedMinutes
 *   Checkpoint interval: 10 minutes
 *   Clamped to [0, +∞)
 * 
 * EXPECTED FEE BASELINE:
 *   expectedFeeVelocity = positionSize * 0.0004 / 60
 *   (Conservative, deterministic constant)
 * 
 * EXIT SENSITIVITY MULTIPLIER:
 *   feeHarvestMultiplier = clamp(
 *     1.0 - (feeVelocity / expectedFeeVelocity - 1.0) * 0.4,
 *     0.70,
 *     1.10
 *   )
 * 
 * INTERPRETATION:
 *   - Strong fee velocity → hold longer (multiplier < 1.0)
 *   - Weak fee velocity → exit earlier (multiplier > 1.0)
 *   - Bounds prevent runaway holding
 * 
 * SAFETY OVERRIDES (MANDATORY - force multiplier = 1.0):
 *   - Migration slope breach
 *   - Volatility breach
 *   - CHAOS regime
 *   - Market crash
 *   - Bin width forced conservative
 * 
 * RATE LIMITER:
 *   MAX_EXIT_DELTA_PER_CYCLE = 0.05
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fee velocity configuration
 */
const FEE_VELOCITY_CONFIG = {
    /**
     * Checkpoint interval (ms)
     * Fee velocity is computed over this rolling window
     */
    checkpointIntervalMs: 10 * 60 * 1000, // 10 minutes
    
    /**
     * Expected fee velocity constant
     * positionSize * this / 60 = expected fee per minute
     * 0.0004 = 0.04% per hour expected fee yield
     */
    expectedFeeRatePerHour: 0.0004,
    
    /**
     * Multiplier adjustment slope
     * How aggressively to adjust based on fee performance
     */
    adjustmentSlope: 0.4,
    
    /**
     * Minimum multiplier (hold longer)
     */
    minMultiplier: 0.70,
    
    /**
     * Maximum multiplier (exit earlier)
     */
    maxMultiplier: 1.10,
    
    /**
     * Rate limiter: maximum change per cycle
     */
    maxDeltaPerCycle: 0.05,
    
    /**
     * Migration slope threshold for safety override
     */
    migrationSlopeThreshold: 0.002,
    
    /**
     * Volatility threshold for safety override (price movement % per hour)
     */
    volatilityThreshold: 0.5,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-position fee velocity tracking state
 */
interface PositionFeeState {
    tradeId: string;
    positionSizeUsd: number;
    
    // Checkpoint tracking
    lastCheckpointTs: number;
    feesAtLastCheckpoint: number;
    
    // Computed values
    currentFeeVelocity: number;       // Fees per minute
    expectedFeeVelocity: number;      // Expected fees per minute
    
    // Multiplier state
    lastMultiplier: number;
    currentMultiplier: number;
    
    // Safety state
    safetyOverrideActive: boolean;
    safetyOverrideReason: string | null;
    
    // Metadata
    createdAt: number;
    lastUpdatedAt: number;
}

/**
 * Inputs for fee velocity computation
 */
export interface FeeVelocityInputs {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    positionSizeUsd: number;
    currentFeesAccruedUsd: number;
    
    // Safety override conditions
    regime: string;
    migrationSlope: number;
    volatilityPctPerHour: number;
    isMarketCrash: boolean;
    isBinWidthForcedConservative: boolean;
}

/**
 * Result of fee velocity computation
 */
export interface FeeVelocityResult {
    tradeId: string;
    
    // Core output
    feeHarvestMultiplier: number;     // 0.70 - 1.10
    
    // Velocity metrics
    feeVelocity: number;              // Fees per minute (clamped >= 0)
    expectedFeeVelocity: number;      // Expected fees per minute
    
    // Status
    holdingBias: boolean;             // true if multiplier < 1.0 (holding longer)
    previousMultiplier: number | null;
    rateLimited: boolean;
    
    // Safety
    safetyOverrideActive: boolean;
    safetyOverrideReason: string | null;
    
    // Metadata
    checkpointAgeMs: number;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-position fee velocity state
 */
const positionFeeState = new Map<string, PositionFeeState>();

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp value to range
 */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Check if safety override conditions are met
 */
function checkSafetyOverrides(inputs: FeeVelocityInputs): {
    override: boolean;
    reason: string | null;
} {
    // CHAOS regime → force 1.0
    if (inputs.regime === 'CHAOS') {
        return { override: true, reason: 'CHAOS_REGIME' };
    }
    
    // Migration slope breach → force 1.0
    if (Math.abs(inputs.migrationSlope) > FEE_VELOCITY_CONFIG.migrationSlopeThreshold) {
        return { override: true, reason: 'MIGRATION_BREACH' };
    }
    
    // Volatility breach → force 1.0
    if (inputs.volatilityPctPerHour > FEE_VELOCITY_CONFIG.volatilityThreshold) {
        return { override: true, reason: 'VOLATILITY_BREACH' };
    }
    
    // Market crash → force 1.0
    if (inputs.isMarketCrash) {
        return { override: true, reason: 'MARKET_CRASH' };
    }
    
    // Bin width forced conservative → force 1.0
    if (inputs.isBinWidthForcedConservative) {
        return { override: true, reason: 'BIN_WIDTH_FORCED' };
    }
    
    return { override: false, reason: null };
}

/**
 * Compute expected fee velocity from position size
 * expectedFeeVelocity = positionSize * 0.0004 / 60
 */
function computeExpectedFeeVelocity(positionSizeUsd: number): number {
    return (positionSizeUsd * FEE_VELOCITY_CONFIG.expectedFeeRatePerHour) / 60;
}

/**
 * Compute fee harvest multiplier from fee velocity ratio
 * 
 * feeHarvestMultiplier = clamp(
 *   1.0 - (feeVelocity / expectedFeeVelocity - 1.0) * 0.4,
 *   0.70,
 *   1.10
 * )
 */
function computeRawMultiplier(feeVelocity: number, expectedFeeVelocity: number): number {
    if (expectedFeeVelocity <= 0) {
        return 1.0; // No expected fees → neutral multiplier
    }
    
    const velocityRatio = feeVelocity / expectedFeeVelocity;
    const rawMultiplier = 1.0 - (velocityRatio - 1.0) * FEE_VELOCITY_CONFIG.adjustmentSlope;
    
    return clamp(rawMultiplier, FEE_VELOCITY_CONFIG.minMultiplier, FEE_VELOCITY_CONFIG.maxMultiplier);
}

/**
 * Apply rate limiter to multiplier change
 */
function applyRateLimiter(
    proposedMultiplier: number,
    previousMultiplier: number | null
): { finalMultiplier: number; rateLimited: boolean } {
    if (previousMultiplier === null) {
        return { finalMultiplier: proposedMultiplier, rateLimited: false };
    }
    
    const delta = proposedMultiplier - previousMultiplier;
    const maxDelta = FEE_VELOCITY_CONFIG.maxDeltaPerCycle;
    
    if (Math.abs(delta) > maxDelta) {
        const limitedMultiplier = previousMultiplier + Math.sign(delta) * maxDelta;
        return { 
            finalMultiplier: clamp(limitedMultiplier, FEE_VELOCITY_CONFIG.minMultiplier, FEE_VELOCITY_CONFIG.maxMultiplier), 
            rateLimited: true 
        };
    }
    
    return { finalMultiplier: proposedMultiplier, rateLimited: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute fee velocity exit sensitivity multiplier for a position
 * 
 * This is the main entry point, called once per position per scan cycle.
 * Returns a multiplier to be applied to exit sensitivity thresholds.
 * 
 * @param inputs - Fee velocity computation inputs
 * @returns Fee velocity result with multiplier
 */
export function computeFeeVelocitySensitivity(inputs: FeeVelocityInputs): FeeVelocityResult {
    const now = Date.now();
    
    // Get or create position state
    let state = positionFeeState.get(inputs.tradeId);
    if (!state) {
        state = {
            tradeId: inputs.tradeId,
            positionSizeUsd: inputs.positionSizeUsd,
            lastCheckpointTs: now,
            feesAtLastCheckpoint: inputs.currentFeesAccruedUsd,
            currentFeeVelocity: 0,
            expectedFeeVelocity: computeExpectedFeeVelocity(inputs.positionSizeUsd),
            lastMultiplier: 1.0,
            currentMultiplier: 1.0,
            safetyOverrideActive: false,
            safetyOverrideReason: null,
            createdAt: now,
            lastUpdatedAt: now,
        };
        positionFeeState.set(inputs.tradeId, state);
    }
    
    // Check safety overrides
    const safetyCheck = checkSafetyOverrides(inputs);
    if (safetyCheck.override) {
        state.safetyOverrideActive = true;
        state.safetyOverrideReason = safetyCheck.reason;
        state.currentMultiplier = 1.0;
        state.lastUpdatedAt = now;
        
        const result: FeeVelocityResult = {
            tradeId: inputs.tradeId,
            feeHarvestMultiplier: 1.0,
            feeVelocity: state.currentFeeVelocity,
            expectedFeeVelocity: state.expectedFeeVelocity,
            holdingBias: false,
            previousMultiplier: state.lastMultiplier,
            rateLimited: false,
            safetyOverrideActive: true,
            safetyOverrideReason: safetyCheck.reason,
            checkpointAgeMs: now - state.lastCheckpointTs,
            timestamp: now,
        };
        
        // Log result
        logFeeVelocity(inputs, result);
        
        return result;
    }
    
    // Clear safety override
    state.safetyOverrideActive = false;
    state.safetyOverrideReason = null;
    
    // Check if checkpoint interval has passed
    const checkpointAgeMs = now - state.lastCheckpointTs;
    
    if (checkpointAgeMs >= FEE_VELOCITY_CONFIG.checkpointIntervalMs) {
        // Compute fee velocity over the checkpoint period
        const feesDelta = inputs.currentFeesAccruedUsd - state.feesAtLastCheckpoint;
        const elapsedMinutes = checkpointAgeMs / (60 * 1000);
        
        // Fee velocity = fees accrued per minute (clamped to >= 0)
        state.currentFeeVelocity = Math.max(0, feesDelta / elapsedMinutes);
        
        // Update checkpoint
        state.lastCheckpointTs = now;
        state.feesAtLastCheckpoint = inputs.currentFeesAccruedUsd;
    }
    
    // Update expected fee velocity (position size may have changed)
    state.expectedFeeVelocity = computeExpectedFeeVelocity(inputs.positionSizeUsd);
    
    // Compute raw multiplier
    const rawMultiplier = computeRawMultiplier(
        state.currentFeeVelocity,
        state.expectedFeeVelocity
    );
    
    // Apply rate limiter
    const previousMultiplier = state.lastMultiplier !== 1.0 ? state.lastMultiplier : null;
    const { finalMultiplier, rateLimited } = applyRateLimiter(rawMultiplier, previousMultiplier);
    
    // Update state
    state.lastMultiplier = state.currentMultiplier;
    state.currentMultiplier = finalMultiplier;
    state.lastUpdatedAt = now;
    
    // Holding bias is true if multiplier < 1.0 (we're holding longer)
    const holdingBias = finalMultiplier < 1.0;
    
    const result: FeeVelocityResult = {
        tradeId: inputs.tradeId,
        feeHarvestMultiplier: Math.round(finalMultiplier * 1000) / 1000, // 3 decimal places
        feeVelocity: Math.round(state.currentFeeVelocity * 10000) / 10000,
        expectedFeeVelocity: Math.round(state.expectedFeeVelocity * 10000) / 10000,
        holdingBias,
        previousMultiplier: previousMultiplier,
        rateLimited,
        safetyOverrideActive: false,
        safetyOverrideReason: null,
        checkpointAgeMs,
        timestamp: now,
    };
    
    // Log result
    logFeeVelocity(inputs, result);
    
    return result;
}

/**
 * Get fee harvest multiplier for a position
 * Returns 1.0 if position not tracked
 */
export function getFeeHarvestMultiplier(tradeId: string): number {
    const state = positionFeeState.get(tradeId);
    if (!state) return 1.0;
    return state.currentMultiplier;
}

/**
 * Check if position has holding bias (multiplier < 1.0)
 */
export function hasHoldingBias(tradeId: string): boolean {
    const state = positionFeeState.get(tradeId);
    if (!state) return false;
    return state.currentMultiplier < 1.0;
}

/**
 * Clear fee velocity state for a position (on exit)
 */
export function clearFeeVelocityState(tradeId: string): void {
    positionFeeState.delete(tradeId);
}

/**
 * Clear all fee velocity state (for testing/reset)
 */
export function clearAllFeeVelocityState(): void {
    positionFeeState.clear();
    logger.info('[FEE-HARVEST] State cleared');
}

/**
 * Get fee velocity summary for all positions
 */
export function getFeeVelocitySummary(): {
    trackedPositions: number;
    avgMultiplier: number;
    holdingBiasCount: number;
    safetyOverrideCount: number;
    positions: Array<{ tradeId: string; multiplier: number; feeVelocity: number; holdingBias: boolean }>;
} {
    const positions: Array<{ tradeId: string; multiplier: number; feeVelocity: number; holdingBias: boolean }> = [];
    let totalMultiplier = 0;
    let holdingBiasCount = 0;
    let safetyOverrideCount = 0;
    
    for (const [tradeId, state] of positionFeeState) {
        positions.push({
            tradeId,
            multiplier: state.currentMultiplier,
            feeVelocity: state.currentFeeVelocity,
            holdingBias: state.currentMultiplier < 1.0,
        });
        totalMultiplier += state.currentMultiplier;
        if (state.currentMultiplier < 1.0) holdingBiasCount++;
        if (state.safetyOverrideActive) safetyOverrideCount++;
    }
    
    return {
        trackedPositions: positionFeeState.size,
        avgMultiplier: positionFeeState.size > 0 ? totalMultiplier / positionFeeState.size : 1.0,
        holdingBiasCount,
        safetyOverrideCount,
        positions,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log fee velocity result (exactly one INFO log per position per cycle)
 */
function logFeeVelocity(inputs: FeeVelocityInputs, result: FeeVelocityResult): void {
    const safetyNote = result.safetyOverrideActive ? ` [SAFETY:${result.safetyOverrideReason}]` : '';
    
    logger.info(
        `[FEE-HARVEST] ` +
        `trade=${inputs.tradeId.slice(0, 8)}... ` +
        `feeVel=${result.feeVelocity.toFixed(4)} ` +
        `expected=${result.expectedFeeVelocity.toFixed(4)} ` +
        `mult=${result.feeHarvestMultiplier.toFixed(3)} ` +
        `prev=${result.previousMultiplier?.toFixed(3) ?? 'null'} ` +
        `holdingBias=${result.holdingBias}${safetyNote}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS — CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const FEE_VELOCITY_SENSITIVITY_CONFIG = FEE_VELOCITY_CONFIG;

