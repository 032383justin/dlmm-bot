/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OBSERVATIONAL REGIME — PREDATOR MODE v1 REGIME HANDLING
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * HARD RULE: Market regime MUST NOT:
 * - Block entries
 * - Trigger exits
 * - Reduce aggression
 * 
 * Regime MAY (slightly):
 * - Modulate rebalance cadence (±10%)
 * - Adjust bin tightness (±5%)
 * 
 * PHILOSOPHICAL RULE: Fees do not care about regime.
 * Regime logic is INFORMATIONAL, not AUTHORITATIVE.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    PREDATOR_MODE_V1_ENABLED,
    REGIME_OBSERVATIONAL_CONFIG,
    getRegimeMultipliers,
} from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type RegimeType = 'BULL' | 'BEAR' | 'NEUTRAL' | 'CHAOS' | 'UNKNOWN';

export interface RegimeState {
    current: RegimeType;
    previous: RegimeType;
    changedAt: number;
    durationMs: number;
    confidence: number;
}

export interface RegimeAdjustments {
    rebalanceCadenceMultiplier: number;
    binTightnessMultiplier: number;
    description: string;
}

export interface RegimeDecision {
    /** Whether to block this action (always false in predator mode) */
    blocked: boolean;
    
    /** Reason (informational only) */
    reason: string;
    
    /** Adjustments to apply (minor only) */
    adjustments: RegimeAdjustments;
    
    /** Is this a predator mode override */
    isPredatorOverride: boolean;
}

