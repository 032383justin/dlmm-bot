/**
 * Bin Dominance Tracker — Core Predator Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREDATOR MODE: Track bin dominance for active positions
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * For every active position, track:
 *   - binSwapShare = swaps_in_our_bin / total_pool_swaps
 *   - binFeeShare = fees_in_our_bin / total_pool_fees
 *   - binRevisitRate
 * 
 * Dominance States:
 *   DOMINANT   if binSwapShare >= 25%
 *   WEAK       if 10%-25%
 *   FAILED     if <10%
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const DOMINANCE_CONFIG = {
    /** Threshold for DOMINANT state */
    DOMINANT_THRESHOLD: 0.25,  // 25%
    
    /** Threshold for WEAK state (below DOMINANT, above FAILED) */
    WEAK_THRESHOLD: 0.10,     // 10%
    
    /** Cycles of FAILED before escalation */
    FAILED_CYCLES_FOR_ESCALATION: 3,
    
    /** Rebalance interval by dominance state (ms) */
    REBALANCE_INTERVALS: {
        DOMINANT: 4 * 60 * 1000,    // 4 minutes
        WEAK: 90 * 1000,            // 90 seconds
        FAILED: 60 * 1000,          // 60 seconds (aggressive)
    },
    
    /** Max rebalances per day target */
    MAX_REBALANCES_PER_DAY: 288,
    
    /** Minimum fee gain vs tx cost for rebalance */
    MIN_FEE_GAIN_MULTIPLIER: 1.5,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type DominanceState = 'DOMINANT' | 'WEAK' | 'FAILED' | 'UNKNOWN';

export interface BinDominanceMetrics {
    /** Current bin we're providing liquidity in */
    activeBin: number;
    
    /** Swaps in our bin / total pool swaps */
    binSwapShare: number;
    
    /** Fees in our bin / total pool fees */
    binFeeShare: number;
    
    /** Rate at which price revisits our bin */
    binRevisitRate: number;
    
    /** Current dominance state */
    dominanceState: DominanceState;
    
    /** Consecutive cycles in current state */
    cyclesInState: number;
    
    /** Time of last state change */
    lastStateChangeMs: number;
    
    /** Total rebalances today */
    rebalancesToday: number;
    
    /** Last rebalance timestamp */
    lastRebalanceMs: number;
    
    /** Fees captured since last rebalance */
    feesSinceRebalance: number;
}

export interface PositionDominance {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    entryBin: number;
    currentBin: number;
    metrics: BinDominanceMetrics;
    createdAt: number;
    updatedAt: number;
}

