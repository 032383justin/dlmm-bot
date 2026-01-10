/**
 * Cost Amortization Decay — Time-Based Exit Gate Relaxation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Prevent COST_NOT_AMORTIZED from hard-blocking exits during prolonged
 * dominance failure. Preserve anti-churn protection early, but guarantee timely
 * capital recycling when recovery probability collapses.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * DECAY POLICY:
 *   - Never allow decay earlier than MIN_DECAY_AGE_MS (60 minutes)
 *   - Never reduce target below MIN_TARGET_FLOOR_USD
 *   - Never reduce more than MAX_TARGET_REDUCTION (85%)
 *   - If telemetry is missing, apply slower decay not faster
 * 
 * WEAKNESS GATE (decay only if ALL true):
 *   - harmonicExitTriggered === true (or Tier4 forced exit)
 *   - healthScore <= 0.50 OR badSamples >= badSamplesRequired
 *   - At least one of:
 *     - velocityRatio <= 0.20 (if known)
 *     - entropyRatio <= 0.35 (if known)
 *     - mtmUnrealizedPnlPct <= -0.20% (negative drift)
 * 
 * DECAY FUNCTION:
 *   t = max(0, holdTimeMs - MIN_DECAY_AGE_MS)
 *   decayFactor = 0.5 ** (t / decayHalfLifeMs)
 *   effectiveCostTargetUsd = max(MIN_TARGET_FLOOR_USD, baseCostTargetUsd * max(0.15, decayFactor))
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — Environment-Overridable Defaults
// ═══════════════════════════════════════════════════════════════════════════════

export const AMORT_DECAY_CONFIG = {
    /**
     * Master kill switch for amortization decay
     * If false, revert fully to prior behavior
     */
    ENABLED: process.env.AMORT_DECAY_ENABLED !== 'false', // Default true
    
    /**
     * Minimum hold time before decay can activate (milliseconds)
     * Default: 60 minutes
     */
    MIN_DECAY_AGE_MS: parseInt(process.env.AMORT_DECAY_MIN_AGE_MINUTES ?? '60', 10) * 60 * 1000,
    
    /**
     * Decay half-life when telemetry is known and weak (milliseconds)
     * Default: 120 minutes (2 hours)
     */
    HALFLIFE_STRONG_MS: parseInt(process.env.AMORT_DECAY_HALFLIFE_MINUTES_STRONG ?? '120', 10) * 60 * 1000,
    
    /**
     * Decay half-life when telemetry is unknown (slower decay)
     * Default: 240 minutes (4 hours)
     */
    HALFLIFE_WEAK_MS: parseInt(process.env.AMORT_DECAY_HALFLIFE_MINUTES_WEAK ?? '240', 10) * 60 * 1000,
    
    /**
     * Minimum cost target floor in USD
     * Default: $0.15
     */
    FLOOR_USD_MIN: parseFloat(process.env.AMORT_DECAY_FLOOR_USD_MIN ?? '0.15'),
    
    /**
     * Minimum cost target floor as fraction of notional (basis points)
     * Default: 0.5 bps = 0.00005
     */
    FLOOR_NOTIONAL_BPS: parseFloat(process.env.AMORT_DECAY_FLOOR_NOTIONAL_BPS ?? '0.5') / 10000,
    
    /**
     * Minimum base target percentage (floor is this % of base)
     * Default: 15% (i.e., never reduce more than 85%)
     */
    MIN_BASE_TARGET_PCT: parseFloat(process.env.AMORT_DECAY_MIN_BASE_TARGET_PCT ?? '15') / 100,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // WEAKNESS GATE THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Health score threshold for weakness gate
     */
    WEAKNESS_HEALTH_THRESHOLD: 0.50,
    
    /**
     * Velocity ratio threshold for weakness signal
     */
    WEAKNESS_VELOCITY_THRESHOLD: 0.20,
    
    /**
     * Entropy ratio threshold for weakness signal
     */
    WEAKNESS_ENTROPY_THRESHOLD: 0.35,
    
    /**
     * MTM unrealized PnL percentage threshold for weakness signal
     * Negative value indicates drift threshold
     */
    WEAKNESS_MTM_PNL_PCT_THRESHOLD: -0.0020, // -0.20%
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Input parameters for computing amortization gate.
 * All values should already be available in exit context.
 */
export interface AmortizationGateInput {
    /** Current base cost target from positionLifecycleCost */
    baseCostTargetUsd: number;
    
    /** Fees accrued so far in USD */
    feesAccruedUsd: number;
    
