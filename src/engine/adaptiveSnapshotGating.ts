/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ADAPTIVE SNAPSHOT GATING — EXECUTION-FRICTION REDUCTION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * OBJECTIVE: Reduce execution latency and missed dominance inflections by lowering
 * confirmation friction where probability asymmetry is already proven.
 * 
 * REPLACES: All fixed snapshot-count requirements for entry, exit, and redeploy.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENTRY CONFIRMATION:
 *   If poolTier ∈ {A, B} AND dominanceScore ≥ threshold AND velocitySlope > 0
 *   AND entropyTrend ≤ 0:
 *     → Reduce required snapshots to 3–5
 *   Else:
 *     → Preserve existing snapshot requirements (15)
 * 
 * EXIT CONFIRMATION (ALL EXIT TYPES):
 *   For HARMONIC_EXIT, DOMINANCE_LOSS, VELOCITY_COLLAPSE, or AMORTIZATION_DECAY:
 *     → Require 1–2 snapshots maximum
 *     → Do NOT delay exits due to snapshot insufficiency
 * 
 * REDEPLOY / ROTATION:
 *   If capital is already deployed and higher-ranked pool emerges:
 *     → Allow redeploy decision with ≤5 snapshots when Tier-A
 * 
 * SAFETY OVERRIDES (NEVER RELAX):
 *   - Kill-switch logic remains unchanged
 *   - Bootstrap pools retain full snapshot requirements
 *   - Entropy shock detection remains authoritative
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { PREDATOR_MODE_V1_ENABLED } from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type PoolTier = 'A' | 'B' | 'C';

/** Type of execution decision being gated */
export type ExecutionType = 'ENTRY' | 'EXIT' | 'REDEPLOY';

/** Exit reason categories that get fast-path confirmation */
export type FastPathExitReason = 
    | 'HARMONIC_EXIT'
    | 'DOMINANCE_LOSS'
    | 'VELOCITY_COLLAPSE'
    | 'AMORTIZATION_DECAY'
    | 'MICROSTRUCTURE_EXIT'
    | 'FEE_BLEED';

export interface SignalStrengthInput {
    /** Velocity collapse ratio (current / peak), lower = worse */
    velocityCollapseRatio: number;
    
    /** Entropy drop magnitude (0-1, higher = larger drop) */
    entropyDropMagnitude: number;
    
    /** Harmonic health delta (current - baseline) */
    harmonicHealthDelta: number;
    
    /** Pool tier confidence */
    tierConfidence: PoolTier;
    
    /** Unrealized PnL percentage */
    unrealizedPnlPct: number;
    
    /** Whether bin flow reversal detected */
    binFlowReversalDetected: boolean;
}

export interface SnapshotGatingResult {
    /** Whether execution is allowed */
    allowed: boolean;
    
    /** Reason for decision */
    reason: string;
    
    /** Effective minimum snapshots required */
    effectiveMinSnapshots: number;
    
    /** Actual snapshots seen */
    snapshotsSeen: number;
    
    /** Computed signal strength */
    signalStrength: number;
    
    /** Whether bypass was used */
    bypassUsed: boolean;
    
    /** Bypass reason if applicable */
    bypassReason: string | null;
}

export interface TradeBypassState {
    tradeId: string;
    bypassCount: number;
    lastBypassTime: number;
    coolingDown: boolean;
}

/**
 * Input for entry confirmation gating
 */
export interface EntryConfirmationInput {
    /** Pool tier (A, B, C) */
    poolTier: PoolTier;
    
    /** Dominance score (0-1) */
    dominanceScore: number;
    
    /** Dominance threshold for the pool */
    dominanceThreshold: number;
    
    /** Velocity slope (positive = improving) */
    velocitySlope: number;
    
    /** Entropy trend (negative = improving for entry) */
    entropyTrend: number;
    
    /** Current snapshot count for the pool */
    snapshotCount: number;
    
    /** Whether pool is in bootstrap mode */
    isBootstrap: boolean;
    
    /** Whether kill switch is active */
    killSwitchActive: boolean;
}

/**
 * Input for exit confirmation gating
 */
export interface ExitConfirmationInput {
    /** Exit reason category */
    exitReason: string;
    
    /** Pool tier */
    poolTier: PoolTier;
    
    /** Current snapshot count */
    snapshotCount: number;
    