export interface RebalanceDecision {
    shouldRebalance: boolean;
    targetBin: number;
    reason: string;
    expectedFeeGain: number;
    estimatedCost: number;
    cadenceMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const positionDominance = new Map<string, PositionDominance>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize dominance tracking for a new position
 */
export function initializeDominance(
    tradeId: string,
    poolAddress: string,
    poolName: string,
    entryBin: number
): PositionDominance {
    const now = Date.now();
    
    const dominance: PositionDominance = {
        tradeId,
        poolAddress,
        poolName,
        entryBin,
        currentBin: entryBin,
        metrics: {
            activeBin: entryBin,
            binSwapShare: 0,
            binFeeShare: 0,
            binRevisitRate: 0,
            dominanceState: 'UNKNOWN',
            cyclesInState: 0,
            lastStateChangeMs: now,
            rebalancesToday: 0,
            lastRebalanceMs: now,
            feesSinceRebalance: 0,
        },
        createdAt: now,
        updatedAt: now,
    };
    
    positionDominance.set(tradeId, dominance);
    
    logger.info(
        `[PREDATOR-ENTRY] mode=BIN_DOMINANCE pool=${poolName} ` +
        `bin=${entryBin} tradeId=${tradeId.slice(0, 8)}`
    );
    
    return dominance;
}

/**
 * Classify dominance state from swap share
 */
function classifyDominance(binSwapShare: number): DominanceState {
    if (binSwapShare >= DOMINANCE_CONFIG.DOMINANT_THRESHOLD) {
        return 'DOMINANT';
    } else if (binSwapShare >= DOMINANCE_CONFIG.WEAK_THRESHOLD) {
        return 'WEAK';
    } else {
        return 'FAILED';
    }
}

/**
 * Update dominance metrics for a position
 */
export function updateDominanceMetrics(
    tradeId: string,
    poolSwapsTotal: number,
    binSwapsOurs: number,
    poolFeesTotal: number,
    binFeesOurs: number,
    currentPoolBin: number,
    binRevisitRate: number
): PositionDominance | null {
    const existing = positionDominance.get(tradeId);
    if (!existing) {
        logger.warn(`[PREDATOR-DOMINANCE] No position found for tradeId=${tradeId.slice(0, 8)}`);
        return null;
    }
    
    const now = Date.now();
    
    // Calculate shares
    const binSwapShare = poolSwapsTotal > 0 ? binSwapsOurs / poolSwapsTotal : 0;
    const binFeeShare = poolFeesTotal > 0 ? binFeesOurs / poolFeesTotal : 0;
    
    // Classify new state
    const newState = classifyDominance(binSwapShare);
    const oldState = existing.metrics.dominanceState;
    
    // Track state transitions
    let cyclesInState = existing.metrics.cyclesInState;
    let lastStateChangeMs = existing.metrics.lastStateChangeMs;
    
    if (newState !== oldState && oldState !== 'UNKNOWN') {
        cyclesInState = 1;
        lastStateChangeMs = now;
        
        logger.info(
            `[PREDATOR-DOMINANCE] ${existing.poolName} STATE_CHANGE: ${oldState} → ${newState} | ` +
            `binSwapShare=${(binSwapShare * 100).toFixed(1)}%`
        );
    } else {
        cyclesInState++;
    }
    
    // Accumulate fees since last rebalance
    const feesSinceRebalance = existing.metrics.feesSinceRebalance + binFeesOurs;
    
    // Update metrics
    existing.metrics = {
        activeBin: existing.currentBin,
        binSwapShare,
        binFeeShare,
        binRevisitRate,
        dominanceState: newState,
        cyclesInState,
        lastStateChangeMs,
        rebalancesToday: existing.metrics.rebalancesToday,
        lastRebalanceMs: existing.metrics.lastRebalanceMs,
        feesSinceRebalance,
    };
    existing.currentBin = currentPoolBin;
    existing.updatedAt = now;
    
    positionDominance.set(tradeId, existing);
    
    // Log dominance state
    logger.debug(
        `[PREDATOR-DOMINANCE] ${existing.poolName} binSwapShare=${(binSwapShare * 100).toFixed(1)}% ` +
        `binFeeShare=${(binFeeShare * 100).toFixed(1)}% state=${newState} cycles=${cyclesInState}`
    );
    
    return existing;
}

/**
 * Evaluate if position should rebalance
 */
export function evaluateRebalance(
    tradeId: string,
    highestSwapBin: number,
    estimatedFeeGain: number,
    estimatedTxCost: number
): RebalanceDecision {
    const dominance = positionDominance.get(tradeId);
    
    if (!dominance) {
        return {
            shouldRebalance: false,
            targetBin: 0,
            reason: 'NO_POSITION',
            expectedFeeGain: 0,
            estimatedCost: 0,
            cadenceMs: 0,
        };
    }
    
    const now = Date.now();
    const state = dominance.metrics.dominanceState;
    // Handle UNKNOWN state by defaulting to WEAK cadence
    const cadenceMs = (state !== 'UNKNOWN' && DOMINANCE_CONFIG.REBALANCE_INTERVALS[state]) 
        ? DOMINANCE_CONFIG.REBALANCE_INTERVALS[state]
        : DOMINANCE_CONFIG.REBALANCE_INTERVALS.WEAK;
    
    // Check cadence
    const timeSinceLastRebalance = now - dominance.metrics.lastRebalanceMs;
    if (timeSinceLastRebalance < cadenceMs) {
        return {
            shouldRebalance: false,
            targetBin: highestSwapBin,
            reason: `CADENCE: ${((cadenceMs - timeSinceLastRebalance) / 1000).toFixed(0)}s remaining`,
            expectedFeeGain: estimatedFeeGain,
            estimatedCost: estimatedTxCost,
            cadenceMs,
        };
    }
    
    // Check daily limit
    if (dominance.metrics.rebalancesToday >= DOMINANCE_CONFIG.MAX_REBALANCES_PER_DAY) {
        return {
            shouldRebalance: false,
            targetBin: highestSwapBin,
            reason: `MAX_DAILY: ${dominance.metrics.rebalancesToday}/${DOMINANCE_CONFIG.MAX_REBALANCES_PER_DAY}`,
            expectedFeeGain: estimatedFeeGain,
            estimatedCost: estimatedTxCost,
            cadenceMs,
        };
    }
    
    // Check if target bin is different
    if (highestSwapBin === dominance.currentBin) {
        return {
            shouldRebalance: false,
            targetBin: highestSwapBin,
            reason: 'SAME_BIN',
            expectedFeeGain: estimatedFeeGain,
            estimatedCost: estimatedTxCost,
            cadenceMs,
        };
    }
    
    // Check fee-positive condition
    const minGain = estimatedTxCost * DOMINANCE_CONFIG.MIN_FEE_GAIN_MULTIPLIER;
    if (estimatedFeeGain < minGain) {
        return {
            shouldRebalance: false,
            targetBin: highestSwapBin,
            reason: `FEE_NEGATIVE: gain $${estimatedFeeGain.toFixed(4)} < min $${minGain.toFixed(4)}`,
            expectedFeeGain: estimatedFeeGain,
            estimatedCost: estimatedTxCost,
            cadenceMs,
        };
    }
    
    // All checks passed
    logger.info(
        `[PREDATOR-REBALANCE] ${dominance.poolName} dominance=${state} cadence=${(cadenceMs/1000).toFixed(0)}s ` +
        `expectedFee=$${estimatedFeeGain.toFixed(4)} cost=$${estimatedTxCost.toFixed(4)} ` +
        `currentBin=${dominance.currentBin} → targetBin=${highestSwapBin}`
    );
    
    return {
        shouldRebalance: true,
        targetBin: highestSwapBin,
        reason: 'FEE_POSITIVE',
        expectedFeeGain: estimatedFeeGain,
        estimatedCost: estimatedTxCost,
        cadenceMs,
    };
}

/**
 * Record a rebalance execution
 */
export function recordRebalance(tradeId: string, newBin: number): void {
    const dominance = positionDominance.get(tradeId);
    if (!dominance) return;
    
    const now = Date.now();
    
    dominance.currentBin = newBin;
    dominance.metrics.activeBin = newBin;
    dominance.metrics.lastRebalanceMs = now;
    dominance.metrics.rebalancesToday++;
    dominance.metrics.feesSinceRebalance = 0;  // Reset
    dominance.updatedAt = now;
    
    positionDominance.set(tradeId, dominance);
}

/**
 * Check if position should exit due to dominance failure
 */
export function shouldExitDominanceFailure(tradeId: string): {
    shouldExit: boolean;
    reason: string;
} {
    const dominance = positionDominance.get(tradeId);
    
    if (!dominance) {
        return { shouldExit: false, reason: 'NO_POSITION' };
    }
    
    const { dominanceState, cyclesInState } = dominance.metrics;
    
    // Only exit if FAILED for consecutive cycles
    if (dominanceState === 'FAILED' && 
        cyclesInState >= DOMINANCE_CONFIG.FAILED_CYCLES_FOR_ESCALATION) {
        logger.warn(
            `[PREDATOR-EXIT] ${dominance.poolName} reason=DOMINANCE_FAILURE ` +
            `state=${dominanceState} cycles=${cyclesInState} ` +
            `binSwapShare=${(dominance.metrics.binSwapShare * 100).toFixed(1)}%`
        );
        return {
            shouldExit: true,
            reason: `DOMINANCE_FAILURE: ${dominanceState} for ${cyclesInState} cycles`,
        };
    }
    
    return { shouldExit: false, reason: 'DOMINANCE_OK' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export function getDominance(tradeId: string): PositionDominance | undefined {
    return positionDominance.get(tradeId);
}

export function clearDominance(tradeId: string): void {
    positionDominance.delete(tradeId);
}

export function getAllDominanceStates(): Map<string, PositionDominance> {
    return new Map(positionDominance);
}

export function resetDailyRebalanceCounts(): void {
    for (const [tradeId, dominance] of positionDominance.entries()) {
        dominance.metrics.rebalancesToday = 0;
        positionDominance.set(tradeId, dominance);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logDominanceSummary(): void {
    const positions = Array.from(positionDominance.values());
    
    if (positions.length === 0) {
        logger.info(`[PREDATOR-SUMMARY] No active positions`);
        return;
    }
    
    const byState = {
        DOMINANT: positions.filter(p => p.metrics.dominanceState === 'DOMINANT'),
        WEAK: positions.filter(p => p.metrics.dominanceState === 'WEAK'),
        FAILED: positions.filter(p => p.metrics.dominanceState === 'FAILED'),
    };
    
    const totalRebalances = positions.reduce((sum, p) => sum + p.metrics.rebalancesToday, 0);
    const avgSwapShare = positions.reduce((sum, p) => sum + p.metrics.binSwapShare, 0) / positions.length;
    
    logger.info(
        `[PREDATOR-SUMMARY] positions=${positions.length} | ` +
        `DOMINANT=${byState.DOMINANT.length} WEAK=${byState.WEAK.length} FAILED=${byState.FAILED.length} | ` +
        `rebalances=${totalRebalances} avgSwapShare=${(avgSwapShare * 100).toFixed(1)}%`
    );
}

