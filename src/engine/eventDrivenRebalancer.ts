/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EVENT-DRIVEN REBALANCER — HOW WE WIN
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * HARD TRUTH: 288 rebalances/day is only valid when flow supports it.
 * We do EVENT-DRIVEN rebalancing, not TIME-DRIVEN.
 * 
 * REBALANCE TRIGGERS (ANY can fire):
 * 1. Dominance Flip: New bin feeVelocity ≥ 1.3× current bin
 * 2. Velocity Collapse: feeVelocity drops ≥40% over rolling window
 * 3. Liquidity Crowding: External liquidity increases >20% inside our bin
 * 4. Revisit Spike: Revisit rate rises in adjacent bin
 * 5. Profit Lock: Fees accrued ≥ txCost × safetyFactor
 * 
 * FREQUENCY ENVELOPE:
 * - High flow: 1 every 2-3 min (max ~480/day)
 * - Normal: 1 every 5-8 min (max ~180/day)
 * - Low flow: DISABLED
 * - Bootstrap: Probe only
 * 
 * This can hit 200-300/day. It will NOT churn blindly.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { PREDATOR_MODE_V1_ENABLED } from '../config/predatorModeV1';
import {
    BIN_DOMINANCE_CONFIG,
    getPoolBinState,
    analyzeDominance,
    hasVelocityCollapsed,
    getRevisitRateChange,
} from './binDominanceEscalation';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type RebalanceTrigger = 
    | 'DOMINANCE_FLIP'
    | 'VELOCITY_COLLAPSE'
    | 'LIQUIDITY_CROWDING'
    | 'REVISIT_SPIKE'
    | 'PROFIT_LOCK'
    | 'TIME_FALLBACK'
    | 'NONE';

export type FlowState = 'HIGH' | 'NORMAL' | 'LOW' | 'BOOTSTRAP';

export interface RebalanceDecision {
    shouldRebalance: boolean;
    trigger: RebalanceTrigger;
    reason: string;
    urgency: 'IMMEDIATE' | 'NORMAL' | 'DEFERRED';
    estimatedGain: number;
    estimatedCost: number;
    netExpected: number;
    passedCostGate: boolean;
}

export interface RebalanceInput {
    poolAddress: string;
    poolName: string;
    currentBinId: number;
    feesAccruedUsd: number;
    txCostUsd: number;
    currentFeeVelocity: number;
    expectedFeeVelocity: number;
    externalLiquidityChange: number;  // % change
    isBootstrap: boolean;
}

