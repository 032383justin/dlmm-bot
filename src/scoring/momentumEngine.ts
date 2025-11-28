/**
 * Momentum Engine - Tier 4 Slope-Based Precognition System
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Implements first-derivative slope calculations for:
 * - velocity_slope (bin movement acceleration)
 * - liquidity_slope (liquidity flow trend)
 * - entropy_slope (market health trend)
 * 
 * These slopes are used in the Tier 4 slope multiplier:
 * 
 * slopeMultiplier = 1.0
 *   + clamp(velocity_slope / 50, -0.10, +0.10)
 *   + clamp(liquidity_slope / 50, -0.10, +0.15)
 *   + clamp(entropy_slope / 50, -0.05, +0.10)
 * 
 * Capped to range [0.75, 1.35]
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { getPoolHistory, DLMMTelemetry } from '../services/dlmmTelemetry';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Momentum slopes for a pool
 */
export interface MomentumSlopes {
    poolId: string;
    velocitySlope: number;      // Bin movement acceleration (bins/sec²)
    liquiditySlope: number;     // Liquidity flow trend (USD/sec)
    entropySlope: number;       // Entropy trend (units/sec)
    
    // Per-minute rates for migration classification
    liquiditySlopePerMin: number;  // Liquidity slope as %/min
    
    snapshotCount: number;
    timeDeltaSeconds: number;
    timestamp: number;
    valid: boolean;
    invalidReason?: string;
}

/**
 * Tier 4 slope multiplier result
 */
