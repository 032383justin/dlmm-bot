/**
 * Exit Suppression Escape Hatch — Tier 5 Production Safety Layer
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREVENTS INFINITE EXIT-SUPPRESSION LOOPS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PROBLEM:
 *   System can enter permanent exit-suppression loop where:
 *   - EXIT_TRIGGERED fires repeatedly
 *   - Suppression occurs hundreds/thousands of times
 *   - Fee velocity is too low to ever amortize cost targets
 *   - Positions remain open indefinitely in near-flat PnL
 * 
 * SOLUTION (4 Escape Hatches):
 *   1. EXIT SUPPRESSION TTL (45 min)
 *      If position in EXIT_TRIGGERED state > 45 min → force exit
 *      Reason: FORCED_EXIT_TTL
 * 
 *   2. SUPPRESSION COUNT CAP (60 in 30 min)
 *      Rolling 30-min window suppression counter
 *      If count > 60 → force exit
 *      Reason: FORCED_EXIT_SUPPRESS_CAP
 * 
 *   3. FEE VELOCITY AWARENESS
 *      Track feeVelocityUsdPerHr
 *      Compute timeToCostTargetEstimate
 *      If estimated time > 90 min → economically stale
 * 
 *   4. ECONOMIC STALENESS OVERRIDE
 *      If EXIT_TRIGGERED + maxBadSamples + economicallyStale → force exit
 *      Reason: FORCED_EXIT_ECONOMIC_STALE
 * 
 * INVARIANTS:
 *   - Does NOT weaken early-exit suppression
 *   - Does NOT reduce min-hold safety
 *   - Does NOT add randomness
 *   - Does NOT degrade deterministic behavior
 *   - This is an OVERRIDE layer, not a replacement
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const ESCAPE_HATCH_CONFIG = {
    /**
     * Maximum time in EXIT_TRIGGERED state before forced exit (ms)
     * 45 minutes
     */
    EXIT_TTL_MS: 45 * 60 * 1000,
    
    /**
     * Rolling window for suppression count (ms)
     * 30 minutes
     */
    SUPPRESSION_WINDOW_MS: 30 * 60 * 1000,
    
    /**
     * Maximum suppressions in rolling window before forced exit
     */
    MAX_SUPPRESSIONS_IN_WINDOW: 60,
    
    /**
     * Maximum estimated time to amortize cost before marking as stale (ms)
     * 90 minutes
     */
    MAX_TIME_TO_AMORTIZE_MS: 90 * 60 * 1000,
    
    /**
     * Minimum fee velocity (USD/hour) to avoid staleness
     * Below this, position is unlikely to recover costs
     */
    MIN_FEE_VELOCITY_USD_HR: 0.01,
    
    /**
     * Log prefix for observability
     */
    LOG_PREFIX: '[ESCAPE-HATCH]',
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Forced exit reason codes
 */
export type ForcedExitReason = 
    | 'FORCED_EXIT_TTL'           // TTL exceeded (45 min in exit state)
    | 'FORCED_EXIT_SUPPRESS_CAP'  // Suppression cap exceeded (60 in 30 min)
    | 'FORCED_EXIT_ECONOMIC_STALE'; // Economically stale + all bad signals

/**
 * Exit state for dashboard display
 */
export type ExitStateDisplay = 
    | 'HOLD'                  // Normal holding, no exit signals
    | 'EXIT_TRIGGERED'        // Exit triggered but suppressed
    | 'FORCED_EXIT_PENDING';  // Forced exit imminent

/**
 * Per-position escape hatch tracking state
 */
export interface EscapeHatchState {
    tradeId: string;
    poolAddress: string;
    
    // TTL Tracking
    exitTriggeredSince: number | null;  // Timestamp when first entered EXIT_TRIGGERED
    
    // Suppression Count Tracking (rolling window)
    suppressionEvents: number[];  // Array of timestamps when suppressed
    
    // Fee Velocity Tracking
    feeSnapshots: Array<{ timestamp: number; feesAccruedUsd: number }>;
    
    // Economic Metrics (computed)
    feeVelocityUsdPerHr: number;
    costTargetUsd: number;
    timeToCostTargetMs: number | null;  // null = infinite/unknown
    economicallyStale: boolean;
    
    // Current state
    exitState: ExitStateDisplay;
    
    // Metrics for dashboard
    exitTriggeredDurationMs: number;
    suppressCountRolling: number;
}