export interface RegimeInputs {
    priceChange24h?: number;
    volumeChange24h?: number;
    tvlChange24h?: number;
    entropy?: number;
    binVelocity?: number;
    marketSentiment?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let currentRegimeState: RegimeState = {
    current: 'NEUTRAL',
    previous: 'NEUTRAL',
    changedAt: Date.now(),
    durationMs: 0,
    confidence: 0.5,
};

// Track regime-based decisions that were overridden
let overriddenEntryBlocks = 0;
let overriddenExitTriggers = 0;
let overriddenAggressionReductions = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// REGIME DETECTION (Observational Only)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect market regime from inputs
 * This is OBSERVATIONAL ONLY - never blocks or triggers
 */
export function detectRegime(inputs: RegimeInputs): RegimeType {
    const priceChange = inputs.priceChange24h || 0;
    const volumeChange = inputs.volumeChange24h || 0;
    const entropy = inputs.entropy || 0.5;
    
    // High entropy with wild swings = CHAOS
    if (entropy > 0.8 && Math.abs(priceChange) > 0.1) {
        return 'CHAOS';
    }
    
    // Strong uptrend
    if (priceChange > 0.05 && volumeChange > 0) {
        return 'BULL';
    }
    
    // Strong downtrend
    if (priceChange < -0.05 && volumeChange > 0) {
        return 'BEAR';
    }
    
    // Default
    return 'NEUTRAL';
}

/**
 * Update regime state (observational only)
 */
export function updateRegimeState(inputs: RegimeInputs): RegimeState {
    const now = Date.now();
    const newRegime = detectRegime(inputs);
    
    if (newRegime !== currentRegimeState.current) {
        currentRegimeState = {
            current: newRegime,
            previous: currentRegimeState.current,
            changedAt: now,
            durationMs: 0,
            confidence: 0.5,  // Reset confidence on change
        };
        
        logger.info(
            `[REGIME-OBS] 📊 Regime changed: ${currentRegimeState.previous} → ${newRegime} | ` +
            `INFORMATIONAL ONLY - No action taken`
        );
    } else {
        currentRegimeState.durationMs = now - currentRegimeState.changedAt;
        // Increase confidence with duration
        currentRegimeState.confidence = Math.min(1, 0.5 + (currentRegimeState.durationMs / (60 * 60 * 1000)) * 0.5);
    }
    
    return currentRegimeState;
}

/**
 * Get current regime state
 */
export function getCurrentRegime(): RegimeState {
    return currentRegimeState;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGIME DECISION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate entry decision with regime consideration
 * 
 * PREDATOR MODE: Regime CANNOT block entries
 */
/**
 * Helper to get regime adjustments with description
 */
function getAdjustmentsWithDescription(regime: RegimeType): RegimeAdjustments {
    const multipliers = getRegimeMultipliers(regime);
    const adjustments = getRegimeAdjustments();
    return {
        ...multipliers,
        description: adjustments.description,
    };
}

export function evaluateEntryWithRegime(
    originalDecision: boolean,
    regimeWouldBlock: boolean
): RegimeDecision {
    if (!PREDATOR_MODE_V1_ENABLED) {
        // Standard mode - regime can block
        return {
            blocked: regimeWouldBlock,
            reason: regimeWouldBlock ? `REGIME_BLOCK: ${currentRegimeState.current}` : 'ALLOWED',
            adjustments: getAdjustmentsWithDescription(currentRegimeState.current),
            isPredatorOverride: false,
        };
    }
    
    // PREDATOR MODE - regime CANNOT block
    if (regimeWouldBlock) {
        overriddenEntryBlocks++;
        logger.info(
            `[REGIME-OBS] 🦅 PREDATOR OVERRIDE | ` +
            `Entry block IGNORED (regime=${currentRegimeState.current}) | ` +
            `overrides=${overriddenEntryBlocks}`
        );
    }
    
    return {
        blocked: false,  // NEVER block in predator mode
        reason: regimeWouldBlock 
            ? `PREDATOR_OVERRIDE: Regime block ignored (${currentRegimeState.current})`
            : 'ALLOWED',
        adjustments: getAdjustmentsWithDescription(currentRegimeState.current),
        isPredatorOverride: regimeWouldBlock,
    };
}

/**
 * Evaluate exit decision with regime consideration
 * 
 * PREDATOR MODE: Regime CANNOT trigger exits
 */
export function evaluateExitWithRegime(
    originalShouldExit: boolean,
    regimeWouldTriggerExit: boolean
): RegimeDecision {
    if (!PREDATOR_MODE_V1_ENABLED) {
        // Standard mode - regime can trigger exit
        return {
            blocked: regimeWouldTriggerExit,
            reason: regimeWouldTriggerExit ? `REGIME_EXIT: ${currentRegimeState.current}` : 'NO_EXIT',
            adjustments: getAdjustmentsWithDescription(currentRegimeState.current),
            isPredatorOverride: false,
        };
    }
    
    // PREDATOR MODE - regime CANNOT trigger exit
    if (regimeWouldTriggerExit) {
        overriddenExitTriggers++;
        logger.info(
            `[REGIME-OBS] 🦅 PREDATOR OVERRIDE | ` +
            `Exit trigger IGNORED (regime=${currentRegimeState.current}) | ` +
            `overrides=${overriddenExitTriggers}`
        );
    }
    
    return {
        blocked: false,  // NEVER trigger exit based on regime in predator mode
        reason: regimeWouldTriggerExit 
            ? `PREDATOR_OVERRIDE: Regime exit ignored (${currentRegimeState.current})`
            : 'NO_EXIT',
        adjustments: getAdjustmentsWithDescription(currentRegimeState.current),
        isPredatorOverride: regimeWouldTriggerExit,
    };
}

/**
 * Evaluate aggression with regime consideration
 * 
 * PREDATOR MODE: Regime CANNOT reduce aggression
 */
export function evaluateAggressionWithRegime(
    baseAggression: number,
    regimeWouldReduce: boolean,
    reducedAggression: number
): { aggression: number; wasOverridden: boolean; reason: string } {
    if (!PREDATOR_MODE_V1_ENABLED) {
        // Standard mode - apply regime reduction
        return {
            aggression: regimeWouldReduce ? reducedAggression : baseAggression,
            wasOverridden: false,
            reason: regimeWouldReduce 
                ? `REGIME_REDUCED: ${baseAggression} → ${reducedAggression}`
                : 'FULL_AGGRESSION',
        };
    }
    
    // PREDATOR MODE - regime CANNOT reduce aggression
    if (regimeWouldReduce) {
        overriddenAggressionReductions++;
        logger.debug(
            `[REGIME-OBS] 🦅 PREDATOR OVERRIDE | ` +
            `Aggression reduction IGNORED (${reducedAggression} → ${baseAggression})`
        );
    }
    
    return {
        aggression: baseAggression,  // NEVER reduce in predator mode
        wasOverridden: regimeWouldReduce,
        reason: regimeWouldReduce 
            ? `PREDATOR_OVERRIDE: Aggression maintained at ${baseAggression}`
            : 'FULL_AGGRESSION',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MINOR ADJUSTMENTS (Allowed in Predator Mode)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get regime-based adjustments
 * 
 * These are MINOR adjustments that ARE allowed in predator mode:
 * - Rebalance cadence: ±10%
 * - Bin tightness: ±5%
 */
export function getRegimeAdjustments(): RegimeAdjustments {
    const multipliers = getRegimeMultipliers(currentRegimeState.current);
    
    let description = '';
    switch (currentRegimeState.current) {
        case 'BULL':
            description = 'Slightly faster rebalance, tighter bins';
            break;
        case 'BEAR':
            description = 'Slightly slower rebalance, wider bins';
            break;
        case 'CHAOS':
            description = 'Neutral adjustments (chaos is noise)';
            break;
        default:
            description = 'Neutral adjustments';
    }
    
    return {
        ...multipliers,
        description,
    };
}

/**
 * Apply rebalance cadence adjustment
 */
export function adjustRebalanceCadence(baseCadenceMs: number): number {
    const adjustments = getRegimeAdjustments();
    return baseCadenceMs * adjustments.rebalanceCadenceMultiplier;
}

/**
 * Apply bin tightness adjustment
 */
export function adjustBinTightness(baseBinCount: number): number {
    const adjustments = getRegimeAdjustments();
    const adjusted = baseBinCount * adjustments.binTightnessMultiplier;
    return Math.max(1, Math.round(adjusted));
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get override statistics
 */
export function getOverrideStats(): {
    entryBlocks: number;
    exitTriggers: number;
    aggressionReductions: number;
    total: number;
} {
    return {
        entryBlocks: overriddenEntryBlocks,
        exitTriggers: overriddenExitTriggers,
        aggressionReductions: overriddenAggressionReductions,
        total: overriddenEntryBlocks + overriddenExitTriggers + overriddenAggressionReductions,
    };
}

/**
 * Reset override counters (for testing)
 */
export function resetOverrideStats(): void {
    overriddenEntryBlocks = 0;
    overriddenExitTriggers = 0;
    overriddenAggressionReductions = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logRegimeObservationalStatus(): void {
    const state = currentRegimeState;
    const adjustments = getRegimeAdjustments();
    const overrides = getOverrideStats();
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('📊 REGIME OBSERVATIONAL STATUS');
    logger.info('═══════════════════════════════════════════════════════════════');
    
    if (PREDATOR_MODE_V1_ENABLED) {
        logger.info('  Mode: PREDATOR (Regime is OBSERVATIONAL ONLY)');
        logger.info('  ❌ Cannot: Block entries, trigger exits, reduce aggression');
        logger.info('  ✅ Can: Adjust rebalance cadence ±10%, bin tightness ±5%');
    } else {
        logger.info('  Mode: STANDARD (Regime is AUTHORITATIVE)');
    }
    
    logger.info(`  Current Regime: ${state.current}`);
    logger.info(`  Duration: ${(state.durationMs / (60 * 1000)).toFixed(0)}m`);
    logger.info(`  Confidence: ${(state.confidence * 100).toFixed(0)}%`);
    logger.info(`  Adjustments: ${adjustments.description}`);
    logger.info(`    Rebalance Cadence: ×${adjustments.rebalanceCadenceMultiplier.toFixed(2)}`);
    logger.info(`    Bin Tightness: ×${adjustments.binTightnessMultiplier.toFixed(2)}`);
    
    if (PREDATOR_MODE_V1_ENABLED && overrides.total > 0) {
        logger.info('  Predator Overrides:');
        logger.info(`    Entry Blocks Ignored: ${overrides.entryBlocks}`);
        logger.info(`    Exit Triggers Ignored: ${overrides.exitTriggers}`);
        logger.info(`    Aggression Reductions Ignored: ${overrides.aggressionReductions}`);
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

export function logRegimeAssertion(): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    logger.info(
        `[REGIME-OBS] 🦅 PREDATOR ASSERTION | ` +
        `Regime=${currentRegimeState.current} | ` +
        `IMPACT=OBSERVATIONAL_ONLY | ` +
        `CANNOT: block_entry, trigger_exit, reduce_aggression | ` +
        `CAN: adjust_cadence_±10%, adjust_bins_±5%`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    detectRegime,
    updateRegimeState,
    getCurrentRegime,
    evaluateEntryWithRegime,
    evaluateExitWithRegime,
    evaluateAggressionWithRegime,
    getRegimeAdjustments,
    adjustRebalanceCadence,
    adjustBinTightness,
    getOverrideStats,
    resetOverrideStats,
    logRegimeObservationalStatus,
    logRegimeAssertion,
};

