/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BULLY REBALANCE LOOP — Core Monster Behavior
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Rebalance becomes the CORE PROFIT ENGINE, not passive hold.
 * 
 * REBALANCE TRIGGERS (any true):
 *   1. Price drifts outside "optimal fee band" (distance from center bin > X bins)
 *   2. Oscillation/churn rises and current bin width is too wide (missed fees)
 *   3. Fee velocity drops below expected for current volatility regime
 *   4. Bin entropy indicates activity concentrated in fewer bins than position width
 * 
 * REBALANCE ACTION:
 *   - Recenter around current price with NARROWER width in churny regimes
 *   - Dynamic bin count based on churn level:
 *     * HIGH_CHURN: 5-9 bins
 *     * MED_CHURN: 9-15 bins
 *     * LOW_CHURN: 15-25 bins
 *   - NEVER create bin arrays or do exotic initialization
 *   - ONLY reposition liquidity within existing DLMM bins
 * 
 * REBALANCE THROTTLE (avoid death by fees):
 *   - Only if expected incremental fees over next H minutes exceed:
 *     rebalanceCost * 1.5 (multiplier configurable)
 *   - Maximum rebalance rate: <= 1 per 8 minutes
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const BULLY_REBALANCE_CONFIG = {
    /** Enable bully rebalance loop */
    ENABLED: true,
    
    /** Trigger thresholds */
    TRIGGERS: {
        /** Price drift: bins from center to trigger rebalance */
        PRICE_DRIFT_BINS: 2,
        
        /** Churn rise: % increase in churn to trigger width adjustment */
        CHURN_RISE_THRESHOLD: 0.25,  // 25% increase
        
        /** Fee velocity drop: % below expected to trigger rebalance */
        FEE_VEL_DROP_THRESHOLD: 0.40,  // 40% drop
        
        /** Bin entropy: activity concentration threshold (0-1) */
        ENTROPY_CONCENTRATION_THRESHOLD: 0.60,  // 60% of activity in subset
    },
    
    /** Dynamic bin counts by churn level */
    BIN_COUNTS: {
        HIGH_CHURN: {
            MIN: 5,
            MAX: 9,
            DEFAULT: 7,
        },
        MED_CHURN: {
            MIN: 9,
            MAX: 15,
            DEFAULT: 12,
        },
        LOW_CHURN: {
            MIN: 15,
            MAX: 25,
            DEFAULT: 20,
        },
    },
    
    /** Churn level thresholds (combined binVel + swapVel, 0-200 scale) */
    CHURN_THRESHOLDS: {
        HIGH: 120,    // >= 120 combined = HIGH_CHURN
        MED: 60,      // 60-119 combined = MED_CHURN
        LOW: 0,       // < 60 combined = LOW_CHURN
    },
    
    /** Throttle settings */
    THROTTLE: {
        /** Minimum interval between rebalances (ms) */
        MIN_INTERVAL_MS: 8 * 60 * 1000,  // 8 minutes
        
        /** Rebalance cost multiplier (must expect 1.5x cost in fees) */
        COST_MULTIPLIER: 1.5,
        
        /** Lookahead window for fee projection (minutes) */
        FEE_PROJECTION_MINUTES: 60,
        
        /** Maximum rebalances per hour */
        MAX_PER_HOUR: 4,
    },
    
    /** Cost estimation */
    COSTS: {
        /** Base rebalance cost (% of position) */
        BASE_COST_PCT: 0.002,  // 0.2%
        
        /** Transaction fee (USD) */
        TX_FEE_USD: 0.02,
        
        /** Slippage (% of position) */
        SLIPPAGE_PCT: 0.001,  // 0.1%
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ChurnLevel = 'HIGH_CHURN' | 'MED_CHURN' | 'LOW_CHURN';

export interface RebalanceMetrics {
    // Position state
    currentCenterBin: number;
    targetCenterBin: number;
    currentBinCount: number;
    positionSizeUsd: number;
    
    // Market metrics
    binVelocity: number;        // 0-100
    swapVelocity: number;       // 0-100
    binEntropy: number;         // 0-1
    priceVol: number;           // Price volatility
    
    // Fee metrics
    currentFeeVelHr: number;    // Current fee velocity $/hr
    expectedFeeVelHr: number;   // Expected fee velocity for conditions
    
    // Timing
    lastRebalanceAt?: number;
    rebalanceCountLastHour: number;
}

export interface RebalanceTrigger {
    triggered: boolean;
    triggerType: 'PRICE_DRIFT' | 'CHURN_RISE' | 'FEE_VEL_DROP' | 'ENTROPY_CONCENTRATION' | 'NONE';
    reason: string;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface RebalanceDecision {
    shouldRebalance: boolean;
    newBinCount: number;
    newCenterBin: number;
    churnLevel: ChurnLevel;
    trigger: RebalanceTrigger;
    costEstimate: number;
    expectedFeeGain: number;
    netBenefit: number;
    throttleStatus: {
        allowed: boolean;
        reason?: string;
        nextAllowedAt?: number;
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

interface PoolRebalanceState {
    poolAddress: string;
    lastRebalanceAt: number;
    rebalanceTimes: number[];  // Timestamps of recent rebalances
    baselineFeeVelHr: number;
    baselineChurn: number;
}

const poolRebalanceStates = new Map<string, PoolRebalanceState>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine churn level from velocity metrics.
 */
export function determineChurnLevel(binVelocity: number, swapVelocity: number): ChurnLevel {
    const combinedChurn = binVelocity + swapVelocity;
    const thresholds = BULLY_REBALANCE_CONFIG.CHURN_THRESHOLDS;
    
    if (combinedChurn >= thresholds.HIGH) {
        return 'HIGH_CHURN';
    } else if (combinedChurn >= thresholds.MED) {
        return 'MED_CHURN';
    } else {
        return 'LOW_CHURN';
    }
}

/**
 * Get optimal bin count for churn level.
 */
export function getOptimalBinCount(churnLevel: ChurnLevel): number {
    const config = BULLY_REBALANCE_CONFIG.BIN_COUNTS[churnLevel];
    return config.DEFAULT;
}

/**
 * Get bin count range for churn level.
 */
export function getBinCountRange(churnLevel: ChurnLevel): { min: number; max: number; default: number } {
    const config = BULLY_REBALANCE_CONFIG.BIN_COUNTS[churnLevel];
    return {
        min: config.MIN,
        max: config.MAX,
        default: config.DEFAULT,
    };
}

/**
 * Check rebalance triggers.
 */
export function checkRebalanceTriggers(
    poolAddress: string,
    metrics: RebalanceMetrics
): RebalanceTrigger {
    const config = BULLY_REBALANCE_CONFIG.TRIGGERS;
    const state = poolRebalanceStates.get(poolAddress);
    
    // Initialize baseline if not exists
    if (!state) {
        poolRebalanceStates.set(poolAddress, {
            poolAddress,
            lastRebalanceAt: 0,
            rebalanceTimes: [],
            baselineFeeVelHr: metrics.currentFeeVelHr,
            baselineChurn: metrics.binVelocity + metrics.swapVelocity,
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRIGGER 1: Price drift outside optimal fee band
    // ═══════════════════════════════════════════════════════════════════════════
    const binDrift = Math.abs(metrics.currentCenterBin - metrics.targetCenterBin);
    if (binDrift >= config.PRICE_DRIFT_BINS) {
        return {
            triggered: true,
            triggerType: 'PRICE_DRIFT',
            reason: `Price drifted ${binDrift} bins from optimal (threshold: ${config.PRICE_DRIFT_BINS})`,
            severity: binDrift >= config.PRICE_DRIFT_BINS * 2 ? 'HIGH' : 'MEDIUM',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRIGGER 2: Churn rise - current bins too wide
    // ═══════════════════════════════════════════════════════════════════════════
    const currentChurn = metrics.binVelocity + metrics.swapVelocity;
    const baselineChurn = state?.baselineChurn || currentChurn;
    const churnIncrease = baselineChurn > 0 ? (currentChurn - baselineChurn) / baselineChurn : 0;
    
    if (churnIncrease >= config.CHURN_RISE_THRESHOLD) {
        const optimalBins = getOptimalBinCount(determineChurnLevel(metrics.binVelocity, metrics.swapVelocity));
        if (metrics.currentBinCount > optimalBins + 3) {
            return {
                triggered: true,
                triggerType: 'CHURN_RISE',
                reason: `Churn increased ${(churnIncrease * 100).toFixed(0)}%, current bins (${metrics.currentBinCount}) too wide for optimal (${optimalBins})`,
                severity: 'MEDIUM',
            };
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRIGGER 3: Fee velocity drop below expected
    // ═══════════════════════════════════════════════════════════════════════════
    if (metrics.expectedFeeVelHr > 0) {
        const feeVelRatio = metrics.currentFeeVelHr / metrics.expectedFeeVelHr;
        if (feeVelRatio < (1 - config.FEE_VEL_DROP_THRESHOLD)) {
            return {
                triggered: true,
                triggerType: 'FEE_VEL_DROP',
                reason: `Fee velocity ${(feeVelRatio * 100).toFixed(0)}% of expected (dropped ${((1 - feeVelRatio) * 100).toFixed(0)}%)`,
                severity: feeVelRatio < 0.5 ? 'HIGH' : 'MEDIUM',
            };
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRIGGER 4: Bin entropy indicates concentrated activity
    // ═══════════════════════════════════════════════════════════════════════════
    if (metrics.binEntropy < config.ENTROPY_CONCENTRATION_THRESHOLD) {
        // High concentration (low entropy) - activity in fewer bins than position
        return {
            triggered: true,
            triggerType: 'ENTROPY_CONCENTRATION',
            reason: `Activity concentrated (entropy ${(metrics.binEntropy * 100).toFixed(0)}% < ${(config.ENTROPY_CONCENTRATION_THRESHOLD * 100).toFixed(0)}% threshold)`,
            severity: 'LOW',
        };
    }
    
    // No triggers
    return {
        triggered: false,
        triggerType: 'NONE',
        reason: 'No rebalance triggers active',
        severity: 'LOW',
    };
}

/**
 * Calculate rebalance cost estimate.
 */
export function calculateRebalanceCost(positionSizeUsd: number): number {
    const config = BULLY_REBALANCE_CONFIG.COSTS;
    
    const baseCost = positionSizeUsd * config.BASE_COST_PCT;
    const slippage = positionSizeUsd * config.SLIPPAGE_PCT;
    const txFee = config.TX_FEE_USD;
    
    return baseCost + slippage + txFee;
}

/**
 * Project expected fee gain from rebalance.
 */
export function projectFeeGain(
    currentFeeVelHr: number,
    expectedFeeVelHr: number,
    projectionMinutes: number
): number {
    // Assume rebalance restores fee velocity to expected level
    const improvementPerHr = expectedFeeVelHr - currentFeeVelHr;
    const projectionHours = projectionMinutes / 60;
    
    // Conservative: assume we capture 70% of the improvement
    return improvementPerHr * projectionHours * 0.70;
}

/**
 * Check throttle constraints.
 */
export function checkThrottle(
    poolAddress: string,
    costEstimate: number,
    expectedFeeGain: number
): { allowed: boolean; reason?: string; nextAllowedAt?: number } {
    const config = BULLY_REBALANCE_CONFIG.THROTTLE;
    const state = poolRebalanceStates.get(poolAddress);
    const now = Date.now();
    
    // Check minimum interval
    if (state?.lastRebalanceAt) {
        const elapsed = now - state.lastRebalanceAt;
        if (elapsed < config.MIN_INTERVAL_MS) {
            return {
                allowed: false,
                reason: `Min interval: ${((config.MIN_INTERVAL_MS - elapsed) / 60000).toFixed(1)}m remaining`,
                nextAllowedAt: state.lastRebalanceAt + config.MIN_INTERVAL_MS,
            };
        }
    }
    
    // Check hourly rate limit
    if (state) {
        const oneHourAgo = now - (60 * 60 * 1000);
        const recentCount = state.rebalanceTimes.filter(t => t > oneHourAgo).length;
        if (recentCount >= config.MAX_PER_HOUR) {
            return {
                allowed: false,
                reason: `Max ${config.MAX_PER_HOUR} rebalances per hour reached`,
            };
        }
    }
    
    // Check cost/benefit ratio
    const minExpectedGain = costEstimate * config.COST_MULTIPLIER;
    if (expectedFeeGain < minExpectedGain) {
        return {
            allowed: false,
            reason: `Expected gain $${expectedFeeGain.toFixed(2)} < ${config.COST_MULTIPLIER}x cost ($${minExpectedGain.toFixed(2)})`,
        };
    }
    
    return { allowed: true };
}

/**
 * Evaluate full rebalance decision.
 */
export function evaluateRebalance(
    poolAddress: string,
    metrics: RebalanceMetrics
): RebalanceDecision {
    // Check triggers
    const trigger = checkRebalanceTriggers(poolAddress, metrics);
    
    // Determine optimal configuration
    const churnLevel = determineChurnLevel(metrics.binVelocity, metrics.swapVelocity);
    const newBinCount = getOptimalBinCount(churnLevel);
    const newCenterBin = metrics.targetCenterBin;
    
    // Calculate costs and benefits
    const costEstimate = calculateRebalanceCost(metrics.positionSizeUsd);
    const expectedFeeGain = projectFeeGain(
        metrics.currentFeeVelHr,
        metrics.expectedFeeVelHr,
        BULLY_REBALANCE_CONFIG.THROTTLE.FEE_PROJECTION_MINUTES
    );
    const netBenefit = expectedFeeGain - costEstimate;
    
    // Check throttle
    const throttleStatus = trigger.triggered 
        ? checkThrottle(poolAddress, costEstimate, expectedFeeGain)
        : { allowed: false, reason: 'No trigger active' };
    
    // Final decision
    const shouldRebalance = trigger.triggered && throttleStatus.allowed && netBenefit > 0;
    
    return {
        shouldRebalance,
        newBinCount,
        newCenterBin,
        churnLevel,
        trigger,
        costEstimate,
        expectedFeeGain,
        netBenefit,
        throttleStatus,
    };
}

/**
 * Record rebalance execution.
 */
export function recordRebalance(
    poolAddress: string,
    metrics: RebalanceMetrics
): void {
    const now = Date.now();
    const state = poolRebalanceStates.get(poolAddress) || {
        poolAddress,
        lastRebalanceAt: 0,
        rebalanceTimes: [],
        baselineFeeVelHr: metrics.currentFeeVelHr,
        baselineChurn: metrics.binVelocity + metrics.swapVelocity,
    };
    
    state.lastRebalanceAt = now;
    state.rebalanceTimes.push(now);
    
    // Keep only last hour of rebalance times
    const oneHourAgo = now - (60 * 60 * 1000);
    state.rebalanceTimes = state.rebalanceTimes.filter(t => t > oneHourAgo);
    
    // Update baselines after rebalance
    state.baselineFeeVelHr = metrics.expectedFeeVelHr;
    state.baselineChurn = metrics.binVelocity + metrics.swapVelocity;
    
    poolRebalanceStates.set(poolAddress, state);
    
    logger.info(
        `[BULLY-REBALANCE] EXECUTED | pool=${poolAddress.slice(0, 8)} | ` +
        `count=${state.rebalanceTimes.length}/hr`
    );
}

/**
 * Get rebalance state for a pool.
 */
export function getRebalanceState(poolAddress: string): PoolRebalanceState | undefined {
    return poolRebalanceStates.get(poolAddress);
}

/**
 * Clear rebalance state (on position close).
 */
export function clearRebalanceState(poolAddress: string): void {
    poolRebalanceStates.delete(poolAddress);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log rebalance decision details.
 */
export function logRebalanceDecision(
    poolName: string,
    decision: RebalanceDecision
): void {
    const { trigger, throttleStatus, costEstimate, expectedFeeGain, netBenefit } = decision;
    
    if (decision.shouldRebalance) {
        logger.info(
            `[BULLY-REBALANCE] ✅ TRIGGERED | pool=${poolName} | ` +
            `trigger=${trigger.triggerType} (${trigger.severity}) | ` +
            `churn=${decision.churnLevel} → bins=${decision.newBinCount} | ` +
            `cost=$${costEstimate.toFixed(2)} gain=$${expectedFeeGain.toFixed(2)} net=$${netBenefit.toFixed(2)}`
        );
    } else if (trigger.triggered) {
        logger.debug(
            `[BULLY-REBALANCE] ⏳ BLOCKED | pool=${poolName} | ` +
            `trigger=${trigger.triggerType} | ` +
            `reason: ${throttleStatus.reason || 'negative net benefit'}`
        );
    }
}

/**
 * Log rebalance summary for observability.
 */
export function logRebalanceSummary(): void {
    const states = Array.from(poolRebalanceStates.values());
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    let totalRebalancesLastHour = 0;
    states.forEach(s => {
        totalRebalancesLastHour += s.rebalanceTimes.filter(t => t > oneHourAgo).length;
    });
    
    logger.info(
        `[BULLY-REBALANCE-SUMMARY] ` +
        `pools=${states.length} | rebalances/hr=${totalRebalancesLastHour}`
    );
}

export default {
    BULLY_REBALANCE_CONFIG,
    determineChurnLevel,
    getOptimalBinCount,
    getBinCountRange,
    checkRebalanceTriggers,
    calculateRebalanceCost,
    projectFeeGain,
    checkThrottle,
    evaluateRebalance,
    recordRebalance,
    getRebalanceState,
    clearRebalanceState,
    logRebalanceDecision,
    logRebalanceSummary,
};

