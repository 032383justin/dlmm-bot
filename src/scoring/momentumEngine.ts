/**
 * Momentum Engine - Tier 3 Predictive Microstructure
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Implements slope-based momentum detection for:
 * - Velocity slope (bin movement acceleration)
 * - Liquidity slope (liquidity flow trend)
 * - Entropy slope (market health trend)
 * 
 * All slopes use snapshot history from poolHistory in dlmmTelemetry.
 * Minimum 3 snapshots required for valid slope calculation.
 * Slopes are returned RAW - no normalization, no clamping.
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
    snapshotCount: number;
    timeDeltaSeconds: number;
    timestamp: number;
    valid: boolean;
    invalidReason?: string;
}

/**
 * Momentum score computed from slopes
 */
export interface MomentumScore {
    poolId: string;
    velocitySlope: number;
    liquiditySlope: number;
    entropySlope: number;
    momentumScore: number;      // Weighted combination
    valid: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MIN_SNAPSHOTS = 3;

// Momentum score weights
const MOMENTUM_WEIGHTS = {
    velocitySlope: 0.40,
    liquiditySlope: 0.35,
    entropySlope: 0.25,
};

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
        snapshotCount: history.length,
        timeDeltaSeconds,
        timestamp: Date.now(),
        valid: true,
    };
}

/**
 * Compute weighted momentum score from slopes.
 * 
 * momentumScore = velocitySlope * 0.40 + liquiditySlope * 0.35 + entropySlope * 0.25
 * 
 * Returns raw score (can be negative).
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
    
    // Scale slopes for scoring (raw slopes are typically very small)
    // Velocity: bins/sec² → scale by 1000
    // Liquidity: USD/sec → scale by 0.001 (normalize large USD values)
    // Entropy: units/sec → scale by 100
    const scaledVelocity = slopes.velocitySlope * 1000;
    const scaledLiquidity = slopes.liquiditySlope * 0.001;
    const scaledEntropy = slopes.entropySlope * 100;
    
    const momentumScore = (
        scaledVelocity * MOMENTUM_WEIGHTS.velocitySlope +
        scaledLiquidity * MOMENTUM_WEIGHTS.liquiditySlope +
        scaledEntropy * MOMENTUM_WEIGHTS.entropySlope
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
 * Log momentum slopes for a pool.
 */
export function logMomentumSlopes(poolId: string): void {
    const slopes = getMomentumSlopes(poolId);
    
    if (!slopes) {
        logger.warn(`[MOMENTUM] pool=${poolId.slice(0, 8)}... INVALID: No slope data`);
        return;
    }
    
    if (!slopes.valid) {
        logger.warn(`[MOMENTUM] pool=${poolId.slice(0, 8)}... INVALID: ${slopes.invalidReason}`);
        return;
    }
    
    const score = computeMomentumScore(poolId);
    
    logger.info(
        `[MOMENTUM] pool=${poolId.slice(0, 8)}... ` +
        `slopeV=${slopes.velocitySlope.toFixed(6)} ` +
        `slopeL=${slopes.liquiditySlope.toFixed(6)} ` +
        `slopeE=${slopes.entropySlope.toFixed(6)} ` +
        `score=${score.momentumScore.toFixed(2)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASELINE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Entry baselines for scale condition checking
const entryBaselines: Map<string, { velocitySlope: number; liquiditySlope: number }> = new Map();

/**
 * Record baseline slopes at entry time.
 */
export function recordEntryBaseline(poolId: string): void {
    const slopes = getMomentumSlopes(poolId);
    
    if (slopes && slopes.valid) {
        entryBaselines.set(poolId, {
            velocitySlope: slopes.velocitySlope,
            liquiditySlope: slopes.liquiditySlope,
        });
        
        logger.info(
            `[MOMENTUM] Recorded baseline for ${poolId.slice(0, 8)}... ` +
            `baseV=${slopes.velocitySlope.toFixed(6)} baseL=${slopes.liquiditySlope.toFixed(6)}`
        );
    }
}

/**
 * Get entry baseline for a pool.
 */
export function getEntryBaseline(poolId: string): { velocitySlope: number; liquiditySlope: number } | null {
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

export { MIN_SNAPSHOTS, MOMENTUM_WEIGHTS };

