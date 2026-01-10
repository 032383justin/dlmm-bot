/**
 * Exit Hysteresis + Cost-Amortization Gate — Non-Risk Exit Suppression
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER-0 CORRECTNESS FIX: Prevent instant fee-bleed exits
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Stop "noise exits" from triggering too fast and causing fee-only losses.
 * 
 * RULES:
 *   1. For HARMONIC_EXIT and NOISE_EXIT types:
 *      - If holdTime < minHoldMsNoiseExit → SUPPRESS
 *      - If feesAccrued < costTarget → SUPPRESS
 *   
 *   2. NEVER suppress RISK_EXIT types:
 *      - KILL_SWITCH
 *      - REGIME_FLIP (to CHAOS)
 *      - FEE_BLEED_ACTIVE
 *      - PORTFOLIO_LEDGER_ERROR
 *      - EMERGENCY_EXIT
 *      - MARKET_CRASH
 *      - INSUFFICIENT_CAPITAL
 * 
 * COST AMORTIZATION (UPDATED MODEL):
 *   costTarget = (txCostUsd + impactCostUsd) × SAFETY_FACTOR
 *   
 *   OLD MODEL (DEPRECATED):
 *     costTarget = (entryFees + exitFees + slippage) × 1.10
 *     Problem: Used 0.8% of notional, way too high for LP operations
 *   
 *   NEW MODEL:
 *     txCostUsd = $0.40 × 2 (enter + exit transactions)
 *     impactCostUsd = 0 (LP doesn't pay swap fees)
 *     costTarget = $0.80 × 1.25 = $1.00 (realistic)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { logExitSuppressRateLimited } from '../utils/rateLimitedLogger';
import type { MTMValuation } from './mtmValuation';
import { 
    estimatePositionLifecycleCostUsd, 
    formatCostEstimate,
    type LifecycleCostEstimate,
} from './positionLifecycleCost';
import {
    computeAmortizationGate,
    formatAmortizationGateLog,
    logAmortDecayOverride,
    AMORT_DECAY_CONFIG,
    type AmortizationGateInput,
    type AmortizationGateResult,
    type AmortizationGateDebug,
} from '../predator/amortization_decay';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const EXIT_CONFIG = {
    /**
     * GLOBAL MINIMUM HOLD — HARD RULE
     * 
     * NO EXIT of any kind (except TRUE emergency) before this duration.
     * 
     * TRUE emergencies that bypass:
     *   - Pool migration/deprecation
     *   - TVL collapse (>50% drop)
     *   - Mint/decimals errors
     *   - On-chain failures
     * 
     * NOT emergencies (must wait for min hold):
     *   - Score drops, MHI drops
     *   - Regime changes
     *   - Velocity dips
     *   - Fee velocity underperformance
     * 
     * Environment override: HARMONIC_EXIT_MIN_HOLD_MINUTES
     */
    minHoldMsNoiseExit: (parseInt(process.env.HARMONIC_EXIT_MIN_HOLD_MINUTES ?? '60', 10)) * 60 * 1000,
    
    /**
     * Log prefix
     */
    logPrefix: '[EXIT-SUPPRESS]',
    
    /**
     * Exit attempt cooldown (ms) - prevents re-triggering same position every 8s
     * After a suppressed exit attempt, don't re-evaluate for this duration
     * 
     * Environment override: EXIT_SUPPRESS_COOLDOWN_SECONDS
     */
    exitAttemptCooldownMs: (parseInt(process.env.EXIT_SUPPRESS_COOLDOWN_SECONDS ?? '900', 10)) * 1000,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HARMONIC EXIT GATING — Stop spam + churn
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Minimum hold time before HARMONIC_EXIT can trigger (minutes)
     * This is the HARD gate for harmonic exits
     * Environment override: HARMONIC_EXIT_MIN_HOLD_MINUTES
     */
    harmonicMinHoldMinutes: parseInt(process.env.HARMONIC_EXIT_MIN_HOLD_MINUTES ?? '60', 10),
    
    /**
     * Number of consecutive bad checks required before exit triggers
     * Prevents single bad sample from causing exit
     * Environment override: HARMONIC_EXIT_CONFIRMATIONS
     */
    harmonicExitConfirmations: parseInt(process.env.HARMONIC_EXIT_CONFIRMATIONS ?? '3', 10),
    
    /**
     * Cooldown after suppressed exit (seconds)
     * Environment override: EXIT_SUPPRESS_COOLDOWN_SECONDS
     */
    exitSuppressCooldownSeconds: parseInt(process.env.EXIT_SUPPRESS_COOLDOWN_SECONDS ?? '900', 10),
    
    /**
     * Maximum exit triggers per hour per position (rate limit)
     * Environment override: EXIT_TRIGGER_MAX_PER_HOUR
     */
    exitTriggerMaxPerHour: parseInt(process.env.EXIT_TRIGGER_MAX_PER_HOUR ?? '3', 10),
    
    /**
     * Hard emergency threshold for health score (bypass all gates)
     * If healthScore < this for badSamples >= 3, force exit
     */
    emergencyHealthThreshold: 0.20,
    
    /**
     * Minimum bad samples for emergency override
     */
    emergencyMinBadSamples: 3,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DEPRECATED — OLD COST MODEL (kept for reference, not used)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** @deprecated Use positionLifecycleCost module instead */
    costAmortizationFactor: 1.10,
    /** @deprecated Use positionLifecycleCost module instead */
    defaultEntryFeeRate: 0.003,
    /** @deprecated Use positionLifecycleCost module instead */
    defaultExitFeeRate: 0.003,
    /** @deprecated Use positionLifecycleCost module instead */
    defaultSlippageRate: 0.002,
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT ATTEMPT COOLDOWN — Prevents exit trigger loops
// ═══════════════════════════════════════════════════════════════════════════════

