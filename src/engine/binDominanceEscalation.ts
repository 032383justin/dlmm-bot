/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BIN DOMINANCE ESCALATION — PRIMARY WEAPON
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * OBJECTIVE: Own the bin traders are forced to cross.
 * CORE RULE: Liquidity must follow FEE FLOW, not PRICE.
 * 
 * ESCALATION STATES:
 * - LOCK:   100% liquidity in 1 bin (dominant)
 * - SPILL:  70/30 across Dominant/Threat bin
 * - SWEEP:  Move entire position to new dominant bin
 * - VACATE: Exit pool immediately
 * 
 * NO WIDE DISTRIBUTIONS. EVER.
 * This is deliberate bullying.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { PREDATOR_MODE_V1_ENABLED } from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type EscalationState = 'LOCK' | 'SPILL' | 'SWEEP' | 'VACATE';

export interface BinMetrics {
    binId: number;
    feeVelocity: number;           // Fees per second
    tradeCount: number;            // Trades in window
    revisitRate: number;           // How often price returns (0-1)
    liquidityCompetition: number;  // External liquidity in bin (USD)
    lastActivityMs: number;        // Last trade timestamp
    isOurs: boolean;               // We have liquidity here
}

export interface DominanceAnalysis {
    dominantBin: BinMetrics | null;
    threatBin: BinMetrics | null;
    deadBins: BinMetrics[];
    currentState: EscalationState;
    recommendedState: EscalationState;
    stateChangeReason: string;
    allocation: BinAllocation[];
}

export interface BinAllocation {
    binId: number;
    allocationPct: number;
}

