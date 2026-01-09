/**
 * Harmonic Exit Gating — Prevent Exit Spam and Churn
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FIX: HARMONIC_EXIT triggers repeatedly when suppressed, causing log spam and
 * decision churn. Positions get stuck in "EXIT_TRIGGERED but suppressed" mode.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * SOLUTION:
 *   1. Require minimum hold time before HARMONIC_EXIT can trigger
 *   2. Require consecutive bad confirmations (not just one bad sample)
 *   3. Enter cooldown after suppressed exit (no re-triggering for 15 min)
 *   4. Rate limit exit triggers per hour per position
 *   5. Allow hard emergency bypass for catastrophic conditions
 * 
 * STATE MACHINE:
 *   HOLD → BAD_SAMPLE(s) → EXIT_TRIGGERED → SUPPRESSED → COOLDOWN → HOLD/EXIT
 *                                                    ↓
 *                              cooldown expires → conditions checked again
 *                                                    ↓
 *                              still bad → re-trigger (rate limited)
 *                              improved → back to HOLD
 * 
 * HARD EXCEPTIONS (bypass all gates):
 *   - healthScore < 0.20 with badSamples >= 3
 *   - KILL_SWITCH or other risk exits
 *   - Pool migration / deprecation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { EXIT_CONFIG } from './exitHysteresis';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const HARMONIC_GATING_CONFIG = {
    /**
     * Minimum hold time before HARMONIC_EXIT can trigger (ms)
     */
    minHoldMs: EXIT_CONFIG.harmonicMinHoldMinutes * 60 * 1000,
    
    /**
     * Consecutive bad checks required before exit triggers
     */
    confirmationsRequired: EXIT_CONFIG.harmonicExitConfirmations,
    
    /**
     * Cooldown after suppressed exit (ms)
     */
    suppressCooldownMs: EXIT_CONFIG.exitSuppressCooldownSeconds * 1000,
    
    /**
     * Maximum exit triggers per hour per position
     */
    maxTriggersPerHour: EXIT_CONFIG.exitTriggerMaxPerHour,
    
    /**
     * Emergency health threshold (bypass all gates if below)
     */
    emergencyHealthThreshold: EXIT_CONFIG.emergencyHealthThreshold,
    
    /**
     * Minimum bad samples for emergency override
     */
    emergencyMinBadSamples: EXIT_CONFIG.emergencyMinBadSamples,
    
    /**
     * Rolling window for rate limiting (ms)
     */
    rateLimitWindowMs: 60 * 60 * 1000, // 1 hour
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-position harmonic gating state
 */
export interface HarmonicGatingState {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    
    /** Consecutive bad samples (reset on good sample) */
    harmonicBadConsecutive: number;
    
    /** Exit cooldown end timestamp */
    exitCooldownUntilMs: number;
    
    /** Rolling list of exit trigger timestamps (for rate limiting) */
    exitTriggerTimestamps: number[];
    
    /** Last evaluation timestamp */
    lastEvaluationMs: number;
    
    /** Current gating state */
    state: HarmonicGatingStateType;
    
    /** Last suppression reason (for logging) */
    lastSuppressionReason?: string;
    
    /** Whether suppression has been logged (once per cooldown period) */
    suppressionLogged: boolean;
}

export type HarmonicGatingStateType = 
    | 'HOLD'                // Normal operation, no exit intent
    | 'PENDING_CONFIRMATION' // Bad samples detected, waiting for confirmations
    | 'EXIT_READY'          // Confirmations met, ready to trigger
    | 'EXIT_TRIGGERED'      // Exit was triggered (awaiting execution)
    | 'SUPPRESSED_COOLDOWN'; // Exit suppressed, in cooldown

/**
 * Result of harmonic exit gating check
 */
export interface HarmonicGatingResult {
    /** Whether exit should be allowed to trigger */
    allowExit: boolean;
    
    /** Gate that blocked exit (if blocked) */
    blockedBy?: HarmonicGateType;
    
    /** Human-readable reason */
    reason: string;
    
    /** Current state for position */
    state: HarmonicGatingStateType;
    