export interface SlopeMultiplierResult {
    velocityComponent: number;
    liquidityComponent: number;
    entropyComponent: number;
    rawMultiplier: number;
    clampedMultiplier: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const MIN_SNAPSHOTS = 3;

/**
 * Slope multiplier clamps (from Tier 4 spec)
 */
const SLOPE_CLAMPS = {
    velocity: { min: -0.10, max: 0.10 },
    liquidity: { min: -0.10, max: 0.15 },
    entropy: { min: -0.05, max: 0.10 },
};

/**
 * Total slope multiplier range
 */
const SLOPE_MULTIPLIER_RANGE = { min: 0.75, max: 1.35 };

/**
 * Slope divisor for multiplier calculation
 */
const SLOPE_DIVISOR = 50;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLOPE COMPUTATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute velocity slope (bin movement acceleration).
 * 
 * Formula: (currentVelocity - previousVelocity) / timeDeltaSeconds
 * 
 * Returns raw slope (can be negative).
 * Returns 0 if insufficient history.
 */
export function computeVelocitySlope(poolId: string): number {
    const history = getPoolHistory(poolId);
    
    if (history.length < MIN_SNAPSHOTS) {
        return 0;
    }
    
    const current = history[history.length - 1];
    const previous = history[history.length - 2];
    const oldest = history[history.length - 3];
    
    // Calculate velocities at two points
    const timeDelta1 = (current.fetchedAt - previous.fetchedAt) / 1000;
    const timeDelta2 = (previous.fetchedAt - oldest.fetchedAt) / 1000;
    
    if (timeDelta1 <= 0 || timeDelta2 <= 0) {
        return 0;
    }
    
    const velocity1 = Math.abs(current.activeBin - previous.activeBin) / timeDelta1;
    const velocity2 = Math.abs(previous.activeBin - oldest.activeBin) / timeDelta2;
    
    // Slope = change in velocity / time between measurements
    const slope = (velocity1 - velocity2) / timeDelta1;
    
    return slope; // Raw, no clamping
}

/**
 * Compute liquidity slope (liquidity flow trend).
 * 
 * Formula: (currentLiquidity - previousLiquidity) / timeDeltaSeconds
 * 
 * Uses liquidityUSD (NEVER totalLiquidity).
 * Returns raw slope (can be negative - indicates outflow).
 * Returns 0 if insufficient history.
 */
export function computeLiquiditySlope(poolId: string): number {
    const history = getPoolHistory(poolId);
    
    if (history.length < MIN_SNAPSHOTS) {
        return 0;
    }
    
    const current = history[history.length - 1];
    const previous = history[history.length - 2];
    
    const timeDeltaSeconds = (current.fetchedAt - previous.fetchedAt) / 1000;
    
    if (timeDeltaSeconds <= 0) {
        return 0;
    }
    
    // Use liquidityUSD (NEVER totalLiquidity)
    const liquidityDelta = current.liquidityUSD - previous.liquidityUSD;
    const slope = liquidityDelta / timeDeltaSeconds;
    
    return slope; // Raw, no clamping
}

/**
 * Compute liquidity slope as percentage per minute (for migration classification).
 * 
 * Used by Tier 4 migration system:
 * - > +40%/min → "in"
 * - < -40%/min → "out"
 */
export function computeLiquiditySlopePerMin(poolId: string): number {
    const history = getPoolHistory(poolId);
    
    if (history.length < 2) {
        return 0;
    }
    
    const current = history[history.length - 1];
    const previous = history[history.length - 2];
    
    const timeDeltaSec = (current.fetchedAt - previous.fetchedAt) / 1000;
    
    if (timeDeltaSec <= 0 || current.liquidityUSD <= 0) {
        return 0;
    }
    
    const liquidityDelta = current.liquidityUSD - previous.liquidityUSD;
    const percentChange = liquidityDelta / current.liquidityUSD;
    const perMinute = percentChange * (60 / timeDeltaSec);
    
    return perMinute;
}

/**
 * Compute entropy slope (market health trend).
 * 
 * Entropy is calculated from inventory ratio variance.
 * Formula: (currentEntropy - previousEntropy) / timeDeltaSeconds
 * 
 * Returns raw slope (can be negative - indicates declining health).
 * Returns 0 if insufficient history.
 */
export function computeEntropySlope(poolId: string): number {
    const history = getPoolHistory(poolId);
    
    if (history.length < MIN_SNAPSHOTS) {
        return 0;
    }
    
    // Calculate entropy at current point (last 3 snapshots)
    const currentEntropy = computeEntropyFromWindow(
        history.slice(-MIN_SNAPSHOTS)
    );
    
    // Calculate entropy at previous point (snapshots before the last 3)
    const prevWindowStart = Math.max(0, history.length - MIN_SNAPSHOTS - 1);
    const prevWindowEnd = history.length - 1;
    
    if (prevWindowStart >= prevWindowEnd - 2) {
        // Not enough history for previous window
        return 0;
    }
    
    const previousEntropy = computeEntropyFromWindow(
        history.slice(prevWindowStart, prevWindowEnd)
    );
    
    const current = history[history.length - 1];
    const previous = history[history.length - 2];
    const timeDeltaSeconds = (current.fetchedAt - previous.fetchedAt) / 1000;
    
    if (timeDeltaSeconds <= 0) {
        return 0;
    }
    
    const slope = (currentEntropy - previousEntropy) / timeDeltaSeconds;
    
    return slope; // Raw, no clamping
}

/**
 * Compute entropy from a window of snapshots.
 * Uses inventory ratio variance + bin movement variance.
 */
function computeEntropyFromWindow(snapshots: DLMMTelemetry[]): number {
    if (snapshots.length < 2) return 0;
    
    // Inventory ratio variance
    const ratios = snapshots.map(s => {
        const total = s.inventoryBase + s.inventoryQuote;
        return total > 0 ? s.inventoryBase / total : 0.5;
    });
    
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const variance = ratios.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / ratios.length;
    const normalizedEntropy = Math.min(variance / 0.25, 1.0);
    
    // Bin movement entropy
    const binDeltas: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
        binDeltas.push(Math.abs(snapshots[i].activeBin - snapshots[i - 1].activeBin));
    }
    
    const binVariance = binDeltas.length > 0
        ? binDeltas.reduce((sum, d) => sum + d, 0) / binDeltas.length
        : 0;
    
    const binEntropy = Math.min(binVariance / 5, 1.0);
    