    /** Time position has been held (milliseconds) */
    holdTimeMs: number;
    
    /** Current health score (0-1), from harmonic stops */
    healthScore: number;
    
    /** Count of consecutive bad samples */
    badSamples: number;
    
    /** Required bad samples for exit */
    badSamplesRequired: number;
    
    /** Whether harmonic exit has triggered */
    harmonicExitTriggered: boolean;
    
    /** Velocity ratio (current/baseline), undefined if unknown */
    velocityRatio?: number;
    
    /** Entropy ratio (current/baseline), undefined if unknown */
    entropyRatio?: number;
    
    /** MTM unrealized PnL in USD */
    mtmUnrealizedPnlUsd?: number;
    
    /** MTM unrealized PnL as percentage (e.g., -0.002 = -0.2%) */
    mtmUnrealizedPnlPct?: number;
    
    /** Notional value in USD (for floor calculation) */
    notionalUsd: number;
}

/**
 * Result of amortization gate computation.
 */
export interface AmortizationGateResult {
    /** Whether exit is allowed based on decayed cost target */
    allowExit: boolean;
    
    /** Effective cost target after decay (may equal base if no decay) */
    effectiveCostTargetUsd: number;
    
    /** Human-readable reason for the decision */
    reason: string;
    
    /** Debug information for logging and analysis */
    debug: AmortizationGateDebug;
}

/**
 * Debug information for amortization gate.
 */
export interface AmortizationGateDebug {
    /** Base cost target before decay */
    baseCostTargetUsd: number;
    
    /** Decay factor applied (1.0 = no decay) */
    decayFactor: number;
    
    /** Time since MIN_DECAY_AGE_MS in minutes (0 if not yet reached) */
    decayAgeMin: number;
    
    /** Whether the weakness gate was satisfied */
    weaknessGate: boolean;
    
    /** Which half-life was used (in minutes) */
    halfLifeMin: number;
    
    /** Whether telemetry was available */
    telemetryKnown: boolean;
    
    /** Which weakness signals were active */
    weaknessSignals: string[];
    
    /** Computed floor for this position */
    floorUsd: number;
    
    /** Whether decay was applied via amortization decay override */
    amortDecayApplied: boolean;
    
    /** Hold time in minutes */
    holdTimeMin: number;
    