    /** Debug info */
    debug: {
        holdTimeMs: number;
        holdTimeMinutes: number;
        minHoldMinutes: number;
        badConsecutive: number;
        confirmationsRequired: number;
        cooldownRemainingSec: number;
        triggersInLastHour: number;
        maxTriggersPerHour: number;
        isEmergency: boolean;
    };
}

export type HarmonicGateType = 
    | 'MIN_HOLD_TIME'
    | 'NEEDS_CONFIRMATIONS'
    | 'COOLDOWN'
    | 'RATE_LIMITED'
    | 'NONE';

/**
 * Input for harmonic gating evaluation
 */
export interface HarmonicGatingInput {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    entryTimeMs: number;
    healthScore: number;
    isBadSample: boolean;
    badSamplesCount: number;
    isRiskExit: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-position harmonic gating state
 * Map: tradeId -> HarmonicGatingState
 */
const gatingState = new Map<string, HarmonicGatingState>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get or create gating state for a position
 */
function getOrCreateState(
    tradeId: string,
    poolAddress: string,
    poolName: string
): HarmonicGatingState {
    let state = gatingState.get(tradeId);
    if (!state) {
        state = {
            tradeId,
            poolAddress,
            poolName,
            harmonicBadConsecutive: 0,
            exitCooldownUntilMs: 0,
            exitTriggerTimestamps: [],
            lastEvaluationMs: Date.now(),
            state: 'HOLD',
            suppressionLogged: false,
        };
        gatingState.set(tradeId, state);
    }
    return state;
}

/**
 * Evaluate whether a HARMONIC_EXIT should be allowed to trigger.
 * 
 * This is the main gating function called before triggering any harmonic exit.
 * 
 * @param input - Gating input with position state and current metrics
 * @returns Gating result indicating whether exit is allowed
 */
export function evaluateHarmonicExitGating(
    input: HarmonicGatingInput
): HarmonicGatingResult {
    const now = Date.now();
    const state = getOrCreateState(input.tradeId, input.poolAddress, input.poolName);
    const config = HARMONIC_GATING_CONFIG;
    
    const holdTimeMs = now - input.entryTimeMs;
    const holdTimeMinutes = holdTimeMs / (60 * 1000);
    const minHoldMinutes = config.minHoldMs / (60 * 1000);
    
    // Prune old exit trigger timestamps (outside rate limit window)
    const windowStart = now - config.rateLimitWindowMs;
    state.exitTriggerTimestamps = state.exitTriggerTimestamps.filter(ts => ts > windowStart);
    const triggersInLastHour = state.exitTriggerTimestamps.length;
    
    // Calculate cooldown remaining
    const cooldownRemainingSec = Math.max(0, (state.exitCooldownUntilMs - now) / 1000);
    const inCooldown = state.exitCooldownUntilMs > now;
    
    // Update bad sample counter
    if (input.isBadSample) {
        state.harmonicBadConsecutive++;
    } else {
        // Good sample - reset counter and potentially clear suppression
        if (state.harmonicBadConsecutive > 0) {
            logger.debug(
                `[HARMONIC_GATE] pool=${input.poolName} trade=${input.tradeId.slice(0, 8)}... ` +
                `badConsecutive reset (was ${state.harmonicBadConsecutive})`
            );
        }
        state.harmonicBadConsecutive = 0;
        
        // If we were in suppressed cooldown and got a good sample, transition back to HOLD
        if (state.state === 'SUPPRESSED_COOLDOWN') {
            state.state = 'HOLD';
            state.exitCooldownUntilMs = 0;
            state.suppressionLogged = false;
        }
    }
    
    // Check for emergency bypass (catastrophic conditions)
    const isEmergency = checkEmergencyBypass(input);
    
    // Build debug info
    const debug = {
        holdTimeMs,
        holdTimeMinutes: Math.round(holdTimeMinutes * 10) / 10,
        minHoldMinutes,
        badConsecutive: state.harmonicBadConsecutive,
        confirmationsRequired: config.confirmationsRequired,
        cooldownRemainingSec: Math.round(cooldownRemainingSec),
        triggersInLastHour,
        maxTriggersPerHour: config.maxTriggersPerHour,
        isEmergency,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BYPASS: Risk exits always allowed
    // ═══════════════════════════════════════════════════════════════════════════
    if (input.isRiskExit) {
        state.state = 'EXIT_TRIGGERED';
        return {
            allowExit: true,
            reason: 'Risk exit - bypass all gates',
            state: 'EXIT_TRIGGERED',
            debug,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BYPASS: Emergency conditions
    // ═══════════════════════════════════════════════════════════════════════════
    if (isEmergency) {
        state.state = 'EXIT_TRIGGERED';
        logger.warn(
            `[HARMONIC_GATE] EMERGENCY EXIT pool=${input.poolName} ` +
            `health=${input.healthScore.toFixed(2)} badSamples=${input.badSamplesCount}`
        );
        return {
            allowExit: true,
            reason: `Emergency: health=${input.healthScore.toFixed(2)} < ${config.emergencyHealthThreshold}`,
            state: 'EXIT_TRIGGERED',
            debug,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 1: Minimum hold time
    // ═══════════════════════════════════════════════════════════════════════════
    if (holdTimeMs < config.minHoldMs) {
        state.state = 'HOLD';
        return {
            allowExit: false,
            blockedBy: 'MIN_HOLD_TIME',
            reason: `Hold time ${debug.holdTimeMinutes}min < ${minHoldMinutes}min`,
            state: 'HOLD',
            debug,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 2: Cooldown check
    // ═══════════════════════════════════════════════════════════════════════════
    if (inCooldown) {
        // Only log once per cooldown period
        if (!state.suppressionLogged) {
            logger.info(
                `[EXIT_GATED] pool=${input.poolName} reason=COOLDOWN ` +
                `remaining=${Math.round(cooldownRemainingSec)}s ` +
                `badConsecutive=${state.harmonicBadConsecutive}`
            );
            state.suppressionLogged = true;
        }
        
        state.state = 'SUPPRESSED_COOLDOWN';
        return {
            allowExit: false,
            blockedBy: 'COOLDOWN',
            reason: `Cooldown: ${Math.round(cooldownRemainingSec)}s remaining`,
            state: 'SUPPRESSED_COOLDOWN',
            debug,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 3: Rate limiting
    // ═══════════════════════════════════════════════════════════════════════════
    if (triggersInLastHour >= config.maxTriggersPerHour) {
        logger.info(
            `[EXIT_GATED] pool=${input.poolName} reason=RATE_LIMITED ` +
            `triggers=${triggersInLastHour}/${config.maxTriggersPerHour} in last hour`
        );
        
        return {
            allowExit: false,
            blockedBy: 'RATE_LIMITED',
            reason: `Rate limited: ${triggersInLastHour}/${config.maxTriggersPerHour} triggers/hour`,
            state: state.state,
            debug,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 4: Confirmation requirement
    // ═══════════════════════════════════════════════════════════════════════════
    if (state.harmonicBadConsecutive < config.confirmationsRequired) {
        state.state = 'PENDING_CONFIRMATION';
        
        // Only log when bad samples are accumulating
        if (state.harmonicBadConsecutive > 0) {
            logger.debug(
                `[EXIT_GATED] pool=${input.poolName} reason=NEEDS_CONFIRMATIONS ` +
                `badConsecutive=${state.harmonicBadConsecutive}/${config.confirmationsRequired}`
            );
        }
        
        return {
            allowExit: false,
            blockedBy: 'NEEDS_CONFIRMATIONS',
            reason: `Confirmations: ${state.harmonicBadConsecutive}/${config.confirmationsRequired}`,
            state: 'PENDING_CONFIRMATION',
            debug,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ALL GATES PASSED: Allow exit
    // ═══════════════════════════════════════════════════════════════════════════
    state.state = 'EXIT_READY';
    state.exitTriggerTimestamps.push(now);
    
    return {
        allowExit: true,
        reason: `Gates passed: badConsecutive=${state.harmonicBadConsecutive}, holdTime=${debug.holdTimeMinutes}min`,
        state: 'EXIT_READY',
        debug,
    };
}

/**
 * Check if emergency bypass conditions are met.
 * 
 * Emergency bypass allows immediate exit when:
 * - Health score is catastrophic (< 0.20)
 * - Multiple bad samples confirm the condition (>= 3)
 */
function checkEmergencyBypass(input: HarmonicGatingInput): boolean {
    const config = HARMONIC_GATING_CONFIG;
    
    return (
        input.healthScore < config.emergencyHealthThreshold &&
        input.badSamplesCount >= config.emergencyMinBadSamples
    );
}

/**
 * Mark position as suppressed and enter cooldown.
 * Called when exit is triggered but suppressed by cost amortization.
 * 
 * STATE TRANSITION: EXIT_READY → SUPPRESSED_COOLDOWN
 */
export function enterSuppressionCooldown(
    tradeId: string,
    suppressionReason: string
): void {
    const state = gatingState.get(tradeId);
    if (!state) return;
    
    const now = Date.now();
    const cooldownMs = HARMONIC_GATING_CONFIG.suppressCooldownMs;
    
    state.state = 'SUPPRESSED_COOLDOWN';
    state.exitCooldownUntilMs = now + cooldownMs;
    state.lastSuppressionReason = suppressionReason;
    state.suppressionLogged = false; // Allow one log for the new cooldown
    
    // Log once when entering suppression
    logger.info(
        `[EXIT_SUPPRESSED] pool=${state.poolName} trade=${tradeId.slice(0, 8)}... ` +
        `reason=${suppressionReason} cooldown=${cooldownMs / 1000}s ` +
        `badConsecutive=${state.harmonicBadConsecutive}`
    );
}

/**
 * Clear gating state for a position (call on exit execution or clear)
 */
export function clearHarmonicGatingState(tradeId: string): void {
    if (gatingState.has(tradeId)) {
        logger.debug(`[HARMONIC_GATE] Cleared state for trade ${tradeId.slice(0, 8)}...`);
        gatingState.delete(tradeId);
    }
}

/**
 * Get gating state for a position
 */
export function getHarmonicGatingState(tradeId: string): HarmonicGatingState | undefined {
    return gatingState.get(tradeId);
}

/**
 * Get all positions in cooldown
 */
export function getPositionsInCooldown(): HarmonicGatingState[] {
    const now = Date.now();
    return Array.from(gatingState.values()).filter(s => s.exitCooldownUntilMs > now);
}

/**
 * Check if position is in cooldown
 */
export function isInHarmonicCooldown(tradeId: string): boolean {
    const state = gatingState.get(tradeId);
    if (!state) return false;
    return state.exitCooldownUntilMs > Date.now();
}

/**
 * Get summary of harmonic gating states for logging
 */
export function getHarmonicGatingSummary(): {
    total: number;
    inCooldown: number;
    pendingConfirmation: number;
    exitReady: number;
    byState: Record<HarmonicGatingStateType, number>;
} {
    const states = Array.from(gatingState.values());
    const now = Date.now();
    
    const byState: Record<HarmonicGatingStateType, number> = {
        'HOLD': 0,
        'PENDING_CONFIRMATION': 0,
        'EXIT_READY': 0,
        'EXIT_TRIGGERED': 0,
        'SUPPRESSED_COOLDOWN': 0,
    };
    
    let inCooldown = 0;
    let pendingConfirmation = 0;
    let exitReady = 0;
    
    for (const state of states) {
        byState[state.state]++;
        
        if (state.exitCooldownUntilMs > now) {
            inCooldown++;
        }
        if (state.state === 'PENDING_CONFIRMATION') {
            pendingConfirmation++;
        }
        if (state.state === 'EXIT_READY') {
            exitReady++;
        }
    }
    
    return {
        total: states.length,
        inCooldown,
        pendingConfirmation,
        exitReady,
        byState,
    };
}

/**
 * Clear all harmonic gating state (for cleanup/reset)
 */
export function clearAllHarmonicGatingState(): void {
    gatingState.clear();
    logger.info('[HARMONIC_GATE] Cleared all gating state');
}

/**
 * Log gating summary
 */
export function logHarmonicGatingSummary(): void {
    const summary = getHarmonicGatingSummary();
    
    if (summary.total === 0) return;
    
    logger.info(
        `[HARMONIC_GATE_SUMMARY] total=${summary.total} ` +
        `inCooldown=${summary.inCooldown} ` +
        `pending=${summary.pendingConfirmation} ` +
        `ready=${summary.exitReady}`
    );
}

