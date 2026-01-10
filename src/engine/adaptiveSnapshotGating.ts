/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ADAPTIVE SNAPSHOT GATING — EXECUTION-FRICTION REDUCTION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * OBJECTIVE: Reduce missed profitable exits and rebalances by replacing static
 * snapshot requirements with confidence-weighted adaptive gating.
 * 
 * REPLACES: if (snapshots < 15) rejectExecution();
 * 
 * WITH: Adaptive threshold driven by:
 * - Signal strength
 * - Velocity collapse severity
 * - Capital exposure
 * 
 * IMMEDIATE BYPASS CONDITIONS (Predator Events):
 * - velocityCollapseRatio <= 0.15
 * - entropyDropRatio <= 0.20
 * - binFlowReversalDetected === true
 * - unrealizedPnlPct >= +0.60%
 * 
 * RISK CONTAINMENT:
 * - maxBypassPerTrade = 2
 * - cooldownMs = 90_000
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { PREDATOR_MODE_V1_ENABLED } from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type PoolTier = 'A' | 'B' | 'C';

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
    // Core
    computeSignalStrength,
    getEffectiveMinSnapshots,
    checkBypassConditions,
    evaluateSnapshotGating,
    wouldAllowExecution,
    
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