    /** Health score at evaluation time */
    healthScore: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute the amortization gate decision with time-based decay.
 * 
 * This function determines whether an exit should be allowed based on
 * whether fees accrued meet the effective (decayed) cost target.
 * 
 * @param input - All parameters needed for gate computation
 * @returns Gate result with decision, effective target, and debug info
 */
export function computeAmortizationGate(input: AmortizationGateInput): AmortizationGateResult {
    const config = AMORT_DECAY_CONFIG;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // KILL SWITCH: If disabled, use original behavior (no decay)
    // ═══════════════════════════════════════════════════════════════════════════
    if (!config.ENABLED) {
        const allowExit = input.feesAccruedUsd >= input.baseCostTargetUsd;
        return {
            allowExit,
            effectiveCostTargetUsd: input.baseCostTargetUsd,
            reason: allowExit 
                ? 'COST_AMORTIZED (decay disabled)'
                : 'COST_NOT_AMORTIZED (decay disabled)',
            debug: createDebugInfo(input, {
                decayFactor: 1.0,
                weaknessGate: false,
                telemetryKnown: false,
                weaknessSignals: [],
                amortDecayApplied: false,
                halfLifeMs: config.HALFLIFE_WEAK_MS,
            }),
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE FLOOR (minimum target regardless of decay)
    // ═══════════════════════════════════════════════════════════════════════════
    const notionalFloor = config.FLOOR_NOTIONAL_BPS * input.notionalUsd;
    const floorUsd = Math.max(config.FLOOR_USD_MIN, notionalFloor);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK WEAKNESS GATE (decay only activates if satisfied)
    // ═══════════════════════════════════════════════════════════════════════════
    const { weaknessGate, weaknessSignals, telemetryKnown } = evaluateWeaknessGate(input);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE DECAY FACTOR
    // ═══════════════════════════════════════════════════════════════════════════
    let decayFactor = 1.0;
    let halfLifeMs = config.HALFLIFE_WEAK_MS;
    let amortDecayApplied = false;
    
    // Only apply decay if:
    // 1. Past minimum decay age
    // 2. Weakness gate is satisfied
    const decayEligible = input.holdTimeMs >= config.MIN_DECAY_AGE_MS;
    
    if (decayEligible && weaknessGate) {
        // Use faster decay if telemetry is known, slower if unknown
        halfLifeMs = telemetryKnown ? config.HALFLIFE_STRONG_MS : config.HALFLIFE_WEAK_MS;
        
        // Time since decay became eligible
        const t = Math.max(0, input.holdTimeMs - config.MIN_DECAY_AGE_MS);
        
        // Exponential decay: halves every halfLifeMs
        decayFactor = Math.pow(0.5, t / halfLifeMs);
        
        // Clamp to minimum (never reduce below MIN_BASE_TARGET_PCT of base)
        decayFactor = Math.max(config.MIN_BASE_TARGET_PCT, decayFactor);
        
        amortDecayApplied = decayFactor < 1.0;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE EFFECTIVE COST TARGET
    // ═══════════════════════════════════════════════════════════════════════════
    const decayedTarget = input.baseCostTargetUsd * decayFactor;
    const effectiveCostTargetUsd = Math.max(floorUsd, decayedTarget);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MAKE DECISION
    // ═══════════════════════════════════════════════════════════════════════════
    const allowExit = input.feesAccruedUsd >= effectiveCostTargetUsd;
    
    // Build reason string
    let reason: string;
    if (allowExit) {
        if (amortDecayApplied && input.feesAccruedUsd < input.baseCostTargetUsd) {
            // Exit allowed via decay override
            reason = 'AMORT_DECAY_OVERRIDE';
        } else {
            // Exit allowed normally (fees >= base target)
            reason = 'COST_AMORTIZED';
        }
    } else {
        reason = 'COST_NOT_AMORTIZED';
    }
    
    return {
        allowExit,
        effectiveCostTargetUsd,
        reason,
        debug: createDebugInfo(input, {
            decayFactor,
            weaknessGate,
            telemetryKnown,
            weaknessSignals,
            amortDecayApplied,
            halfLifeMs,
            floorUsd,
        }),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEAKNESS GATE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

interface WeaknessGateResult {
    weaknessGate: boolean;
    weaknessSignals: string[];
    telemetryKnown: boolean;
}

/**
 * Evaluate the weakness gate conditions.
 * 
 * Decay only activates if ALL of these are true:
 *   1. harmonicExitTriggered === true
 *   2. healthScore <= 0.50 OR badSamples >= badSamplesRequired
 *   3. At least one of:
 *      - velocityRatio <= 0.20 (if known)
 *      - entropyRatio <= 0.35 (if known)
 *      - mtmUnrealizedPnlPct <= -0.20%
 */
function evaluateWeaknessGate(input: AmortizationGateInput): WeaknessGateResult {
    const config = AMORT_DECAY_CONFIG;
    const weaknessSignals: string[] = [];
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONDITION 1: Harmonic exit must be triggered
    // ═══════════════════════════════════════════════════════════════════════════
    if (!input.harmonicExitTriggered) {
        return { weaknessGate: false, weaknessSignals: [], telemetryKnown: false };
    }
    weaknessSignals.push('HARMONIC_EXIT_TRIGGERED');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONDITION 2: Health must be poor OR bad samples threshold met
    // ═══════════════════════════════════════════════════════════════════════════
    const healthPoor = input.healthScore <= config.WEAKNESS_HEALTH_THRESHOLD;
    const badSamplesMet = input.badSamples >= input.badSamplesRequired;
    
    if (!healthPoor && !badSamplesMet) {
        return { weaknessGate: false, weaknessSignals, telemetryKnown: false };
    }
    
    if (healthPoor) {
        weaknessSignals.push(`HEALTH_LOW(${input.healthScore.toFixed(2)})`);
    }
    if (badSamplesMet) {
        weaknessSignals.push(`BAD_SAMPLES(${input.badSamples}/${input.badSamplesRequired})`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONDITION 3: At least one telemetry signal must show weakness
    // ═══════════════════════════════════════════════════════════════════════════
    let telemetryKnown = false;
    let telemetryWeak = false;
    
    // Check velocity ratio
    if (input.velocityRatio !== undefined) {
        telemetryKnown = true;
        if (input.velocityRatio <= config.WEAKNESS_VELOCITY_THRESHOLD) {
            telemetryWeak = true;
            weaknessSignals.push(`VELOCITY_LOW(${input.velocityRatio.toFixed(2)})`);
        }
    }
    
    // Check entropy ratio
    if (input.entropyRatio !== undefined) {
        telemetryKnown = true;
        if (input.entropyRatio <= config.WEAKNESS_ENTROPY_THRESHOLD) {
            telemetryWeak = true;
            weaknessSignals.push(`ENTROPY_LOW(${input.entropyRatio.toFixed(2)})`);
        }
    }
    
    // Check MTM unrealized PnL percentage
    if (input.mtmUnrealizedPnlPct !== undefined) {
        // PnL is always "known" if provided
        if (input.mtmUnrealizedPnlPct <= config.WEAKNESS_MTM_PNL_PCT_THRESHOLD) {
            telemetryWeak = true;
            weaknessSignals.push(`MTM_DRIFT(${(input.mtmUnrealizedPnlPct * 100).toFixed(2)}%)`);
        }
    }
    
    // If no telemetry signals are weak, gate is not satisfied
    // Exception: If telemetry is unknown, we still allow decay but at slower rate
    const weaknessGate = telemetryWeak || (!telemetryKnown && (healthPoor || badSamplesMet));
    
    if (!telemetryKnown && weaknessGate) {
        weaknessSignals.push('TELEMETRY_UNKNOWN');
    }
    
    return { weaknessGate, weaknessSignals, telemetryKnown };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

interface DebugInfoParams {
    decayFactor: number;
    weaknessGate: boolean;
    telemetryKnown: boolean;
    weaknessSignals: string[];
    amortDecayApplied: boolean;
    halfLifeMs: number;
    floorUsd?: number;
}

/**
 * Create debug info object for logging and analysis.
 */
function createDebugInfo(
    input: AmortizationGateInput,
    params: DebugInfoParams
): AmortizationGateDebug {
    const config = AMORT_DECAY_CONFIG;
    
    const decayAgeMs = Math.max(0, input.holdTimeMs - config.MIN_DECAY_AGE_MS);
    
    return {
        baseCostTargetUsd: input.baseCostTargetUsd,
        decayFactor: params.decayFactor,
        decayAgeMin: Math.round(decayAgeMs / 60000),
        weaknessGate: params.weaknessGate,
        halfLifeMin: Math.round(params.halfLifeMs / 60000),
        telemetryKnown: params.telemetryKnown,
        weaknessSignals: params.weaknessSignals,
        floorUsd: params.floorUsd ?? Math.max(
            config.FLOOR_USD_MIN,
            config.FLOOR_NOTIONAL_BPS * input.notionalUsd
        ),
        amortDecayApplied: params.amortDecayApplied,
        holdTimeMin: Math.round(input.holdTimeMs / 60000),
        healthScore: input.healthScore,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format amortization gate result for logging.
 * 
 * Format for suppression:
 *   baseCostTarget=$X.XX effectiveCostTarget=$Y.YY decayFactor=Z.ZZZ
 *   decayAgeMin=NN weaknessGate=true/false halfLifeMin=NN
 * 
 * Format for exit via decay:
 *   [EXIT_AUTH] ... via AMORT_DECAY_OVERRIDE
 */
export function formatAmortizationGateLog(
    result: AmortizationGateResult,
    feesAccruedUsd: number
): string {
    const d = result.debug;
    
    const parts = [
        `baseCostTarget=$${d.baseCostTargetUsd.toFixed(2)}`,
        `effectiveCostTarget=$${result.effectiveCostTargetUsd.toFixed(2)}`,
        `feesAccrued=$${feesAccruedUsd.toFixed(2)}`,
        `decayFactor=${d.decayFactor.toFixed(3)}`,
        `decayAgeMin=${d.decayAgeMin}`,
        `weaknessGate=${d.weaknessGate}`,
        `halfLifeMin=${d.halfLifeMin}`,
    ];
    
    if (d.amortDecayApplied) {
        parts.push('amortDecayApplied=true');
    }
    
    if (d.weaknessSignals.length > 0) {
        parts.push(`signals=[${d.weaknessSignals.join(',')}]`);
    }
    
    return parts.join(' ');
}

/**
 * Log amortization decay override for exit.
 */
export function logAmortDecayOverride(
    poolName: string,
    tradeId: string,
    result: AmortizationGateResult,
    feesAccruedUsd: number
): void {
    logger.info(
        `[EXIT_AUTH] pool=${poolName} trade=${tradeId.slice(0, 8)}... ` +
        `via AMORT_DECAY_OVERRIDE | ${formatAmortizationGateLog(result, feesAccruedUsd)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    AMORT_DECAY_CONFIG as AmortDecayConfig,
};