    /** Health score (0-1) */
    healthScore: number;
    
    /** Whether kill switch is active */
    killSwitchActive: boolean;
    
    /** Whether this is an entropy shock */
    entropyShock: boolean;
}

/**
 * Input for redeploy/rotation confirmation gating
 */
export interface RedeployConfirmationInput {
    /** Target pool tier */
    targetPoolTier: PoolTier;
    
    /** Current pool tier (if deployed) */
    currentPoolTier?: PoolTier;
    
    /** Target pool snapshot count */
    targetSnapshotCount: number;
    
    /** Target pool rank (lower = better) */
    targetPoolRank: number;
    
    /** Current pool rank (if deployed) */
    currentPoolRank?: number;
    
    /** Whether capital is currently deployed */
    isDeployed: boolean;
    
    /** Whether target is in bootstrap mode */
    isBootstrap: boolean;
}

/**
 * Result of confirmation gating
 */
export interface ConfirmationResult {
    /** Whether action is allowed */
    allowed: boolean;
    
    /** Reason for decision */
    reason: string;
    
    /** Required snapshots for this context */
    requiredSnapshots: number;
    
    /** Actual snapshots available */
    actualSnapshots: number;
    
    /** Whether fast-path was used */
    fastPathUsed: boolean;
    
    /** Execution type */
    executionType: ExecutionType;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const ADAPTIVE_SNAPSHOT_CONFIG = {
    /** Signal strength thresholds for min snapshots */
    THRESHOLDS: {
        VERY_HIGH: { signalStrength: 0.85, minSnapshots: 3 },
        HIGH: { signalStrength: 0.70, minSnapshots: 5 },
        MEDIUM: { signalStrength: 0.55, minSnapshots: 8 },
        LOW: { signalStrength: 0, minSnapshots: 12 },
    },
    
    /** Predator event bypass conditions */
    BYPASS_CONDITIONS: {
        /** Velocity collapse threshold (ratio <= this triggers bypass) */
        VELOCITY_COLLAPSE_THRESHOLD: 0.15,
        
        /** Entropy drop threshold (ratio <= this triggers bypass) */
        ENTROPY_DROP_THRESHOLD: 0.20,
        
        /** Unrealized PnL threshold for profit-taking bypass */
        UNREALIZED_PNL_THRESHOLD: 0.0060,  // +0.60%
    },
    
    /** Risk containment */
    RISK_LIMITS: {
        /** Max bypasses per trade before re-engaging gating */
        MAX_BYPASS_PER_TRADE: 2,
        
        /** Cooldown after max bypasses reached */
        COOLDOWN_MS: 90_000,  // 90 seconds
    },
    
    /** Tier confidence multipliers */
    TIER_CONFIDENCE: {
        A: 1.0,   // Full confidence
        B: 0.85,  // 85% confidence
        C: 0.70,  // 70% confidence
    },
    
    /** Signal strength component weights */
    SIGNAL_WEIGHTS: {
        VELOCITY: 0.35,
        ENTROPY: 0.25,
        HARMONIC: 0.25,
        TIER: 0.15,
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ENTRY CONFIRMATION — Reduce friction for high-probability entries
    // ═══════════════════════════════════════════════════════════════════════════
    
    ENTRY: {
        /** Default snapshot requirement (preserved for non-qualifying entries) */
        DEFAULT_SNAPSHOTS: 15,
        
        /** Reduced snapshot requirement for qualifying Tier A/B entries */
        FAST_PATH_SNAPSHOTS_MIN: 3,
        FAST_PATH_SNAPSHOTS_MAX: 5,
        
        /** Minimum dominance score for fast-path (relative to threshold) */
        DOMINANCE_MULTIPLIER: 1.0, // dominanceScore >= dominanceThreshold * 1.0
        
        /** Velocity slope must be positive for fast-path */
        MIN_VELOCITY_SLOPE: 0.0,
        
        /** Entropy trend must be non-positive for fast-path (flat or improving) */
        MAX_ENTROPY_TREND: 0.0,
        
        /** Pool tiers eligible for fast-path entry */
        ELIGIBLE_TIERS: ['A', 'B'] as PoolTier[],
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT CONFIRMATION — Minimize delay for all exit types
    // ═══════════════════════════════════════════════════════════════════════════
    
    EXIT: {
        /** Maximum snapshots required for any exit (1-2 max per directive) */
        MAX_SNAPSHOTS_REQUIRED: 2,
        
        /** Minimum snapshots for safety (at least 1 confirmation) */
        MIN_SNAPSHOTS_REQUIRED: 1,
        
        /** Exit reasons that qualify for fast-path (1-2 snapshots) */
        FAST_PATH_REASONS: [
            'HARMONIC_EXIT',
            'HARMONIC',
            'DOMINANCE_LOSS',
            'DOMINANCE_FAILED',
            'VELOCITY_COLLAPSE',
            'VELOCITY_DIP',
            'FEE_VELOCITY_LOW',
            'AMORTIZATION_DECAY',
            'AMORT_DECAY',
            'MICROSTRUCTURE_EXIT',
            'MICROSTRUCTURE',
            'FEE_BLEED',
            'BLEED_EXIT',
            'ENTROPY_DROP',
            'HEALTH_FLOOR',
        ],
        
        /** Default snapshots for non-fast-path exits */
        DEFAULT_SNAPSHOTS: 3,
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REDEPLOY/ROTATION — Fast capital recycling
    // ═══════════════════════════════════════════════════════════════════════════
    
    REDEPLOY: {
        /** Snapshots required for Tier-A redeploy target */
        TIER_A_SNAPSHOTS: 5,
        
        /** Snapshots required for Tier-B redeploy target */
        TIER_B_SNAPSHOTS: 8,
        
        /** Default snapshots for Tier-C or unknown */
        DEFAULT_SNAPSHOTS: 12,
        
        /** Minimum rank improvement required to trigger fast-path */
        MIN_RANK_IMPROVEMENT: 1,
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SAFETY OVERRIDES — Never relaxed
    // ═══════════════════════════════════════════════════════════════════════════
    
    SAFETY: {
        /** Bootstrap pools always use full snapshot requirements */
        BOOTSTRAP_SNAPSHOTS: 15,
        
        /** Kill switch bypasses all gating (immediate action) */
        KILL_SWITCH_BYPASS: true,
        
        /** Entropy shock bypasses exit gating (immediate exit) */
        ENTROPY_SHOCK_BYPASS: true,
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const tradeBypassStates = new Map<string, TradeBypassState>();

// Telemetry
let totalGatingChecks = 0;
let bypassesUsed = 0;
let executionsBlocked = 0;
let executionsAllowed = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL STRENGTH COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute signal strength from input components
 * 
 * Higher signal strength = more confidence in the signal = fewer snapshots needed
 */
export function computeSignalStrength(input: SignalStrengthInput): number {
    const weights = ADAPTIVE_SNAPSHOT_CONFIG.SIGNAL_WEIGHTS;
    const tierConf = ADAPTIVE_SNAPSHOT_CONFIG.TIER_CONFIDENCE;
    
    // Velocity component: lower ratio = stronger exit signal
    // Invert: velocityCollapseRatio of 0.15 becomes strength of 0.85
    const velocityStrength = 1 - Math.min(1, Math.max(0, input.velocityCollapseRatio));
    
    // Entropy component: higher drop = stronger signal
    const entropyStrength = Math.min(1, Math.max(0, input.entropyDropMagnitude));
    
    // Harmonic component: more negative delta = stronger exit signal
    // Normalize: delta of -0.5 becomes strength of 1.0
    const harmonicStrength = Math.min(1, Math.max(0, -input.harmonicHealthDelta * 2));
    
    // Tier component: direct confidence mapping
    const tierStrength = tierConf[input.tierConfidence] || tierConf.B;
    
    // Weighted sum
    const signalStrength = 
        velocityStrength * weights.VELOCITY +
        entropyStrength * weights.ENTROPY +
        harmonicStrength * weights.HARMONIC +
        tierStrength * weights.TIER;
    
    return Math.min(1, Math.max(0, signalStrength));
}

/**
 * Get effective minimum snapshots based on signal strength
 */
export function getEffectiveMinSnapshots(signalStrength: number): number {
    const thresholds = ADAPTIVE_SNAPSHOT_CONFIG.THRESHOLDS;
    
    if (signalStrength >= thresholds.VERY_HIGH.signalStrength) {
        return thresholds.VERY_HIGH.minSnapshots;
    } else if (signalStrength >= thresholds.HIGH.signalStrength) {
        return thresholds.HIGH.minSnapshots;
    } else if (signalStrength >= thresholds.MEDIUM.signalStrength) {
        return thresholds.MEDIUM.minSnapshots;
    } else {
        return thresholds.LOW.minSnapshots;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BYPASS DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if predator event bypass conditions are met
 */
export function checkBypassConditions(input: SignalStrengthInput): {
    shouldBypass: boolean;
    reason: string;
} {
    const conditions = ADAPTIVE_SNAPSHOT_CONFIG.BYPASS_CONDITIONS;
    
    // Condition 1: Velocity collapse
    if (input.velocityCollapseRatio <= conditions.VELOCITY_COLLAPSE_THRESHOLD) {
        return {
            shouldBypass: true,
            reason: `VELOCITY_COLLAPSE: ratio=${input.velocityCollapseRatio.toFixed(3)} <= ${conditions.VELOCITY_COLLAPSE_THRESHOLD}`,
        };
    }
    
    // Condition 2: Entropy drop
    if (input.entropyDropMagnitude >= (1 - conditions.ENTROPY_DROP_THRESHOLD)) {
        return {
            shouldBypass: true,
            reason: `ENTROPY_DROP: magnitude=${input.entropyDropMagnitude.toFixed(3)} (threshold=${conditions.ENTROPY_DROP_THRESHOLD})`,
        };
    }
    
    // Condition 3: Bin flow reversal
    if (input.binFlowReversalDetected) {
        return {
            shouldBypass: true,
            reason: 'BIN_FLOW_REVERSAL_DETECTED',
        };
    }
    
    // Condition 4: Profit taking opportunity
    if (input.unrealizedPnlPct >= conditions.UNREALIZED_PNL_THRESHOLD) {
        return {
            shouldBypass: true,
            reason: `PROFIT_LOCK: unrealizedPnl=${(input.unrealizedPnlPct * 100).toFixed(2)}% >= ${(conditions.UNREALIZED_PNL_THRESHOLD * 100).toFixed(2)}%`,
        };
    }
    
    return {
        shouldBypass: false,
        reason: 'NO_BYPASS_CONDITION_MET',
    };
}

/**
 * Check if bypass is allowed for this trade (risk containment)
 */
function canUseBypass(tradeId: string): { allowed: boolean; reason: string } {
    const state = tradeBypassStates.get(tradeId);
    const limits = ADAPTIVE_SNAPSHOT_CONFIG.RISK_LIMITS;
    const now = Date.now();
    
    if (!state) {
        return { allowed: true, reason: 'FIRST_BYPASS' };
    }
    
    // Check cooldown
    if (state.coolingDown) {
        const elapsed = now - state.lastBypassTime;
        if (elapsed < limits.COOLDOWN_MS) {
            const remaining = ((limits.COOLDOWN_MS - elapsed) / 1000).toFixed(0);
            return {
                allowed: false,
                reason: `COOLDOWN_ACTIVE: ${remaining}s remaining`,
            };
        }
        // Cooldown expired, reset state
        state.coolingDown = false;
        state.bypassCount = 0;
    }
    
    // Check bypass count
    if (state.bypassCount >= limits.MAX_BYPASS_PER_TRADE) {
        state.coolingDown = true;
        state.lastBypassTime = now;
        return {
            allowed: false,
            reason: `MAX_BYPASS_REACHED: ${state.bypassCount}/${limits.MAX_BYPASS_PER_TRADE}`,
        };
    }
    
    return { allowed: true, reason: 'BYPASS_AVAILABLE' };
}

/**
 * Record bypass usage
 */
function recordBypassUsage(tradeId: string): void {
    let state = tradeBypassStates.get(tradeId);
    
    if (!state) {
        state = {
            tradeId,
            bypassCount: 0,
            lastBypassTime: Date.now(),
            coolingDown: false,
        };
        tradeBypassStates.set(tradeId, state);
    }
    
    state.bypassCount++;
    state.lastBypassTime = Date.now();
    bypassesUsed++;
}

/**
 * Reset bypass state (on successful exit, rebalance, or capital redeploy)
 */
export function resetBypassState(tradeId: string): void {
    tradeBypassStates.delete(tradeId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE GATING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate snapshot gating for an execution (exit or rebalance)
 * 
 * This REPLACES any static snapshot checks like:
 * if (snapshots < 15) rejectExecution();
 */
export function evaluateSnapshotGating(
    tradeId: string,
    snapshotsSeen: number,
    signalInput: SignalStrengthInput
): SnapshotGatingResult {
    totalGatingChecks++;
    
    // Compute signal strength
    const signalStrength = computeSignalStrength(signalInput);
    const effectiveMinSnapshots = getEffectiveMinSnapshots(signalStrength);
    
    // Check for predator event bypass
    const bypassCheck = checkBypassConditions(signalInput);
    
    if (bypassCheck.shouldBypass) {
        // Check if bypass is allowed (risk containment)
        const canBypass = canUseBypass(tradeId);
        
        if (canBypass.allowed) {
            recordBypassUsage(tradeId);
            
            // Emit telemetry
            logger.info(
                `[EXEC-BYPASS] reason=SNAPSHOT_ADAPTIVE_OVERRIDE | ` +
                `signalStrength=${signalStrength.toFixed(2)} | ` +
                `snapshotsSeen=${snapshotsSeen} | ` +
                `bypassReason=${bypassCheck.reason}`
            );
            
            executionsAllowed++;
            
            return {
                allowed: true,
                reason: `BYPASS: ${bypassCheck.reason}`,
                effectiveMinSnapshots,
                snapshotsSeen,
                signalStrength,
                bypassUsed: true,
                bypassReason: bypassCheck.reason,
            };
        } else {
            // Bypass not allowed, fall through to normal gating
            logger.debug(
                `[EXEC-BYPASS] BLOCKED | ${canBypass.reason} | ` +
                `Falling back to adaptive gating`
            );
        }
    }
    
    // Normal adaptive gating
    if (snapshotsSeen >= effectiveMinSnapshots) {
        executionsAllowed++;
        
        return {
            allowed: true,
            reason: `ADAPTIVE_GATE_PASSED: ${snapshotsSeen} >= ${effectiveMinSnapshots} (signal=${signalStrength.toFixed(2)})`,
            effectiveMinSnapshots,
            snapshotsSeen,
            signalStrength,
            bypassUsed: false,
            bypassReason: null,
        };
    }
    
    executionsBlocked++;
    
    return {
        allowed: false,
        reason: `ADAPTIVE_GATE_BLOCKED: ${snapshotsSeen} < ${effectiveMinSnapshots} (signal=${signalStrength.toFixed(2)})`,
        effectiveMinSnapshots,
        snapshotsSeen,
        signalStrength,
        bypassUsed: false,
        bypassReason: null,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY CONFIRMATION — Adaptive snapshot requirements for entries
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate entry confirmation with adaptive snapshot requirements.
 * 
 * FAST-PATH (3-5 snapshots):
 *   poolTier ∈ {A, B} AND
 *   dominanceScore ≥ dominanceThreshold AND
 *   velocitySlope > 0 AND
 *   entropyTrend ≤ 0
 * 
 * DEFAULT (15 snapshots):
 *   All other entries
 * 
 * SAFETY (never relaxed):
 *   Bootstrap pools always require full snapshots
 *   Kill switch blocks all entries
 */
export function evaluateEntryConfirmation(input: EntryConfirmationInput): ConfirmationResult {
    const config = ADAPTIVE_SNAPSHOT_CONFIG;
    
    // Safety override: Kill switch blocks all entries
    if (input.killSwitchActive) {
        return {
            allowed: false,
            reason: 'KILL_SWITCH_ACTIVE',
            requiredSnapshots: config.ENTRY.DEFAULT_SNAPSHOTS,
            actualSnapshots: input.snapshotCount,
            fastPathUsed: false,
            executionType: 'ENTRY',
        };
    }
    
    // Safety override: Bootstrap pools require full snapshots
    if (input.isBootstrap) {
        const required = config.SAFETY.BOOTSTRAP_SNAPSHOTS;
        const allowed = input.snapshotCount >= required;
        
        return {
            allowed,
            reason: allowed 
                ? `BOOTSTRAP_PASSED: ${input.snapshotCount} >= ${required}`
                : `BOOTSTRAP_INSUFFICIENT: ${input.snapshotCount} < ${required}`,
            requiredSnapshots: required,
            actualSnapshots: input.snapshotCount,
            fastPathUsed: false,
            executionType: 'ENTRY',
        };
    }
    
    // Check fast-path eligibility
    const eligibleTier = config.ENTRY.ELIGIBLE_TIERS.includes(input.poolTier);
    const dominanceQualified = input.dominanceScore >= (input.dominanceThreshold * config.ENTRY.DOMINANCE_MULTIPLIER);
    const velocityQualified = input.velocitySlope > config.ENTRY.MIN_VELOCITY_SLOPE;
    const entropyQualified = input.entropyTrend <= config.ENTRY.MAX_ENTROPY_TREND;
    
    const fastPathEligible = eligibleTier && dominanceQualified && velocityQualified && entropyQualified;
    
    // Determine required snapshots
    let requiredSnapshots: number;
    
    if (fastPathEligible) {
        // Fast-path: 3-5 snapshots based on tier
        requiredSnapshots = input.poolTier === 'A' 
            ? config.ENTRY.FAST_PATH_SNAPSHOTS_MIN 
            : config.ENTRY.FAST_PATH_SNAPSHOTS_MAX;
    } else {
        // Default: full snapshot requirement
        requiredSnapshots = config.ENTRY.DEFAULT_SNAPSHOTS;
    }
    
    const allowed = input.snapshotCount >= requiredSnapshots;
    
    // Log fast-path usage
    if (fastPathEligible && allowed) {
        logger.debug(
            `[ENTRY-FASTPATH] tier=${input.poolTier} dominance=${input.dominanceScore.toFixed(2)} ` +
            `velSlope=${input.velocitySlope.toFixed(4)} entTrend=${input.entropyTrend.toFixed(4)} ` +
            `snapshots=${input.snapshotCount}/${requiredSnapshots}`
        );
    }
    
    return {
        allowed,
        reason: allowed
            ? `ENTRY_${fastPathEligible ? 'FASTPATH' : 'DEFAULT'}_PASSED: ${input.snapshotCount} >= ${requiredSnapshots}`
            : `ENTRY_INSUFFICIENT: ${input.snapshotCount} < ${requiredSnapshots}`,
        requiredSnapshots,
        actualSnapshots: input.snapshotCount,
        fastPathUsed: fastPathEligible,
        executionType: 'ENTRY',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT CONFIRMATION — Minimize delay for all exit types (1-2 snapshots max)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate exit confirmation with minimal snapshot requirements.
 * 
 * For HARMONIC_EXIT, DOMINANCE_LOSS, VELOCITY_COLLAPSE, AMORTIZATION_DECAY:
 *   → Require 1–2 snapshots maximum
 *   → Do NOT delay exits due to snapshot insufficiency
 * 
 * SAFETY (never relaxed):
 *   Entropy shock triggers immediate exit (bypass)
 */
export function evaluateExitConfirmation(input: ExitConfirmationInput): ConfirmationResult {
    const config = ADAPTIVE_SNAPSHOT_CONFIG;
    
    // Safety override: Entropy shock bypasses all gating
    if (input.entropyShock && config.SAFETY.ENTROPY_SHOCK_BYPASS) {
        return {
            allowed: true,
            reason: 'ENTROPY_SHOCK_BYPASS',
            requiredSnapshots: 0,
            actualSnapshots: input.snapshotCount,
            fastPathUsed: true,
            executionType: 'EXIT',
        };
    }
    
    // Check if exit reason qualifies for fast-path
    const normalizedReason = input.exitReason.toUpperCase();
    const isFastPathReason = config.EXIT.FAST_PATH_REASONS.some(
        reason => normalizedReason.includes(reason)
    );
    
    // Determine required snapshots
    let requiredSnapshots: number;
    
    if (isFastPathReason) {
        // Fast-path exits: 1-2 snapshots based on health
        // Lower health = more urgent = fewer snapshots required
        requiredSnapshots = input.healthScore <= 0.40 
            ? config.EXIT.MIN_SNAPSHOTS_REQUIRED 
            : config.EXIT.MAX_SNAPSHOTS_REQUIRED;
    } else {
        // Non-fast-path exits: still reduced but slightly more caution
        requiredSnapshots = config.EXIT.DEFAULT_SNAPSHOTS;
    }
    
    const allowed = input.snapshotCount >= requiredSnapshots;
    
    // Log for observability
    if (isFastPathReason) {
        logger.debug(
            `[EXIT-FASTPATH] reason=${input.exitReason} tier=${input.poolTier} ` +
            `health=${input.healthScore.toFixed(2)} snapshots=${input.snapshotCount}/${requiredSnapshots} ` +
            `allowed=${allowed}`
        );
    }
    
    return {
        allowed,
        reason: allowed
            ? `EXIT_${isFastPathReason ? 'FASTPATH' : 'DEFAULT'}_PASSED: ${input.snapshotCount} >= ${requiredSnapshots}`
            : `EXIT_INSUFFICIENT: ${input.snapshotCount} < ${requiredSnapshots}`,
        requiredSnapshots,
        actualSnapshots: input.snapshotCount,
        fastPathUsed: isFastPathReason,
        executionType: 'EXIT',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REDEPLOY/ROTATION CONFIRMATION — Fast capital recycling
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate redeploy/rotation confirmation with tier-based snapshot requirements.
 * 
 * If capital is already deployed and a higher-ranked pool emerges:
 *   → Allow redeploy decision with ≤5 snapshots when Tier-A
 * 
 * SAFETY (never relaxed):
 *   Bootstrap targets require full snapshot requirements
 */
export function evaluateRedeployConfirmation(input: RedeployConfirmationInput): ConfirmationResult {
    const config = ADAPTIVE_SNAPSHOT_CONFIG;
    
    // Safety override: Bootstrap targets require full snapshots
    if (input.isBootstrap) {
        const required = config.SAFETY.BOOTSTRAP_SNAPSHOTS;
        const allowed = input.targetSnapshotCount >= required;
        
        return {
            allowed,
            reason: allowed
                ? `REDEPLOY_BOOTSTRAP_PASSED: ${input.targetSnapshotCount} >= ${required}`
                : `REDEPLOY_BOOTSTRAP_INSUFFICIENT: ${input.targetSnapshotCount} < ${required}`,
            requiredSnapshots: required,
            actualSnapshots: input.targetSnapshotCount,
            fastPathUsed: false,
            executionType: 'REDEPLOY',
        };
    }
    
    // Check rank improvement requirement
    const hasRankImprovement = input.currentPoolRank !== undefined 
        ? (input.currentPoolRank - input.targetPoolRank) >= config.REDEPLOY.MIN_RANK_IMPROVEMENT
        : true; // No current position = any rank is improvement
    
    // Determine required snapshots based on target tier
    let requiredSnapshots: number;
    let fastPath = false;
    
    switch (input.targetPoolTier) {
        case 'A':
            requiredSnapshots = config.REDEPLOY.TIER_A_SNAPSHOTS;
            fastPath = true;
            break;
        case 'B':
            requiredSnapshots = config.REDEPLOY.TIER_B_SNAPSHOTS;
            fastPath = true;
            break;
        default:
            requiredSnapshots = config.REDEPLOY.DEFAULT_SNAPSHOTS;
            fastPath = false;
    }
    
    const meetsSnapshots = input.targetSnapshotCount >= requiredSnapshots;
    const allowed = meetsSnapshots && (hasRankImprovement || !input.isDeployed);
    
    // Log for observability
    if (fastPath && allowed) {
        logger.debug(
            `[REDEPLOY-FASTPATH] targetTier=${input.targetPoolTier} ` +
            `rank=${input.targetPoolRank}${input.currentPoolRank !== undefined ? ` (from ${input.currentPoolRank})` : ''} ` +
            `snapshots=${input.targetSnapshotCount}/${requiredSnapshots}`
        );
    }
    
    return {
        allowed,
        reason: allowed
            ? `REDEPLOY_${fastPath ? 'FASTPATH' : 'DEFAULT'}_PASSED: tier=${input.targetPoolTier} snapshots=${input.targetSnapshotCount}/${requiredSnapshots}`
            : `REDEPLOY_BLOCKED: ${!meetsSnapshots ? `snapshots ${input.targetSnapshotCount} < ${requiredSnapshots}` : 'rank not improved'}`,
        requiredSnapshots,
        actualSnapshots: input.targetSnapshotCount,
        fastPathUsed: fastPath,
        executionType: 'REDEPLOY',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Quick check if execution would be allowed (without recording)
 */
export function wouldAllowExecution(
    snapshotsSeen: number,
    signalInput: SignalStrengthInput
): boolean {
    const signalStrength = computeSignalStrength(signalInput);
    const effectiveMinSnapshots = getEffectiveMinSnapshots(signalStrength);
    
    // Check bypass conditions
    const bypassCheck = checkBypassConditions(signalInput);
    if (bypassCheck.shouldBypass) {
        return true;  // Would bypass
    }
    
    return snapshotsSeen >= effectiveMinSnapshots;
}

/**
 * Quick check: would entry be allowed?
 */
export function wouldAllowEntry(input: EntryConfirmationInput): boolean {
    return evaluateEntryConfirmation(input).allowed;
}

/**
 * Quick check: would exit be allowed?
 */
export function wouldAllowExit(input: ExitConfirmationInput): boolean {
    return evaluateExitConfirmation(input).allowed;
}

/**
 * Quick check: would redeploy be allowed?
 */
export function wouldAllowRedeploy(input: RedeployConfirmationInput): boolean {
    return evaluateRedeployConfirmation(input).allowed;
}

/**
 * Get current bypass state for a trade
 */
export function getBypassState(tradeId: string): TradeBypassState | undefined {
    return tradeBypassStates.get(tradeId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════════

export function getGatingStats(): {
    totalChecks: number;
    bypassesUsed: number;
    executionsBlocked: number;
    executionsAllowed: number;
    bypassRate: number;
    allowRate: number;
} {
    return {
        totalChecks: totalGatingChecks,
        bypassesUsed,
        executionsBlocked,
        executionsAllowed,
        bypassRate: totalGatingChecks > 0 ? bypassesUsed / totalGatingChecks : 0,
        allowRate: totalGatingChecks > 0 ? executionsAllowed / totalGatingChecks : 0,
    };
}

export function logGatingStats(): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    const stats = getGatingStats();
    
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info('📊 ADAPTIVE SNAPSHOT GATING STATS');
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`  Total Checks: ${stats.totalChecks}`);
    logger.info(`  Allowed: ${stats.executionsAllowed} (${(stats.allowRate * 100).toFixed(1)}%)`);
    logger.info(`  Blocked: ${stats.executionsBlocked}`);
    logger.info(`  Bypasses Used: ${stats.bypassesUsed} (${(stats.bypassRate * 100).toFixed(1)}%)`);
    logger.info(`  Active Trade States: ${tradeBypassStates.size}`);
    
    // Log threshold info
    const thresholds = ADAPTIVE_SNAPSHOT_CONFIG.THRESHOLDS;
    logger.info('  Thresholds:');
    logger.info(`    Signal ≥ ${thresholds.VERY_HIGH.signalStrength}: min ${thresholds.VERY_HIGH.minSnapshots} snapshots`);
    logger.info(`    Signal ≥ ${thresholds.HIGH.signalStrength}: min ${thresholds.HIGH.minSnapshots} snapshots`);
    logger.info(`    Signal ≥ ${thresholds.MEDIUM.signalStrength}: min ${thresholds.MEDIUM.minSnapshots} snapshots`);
    logger.info(`    Signal < ${thresholds.MEDIUM.signalStrength}: min ${thresholds.LOW.minSnapshots} snapshots`);
    
    logger.info('───────────────────────────────────────────────────────────────');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

export function clearGatingState(): void {
    tradeBypassStates.clear();
}

export function resetGatingStats(): void {
    totalGatingChecks = 0;
    bypassesUsed = 0;
    executionsBlocked = 0;
    executionsAllowed = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    // Core (legacy)
    computeSignalStrength,
    getEffectiveMinSnapshots,
    checkBypassConditions,
    evaluateSnapshotGating,
    wouldAllowExecution,
    
    // Adaptive Confirmation (new)
    evaluateEntryConfirmation,
    evaluateExitConfirmation,
    evaluateRedeployConfirmation,
    wouldAllowEntry,
    wouldAllowExit,
    wouldAllowRedeploy,
    
    // State
    resetBypassState,
    getBypassState,
    
    // Telemetry
    getGatingStats,
    logGatingStats,
    
    // Cleanup
    clearGatingState,
    resetGatingStats,
    
    // Config
    ADAPTIVE_SNAPSHOT_CONFIG,
};

