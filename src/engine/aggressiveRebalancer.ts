/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AGGRESSIVE REBALANCER — PREDATOR MODE v1 REBALANCING ENGINE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * REMOVED:
 * - Rebalance throttles >5 minutes
 * - Rebalance suppression due to "noise"
 * 
 * ADDED:
 * - Event-driven + time-based hybrid rebalancing
 * - Rebalance when: price exits dominant bin, oscillation midpoint shifts,
 *   fee velocity decay detected
 * - Time-based fallback: 60-240 seconds cadence
 * 
 * YES, this increases churn. That is INTENTIONAL.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    PREDATOR_MODE_V1_ENABLED,
    REBALANCE_AGGRESSION_CONFIG,
    shouldRebalance as shouldRebalanceFromConfig,
    getRegimeMultipliers,
} from '../config/predatorModeV1';
import {
    BinDominanceResult,
    hasPriceExitedDominance,
    determineBinDominanceStrategy,
    recordBinRebalance,
    getBinStrategy,
    getRebalanceCount,
    updateBinTracking,
    PriceHistory,
} from './binDominanceStrategy';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RebalanceEvaluation {
    shouldRebalance: boolean;
    trigger: RebalanceTrigger;
    urgency: 'HIGH' | 'MEDIUM' | 'LOW';
    reason: string;
    newStrategy?: BinDominanceResult;
    estimatedCostUsd?: number;
}

export type RebalanceTrigger =
    | 'PRICE_EXIT_BIN'
    | 'MIDPOINT_SHIFT'
    | 'FEE_VELOCITY_DECAY'
    | 'TIME_FALLBACK'
    | 'REGIME_ADJUSTMENT'
    | 'NONE';

export interface PositionRebalanceState {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    lastRebalanceMs: number;
    rebalanceCount: number;
    currentBinId: number;
    entryBinId: number;
    lastFeeVelocity: number;
    feeVelocityHistory: number[];
    oscillationMidpoint: number;
}