interface PoolRebalanceState {
    poolAddress: string;
    lastRebalanceMs: number;
    rebalanceCount: number;
    rebalancesToday: number;
    lastTrigger: RebalanceTrigger;
    flowState: FlowState;
    consecutiveBlocks: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const REBALANCE_CONFIG = {
    /** Dominance flip threshold (1.3x = 30% higher velocity) */
    DOMINANCE_FLIP_RATIO: 1.3,
    
    /** Velocity collapse threshold (40% drop) */
    VELOCITY_COLLAPSE_RATIO: 0.40,
    
    /** Liquidity crowding threshold (20% increase) */
    CROWDING_THRESHOLD_PCT: 0.20,
    
    /** Revisit spike threshold (30% increase) */
    REVISIT_SPIKE_THRESHOLD: 0.30,
    
    /** Cost gate safety factor (1.25x) */
    COST_GATE_SAFETY_FACTOR: 1.25,
    
    /** Fee velocity estimation window (seconds) */
    FEE_VELOCITY_WINDOW_SEC: 300,  // 5 minutes
    
    /** Frequency envelopes (milliseconds) */
    FREQUENCY_ENVELOPE: {
        HIGH: { min: 2 * 60 * 1000, max: 3 * 60 * 1000 },    // 2-3 min
        NORMAL: { min: 5 * 60 * 1000, max: 8 * 60 * 1000 },  // 5-8 min
        LOW: { min: Infinity, max: Infinity },                // Disabled
        BOOTSTRAP: { min: 10 * 60 * 1000, max: 15 * 60 * 1000 }, // 10-15 min (probe)
    },
    
    /** Flow state thresholds */
    FLOW_THRESHOLDS: {
        HIGH: 0.001,     // >0.1% fee velocity = high flow
        NORMAL: 0.0001,  // >0.01% = normal
        LOW: 0,          // Otherwise low
    },
    
    /** Max rebalances per day by flow state */
    MAX_REBALANCES_PER_DAY: {
        HIGH: 480,      // ~1 every 3 min
        NORMAL: 180,    // ~1 every 8 min
        LOW: 0,
        BOOTSTRAP: 50,  // Limited probing
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const poolRebalanceStates = new Map<string, PoolRebalanceState>();

let totalRebalancesToday = 0;
let lastDayReset = Date.now();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize rebalance state for a pool
 */
export function initializeRebalanceState(poolAddress: string): void {
    poolRebalanceStates.set(poolAddress, {
        poolAddress,
        lastRebalanceMs: Date.now(),
        rebalanceCount: 0,
        rebalancesToday: 0,
        lastTrigger: 'NONE',
        flowState: 'NORMAL',
        consecutiveBlocks: 0,
    });
}

/**
 * Determine current flow state based on fee velocity
 */
export function determineFlowState(
    feeVelocity: number,
    isBootstrap: boolean
): FlowState {
    if (isBootstrap) return 'BOOTSTRAP';
    
    if (feeVelocity >= REBALANCE_CONFIG.FLOW_THRESHOLDS.HIGH) {
        return 'HIGH';
    } else if (feeVelocity >= REBALANCE_CONFIG.FLOW_THRESHOLDS.NORMAL) {
        return 'NORMAL';
    }
    return 'LOW';
}

/**
 * Check if rebalance is allowed by frequency envelope
 */
function isWithinFrequencyEnvelope(
    state: PoolRebalanceState,
    flowState: FlowState
): { allowed: boolean; reason: string } {
    const now = Date.now();
    const elapsed = now - state.lastRebalanceMs;
    const envelope = REBALANCE_CONFIG.FREQUENCY_ENVELOPE[flowState];
    
    if (elapsed < envelope.min) {
        return {
            allowed: false,
            reason: `COOLDOWN: ${((envelope.min - elapsed) / 1000).toFixed(0)}s remaining`,
        };
    }
    
    // Check daily limit
    const maxPerDay = REBALANCE_CONFIG.MAX_REBALANCES_PER_DAY[flowState];
    if (state.rebalancesToday >= maxPerDay) {
        return {
            allowed: false,
            reason: `DAILY_LIMIT: ${state.rebalancesToday}/${maxPerDay}`,
        };
    }
    
    return { allowed: true, reason: 'ALLOWED' };
}

/**
 * Check TRIGGER 1: Dominance Flip
 */
function checkDominanceFlip(input: RebalanceInput): { triggered: boolean; reason: string } {
    const analysis = analyzeDominance(input.poolAddress);
    if (!analysis || !analysis.dominantBin) {
        return { triggered: false, reason: 'NO_ANALYSIS' };
    }
    
    if (analysis.dominantBin.binId !== input.currentBinId) {
        const binState = getPoolBinState(input.poolAddress);
        if (binState) {
            const oldBin = binState.bins.get(input.currentBinId);
            if (oldBin) {
                const ratio = analysis.dominantBin.feeVelocity / Math.max(0.000001, oldBin.feeVelocity);
                if (ratio >= REBALANCE_CONFIG.DOMINANCE_FLIP_RATIO) {
                    return {
                        triggered: true,
                        reason: `DOMINANCE_FLIP: bin ${analysis.dominantBin.binId} @ ${ratio.toFixed(1)}x velocity`,
                    };
                }
            }
        }
    }
    
    return { triggered: false, reason: 'NO_FLIP' };
}

/**
 * Check TRIGGER 2: Velocity Collapse
 */
function checkVelocityCollapse(input: RebalanceInput): { triggered: boolean; reason: string } {
    if (hasVelocityCollapsed(input.poolAddress, input.currentBinId)) {
        return {
            triggered: true,
            reason: `VELOCITY_COLLAPSE: ≥${(REBALANCE_CONFIG.VELOCITY_COLLAPSE_RATIO * 100).toFixed(0)}% drop`,
        };
    }
    return { triggered: false, reason: 'VELOCITY_STABLE' };
}

/**
 * Check TRIGGER 3: Liquidity Crowding
 */
function checkLiquidityCrowding(input: RebalanceInput): { triggered: boolean; reason: string } {
    if (input.externalLiquidityChange >= REBALANCE_CONFIG.CROWDING_THRESHOLD_PCT) {
        return {
            triggered: true,
            reason: `LIQUIDITY_CROWDING: ${(input.externalLiquidityChange * 100).toFixed(0)}% increase`,
        };
    }
    return { triggered: false, reason: 'NO_CROWDING' };
}

/**
 * Check TRIGGER 4: Revisit Spike
 */
function checkRevisitSpike(input: RebalanceInput): { triggered: boolean; reason: string } {
    const binState = getPoolBinState(input.poolAddress);
    if (!binState) return { triggered: false, reason: 'NO_STATE' };
    
    // Check adjacent bins for revisit spike
    for (const bin of binState.bins.values()) {
        if (Math.abs(bin.binId - input.currentBinId) === 1) {
            const change = getRevisitRateChange(input.poolAddress, bin.binId);
            if (change >= REBALANCE_CONFIG.REVISIT_SPIKE_THRESHOLD) {
                return {
                    triggered: true,
                    reason: `REVISIT_SPIKE: bin ${bin.binId} @ ${(change * 100).toFixed(0)}% increase`,
                };
            }
        }
    }
    
    return { triggered: false, reason: 'NO_SPIKE' };
}

/**
 * Check TRIGGER 5: Profit Lock
 */
function checkProfitLock(input: RebalanceInput): { triggered: boolean; reason: string } {
    const threshold = input.txCostUsd * REBALANCE_CONFIG.COST_GATE_SAFETY_FACTOR;
    if (input.feesAccruedUsd >= threshold) {
        return {
            triggered: true,
            reason: `PROFIT_LOCK: fees=$${input.feesAccruedUsd.toFixed(4)} >= threshold=$${threshold.toFixed(4)}`,
        };
    }
    return { triggered: false, reason: 'FEES_BELOW_THRESHOLD' };
}

/**
 * Cost-Aware Dominance Gate
 * Every rebalance must pass: expectedFeeGainNextWindow ≥ txCost × 1.25
 */
function checkCostGate(
    input: RebalanceInput,
    trigger: RebalanceTrigger
): { passed: boolean; estimatedGain: number; estimatedCost: number; netExpected: number } {
    const estimatedCost = input.txCostUsd;
    
    // Estimate fee gain for next window based on current velocity
    const windowSeconds = REBALANCE_CONFIG.FEE_VELOCITY_WINDOW_SEC;
    const estimatedGain = input.expectedFeeVelocity * windowSeconds;
    
    const requiredGain = estimatedCost * REBALANCE_CONFIG.COST_GATE_SAFETY_FACTOR;
    const netExpected = estimatedGain - estimatedCost;
    const passed = estimatedGain >= requiredGain;
    
    // Override: Emergency triggers bypass cost gate
    if (trigger === 'VELOCITY_COLLAPSE' || trigger === 'DOMINANCE_FLIP') {
        return { passed: true, estimatedGain, estimatedCost, netExpected };
    }
    
    return { passed, estimatedGain, estimatedCost, netExpected };
}

/**
 * Evaluate all rebalance triggers and determine if rebalance should occur
 */
export function evaluateRebalance(input: RebalanceInput): RebalanceDecision {
    // Reset daily counter if new day
    const now = Date.now();
    if (now - lastDayReset > 24 * 60 * 60 * 1000) {
        lastDayReset = now;
        totalRebalancesToday = 0;
        for (const state of poolRebalanceStates.values()) {
            state.rebalancesToday = 0;
        }
    }
    
    // Get or create state
    let state = poolRebalanceStates.get(input.poolAddress);
    if (!state) {
        initializeRebalanceState(input.poolAddress);
        state = poolRebalanceStates.get(input.poolAddress)!;
    }
    
    // Determine flow state
    const flowState = determineFlowState(input.currentFeeVelocity, input.isBootstrap);
    state.flowState = flowState;
    
    // Check frequency envelope
    const frequencyCheck = isWithinFrequencyEnvelope(state, flowState);
    
    // Check all triggers
    const triggers: { trigger: RebalanceTrigger; result: { triggered: boolean; reason: string } }[] = [
        { trigger: 'DOMINANCE_FLIP', result: checkDominanceFlip(input) },
        { trigger: 'VELOCITY_COLLAPSE', result: checkVelocityCollapse(input) },
        { trigger: 'LIQUIDITY_CROWDING', result: checkLiquidityCrowding(input) },
        { trigger: 'REVISIT_SPIKE', result: checkRevisitSpike(input) },
        { trigger: 'PROFIT_LOCK', result: checkProfitLock(input) },
    ];
    
    // Find first triggered condition
    const triggered = triggers.find(t => t.result.triggered);
    
    if (!triggered) {
        state.consecutiveBlocks++;
        return {
            shouldRebalance: false,
            trigger: 'NONE',
            reason: 'NO_TRIGGER_FIRED',
            urgency: 'DEFERRED',
            estimatedGain: 0,
            estimatedCost: input.txCostUsd,
            netExpected: -input.txCostUsd,
            passedCostGate: false,
        };
    }
    
    // Check frequency envelope (unless emergency)
    const isEmergency = triggered.trigger === 'DOMINANCE_FLIP' || triggered.trigger === 'VELOCITY_COLLAPSE';
    if (!frequencyCheck.allowed && !isEmergency) {
        return {
            shouldRebalance: false,
            trigger: triggered.trigger,
            reason: `BLOCKED: ${frequencyCheck.reason}`,
            urgency: 'DEFERRED',
            estimatedGain: 0,
            estimatedCost: input.txCostUsd,
            netExpected: 0,
            passedCostGate: false,
        };
    }
    
    // Check cost gate
    const costGate = checkCostGate(input, triggered.trigger);
    
    if (!costGate.passed) {
        state.consecutiveBlocks++;
        return {
            shouldRebalance: false,
            trigger: triggered.trigger,
            reason: `COST_GATE_FAILED: expectedGain=$${costGate.estimatedGain.toFixed(4)} < required=$${(input.txCostUsd * REBALANCE_CONFIG.COST_GATE_SAFETY_FACTOR).toFixed(4)}`,
            urgency: 'DEFERRED',
            estimatedGain: costGate.estimatedGain,
            estimatedCost: costGate.estimatedCost,
            netExpected: costGate.netExpected,
            passedCostGate: false,
        };
    }
    
    // All gates passed
    state.consecutiveBlocks = 0;
    
    const urgency = isEmergency ? 'IMMEDIATE' : 'NORMAL';
    
    return {
        shouldRebalance: true,
        trigger: triggered.trigger,
        reason: triggered.result.reason,
        urgency,
        estimatedGain: costGate.estimatedGain,
        estimatedCost: costGate.estimatedCost,
        netExpected: costGate.netExpected,
        passedCostGate: true,
    };
}

/**
 * Record a completed rebalance
 */
export function recordRebalance(
    poolAddress: string,
    trigger: RebalanceTrigger,
    actualCostUsd: number
): void {
    const state = poolRebalanceStates.get(poolAddress);
    if (!state) return;
    
    state.lastRebalanceMs = Date.now();
    state.rebalanceCount++;
    state.rebalancesToday++;
    state.lastTrigger = trigger;
    totalRebalancesToday++;
    
    logger.info(
        `[REBAL] ✅ EXECUTED | trigger=${trigger} | ` +
        `cost=$${actualCostUsd.toFixed(4)} | ` +
        `count=${state.rebalanceCount} | ` +
        `today=${state.rebalancesToday} | ` +
        `flow=${state.flowState}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export function getRebalanceState(poolAddress: string): PoolRebalanceState | undefined {
    return poolRebalanceStates.get(poolAddress);
}

export function getGlobalRebalanceStats(): {
    totalToday: number;
    poolCount: number;
    avgPerPool: number;
} {
    const poolCount = poolRebalanceStates.size;
    return {
        totalToday: totalRebalancesToday,
        poolCount,
        avgPerPool: poolCount > 0 ? totalRebalancesToday / poolCount : 0,
    };
}

export function clearRebalanceState(poolAddress: string): void {
    poolRebalanceStates.delete(poolAddress);
}

export function clearAllRebalanceState(): void {
    poolRebalanceStates.clear();
    totalRebalancesToday = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logRebalanceDecision(
    poolName: string,
    decision: RebalanceDecision
): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    if (decision.shouldRebalance) {
        logger.info(
            `[REBAL] 🔄 APPROVED | ${poolName} | ` +
            `trigger=${decision.trigger} | ` +
            `urgency=${decision.urgency} | ` +
            `expectedNet=$${decision.netExpected.toFixed(4)} | ` +
            `${decision.reason}`
        );
    } else {
        logger.debug(
            `[REBAL] ⏸️ BLOCKED | ${poolName} | ` +
            `trigger=${decision.trigger} | ` +
            `${decision.reason}`
        );
    }
}

export function logRebalanceStats(): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    const stats = getGlobalRebalanceStats();
    
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info('🔄 REBALANCE STATS (Event-Driven)');
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`  Total Today: ${stats.totalToday}`);
    logger.info(`  Active Pools: ${stats.poolCount}`);
    logger.info(`  Avg Per Pool: ${stats.avgPerPool.toFixed(1)}`);
    
    for (const [addr, state] of poolRebalanceStates) {
        const elapsed = ((Date.now() - state.lastRebalanceMs) / 60000).toFixed(1);
        logger.info(
            `    ${addr.slice(0, 8)}: count=${state.rebalancesToday} | ` +
            `flow=${state.flowState} | ` +
            `lastTrigger=${state.lastTrigger} | ` +
            `${elapsed}min ago`
        );
    }
    
    logger.info('───────────────────────────────────────────────────────────────');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    initializeRebalanceState,
    determineFlowState,
    evaluateRebalance,
    recordRebalance,
    getRebalanceState,
    getGlobalRebalanceStats,
    clearRebalanceState,
    clearAllRebalanceState,
    logRebalanceDecision,
    logRebalanceStats,
    REBALANCE_CONFIG,
};