interface ExitAttemptRecord {
    lastAttemptTime: number;
    attemptCount: number;
    lastReason: string;
}

/** Track exit attempts per tradeId to prevent 8s re-trigger loops */
const exitAttemptCooldowns = new Map<string, ExitAttemptRecord>();

/**
 * Check if a position is in exit cooldown (recently had suppressed exit attempt)
 */
export function isInExitCooldown(tradeId: string): boolean {
    const record = exitAttemptCooldowns.get(tradeId);
    if (!record) return false;
    
    const elapsed = Date.now() - record.lastAttemptTime;
    if (elapsed > EXIT_CONFIG.exitAttemptCooldownMs) {
        // Cooldown expired, clear it
        exitAttemptCooldowns.delete(tradeId);
        return false;
    }
    
    return true;
}

/**
 * Record a suppressed exit attempt (sets cooldown)
 */
export function recordSuppressedExitAttempt(tradeId: string, reason: string): void {
    const existing = exitAttemptCooldowns.get(tradeId);
    exitAttemptCooldowns.set(tradeId, {
        lastAttemptTime: Date.now(),
        attemptCount: (existing?.attemptCount ?? 0) + 1,
        lastReason: reason,
    });
    
    const record = exitAttemptCooldowns.get(tradeId)!;
    if (record.attemptCount > 3) {
        logger.warn(
            `[EXIT-COOLDOWN] tradeId=${tradeId.slice(0, 8)}... ` +
            `attempts=${record.attemptCount} reason="${reason}" — ` +
            `Consider forcing exit if this persists`
        );
    }
}

/**
 * Clear exit cooldown for a position (call after successful exit)
 */
export function clearExitCooldown(tradeId: string): void {
    exitAttemptCooldowns.delete(tradeId);
}

/**
 * Get exit attempt count for debugging
 */
