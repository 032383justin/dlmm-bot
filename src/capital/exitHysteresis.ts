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
 * COST AMORTIZATION:
 *   costTarget = (entryFees + expectedExitFees + slippageTotal) × costAmortizationFactor
 *   feesAccrued must >= costTarget before allowing noise exit
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { logExitSuppressRateLimited } from '../utils/rateLimitedLogger';
import type { MTMValuation } from './mtmValuation';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const EXIT_CONFIG = {
    /**
     * Minimum hold time for noise exits (ms)
     * Positions held less than this cannot exit via noise triggers
     * 
     * ALIGNED WITH dlmmTelemetry.EXIT_THRESHOLDS.minHoldForMicroExit
     */
    minHoldMsNoiseExit: 60 * 60 * 1000, // 60 minutes (aligned with microstructure exit)
    
    /**
     * Cost amortization factor
     * feesAccrued must be >= (entryFees + exitFees + slippage) × this factor
     */
    costAmortizationFactor: 1.10, // 110% of costs
    
    /**
     * Default entry fee rate (as fraction)
     */
    defaultEntryFeeRate: 0.003, // 0.3%
    
    /**
     * Default exit fee rate (as fraction)
     */
    defaultExitFeeRate: 0.003, // 0.3%
    
    /**
     * Default slippage rate (as fraction)
     */
    defaultSlippageRate: 0.002, // 0.2% total (entry + exit)
    
    /**
     * Log prefix
     */
    logPrefix: '[EXIT-SUPPRESS]',
    
    /**
     * Exit attempt cooldown (ms) - prevents re-triggering same position every 8s
     * After a suppressed exit attempt, don't re-evaluate for this duration
     */
    exitAttemptCooldownMs: 2 * 60 * 1000, // 2 minutes
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
 * Risk exit types that must NEVER be suppressed
 * 
 * CRITICAL: Health exits (HARMONIC, KILL_SWITCH, RUG_RISK) are NEVER suppressible.
 * Only "optional" exits (profit take, rebalance) can be suppressed.
 */
export const RISK_EXIT_TYPES = [
    'KILL_SWITCH',
    'KILL_SWITCH_EXIT',
    'REGIME_FLIP',
    'CHAOS_REGIME',
    'FEE_BLEED_ACTIVE',
    'FEE_BLEED_DEFENSE',
    'FORCED_EXIT', // Execution telemetry forced exit (bypasses gating)
    'PORTFOLIO_LEDGER_ERROR',
    'LEDGER_ERROR',
    'EMERGENCY_EXIT',
    'EMERGENCY',
    'MARKET_CRASH',
    // Crash-recovery exit types — MUST bypass all suppression
    'RECOVERY_EXIT',
    'MTM_ERROR_EXIT',
    'RESTART_RECONCILE',
    'MARKET_CRASH_EXIT',
    'INSUFFICIENT_CAPITAL',
    'CAPITAL_ERROR',
    'INVARIANT_FAILURE',
    'FORCE_EXIT',
    'STOP_LOSS',
    'TIER4_CHAOS',
    'BLEED_EXIT',
    'MTM_ERROR_EXIT',
    // HEALTH EXITS — Never suppress, these indicate position health issues
    'HARMONIC_EXIT',
    'HARMONIC',
    'RUG_RISK_EXIT',
    'RUG_RISK',
    'MICROSTRUCTURE_EXIT',  // Pool health degraded
    'MICROSTRUCTURE',
] as const;

export type RiskExitType = typeof RISK_EXIT_TYPES[number];

/**
 * Noise exit types that CAN be suppressed (optional exits only)
 * 
 * These are "nice to have" exits - profit taking, rebalancing, etc.
 * NOT health exits - those go in RISK_EXIT_TYPES.
 */
export const NOISE_EXIT_TYPES = [
    'TIER4_SCORE_DROP',
    'SCORE_DROP',
    'FEE_INTENSITY_COLLAPSE',
    'MIGRATION_REVERSAL',
    'BIN_OFFSET',
    'VSH_EXIT',
    'HOLD_TIMEOUT',
    'PROFIT_TAKE',
    'REBALANCE',
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
    entryFeesUsd?: number;
    expectedExitFeesUsd?: number;
    slippageTotalUsd?: number;
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
 * @param position - Position being evaluated
 * @param mtm - Current MTM valuation (for fees accrued)
 * @param exitReason - Reason for exit attempt
 * @returns Suppression result with reason
 */
export function shouldSuppressNoiseExit(
    position: PositionForSuppression,
    mtm: MTMValuation,
    exitReason: string
): SuppressionResult {
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
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: Cost amortization
    // ═══════════════════════════════════════════════════════════════════════════
    const entryFees = position.entryFeesUsd ?? (position.entryNotionalUsd * EXIT_CONFIG.defaultEntryFeeRate);
    const exitFees = position.expectedExitFeesUsd ?? (mtm.mtmValueUsd * EXIT_CONFIG.defaultExitFeeRate);
    const slippage = position.slippageTotalUsd ?? (position.entryNotionalUsd * EXIT_CONFIG.defaultSlippageRate);
    
    const totalCosts = entryFees + exitFees + slippage;
    const costTarget = totalCosts * EXIT_CONFIG.costAmortizationFactor;
    
    if (mtm.feesAccruedUsd < costTarget) {
        logSuppression(position, 'COST_NOT_AMORTIZED', exitReason, {
            feesAccruedUsd: mtm.feesAccruedUsd,
            costTargetUsd: costTarget,
            entryFees,
            exitFees,
            slippage,
        });
        
        return {
            suppress: true,
            reason: 'COST_NOT_AMORTIZED',
            details: `feesAccrued=$${mtm.feesAccruedUsd.toFixed(2)} < costTarget=$${costTarget.toFixed(2)}`,
            holdTimeMs,
            feesAccruedUsd: mtm.feesAccruedUsd,
            costTargetUsd: costTarget,
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