    return (normalizedEntropy * 0.6) + (binEntropy * 0.4);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED SLOPE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get all momentum slopes for a pool.
 * 
 * Returns null if insufficient history (< 3 snapshots).
 */
export function getMomentumSlopes(poolId: string): MomentumSlopes | null {
    const history = getPoolHistory(poolId);
    
    if (history.length < MIN_SNAPSHOTS) {
        return {
            poolId,
            velocitySlope: 0,
            liquiditySlope: 0,
            entropySlope: 0,
            liquiditySlopePerMin: 0,
            snapshotCount: history.length,
            timeDeltaSeconds: 0,
            timestamp: Date.now(),
            valid: false,
            invalidReason: `Insufficient snapshots: ${history.length} < ${MIN_SNAPSHOTS}`,
        };
    }
    
    const current = history[history.length - 1];
    const oldest = history[0];
    const timeDeltaSeconds = (current.fetchedAt - oldest.fetchedAt) / 1000;
    
    return {
        poolId,
        velocitySlope: computeVelocitySlope(poolId),
        liquiditySlope: computeLiquiditySlope(poolId),
        entropySlope: computeEntropySlope(poolId),
        liquiditySlopePerMin: computeLiquiditySlopePerMin(poolId),
        snapshotCount: history.length,
        timeDeltaSeconds,
        timestamp: Date.now(),
        valid: true,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 SLOPE MULTIPLIER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Tier 4 slope multiplier.
 * 
 * slopeMultiplier = 1.0
 *   + clamp(velocity_slope / 50, -0.10, +0.10)
 *   + clamp(liquidity_slope / 50, -0.10, +0.15)
 *   + clamp(entropy_slope / 50, -0.05, +0.10)
 * 
 * Capped to range [0.75, 1.35]
 */
export function computeSlopeMultiplier(poolId: string): SlopeMultiplierResult {
    const slopes = getMomentumSlopes(poolId);
    
    if (!slopes || !slopes.valid) {
        return {
            velocityComponent: 0,
            liquidityComponent: 0,
            entropyComponent: 0,
            rawMultiplier: 1.0,
            clampedMultiplier: 1.0,
        };
    }
    
    const velocityComponent = clamp(
        slopes.velocitySlope / SLOPE_DIVISOR,
        SLOPE_CLAMPS.velocity.min,
        SLOPE_CLAMPS.velocity.max
    );
    
    const liquidityComponent = clamp(
        slopes.liquiditySlope / SLOPE_DIVISOR,
        SLOPE_CLAMPS.liquidity.min,
        SLOPE_CLAMPS.liquidity.max
    );
    
    const entropyComponent = clamp(
        slopes.entropySlope / SLOPE_DIVISOR,
        SLOPE_CLAMPS.entropy.min,
        SLOPE_CLAMPS.entropy.max
    );
    
    const rawMultiplier = 1.0 + velocityComponent + liquidityComponent + entropyComponent;
    const clampedMultiplier = clamp(rawMultiplier, SLOPE_MULTIPLIER_RANGE.min, SLOPE_MULTIPLIER_RANGE.max);
    
    return {
        velocityComponent,
        liquidityComponent,
        entropyComponent,
        rawMultiplier,
        clampedMultiplier,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY MOMENTUM SCORE (deprecated, kept for compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @deprecated Use computeSlopeMultiplier for Tier 4
 */
export interface MomentumScore {
    poolId: string;
    velocitySlope: number;
    liquiditySlope: number;
    entropySlope: number;
    momentumScore: number;
    valid: boolean;
}

/**
 * @deprecated Use computeSlopeMultiplier for Tier 4
 */
export function computeMomentumScore(poolId: string): MomentumScore {
    const slopes = getMomentumSlopes(poolId);
    
    if (!slopes || !slopes.valid) {
        return {
            poolId,
            velocitySlope: 0,
            liquiditySlope: 0,
            entropySlope: 0,
            momentumScore: 0,
            valid: false,
        };
    }
    
    // Legacy scoring (kept for backwards compatibility)
    const scaledVelocity = slopes.velocitySlope * 1000;
    const scaledLiquidity = slopes.liquiditySlope * 0.001;
    const scaledEntropy = slopes.entropySlope * 100;
    
    const momentumScore = (
        scaledVelocity * 0.40 +
        scaledLiquidity * 0.35 +
        scaledEntropy * 0.25
    );
    
    return {
        poolId,
        velocitySlope: slopes.velocitySlope,
        liquiditySlope: slopes.liquiditySlope,
        entropySlope: slopes.entropySlope,
        momentumScore,
        valid: true,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log momentum slopes for a pool (Tier 4 format).
 */
export function logMomentumSlopes(poolId: string): void {
    const slopes = getMomentumSlopes(poolId);
    const multiplier = computeSlopeMultiplier(poolId);
    
    if (!slopes) {
        logger.warn(`[SLOPES] pool=${poolId.slice(0, 8)}... INVALID: No slope data`);
        return;
    }
    
    if (!slopes.valid) {
        logger.warn(`[SLOPES] pool=${poolId.slice(0, 8)}... INVALID: ${slopes.invalidReason}`);
        return;
    }
    
    logger.info(
        `[SLOPES] pool=${poolId.slice(0, 8)}... ` +
        `slopeV=${slopes.velocitySlope.toFixed(6)} ` +
        `slopeL=${slopes.liquiditySlope.toFixed(6)} (${(slopes.liquiditySlopePerMin * 100).toFixed(1)}%/min) ` +
        `slopeE=${slopes.entropySlope.toFixed(6)} ` +
        `multiplier=${multiplier.clampedMultiplier.toFixed(3)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASELINE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Entry baselines for scale condition checking
const entryBaselines: Map<string, { 
    velocitySlope: number; 
    liquiditySlope: number;
    entropySlope: number;
    slopeMultiplier: number;
}> = new Map();

/**
 * Record baseline slopes at entry time.
 */
export function recordEntryBaseline(poolId: string): void {
    const slopes = getMomentumSlopes(poolId);
    const multiplier = computeSlopeMultiplier(poolId);
    
    if (slopes && slopes.valid) {
        entryBaselines.set(poolId, {
            velocitySlope: slopes.velocitySlope,
            liquiditySlope: slopes.liquiditySlope,
            entropySlope: slopes.entropySlope,
            slopeMultiplier: multiplier.clampedMultiplier,
        });
        
        logger.info(
            `[SLOPES] Recorded baseline for ${poolId.slice(0, 8)}... ` +
            `baseV=${slopes.velocitySlope.toFixed(6)} ` +
            `baseL=${slopes.liquiditySlope.toFixed(6)} ` +
            `baseE=${slopes.entropySlope.toFixed(6)} ` +
            `baseMult=${multiplier.clampedMultiplier.toFixed(3)}`
        );
    }
}

/**
 * Get entry baseline for a pool.
 */
export function getEntryBaseline(poolId: string): { 
    velocitySlope: number; 
    liquiditySlope: number;
    entropySlope: number;
    slopeMultiplier: number;
} | null {
    return entryBaselines.get(poolId) || null;
}

/**
 * Clear entry baseline when position is closed.
 */
export function clearEntryBaseline(poolId: string): void {
    entryBaselines.delete(poolId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEGATIVE SLOPE TRACKING (for exit conditions)
// ═══════════════════════════════════════════════════════════════════════════════

// Track consecutive negative velocity snapshots
const negativeVelocityCount: Map<string, number> = new Map();

/**
 * Update negative velocity slope counter.
 * Returns true if velocity has been negative for 2+ consecutive snapshots.
 */
export function checkNegativeVelocityStreak(poolId: string): boolean {
    const slopes = getMomentumSlopes(poolId);
    
    if (!slopes || !slopes.valid) {
        return false;
    }
    
    const currentCount = negativeVelocityCount.get(poolId) || 0;
    
    if (slopes.velocitySlope < 0) {
        negativeVelocityCount.set(poolId, currentCount + 1);
    } else {
        negativeVelocityCount.set(poolId, 0);
    }
    
    return (negativeVelocityCount.get(poolId) || 0) >= 2;
}

/**
 * Clear negative velocity counter.
 */
export function clearNegativeVelocityCount(poolId: string): void {
    negativeVelocityCount.delete(poolId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { SLOPE_CLAMPS, SLOPE_MULTIPLIER_RANGE, SLOPE_DIVISOR };