export function getExitAttemptCount(tradeId: string): number {
    return exitAttemptCooldowns.get(tradeId)?.attemptCount ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT-IN-PROGRESS LOCK — Prevents double-exit execution
// ═══════════════════════════════════════════════════════════════════════════════

/** Track exits currently being executed to prevent duplicate execution */
const exitsInProgress = new Set<string>();

/**
 * Check if an exit is already in progress for this tradeId.
 * Used to prevent ScanLoop and ExitWatcher from both executing same exit.
 */
export function isExitInProgress(tradeId: string): boolean {
    return exitsInProgress.has(tradeId);
}

/**
 * Mark an exit as in-progress (call BEFORE executing exit).
 * Returns false if exit already in progress (caller should abort).
 */
export function markExitInProgress(tradeId: string): boolean {
    if (exitsInProgress.has(tradeId)) {
        logger.warn(
            `[EXIT-LOCK] tradeId=${tradeId.slice(0, 8)}... ` +
            `Exit already in progress — skipping duplicate execution`
        );
        return false;
    }
    exitsInProgress.add(tradeId);
    logger.debug(`[EXIT-LOCK] tradeId=${tradeId.slice(0, 8)}... Exit locked`);
    return true;
}

/**
 * Clear the exit-in-progress lock (call AFTER exit completes or fails).
 */
export function clearExitInProgress(tradeId: string): void {
    exitsInProgress.delete(tradeId);
    // Also clear cooldown since exit completed
    clearExitCooldown(tradeId);
    logger.debug(`[EXIT-LOCK] tradeId=${tradeId.slice(0, 8)}... Exit lock released`);
}

/**
 * Get count of exits currently in progress
 */
export function getExitsInProgressCount(): number {
    return exitsInProgress.size;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * TRUE EMERGENCY exit types — ONLY existential threats
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHASE 1 FIX: Narrowed down to REAL emergencies only
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * TRUE emergencies that bypass minimum hold:
 *   ✅ Pool migration / deprecation
 *   ✅ Liquidity collapse (TVL drop > 50%)
 *   ✅ Decimals / mint inconsistency
 *   ✅ On-chain failure / revert loop
 *   ✅ Rug pull / freeze/mint authority
 * 
 * NOT emergencies (moved to NOISE_EXIT_TYPES):
 *   ❌ Score drops
 *   ❌ MHI drops
 *   ❌ Regime changes
 *   ❌ Velocity dips
 *   ❌ Fee velocity underperformance
 *   ❌ Any ranking-based signal
 */
export const RISK_EXIT_TYPES = [
    // TRUE EXISTENTIAL THREATS ONLY
    'POOL_MIGRATION',
    'POOL_DEPRECATED',
    'POOL_CLOSED',
    'TVL_COLLAPSE',
    'LIQUIDITY_DRAIN',
    'MINT_MISMATCH',
    'DECIMALS_ERROR',
    'ONCHAIN_REVERT',
    'TRANSACTION_FAILURE',
    'RUG_PULL',
    'RUG_RISK',
    'RUG_RISK_EXIT',
    'FREEZE_AUTHORITY_USED',
    'MINT_AUTHORITY_ACTIVE',
    'CAPITAL_ERROR',
    'LEDGER_CORRUPTION',
    'LEDGER_ERROR',
    'DB_SYNC_FAILURE',
    'PORTFOLIO_LEDGER_ERROR',
    'INVARIANT_FAILURE',
] as const;

export type RiskExitType = typeof RISK_EXIT_TYPES[number];

/**
 * Noise exit types — RESPECT MINIMUM HOLD TIME
 * 
 * These are NOT emergencies. They must wait for:
 *   1. Minimum hold time (60 minutes)
 *   2. Fee amortization gate (fee velocity decay)
 * 
 * Moved here from RISK_EXIT_TYPES:
 *   - Score/MHI drops
 *   - Regime changes
 *   - Velocity dips
 *   - All ranking-based signals
 */
export const NOISE_EXIT_TYPES = [
    // Score-based (NOT EMERGENCY)
    'TIER4_SCORE_DROP',
    'SCORE_DROP',
    'MHI_DROP',
    
    // Regime-based (NOT EMERGENCY)
    'REGIME_FLIP',
    'CHAOS_REGIME',
    'TIER4_CHAOS',
    'MARKET_CRASH',
    'MARKET_CRASH_EXIT',
    'KILL_SWITCH',
    'KILL_SWITCH_EXIT',
    
    // Velocity-based (NOT EMERGENCY)
    'FEE_VELOCITY_LOW',
    'SWAP_VELOCITY_LOW',
    'VELOCITY_DIP',
    'FEE_BLEED_ACTIVE',
    'FEE_BLEED_DEFENSE',
    'BLEED_EXIT',
    'FEE_INTENSITY_COLLAPSE',
    
    // Health signals (NOT EMERGENCY — use fee amortization)
    'HARMONIC_EXIT',
    'HARMONIC',
    'MICROSTRUCTURE_EXIT',
    'MICROSTRUCTURE',
    'EMERGENCY_EXIT',  // Misnomer - not a true emergency
    'EMERGENCY',       // Misnomer - check actual reason
    
    // Optional exits
    'MIGRATION_REVERSAL',
    'BIN_OFFSET',
    'VSH_EXIT',
    'HOLD_TIMEOUT',
    'PROFIT_TAKE',
    'REBALANCE',
    'FORCED_EXIT',
    'FORCE_EXIT',
    'RECOVERY_EXIT',
    'MTM_ERROR_EXIT',
    'RESTART_RECONCILE',
    'INSUFFICIENT_CAPITAL',
    'STOP_LOSS',
] as const;

export type NoiseExitType = typeof NOISE_EXIT_TYPES[number];

/**
 * Position data for suppression check
 */
export interface PositionForSuppression {
    tradeId: string;
    poolName: string;
    entryTime: number;
    entryNotionalUsd: number;
    /** @deprecated Not used in new cost model */
    entryFeesUsd?: number;
    /** @deprecated Not used in new cost model */
    expectedExitFeesUsd?: number;
    /** @deprecated Not used in new cost model */
    slippageTotalUsd?: number;
}

/**
 * Extended position data with amortization decay telemetry.
 * Used by shouldSuppressNoiseExitWithDecay for advanced decay gating.
 */
export interface ExtendedPositionForSuppression extends PositionForSuppression {
    /** Current health score from harmonic stops (0-1) */
    healthScore?: number;
    
    /** Count of consecutive bad samples */
    badSamples?: number;
    
    /** Required bad samples threshold for exit */
    badSamplesRequired?: number;
    
    /** Whether harmonic exit has been triggered */
    harmonicExitTriggered?: boolean;
    
    /** Velocity ratio (current/baseline), from harmonic debug */
    velocityRatio?: number;
    
    /** Entropy ratio (current/baseline), from harmonic debug */
    entropyRatio?: number;
    
    /** MTM unrealized PnL in USD */
    mtmUnrealizedPnlUsd?: number;
    
    /** MTM unrealized PnL as percentage */
    mtmUnrealizedPnlPct?: number;
}

/**
 * Extended suppression result with full cost breakdown
 */
export interface ExtendedSuppressionResult extends SuppressionResult {
    /** Full lifecycle cost breakdown (for logging) */
    costBreakdown?: LifecycleCostEstimate;
    /** Exit trigger reason */
    exitTrigger?: string;
    /** Amortization gate result (if decay was evaluated) */
    amortGate?: AmortizationGateResult;
    /** Whether exit was allowed via amortization decay override */
    amortDecayApplied?: boolean;
    /** Effective cost target after decay (may differ from costTargetUsd) */
    effectiveCostTargetUsd?: number;
}

/**
 * Suppression check result
 */
export interface SuppressionResult {
    suppress: boolean;
    reason: SuppressReason | null;
    details: string;
    holdTimeMs: number;
    feesAccruedUsd: number;
    costTargetUsd: number;
}

export type SuppressReason = 'MIN_HOLD' | 'COST_NOT_AMORTIZED' | 'NONE';

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT TYPE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if an exit reason is a RISK exit (never suppress)
 */
export function isRiskExit(exitReason: string): boolean {
    const normalizedReason = exitReason.toUpperCase().replace(/[^A-Z_]/g, '_');
    
    for (const riskType of RISK_EXIT_TYPES) {
        if (normalizedReason.includes(riskType)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Check if an exit reason is a NOISE exit (can be suppressed)
 */
export function isNoiseExit(exitReason: string): boolean {
    const normalizedReason = exitReason.toUpperCase().replace(/[^A-Z_]/g, '_');
    
    for (const noiseType of NOISE_EXIT_TYPES) {
        if (normalizedReason.includes(noiseType)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Classify an exit reason
 */
export function classifyExitReason(exitReason: string): 'RISK' | 'NOISE' | 'UNKNOWN' {
    if (isRiskExit(exitReason)) return 'RISK';
    if (isNoiseExit(exitReason)) return 'NOISE';
    return 'UNKNOWN';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPRESSION CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a noise exit should be suppressed
 * 
 * CRITICAL: This function MUST NEVER suppress risk exits.
 * Caller must verify exit type before calling.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * UPDATED COST MODEL: Uses positionLifecycleCost instead of swap fees
 * 
 * OLD: costTarget = (0.3% entry + 0.3% exit + 0.2% slippage) × 1.1 = 0.88% of notional
 *      For $2800 → $24.64 (unrealistic, caused perpetual suppression)
 * 
 * NEW: costTarget = ($0.40 × 2 actions) × 1.25 = $1.00
 *      Realistic for LP operations that don't pay swap fees
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * @param position - Position being evaluated
 * @param mtm - Current MTM valuation (for fees accrued)
 * @param exitReason - Reason for exit attempt
 * @returns Suppression result with reason
 */
export function shouldSuppressNoiseExit(
    position: PositionForSuppression,
    mtm: MTMValuation,
    exitReason: string
): ExtendedSuppressionResult {
    const now = Date.now();
    const holdTimeMs = now - position.entryTime;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SAFETY CHECK: Never suppress risk exits
    // ═══════════════════════════════════════════════════════════════════════════
    if (isRiskExit(exitReason)) {
        return {
            suppress: false,
            reason: null,
            details: `RISK exit "${exitReason}" — never suppress`,
            holdTimeMs,
            feesAccruedUsd: mtm.feesAccruedUsd,
            costTargetUsd: 0,
            exitTrigger: exitReason,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: Minimum hold time
    // ═══════════════════════════════════════════════════════════════════════════
    if (holdTimeMs < EXIT_CONFIG.minHoldMsNoiseExit) {
        const holdTimeMin = Math.floor(holdTimeMs / 60000);
        const minHoldMin = Math.floor(EXIT_CONFIG.minHoldMsNoiseExit / 60000);
        
        logSuppression(position, 'MIN_HOLD', exitReason, {
            holdTimeMs,
            minHoldMs: EXIT_CONFIG.minHoldMsNoiseExit,
        });
        
        return {
            suppress: true,
            reason: 'MIN_HOLD',
            details: `holdTime=${holdTimeMin}min < minHold=${minHoldMin}min`,
            holdTimeMs,
            feesAccruedUsd: mtm.feesAccruedUsd,
            costTargetUsd: 0,
            exitTrigger: exitReason,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: Cost amortization (NEW MODEL)
    // ═══════════════════════════════════════════════════════════════════════════
    const costBreakdown = estimatePositionLifecycleCostUsd({
        notionalUsd: mtm.mtmValueUsd,
        entryNotionalUsd: position.entryNotionalUsd,
    });
    
    const costTarget = costBreakdown.costTargetUsd;
    
    if (mtm.feesAccruedUsd < costTarget) {
        logSuppressionWithBreakdown(position, exitReason, mtm.feesAccruedUsd, costBreakdown);
        
        return {
            suppress: true,
            reason: 'COST_NOT_AMORTIZED',
            details: `feesAccrued=$${mtm.feesAccruedUsd.toFixed(2)} < costTarget=$${costTarget.toFixed(2)}`,
            holdTimeMs,
            feesAccruedUsd: mtm.feesAccruedUsd,
            costTargetUsd: costTarget,
            costBreakdown,
            exitTrigger: exitReason,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PASSED: Allow exit
    // ═══════════════════════════════════════════════════════════════════════════
    return {
        suppress: false,
        reason: null,
        details: 'Passed all suppression checks',
        holdTimeMs,
        feesAccruedUsd: mtm.feesAccruedUsd,
        costTargetUsd: costTarget,
        costBreakdown,
        exitTrigger: exitReason,
    };
}

/**
 * Check if a noise exit should be suppressed with AMORTIZATION DECAY support.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * AMORTIZATION DECAY: Time-based relaxation of cost target when recovery
 * probability collapses. Preserves anti-churn protection early, but guarantees
 * timely capital recycling during prolonged dominance failure.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This function extends shouldSuppressNoiseExit with decay gating:
 * - If telemetry is available, uses computeAmortizationGate() for decay
 * - Falls back to base behavior if telemetry is missing
 * - Logs both base and effective cost targets for observability
 * 
 * @param position - Extended position with decay telemetry
 * @param mtm - Current MTM valuation
 * @param exitReason - Reason for exit attempt
 * @returns Extended suppression result with decay info
 */
export function shouldSuppressNoiseExitWithDecay(
    position: ExtendedPositionForSuppression,
    mtm: MTMValuation,
    exitReason: string
): ExtendedSuppressionResult {
    const now = Date.now();
    const holdTimeMs = now - position.entryTime;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SAFETY CHECK: Never suppress risk exits
    // ═══════════════════════════════════════════════════════════════════════════
    if (isRiskExit(exitReason)) {
        return {
            suppress: false,
            reason: null,
            details: `RISK exit "${exitReason}" — never suppress`,
            holdTimeMs,
            feesAccruedUsd: mtm.feesAccruedUsd,
            costTargetUsd: 0,
            exitTrigger: exitReason,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: Minimum hold time (unchanged)
    // ═══════════════════════════════════════════════════════════════════════════
    if (holdTimeMs < EXIT_CONFIG.minHoldMsNoiseExit) {
        const holdTimeMin = Math.floor(holdTimeMs / 60000);
        const minHoldMin = Math.floor(EXIT_CONFIG.minHoldMsNoiseExit / 60000);
        
        logSuppression(position, 'MIN_HOLD', exitReason, {
            holdTimeMs,
            minHoldMs: EXIT_CONFIG.minHoldMsNoiseExit,
        });
        
        return {
            suppress: true,
            reason: 'MIN_HOLD',
            details: `holdTime=${holdTimeMin}min < minHold=${minHoldMin}min`,
            holdTimeMs,
            feesAccruedUsd: mtm.feesAccruedUsd,
            costTargetUsd: 0,
            exitTrigger: exitReason,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: Cost amortization WITH DECAY
    // ═══════════════════════════════════════════════════════════════════════════
    const costBreakdown = estimatePositionLifecycleCostUsd({
        notionalUsd: mtm.mtmValueUsd,
        entryNotionalUsd: position.entryNotionalUsd,
    });
    
    const baseCostTarget = costBreakdown.costTargetUsd;
    
    // Build amortization gate input from position telemetry
    const gateInput: AmortizationGateInput = {
        baseCostTargetUsd: baseCostTarget,
        feesAccruedUsd: mtm.feesAccruedUsd,
        holdTimeMs,
        healthScore: position.healthScore ?? 1.0,
        badSamples: position.badSamples ?? 0,
        badSamplesRequired: position.badSamplesRequired ?? EXIT_CONFIG.harmonicExitConfirmations,
        harmonicExitTriggered: position.harmonicExitTriggered ?? 
            (exitReason.toUpperCase().includes('HARMONIC') ||
            exitReason.toUpperCase().includes('EXIT_TRIGGERED')),
        velocityRatio: position.velocityRatio,
        entropyRatio: position.entropyRatio,
        mtmUnrealizedPnlUsd: position.mtmUnrealizedPnlUsd,
        mtmUnrealizedPnlPct: position.mtmUnrealizedPnlPct,
        notionalUsd: mtm.mtmValueUsd,
    };
    
    // Compute amortization gate with decay
    const amortGate = computeAmortizationGate(gateInput);
    const effectiveCostTarget = amortGate.effectiveCostTargetUsd;
    const amortDecayApplied = amortGate.debug.amortDecayApplied;
    
    // Check if exit is allowed (fees >= effective target)
    if (!amortGate.allowExit) {
        // Exit suppressed - log with decay info
        logSuppressionWithDecay(
            position,
            exitReason,
            mtm.feesAccruedUsd,
            costBreakdown,
            amortGate
        );
        
        return {
            suppress: true,
            reason: 'COST_NOT_AMORTIZED',
            details: `feesAccrued=$${mtm.feesAccruedUsd.toFixed(2)} < effectiveCostTarget=$${effectiveCostTarget.toFixed(2)}`,
            holdTimeMs,
            feesAccruedUsd: mtm.feesAccruedUsd,
            costTargetUsd: baseCostTarget,
            effectiveCostTargetUsd: effectiveCostTarget,
            costBreakdown,
            exitTrigger: exitReason,
            amortGate,
            amortDecayApplied,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PASSED: Allow exit
    // ═══════════════════════════════════════════════════════════════════════════
    
    // If exit was allowed via decay override, log it
    if (amortDecayApplied && mtm.feesAccruedUsd < baseCostTarget) {
        logAmortDecayOverride(
            position.poolName,
            position.tradeId,
            amortGate,
            mtm.feesAccruedUsd
        );
    }
    
    return {
        suppress: false,
        reason: null,
        details: amortDecayApplied 
            ? `AMORT_DECAY_OVERRIDE: fees=$${mtm.feesAccruedUsd.toFixed(2)} >= effective=$${effectiveCostTarget.toFixed(2)}`
            : 'Passed all suppression checks',
        holdTimeMs,
        feesAccruedUsd: mtm.feesAccruedUsd,
        costTargetUsd: baseCostTarget,
        effectiveCostTargetUsd: effectiveCostTarget,
        costBreakdown,
        exitTrigger: exitReason,
        amortGate,
        amortDecayApplied,
    };
}

/**
 * Quick check if exit can proceed (for early filtering)
 * 
 * Returns true if exit should proceed, false if might be suppressed
 * 
 * @param exitReason - Exit reason
 * @param holdTimeMs - Time position has been held
 * @returns true if definitely allowed (risk exit or old enough)
 */
export function canExitProceed(exitReason: string, holdTimeMs: number): boolean {
    // Risk exits always proceed
    if (isRiskExit(exitReason)) {
        return true;
    }
    
    // Old positions can proceed (will still check amortization)
    if (holdTimeMs >= EXIT_CONFIG.minHoldMsNoiseExit * 2) {
        return true;
    }
    
    // Need full check
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log exit suppression with rate limiting
 * Reduces log spam by only logging each (tradeId, reason) combo once per 60s
 */
function logSuppression(
    position: PositionForSuppression,
    reason: SuppressReason,
    exitReason: string,
    details: Record<string, number>
): void {
    const detailStr = Object.entries(details)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
        .join(' ');
    
    // Use rate-limited logging to prevent spam
    // Key is tradeId + reason to deduplicate same suppression
    logExitSuppressRateLimited(
        position.tradeId,
        position.poolName,
        reason,
        `exitTrigger="${exitReason}" ${detailStr}`
    );
}

/**
 * Log COST_NOT_AMORTIZED suppression with FULL cost breakdown
 * Shows: feesAccrued, costTarget, txCost, impactCost, safetyFactor, notional, clamp
 * 
 * This is the NEW logging format requested in the spec.
 */
function logSuppressionWithBreakdown(
    position: PositionForSuppression,
    exitTrigger: string,
    feesAccruedUsd: number,
    breakdown: LifecycleCostEstimate
): void {
    const clampInfo = breakdown.clampApplied 
        ? ` clamp=${breakdown.clampType}` 
        : '';
    
    // Rate-limited log with full breakdown
    logExitSuppressRateLimited(
        position.tradeId,
        position.poolName,
        'COST_NOT_AMORTIZED',
        `exitTrigger="${exitTrigger}" ` +
        `feesAccrued=$${feesAccruedUsd.toFixed(2)} ` +
        `costTarget=$${breakdown.costTargetUsd.toFixed(2)} ` +
        `txCost=$${breakdown.txCostUsd.toFixed(2)} ` +
        `impactCost=$${breakdown.impactCostUsd.toFixed(2)} ` +
        `safetyFactor=${breakdown.safetyFactor.toFixed(2)} ` +
        `notional=$${breakdown.notionalUsd.toFixed(2)}` +
        clampInfo
    );
}

/**
 * Log COST_NOT_AMORTIZED suppression with DECAY breakdown.
 * 
 * Format includes both base and effective cost targets, decay factor,
 * decay age, weakness gate status, and half-life used.
 */
function logSuppressionWithDecay(
    position: PositionForSuppression,
    exitTrigger: string,
    feesAccruedUsd: number,
    breakdown: LifecycleCostEstimate,
    amortGate: AmortizationGateResult
): void {
    const d = amortGate.debug;
    
    const decayInfo = d.amortDecayApplied
        ? ` decayFactor=${d.decayFactor.toFixed(3)} decayAgeMin=${d.decayAgeMin} halfLifeMin=${d.halfLifeMin}`
        : '';
    
    const weaknessInfo = d.weaknessGate
        ? ` weaknessGate=true signals=[${d.weaknessSignals.join(',')}]`
        : ' weaknessGate=false';
    
    // Rate-limited log with decay breakdown
    logExitSuppressRateLimited(
        position.tradeId,
        position.poolName,
        'COST_NOT_AMORTIZED',
        `exitTrigger="${exitTrigger}" ` +
        `feesAccrued=$${feesAccruedUsd.toFixed(2)} ` +
        `baseCostTarget=$${d.baseCostTargetUsd.toFixed(2)} ` +
        `effectiveCostTarget=$${amortGate.effectiveCostTargetUsd.toFixed(2)}` +
        decayInfo +
        weaknessInfo +
        ` holdTimeMin=${d.holdTimeMin} healthScore=${d.healthScore.toFixed(2)}`
    );
}

/**
 * Log allowed exit (for debugging)
 */
export function logExitAllowed(
    position: PositionForSuppression,
    exitReason: string,
    result: SuppressionResult
): void {
    const holdTimeMin = Math.floor(result.holdTimeMs / 60000);
    
    logger.debug(
        `[EXIT-ALLOWED] pool=${position.poolName} ` +
        `reason="${exitReason}" ` +
        `holdTime=${holdTimeMin}min ` +
        `feesAccrued=$${result.feesAccruedUsd.toFixed(2)} ` +
        `costTarget=$${result.costTargetUsd.toFixed(2)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════════════════════

interface SuppressionStats {
    totalChecks: number;
    suppressed: number;
    allowed: number;
    byReason: Record<SuppressReason | 'ALLOWED', number>;
    byExitType: Record<string, number>;
}

const stats: SuppressionStats = {
    totalChecks: 0,
    suppressed: 0,
    allowed: 0,
    byReason: { MIN_HOLD: 0, COST_NOT_AMORTIZED: 0, NONE: 0, ALLOWED: 0 },
    byExitType: {},
};

/**
 * Record suppression check result
 */
export function recordSuppressionCheck(
    result: SuppressionResult,
    exitReason: string
): void {
    stats.totalChecks++;
    
    if (result.suppress) {
        stats.suppressed++;
        if (result.reason) {
            stats.byReason[result.reason] = (stats.byReason[result.reason] || 0) + 1;
        }
    } else {
        stats.allowed++;
        stats.byReason.ALLOWED++;
    }
    
    const classification = classifyExitReason(exitReason);
    stats.byExitType[classification] = (stats.byExitType[classification] || 0) + 1;
}

/**
 * Get suppression statistics
 */
export function getSuppressionStats(): SuppressionStats {
    return { ...stats };
}

/**
 * Reset statistics (for testing)
 */
export function resetSuppressionStats(): void {
    stats.totalChecks = 0;
    stats.suppressed = 0;
    stats.allowed = 0;
    stats.byReason = { MIN_HOLD: 0, COST_NOT_AMORTIZED: 0, NONE: 0, ALLOWED: 0 };
    stats.byExitType = {};
}

/**
 * Log suppression summary
 */
export function logSuppressionSummary(): void {
    if (stats.totalChecks === 0) return;
    
    const suppressRate = (stats.suppressed / stats.totalChecks * 100).toFixed(1);
    
    logger.info(
        `[EXIT-SUPPRESS-SUMMARY] ` +
        `total=${stats.totalChecks} suppressed=${stats.suppressed} (${suppressRate}%) ` +
        `byReason=${JSON.stringify(stats.byReason)}`
    );
}