export interface RebalanceMetrics {
    currentBinId: number;
    feeVelocity: number;  // Fees per hour
    oscillationMidpoint?: number;
    regime?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

const positionStates = new Map<string, PositionRebalanceState>();
let totalRebalancesThisCycle = 0;
let totalRebalancesAllTime = 0;

/**
 * Initialize rebalance tracking for a new position
 */
export function initializeRebalanceState(
    tradeId: string,
    poolAddress: string,
    poolName: string,
    entryBinId: number,
    initialFeeVelocity: number = 0
): void {
    positionStates.set(tradeId, {
        tradeId,
        poolAddress,
        poolName,
        lastRebalanceMs: Date.now(),
        rebalanceCount: 0,
        currentBinId: entryBinId,
        entryBinId,
        lastFeeVelocity: initialFeeVelocity,
        feeVelocityHistory: [initialFeeVelocity],
        oscillationMidpoint: entryBinId,
    });
}

/**
 * Update position state with new metrics
 */
export function updateRebalanceState(
    tradeId: string,
    metrics: RebalanceMetrics
): void {
    const state = positionStates.get(tradeId);
    if (!state) return;
    
    state.currentBinId = metrics.currentBinId;
    state.lastFeeVelocity = metrics.feeVelocity;
    state.feeVelocityHistory.push(metrics.feeVelocity);
    
    // Keep last 20 velocity samples
    if (state.feeVelocityHistory.length > 20) {
        state.feeVelocityHistory = state.feeVelocityHistory.slice(-20);
    }
    
    // Update oscillation midpoint (running average of bin positions)
    if (metrics.oscillationMidpoint !== undefined) {
        state.oscillationMidpoint = metrics.oscillationMidpoint;
    } else {
        // Calculate from current position (weighted average)
        state.oscillationMidpoint = state.oscillationMidpoint * 0.9 + metrics.currentBinId * 0.1;
    }
    
    // Also update bin tracking
    updateBinTracking(tradeId, metrics.currentBinId);
}

/**
 * Record that a rebalance was executed
 */
export function recordRebalanceExecution(
    tradeId: string,
    newBinId: number,
    newStrategy: BinDominanceResult
): void {
    const state = positionStates.get(tradeId);
    if (!state) return;
    
    state.lastRebalanceMs = Date.now();
    state.rebalanceCount++;
    state.currentBinId = newBinId;
    state.oscillationMidpoint = newBinId;  // Reset midpoint on rebalance
    
    // Record in bin dominance tracking
    recordBinRebalance(tradeId, newStrategy);
    
    totalRebalancesThisCycle++;
    totalRebalancesAllTime++;
    
    logger.info(
        `[REBALANCE] ⚡ Executed for ${state.poolName} | ` +
        `newBin=${newBinId} | ` +
        `count=${state.rebalanceCount} | ` +
        `total=${totalRebalancesAllTime}`
    );
}

/**
 * Cleanup state for closed position
 */
export function cleanupRebalanceState(tradeId: string): void {
    positionStates.delete(tradeId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REBALANCE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate if a position should be rebalanced
 * 
 * This is the core decision function that implements the aggressive
 * rebalancing logic from Predator Mode v1.
 */
export function evaluateRebalance(
    tradeId: string,
    metrics: RebalanceMetrics,
    priceHistory: PriceHistory[] = []
): RebalanceEvaluation {
    if (!PREDATOR_MODE_V1_ENABLED) {
        return {
            shouldRebalance: false,
            trigger: 'NONE',
            urgency: 'LOW',
            reason: 'PREDATOR_DISABLED',
        };
    }
    
    const state = positionStates.get(tradeId);
    if (!state) {
        return {
            shouldRebalance: false,
            trigger: 'NONE',
            urgency: 'LOW',
            reason: 'NO_STATE',
        };
    }
    
    const now = Date.now();
    const elapsed = now - state.lastRebalanceMs;
    const config = REBALANCE_AGGRESSION_CONFIG;
    
    // Update state with new metrics
    updateRebalanceState(tradeId, metrics);
    
    // Get current bin strategy
    const strategy = getBinStrategy(tradeId);
    if (!strategy) {
        return {
            shouldRebalance: false,
            trigger: 'NONE',
            urgency: 'LOW',
            reason: 'NO_STRATEGY',
        };
    }
    
    // Apply regime multipliers (minor only)
    const regimeMultipliers = getRegimeMultipliers(metrics.regime || 'NEUTRAL');
    const adjustedMinInterval = config.MIN_REBALANCE_INTERVAL_MS * regimeMultipliers.rebalanceCadenceMultiplier;
    const adjustedMaxInterval = config.MAX_REBALANCE_INTERVAL_MS * regimeMultipliers.rebalanceCadenceMultiplier;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: Minimum interval (prevent spam)
    // ═══════════════════════════════════════════════════════════════════════════
    if (elapsed < adjustedMinInterval) {
        return {
            shouldRebalance: false,
            trigger: 'NONE',
            urgency: 'LOW',
            reason: `Min interval: ${(elapsed / 1000).toFixed(0)}s < ${(adjustedMinInterval / 1000).toFixed(0)}s`,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: Price exited dominant bin (HIGH PRIORITY)
    // ═══════════════════════════════════════════════════════════════════════════
    if (config.TRIGGERS.PRICE_EXITS_BIN && hasPriceExitedDominance(metrics.currentBinId, strategy)) {
        const newStrategy = determineBinDominanceStrategy(
            metrics.currentBinId,
            priceHistory,
            undefined,
            metrics.regime
        );
        
        return {
            shouldRebalance: true,
            trigger: 'PRICE_EXIT_BIN',
            urgency: 'HIGH',
            reason: `Price exited: current=${metrics.currentBinId}, modal=${strategy.modalBinId}, drift=${Math.abs(metrics.currentBinId - strategy.modalBinId)}`,
            newStrategy,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 3: Oscillation midpoint shifted (MEDIUM PRIORITY)
    // ═══════════════════════════════════════════════════════════════════════════
    if (config.TRIGGERS.MIDPOINT_SHIFT) {
        const midpointDrift = Math.abs(metrics.currentBinId - state.oscillationMidpoint);
        if (midpointDrift >= 2) {  // 2+ bin midpoint shift
            const newStrategy = determineBinDominanceStrategy(
                metrics.currentBinId,
                priceHistory,
                undefined,
                metrics.regime
            );
            
            return {
                shouldRebalance: true,
                trigger: 'MIDPOINT_SHIFT',
                urgency: 'MEDIUM',
                reason: `Midpoint shifted: old=${state.oscillationMidpoint.toFixed(1)}, new=${metrics.currentBinId}, drift=${midpointDrift.toFixed(1)}`,
                newStrategy,
            };
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 4: Fee velocity decay (MEDIUM PRIORITY)
    // ═══════════════════════════════════════════════════════════════════════════
    if (config.TRIGGERS.FEE_VELOCITY_DECAY && state.feeVelocityHistory.length >= 3) {
        const recentAvg = state.feeVelocityHistory.slice(-3).reduce((a, b) => a + b, 0) / 3;
        const historicalAvg = state.feeVelocityHistory.slice(0, -3).reduce((a, b) => a + b, 0) / 
                              Math.max(1, state.feeVelocityHistory.length - 3);
        
        if (historicalAvg > 0) {
            const drop = (historicalAvg - recentAvg) / historicalAvg;
            if (drop >= config.FEE_VELOCITY_DROP_THRESHOLD) {
                const newStrategy = determineBinDominanceStrategy(
                    metrics.currentBinId,
                    priceHistory,
                    undefined,
                    metrics.regime
                );
                
                return {
                    shouldRebalance: true,
                    trigger: 'FEE_VELOCITY_DECAY',
                    urgency: 'MEDIUM',
                    reason: `Fee velocity dropped: ${(drop * 100).toFixed(0)}% (${recentAvg.toFixed(4)} vs ${historicalAvg.toFixed(4)})`,
                    newStrategy,
                };
            }
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 5: Time-based fallback (LOW PRIORITY)
    // ═══════════════════════════════════════════════════════════════════════════
    if (elapsed >= adjustedMaxInterval) {
        const newStrategy = determineBinDominanceStrategy(
            metrics.currentBinId,
            priceHistory,
            undefined,
            metrics.regime
        );
        
        return {
            shouldRebalance: true,
            trigger: 'TIME_FALLBACK',
            urgency: 'LOW',
            reason: `Time fallback: ${(elapsed / 1000).toFixed(0)}s >= ${(adjustedMaxInterval / 1000).toFixed(0)}s max`,
            newStrategy,
        };
    }
    
    // No rebalance needed
    return {
        shouldRebalance: false,
        trigger: 'NONE',
        urgency: 'LOW',
        reason: `Stable: bin=${metrics.currentBinId}, elapsed=${(elapsed / 1000).toFixed(0)}s`,
    };
}

/**
 * Get positions that need immediate rebalancing
 */
export function getPositionsNeedingRebalance(
    allMetrics: Map<string, RebalanceMetrics>,
    priceHistories: Map<string, PriceHistory[]> = new Map()
): Map<string, RebalanceEvaluation> {
    const results = new Map<string, RebalanceEvaluation>();
    
    for (const [tradeId, metrics] of allMetrics) {
        const priceHistory = priceHistories.get(tradeId) || [];
        const evaluation = evaluateRebalance(tradeId, metrics, priceHistory);
        
        if (evaluation.shouldRebalance) {
            results.set(tradeId, evaluation);
        }
    }
    
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reset cycle rebalance count (call at start of each cycle)
 */
export function resetCycleRebalanceCount(): void {
    totalRebalancesThisCycle = 0;
}

/**
 * Get rebalance counts
 */
export function getRebalanceCounts(): {
    thisCycle: number;
    allTime: number;
    byPosition: Map<string, number>;
} {
    const byPosition = new Map<string, number>();
    for (const [tradeId, state] of positionStates) {
        byPosition.set(tradeId, state.rebalanceCount);
    }
    
    return {
        thisCycle: totalRebalancesThisCycle,
        allTime: totalRebalancesAllTime,
        byPosition,
    };
}

/**
 * Get rebalance density (rebalances per hour)
 */
export function getRebalanceDensity(windowMs: number = 60 * 60 * 1000): number {
    // This is a simplified calculation - in production you'd track timestamps
    // For now, estimate based on cycle rate
    const avgCycleMs = 2 * 60 * 1000;  // 2 minutes
    const cyclesPerHour = windowMs / avgCycleMs;
    return totalRebalancesThisCycle * cyclesPerHour;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logRebalanceEvaluation(
    poolName: string,
    evaluation: RebalanceEvaluation
): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    if (evaluation.shouldRebalance) {
        const urgencyEmoji = evaluation.urgency === 'HIGH' ? '🔴' :
                            evaluation.urgency === 'MEDIUM' ? '🟡' : '🟢';
        logger.info(
            `[REBALANCE] ${urgencyEmoji} ${poolName} | ` +
            `trigger=${evaluation.trigger} | ` +
            `urgency=${evaluation.urgency} | ` +
            `${evaluation.reason}`
        );
    } else {
        logger.debug(
            `[REBALANCE] ⏸️ ${poolName} | ` +
            `${evaluation.reason}`
        );
    }
}

export function logRebalanceSummary(): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    const counts = getRebalanceCounts();
    const density = getRebalanceDensity();
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('⚡ REBALANCE SUMMARY');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`  This Cycle: ${counts.thisCycle} rebalances`);
    logger.info(`  All Time: ${counts.allTime} rebalances`);
    logger.info(`  Density: ~${density.toFixed(1)}/hour (estimated)`);
    
    if (counts.byPosition.size > 0) {
        logger.info('  By Position:');
        for (const [tradeId, count] of counts.byPosition) {
            const state = positionStates.get(tradeId);
            const name = state?.poolName || tradeId.slice(0, 8);
            logger.info(`    ${name}: ${count} rebalances`);
        }
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

export function logAggressiveRebalancerStatus(): void {
    if (!PREDATOR_MODE_V1_ENABLED) {
        logger.info('[REBALANCE] Aggressive rebalancer DISABLED');
        return;
    }
    
    const config = REBALANCE_AGGRESSION_CONFIG;
    
    logger.info(
        `[REBALANCE] ⚡ Aggressive rebalancer ACTIVE | ` +
        `interval=${config.MIN_REBALANCE_INTERVAL_MS / 1000}-${config.MAX_REBALANCE_INTERVAL_MS / 1000}s | ` +
        `triggers=[PRICE_EXIT,MIDPOINT_SHIFT,FEE_DECAY,TIME] | ` +
        `noise_suppression=DISABLED | ` +
        `tracked=${positionStates.size} positions`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    initializeRebalanceState,
    updateRebalanceState,
    recordRebalanceExecution,
    cleanupRebalanceState,
    evaluateRebalance,
    getPositionsNeedingRebalance,
    resetCycleRebalanceCount,
    getRebalanceCounts,
    getRebalanceDensity,
    logRebalanceEvaluation,
    logRebalanceSummary,
    logAggressiveRebalancerStatus,
};