/**
 * Result of escape hatch evaluation
 */
export interface EscapeHatchResult {
    shouldForceExit: boolean;
    reason: ForcedExitReason | null;
    
    // Metrics for logging/dashboard
    exitTriggeredSince: number | null;
    exitTriggeredDurationMs: number;
    suppressCountRolling: number;
    feeVelocityUsdPerHr: number;
    timeToCostTargetMs: number | null;
    economicallyStale: boolean;
    exitState: ExitStateDisplay;
    
    // Debug info
    debugMessage: string;
}

/**
 * Input for escape hatch evaluation
 */
export interface EscapeHatchInput {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    
    // Position info
    entrySizeUsd: number;
    entryTimeMs: number;
    
    // Current state
    isExitTriggered: boolean;
    isSuppressed: boolean;
    badSamplesCount: number;
    badSamplesMax: number;
    
    // Fee info
    currentFeesAccruedUsd: number;
    
    // Cost info (entry + expected exit costs)
    costTargetUsd: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In-memory state per position
 * Map: tradeId -> EscapeHatchState
 */
const escapeHatchState = new Map<string, EscapeHatchState>();

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get or create escape hatch state for a position
 */
function getOrCreateState(tradeId: string, poolAddress: string): EscapeHatchState {
    let state = escapeHatchState.get(tradeId);
    if (!state) {
        state = {
            tradeId,
            poolAddress,
            exitTriggeredSince: null,
            suppressionEvents: [],
            feeSnapshots: [],
            feeVelocityUsdPerHr: 0,
            costTargetUsd: 0,
            timeToCostTargetMs: null,
            economicallyStale: false,
            exitState: 'HOLD',
            exitTriggeredDurationMs: 0,
            suppressCountRolling: 0,
        };
        escapeHatchState.set(tradeId, state);
    }
    return state;
}

/**
 * Get escape hatch state for a position (readonly)
 */
export function getEscapeHatchState(tradeId: string): EscapeHatchState | undefined {
    return escapeHatchState.get(tradeId);
}

/**
 * Get all escape hatch states (for dashboard)
 */
export function getAllEscapeHatchStates(): Map<string, EscapeHatchState> {
    return new Map(escapeHatchState);
}

/**
 * Clear escape hatch state for a position (on exit)
 */
export function clearEscapeHatchState(tradeId: string): void {
    if (escapeHatchState.has(tradeId)) {
        escapeHatchState.delete(tradeId);
        logger.debug(`${ESCAPE_HATCH_CONFIG.LOG_PREFIX} Cleared state for trade ${tradeId.slice(0, 8)}...`);
    }
}

/**
 * Clear all escape hatch state (for reset)
 */
export function clearAllEscapeHatchState(): void {
    escapeHatchState.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPRESSION EVENT TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a suppression event for a position
 * Called every time exit is suppressed
 */
export function recordSuppressionEvent(tradeId: string, poolAddress: string): void {
    const state = getOrCreateState(tradeId, poolAddress);
    const now = Date.now();
    
    // Add suppression event timestamp
    state.suppressionEvents.push(now);
    
    // Prune old events outside rolling window
    const cutoff = now - ESCAPE_HATCH_CONFIG.SUPPRESSION_WINDOW_MS;
    state.suppressionEvents = state.suppressionEvents.filter(ts => ts > cutoff);
    
    // Update rolling count
    state.suppressCountRolling = state.suppressionEvents.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEE VELOCITY TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a fee snapshot for velocity calculation
 */
export function recordFeeSnapshot(tradeId: string, poolAddress: string, feesAccruedUsd: number): void {
    const state = getOrCreateState(tradeId, poolAddress);
    const now = Date.now();
    
    state.feeSnapshots.push({ timestamp: now, feesAccruedUsd });
    
    // Keep only last 10 snapshots for velocity calculation
    if (state.feeSnapshots.length > 10) {
        state.feeSnapshots = state.feeSnapshots.slice(-10);
    }
    
    // Compute fee velocity
    updateFeeVelocity(state);
}

/**
 * Compute fee velocity from snapshots
 */
function updateFeeVelocity(state: EscapeHatchState): void {
    const snapshots = state.feeSnapshots;
    
    if (snapshots.length < 2) {
        state.feeVelocityUsdPerHr = 0;
        return;
    }
    
    // Use first and last snapshot to compute velocity
    const oldest = snapshots[0];
    const newest = snapshots[snapshots.length - 1];
    
    const timeDiffMs = newest.timestamp - oldest.timestamp;
    const feeDiff = newest.feesAccruedUsd - oldest.feesAccruedUsd;
    
    if (timeDiffMs <= 0) {
        state.feeVelocityUsdPerHr = 0;
        return;
    }
    
    // Convert to USD/hour
    const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
    state.feeVelocityUsdPerHr = feeDiff / timeDiffHours;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EVALUATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate escape hatch conditions for a position
 * 
 * This is the main function called by scanLoop to check if forced exit is needed.
 * 
 * @param input - Current position state and metrics
 * @returns EscapeHatchResult with shouldForceExit and reason
 */
export function evaluateEscapeHatch(input: EscapeHatchInput): EscapeHatchResult {
    const now = Date.now();
    const state = getOrCreateState(input.tradeId, input.poolAddress);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // UPDATE TRACKING STATE
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Update cost target
    state.costTargetUsd = input.costTargetUsd;
    
    // Track exit triggered since
    if (input.isExitTriggered) {
        if (state.exitTriggeredSince === null) {
            state.exitTriggeredSince = now;
            logger.info(
                `${ESCAPE_HATCH_CONFIG.LOG_PREFIX} EXIT_TRIGGERED started for ` +
                `${input.poolName} trade=${input.tradeId.slice(0, 8)}...`
            );
        }
    } else {
        // Exit no longer triggered - reset
        if (state.exitTriggeredSince !== null) {
            logger.info(
                `${ESCAPE_HATCH_CONFIG.LOG_PREFIX} EXIT_TRIGGERED cleared for ` +
                `${input.poolName} trade=${input.tradeId.slice(0, 8)}...`
            );
        }
        state.exitTriggeredSince = null;
    }
    
    // Record suppression event if currently suppressed
    if (input.isSuppressed) {
        recordSuppressionEvent(input.tradeId, input.poolAddress);
    }
    
    // Record fee snapshot
    recordFeeSnapshot(input.tradeId, input.poolAddress, input.currentFeesAccruedUsd);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE DERIVED METRICS
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Exit triggered duration
    state.exitTriggeredDurationMs = state.exitTriggeredSince !== null 
        ? now - state.exitTriggeredSince 
        : 0;
    
    // Time to cost target estimate
    const remainingCost = state.costTargetUsd - input.currentFeesAccruedUsd;
    if (state.feeVelocityUsdPerHr > ESCAPE_HATCH_CONFIG.MIN_FEE_VELOCITY_USD_HR && remainingCost > 0) {
        const hoursToAmortize = remainingCost / state.feeVelocityUsdPerHr;
        state.timeToCostTargetMs = hoursToAmortize * 60 * 60 * 1000;
    } else if (remainingCost <= 0) {
        state.timeToCostTargetMs = 0; // Already amortized
    } else {
        state.timeToCostTargetMs = null; // Infinite - fee velocity too low
    }
    
    // Economic staleness
    state.economicallyStale = 
        state.timeToCostTargetMs === null || 
        state.timeToCostTargetMs > ESCAPE_HATCH_CONFIG.MAX_TIME_TO_AMORTIZE_MS;
    
    // Prune old suppression events
    const cutoff = now - ESCAPE_HATCH_CONFIG.SUPPRESSION_WINDOW_MS;
    state.suppressionEvents = state.suppressionEvents.filter(ts => ts > cutoff);
    state.suppressCountRolling = state.suppressionEvents.length;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DETERMINE EXIT STATE FOR DASHBOARD
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (input.isExitTriggered) {
        // Check if forced exit is pending
        const ttlExceeded = state.exitTriggeredDurationMs > ESCAPE_HATCH_CONFIG.EXIT_TTL_MS;
        const suppressCapExceeded = state.suppressCountRolling >= ESCAPE_HATCH_CONFIG.MAX_SUPPRESSIONS_IN_WINDOW;
        const economicStalenessTriggered = 
            input.badSamplesCount >= input.badSamplesMax && 
            state.economicallyStale;
        
        if (ttlExceeded || suppressCapExceeded || economicStalenessTriggered) {
            state.exitState = 'FORCED_EXIT_PENDING';
        } else {
            state.exitState = 'EXIT_TRIGGERED';
        }
    } else {
        state.exitState = 'HOLD';
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK ESCAPE HATCH CONDITIONS (ORDER MATTERS)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // ESCAPE HATCH 1: EXIT SUPPRESSION TTL
    if (state.exitTriggeredDurationMs > ESCAPE_HATCH_CONFIG.EXIT_TTL_MS) {
        const durationMin = Math.floor(state.exitTriggeredDurationMs / 60000);
        
        logger.warn(
            `${ESCAPE_HATCH_CONFIG.LOG_PREFIX} 🚨 FORCED_EXIT_TTL triggered for ` +
            `${input.poolName} trade=${input.tradeId.slice(0, 8)}... | ` +
            `duration=${durationMin}min > TTL=${ESCAPE_HATCH_CONFIG.EXIT_TTL_MS / 60000}min | ` +
            `suppressCount=${state.suppressCountRolling} | ` +
            `feeVelocity=$${state.feeVelocityUsdPerHr.toFixed(4)}/hr`
        );
        
        return buildResult(state, true, 'FORCED_EXIT_TTL', 
            `TTL exceeded: ${durationMin}min in EXIT_TRIGGERED state`);
    }
    
    // ESCAPE HATCH 2: SUPPRESSION COUNT CAP
    if (state.suppressCountRolling >= ESCAPE_HATCH_CONFIG.MAX_SUPPRESSIONS_IN_WINDOW) {
        const windowMin = Math.floor(ESCAPE_HATCH_CONFIG.SUPPRESSION_WINDOW_MS / 60000);
        
        logger.warn(
            `${ESCAPE_HATCH_CONFIG.LOG_PREFIX} 🚨 FORCED_EXIT_SUPPRESS_CAP triggered for ` +
            `${input.poolName} trade=${input.tradeId.slice(0, 8)}... | ` +
            `suppressions=${state.suppressCountRolling} > cap=${ESCAPE_HATCH_CONFIG.MAX_SUPPRESSIONS_IN_WINDOW} ` +
            `in ${windowMin}min window | ` +
            `feeVelocity=$${state.feeVelocityUsdPerHr.toFixed(4)}/hr`
        );
        
        return buildResult(state, true, 'FORCED_EXIT_SUPPRESS_CAP',
            `Suppression cap exceeded: ${state.suppressCountRolling}/${ESCAPE_HATCH_CONFIG.MAX_SUPPRESSIONS_IN_WINDOW} in ${windowMin}min`);
    }
    
    // ESCAPE HATCH 3: ECONOMIC STALENESS OVERRIDE
    // Requires: EXIT_TRIGGERED + badSamples at max + economically stale
    if (input.isExitTriggered && 
        input.badSamplesCount >= input.badSamplesMax && 
        state.economicallyStale) {
        
        const ttaMin = state.timeToCostTargetMs !== null 
            ? Math.floor(state.timeToCostTargetMs / 60000)
            : 'INF';
        
        logger.warn(
            `${ESCAPE_HATCH_CONFIG.LOG_PREFIX} 🚨 FORCED_EXIT_ECONOMIC_STALE triggered for ` +
            `${input.poolName} trade=${input.tradeId.slice(0, 8)}... | ` +
            `badSamples=${input.badSamplesCount}/${input.badSamplesMax} (MAX) | ` +
            `economicallyStale=true | ` +
            `timeToCostTarget=${ttaMin}min | ` +
            `feeVelocity=$${state.feeVelocityUsdPerHr.toFixed(4)}/hr | ` +
            `costRemaining=$${(state.costTargetUsd - input.currentFeesAccruedUsd).toFixed(2)}`
        );
        
        return buildResult(state, true, 'FORCED_EXIT_ECONOMIC_STALE',
            `Economic staleness: badSamples=MAX, timeToCostTarget=${ttaMin}min > 90min`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // NO FORCED EXIT — LOG STATUS IF EXIT_TRIGGERED
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (input.isExitTriggered && input.isSuppressed) {
        const durationMin = Math.floor(state.exitTriggeredDurationMs / 60000);
        const ttlRemainMin = Math.floor((ESCAPE_HATCH_CONFIG.EXIT_TTL_MS - state.exitTriggeredDurationMs) / 60000);
        const capRemain = ESCAPE_HATCH_CONFIG.MAX_SUPPRESSIONS_IN_WINDOW - state.suppressCountRolling;
        const ttaMin = state.timeToCostTargetMs !== null 
            ? Math.floor(state.timeToCostTargetMs / 60000)
            : 'INF';
        
        logger.info(
            `${ESCAPE_HATCH_CONFIG.LOG_PREFIX} POLICY_SUPPRESSION ${input.poolName} | ` +
            `exitDur=${durationMin}min (TTL in ${ttlRemainMin}min) | ` +
            `suppressCount=${state.suppressCountRolling} (cap in ${capRemain}) | ` +
            `feeVelocity=$${state.feeVelocityUsdPerHr.toFixed(4)}/hr | ` +
            `timeToCostTarget=${ttaMin}min | ` +
            `stale=${state.economicallyStale}`
        );
    }
    
    return buildResult(state, false, null, 'No forced exit conditions met');
}

/**
 * Build escape hatch result
 */
function buildResult(
    state: EscapeHatchState,
    shouldForceExit: boolean,
    reason: ForcedExitReason | null,
    debugMessage: string
): EscapeHatchResult {
    return {
        shouldForceExit,
        reason,
        exitTriggeredSince: state.exitTriggeredSince,
        exitTriggeredDurationMs: state.exitTriggeredDurationMs,
        suppressCountRolling: state.suppressCountRolling,
        feeVelocityUsdPerHr: state.feeVelocityUsdPerHr,
        timeToCostTargetMs: state.timeToCostTargetMs,
        economicallyStale: state.economicallyStale,
        exitState: state.exitState,
        debugMessage,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log comprehensive escape hatch status for a position
 */
export function logEscapeHatchStatus(
    tradeId: string,
    poolName: string,
    result: EscapeHatchResult
): void {
    const ttlRemainMin = result.exitTriggeredSince !== null
        ? Math.max(0, Math.floor((ESCAPE_HATCH_CONFIG.EXIT_TTL_MS - result.exitTriggeredDurationMs) / 60000))
        : 'N/A';
    
    const capRemain = ESCAPE_HATCH_CONFIG.MAX_SUPPRESSIONS_IN_WINDOW - result.suppressCountRolling;
    
    const ttaMin = result.timeToCostTargetMs !== null 
        ? Math.floor(result.timeToCostTargetMs / 60000)
        : 'INF';
    
    logger.debug(
        `${ESCAPE_HATCH_CONFIG.LOG_PREFIX} STATUS ${poolName} trade=${tradeId.slice(0, 8)}... | ` +
        `state=${result.exitState} | ` +
        `ttlRemain=${ttlRemainMin}min | ` +
        `suppressCount=${result.suppressCountRolling}/${ESCAPE_HATCH_CONFIG.MAX_SUPPRESSIONS_IN_WINDOW} | ` +
        `feeVel=$${result.feeVelocityUsdPerHr.toFixed(4)}/hr | ` +
        `tta=${ttaMin}min | ` +
        `stale=${result.economicallyStale}`
    );
}

/**
 * Get summary of all escape hatch states for logging
 */
export function getEscapeHatchSummary(): {
    total: number;
    exitTriggered: number;
    forcedExitPending: number;
    economicallyStale: number;
    avgSuppressionCount: number;
    avgFeeVelocity: number;
} {
    const states = Array.from(escapeHatchState.values());
    
    if (states.length === 0) {
        return {
            total: 0,
            exitTriggered: 0,
            forcedExitPending: 0,
            economicallyStale: 0,
            avgSuppressionCount: 0,
            avgFeeVelocity: 0,
        };
    }
    
    let exitTriggered = 0;
    let forcedExitPending = 0;
    let economicallyStale = 0;
    let totalSuppressions = 0;
    let totalFeeVelocity = 0;
    
    for (const state of states) {
        if (state.exitState === 'EXIT_TRIGGERED') exitTriggered++;
        if (state.exitState === 'FORCED_EXIT_PENDING') forcedExitPending++;
        if (state.economicallyStale) economicallyStale++;
        totalSuppressions += state.suppressCountRolling;
        totalFeeVelocity += state.feeVelocityUsdPerHr;
    }
    
    return {
        total: states.length,
        exitTriggered,
        forcedExitPending,
        economicallyStale,
        avgSuppressionCount: totalSuppressions / states.length,
        avgFeeVelocity: totalFeeVelocity / states.length,
    };
}