export interface PoolBinState {
    poolAddress: string;
    poolName: string;
    bins: Map<number, BinMetrics>;
    currentState: EscalationState;
    lastStateChange: number;
    dominantBinId: number | null;
    threatBinId: number | null;
    sweepCount: number;
    lockDurationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const BIN_DOMINANCE_CONFIG = {
    /** Telemetry tick interval */
    TICK_INTERVAL_MS: 15 * 1000,  // ≤15s as specified
    
    /** Threat bin threshold: adjacent bin with ≥70% of DB activity */
    THREAT_ACTIVITY_RATIO: 0.70,
    
    /** Dead bin decay threshold (fee velocity) */
    DEAD_BIN_VELOCITY_THRESHOLD: 0.00001,  // Near-zero
    
    /** Dead bin duration before flagged */
    DEAD_BIN_DURATION_MS: 60 * 1000,  // 1 minute
    
    /** Dominance flip threshold */
    DOMINANCE_FLIP_RATIO: 1.3,  // New bin must have 1.3x fee velocity
    
    /** Velocity collapse threshold */
    VELOCITY_COLLAPSE_RATIO: 0.40,  // 40% drop triggers action
    
    /** LOCK allocation */
    LOCK_ALLOCATION: { primary: 1.0, secondary: 0 },
    
    /** SPILL allocation */
    SPILL_ALLOCATION: { primary: 0.70, secondary: 0.30 },
    
    /** Max bins to track per pool */
    MAX_BINS_TRACKED: 10,
    
    /** Rolling window for metrics */
    ROLLING_WINDOW_MS: 5 * 60 * 1000,  // 5 minutes
    
    /** Minimum fee velocity to consider bin active */
    MIN_ACTIVE_VELOCITY: 0.0001,
    
    /** Crowding threshold (% increase in external liquidity) */
    CROWDING_THRESHOLD_PCT: 0.20,  // 20% increase
    
    /** Revisit spike threshold */
    REVISIT_SPIKE_THRESHOLD: 0.30,  // 30% increase in revisit rate
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const poolBinStates = new Map<string, PoolBinState>();

// Metrics history for rolling calculations
interface BinHistory {
    feeVelocities: { timestamp: number; value: number }[];
    tradeCounts: { timestamp: number; value: number }[];
    revisitRates: { timestamp: number; value: number }[];
}
const binHistories = new Map<string, Map<number, BinHistory>>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize bin state for a pool
 */
export function initializeBinState(
    poolAddress: string,
    poolName: string,
    initialBinId: number
): PoolBinState {
    const state: PoolBinState = {
        poolAddress,
        poolName,
        bins: new Map(),
        currentState: 'LOCK',  // Start in LOCK
        lastStateChange: Date.now(),
        dominantBinId: initialBinId,
        threatBinId: null,
        sweepCount: 0,
        lockDurationMs: 0,
    };
    
    poolBinStates.set(poolAddress, state);
    binHistories.set(poolAddress, new Map());
    
    logger.info(
        `[BIN-DOM] 🎯 Initialized bin state | ${poolName} | ` +
        `startBin=${initialBinId} | state=LOCK`
    );
    
    return state;
}

/**
 * Update bin metrics from telemetry tick
 */
export function updateBinMetrics(
    poolAddress: string,
    binId: number,
    metrics: Partial<BinMetrics>
): void {
    const state = poolBinStates.get(poolAddress);
    if (!state) return;
    
    const now = Date.now();
    const existing = state.bins.get(binId) || {
        binId,
        feeVelocity: 0,
        tradeCount: 0,
        revisitRate: 0,
        liquidityCompetition: 0,
        lastActivityMs: now,
        isOurs: false,
    };
    
    const updated: BinMetrics = {
        ...existing,
        ...metrics,
        lastActivityMs: now,
    };
    
    state.bins.set(binId, updated);
    
    // Update history
    updateBinHistory(poolAddress, binId, updated);
}

/**
 * Update bin history for rolling calculations
 */
function updateBinHistory(
    poolAddress: string,
    binId: number,
    metrics: BinMetrics
): void {
    const poolHistory = binHistories.get(poolAddress);
    if (!poolHistory) return;
    
    const now = Date.now();
    const cutoff = now - BIN_DOMINANCE_CONFIG.ROLLING_WINDOW_MS;
    
    let history = poolHistory.get(binId);
    if (!history) {
        history = {
            feeVelocities: [],
            tradeCounts: [],
            revisitRates: [],
        };
        poolHistory.set(binId, history);
    }
    
    // Add new data points
    history.feeVelocities.push({ timestamp: now, value: metrics.feeVelocity });
    history.tradeCounts.push({ timestamp: now, value: metrics.tradeCount });
    history.revisitRates.push({ timestamp: now, value: metrics.revisitRate });
    
    // Prune old data
    history.feeVelocities = history.feeVelocities.filter(p => p.timestamp > cutoff);
    history.tradeCounts = history.tradeCounts.filter(p => p.timestamp > cutoff);
    history.revisitRates = history.revisitRates.filter(p => p.timestamp > cutoff);
}

/**
 * Analyze dominance and determine recommended state
 */
export function analyzeDominance(poolAddress: string): DominanceAnalysis | null {
    const state = poolBinStates.get(poolAddress);
    if (!state) return null;
    
    const now = Date.now();
    const bins = Array.from(state.bins.values());
    
    if (bins.length === 0) {
        return null;
    }
    
    // Sort bins by fee velocity (descending)
    const sortedBins = [...bins].sort((a, b) => b.feeVelocity - a.feeVelocity);
    
    // Identify dominant bin (highest fee velocity)
    const dominantBin = sortedBins[0];
    
    // Identify threat bin (adjacent with ≥70% activity)
    let threatBin: BinMetrics | null = null;
    for (const bin of sortedBins.slice(1)) {
        const isAdjacent = Math.abs(bin.binId - dominantBin.binId) <= 1;
        const activityRatio = dominantBin.feeVelocity > 0 
            ? bin.feeVelocity / dominantBin.feeVelocity 
            : 0;
        
        if (isAdjacent && activityRatio >= BIN_DOMINANCE_CONFIG.THREAT_ACTIVITY_RATIO) {
            threatBin = bin;
            break;
        }
    }
    
    // Identify dead bins
    const deadBins = bins.filter(bin => {
        const isDead = bin.feeVelocity < BIN_DOMINANCE_CONFIG.DEAD_BIN_VELOCITY_THRESHOLD;
        const deadDuration = now - bin.lastActivityMs;
        return isDead && deadDuration >= BIN_DOMINANCE_CONFIG.DEAD_BIN_DURATION_MS;
    });
    
    // Determine recommended state
    const { recommendedState, stateChangeReason } = determineRecommendedState(
        state,
        dominantBin,
        threatBin,
        deadBins
    );
    
    // Calculate allocation based on state
    const allocation = calculateAllocation(recommendedState, dominantBin, threatBin);
    
    return {
        dominantBin,
        threatBin,
        deadBins,
        currentState: state.currentState,
        recommendedState,
        stateChangeReason,
        allocation,
    };
}

/**
 * Determine recommended escalation state
 */
function determineRecommendedState(
    state: PoolBinState,
    dominantBin: BinMetrics,
    threatBin: BinMetrics | null,
    deadBins: BinMetrics[]
): { recommendedState: EscalationState; stateChangeReason: string } {
    const now = Date.now();
    
    // Check for VACATE conditions
    // All bins are dead = pool is dead
    const allDead = Array.from(state.bins.values()).every(
        bin => bin.feeVelocity < BIN_DOMINANCE_CONFIG.DEAD_BIN_VELOCITY_THRESHOLD
    );
    if (allDead && state.bins.size > 0) {
        return {
            recommendedState: 'VACATE',
            stateChangeReason: 'ALL_BINS_DEAD: Pool has no fee activity',
        };
    }
    
    // Check for dominance flip (need to SWEEP)
    if (state.dominantBinId !== null && state.dominantBinId !== dominantBin.binId) {
        const oldDominant = state.bins.get(state.dominantBinId);
        if (oldDominant) {
            const flipRatio = dominantBin.feeVelocity / Math.max(0.000001, oldDominant.feeVelocity);
            if (flipRatio >= BIN_DOMINANCE_CONFIG.DOMINANCE_FLIP_RATIO) {
                return {
                    recommendedState: 'SWEEP',
                    stateChangeReason: `DOMINANCE_FLIP: bin ${dominantBin.binId} has ${flipRatio.toFixed(1)}× velocity`,
                };
            }
        }
    }
    
    // Check for threat requiring SPILL
    if (threatBin) {
        return {
            recommendedState: 'SPILL',
            stateChangeReason: `THREAT_DETECTED: bin ${threatBin.binId} at ${((threatBin.feeVelocity / dominantBin.feeVelocity) * 100).toFixed(0)}% activity`,
        };
    }
    
    // Default to LOCK (single-bin dominance)
    return {
        recommendedState: 'LOCK',
        stateChangeReason: 'LOCK_MAINTAINED: Single-bin dominance optimal',
    };
}

/**
 * Calculate bin allocation based on state
 */
function calculateAllocation(
    state: EscalationState,
    dominantBin: BinMetrics,
    threatBin: BinMetrics | null
): BinAllocation[] {
    switch (state) {
        case 'LOCK':
            return [{ binId: dominantBin.binId, allocationPct: 100 }];
            
        case 'SPILL':
            if (threatBin) {
                return [
                    { binId: dominantBin.binId, allocationPct: 70 },
                    { binId: threatBin.binId, allocationPct: 30 },
                ];
            }
            return [{ binId: dominantBin.binId, allocationPct: 100 }];
            
        case 'SWEEP':
            return [{ binId: dominantBin.binId, allocationPct: 100 }];
            
        case 'VACATE':
            return [];  // Exit position
            
        default:
            return [{ binId: dominantBin.binId, allocationPct: 100 }];
    }
}

/**
 * Execute state transition
 */
export function executeStateTransition(
    poolAddress: string,
    newState: EscalationState,
    reason: string
): { executed: boolean; action: string } {
    const state = poolBinStates.get(poolAddress);
    if (!state) {
        return { executed: false, action: 'NO_STATE' };
    }
    
    const oldState = state.currentState;
    
    if (oldState === newState) {
        return { executed: false, action: 'NO_CHANGE' };
    }
    
    // Update state
    state.currentState = newState;
    state.lastStateChange = Date.now();
    
    if (newState === 'SWEEP') {
        state.sweepCount++;
    }
    
    const action = getStateAction(oldState, newState);
    
    logger.info(
        `[BIN-DOM] ⚡ STATE_TRANSITION | ${state.poolName} | ` +
        `${oldState} → ${newState} | ${reason} | ` +
        `action=${action}`
    );
    
    return { executed: true, action };
}

/**
 * Get action description for state transition
 */
function getStateAction(oldState: EscalationState, newState: EscalationState): string {
    switch (newState) {
        case 'LOCK':
            return 'CONCENTRATE_100_PCT';
        case 'SPILL':
            return 'SPLIT_70_30';
        case 'SWEEP':
            return 'MOVE_TO_NEW_DOMINANT';
        case 'VACATE':
            return 'EXIT_POOL_IMMEDIATELY';
        default:
            return 'UNKNOWN';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROLLING METRIC CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get velocity change over rolling window
 */
export function getVelocityChange(poolAddress: string, binId: number): number {
    const poolHistory = binHistories.get(poolAddress);
    if (!poolHistory) return 0;
    
    const history = poolHistory.get(binId);
    if (!history || history.feeVelocities.length < 2) return 0;
    
    const oldest = history.feeVelocities[0].value;
    const newest = history.feeVelocities[history.feeVelocities.length - 1].value;
    
    if (oldest === 0) return 0;
    return (newest - oldest) / oldest;
}

/**
 * Check if velocity has collapsed
 */
export function hasVelocityCollapsed(poolAddress: string, binId: number): boolean {
    const change = getVelocityChange(poolAddress, binId);
    return change <= -BIN_DOMINANCE_CONFIG.VELOCITY_COLLAPSE_RATIO;
}

/**
 * Get revisit rate change
 */
export function getRevisitRateChange(poolAddress: string, binId: number): number {
    const poolHistory = binHistories.get(poolAddress);
    if (!poolHistory) return 0;
    
    const history = poolHistory.get(binId);
    if (!history || history.revisitRates.length < 2) return 0;
    
    const oldest = history.revisitRates[0].value;
    const newest = history.revisitRates[history.revisitRates.length - 1].value;
    
    if (oldest === 0) return newest > 0 ? 1 : 0;
    return (newest - oldest) / oldest;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current state for a pool
 */
export function getPoolBinState(poolAddress: string): PoolBinState | undefined {
    return poolBinStates.get(poolAddress);
}

/**
 * Clear state for a pool
 */
export function clearPoolBinState(poolAddress: string): void {
    poolBinStates.delete(poolAddress);
    binHistories.delete(poolAddress);
}

/**
 * Clear all state
 */
export function clearAllBinState(): void {
    poolBinStates.clear();
    binHistories.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logBinDominanceStatus(poolAddress: string): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    const state = poolBinStates.get(poolAddress);
    if (!state) return;
    
    const analysis = analyzeDominance(poolAddress);
    if (!analysis) return;
    
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`🎯 BIN DOMINANCE | ${state.poolName}`);
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`  State: ${state.currentState}`);
    logger.info(`  Dominant Bin: ${analysis.dominantBin?.binId || 'NONE'} (velocity=${analysis.dominantBin?.feeVelocity.toFixed(6) || 0})`);
    logger.info(`  Threat Bin: ${analysis.threatBin?.binId || 'NONE'}`);
    logger.info(`  Dead Bins: ${analysis.deadBins.length}`);
    logger.info(`  Sweeps: ${state.sweepCount}`);
    
    if (analysis.recommendedState !== state.currentState) {
        logger.info(`  ⚠️ RECOMMENDED: ${analysis.recommendedState} (${analysis.stateChangeReason})`);
    }
    
    logger.info('  Allocation:');
    for (const alloc of analysis.allocation) {
        logger.info(`    Bin ${alloc.binId}: ${alloc.allocationPct}%`);
    }
    
    logger.info('───────────────────────────────────────────────────────────────');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    initializeBinState,
    updateBinMetrics,
    analyzeDominance,
    executeStateTransition,
    getVelocityChange,
    hasVelocityCollapsed,
    getRevisitRateChange,
    getPoolBinState,
    clearPoolBinState,
    clearAllBinState,
    logBinDominanceStatus,
    BIN_DOMINANCE_CONFIG,
};

