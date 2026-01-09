/**
 * Emergency Exit Definition — STRICT EXISTENTIAL THREATS ONLY
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHASE 1 FIX: Redefine what constitutes a TRUE emergency
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Emergency exits may ONLY trigger on:
 *   ✅ Pool migration / deprecation
 *   ✅ Liquidity collapse (TVL drop > X%)
 *   ✅ Decimals / mint inconsistency
 *   ✅ On-chain failure / revert loop
 * 
 * Explicitly REMOVED from emergency:
 *   ❌ Score drops
 *   ❌ MHI drops
 *   ❌ Regime changes
 *   ❌ Velocity dips
 *   ❌ Fee velocity underperformance
 *   ❌ Any ranking-based signal
 * 
 * RULE: If it's not existential, it is not an emergency.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEE PREDATOR MODE UPDATE:
 * 
 * For CLASS_A_FEE_FOUNTAIN pools:
 *   - ABSOLUTE minimum hold: 90 minutes
 *   - Harmonic, entropy, velocity, regime, score exits are DISABLED
 *   - Only TRUE emergencies bypass hold
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    FEE_PREDATOR_MODE_ENABLED,
    PREDATOR_HOLD_CONFIG,
    PoolClass,
    isValidExitForClass,
    getMinHoldMinutes,
} from '../config/feePredatorConfig';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const EMERGENCY_CONFIG = {
    /**
     * GLOBAL MINIMUM HOLD — HARD RULE
     * NO EXIT of any kind (except true emergency) before this duration
     * FEE PREDATOR: 90 minutes for Class A pools
     */
    MIN_HOLD_MINUTES: FEE_PREDATOR_MODE_ENABLED 
        ? PREDATOR_HOLD_CONFIG.MIN_HOLD_MINUTES_CLASS_A 
        : 60,
    
    /**
     * Class B minimum hold (for stable pools)
     */
    MIN_HOLD_MINUTES_CLASS_B: FEE_PREDATOR_MODE_ENABLED 
        ? PREDATOR_HOLD_CONFIG.MIN_HOLD_MINUTES_CLASS_B 
        : 60,
    
    /**
     * Liquidity collapse threshold — TVL must drop by this % to trigger emergency
     */
    TVL_COLLAPSE_THRESHOLD_PCT: 0.50,  // 50% drop
    
    /**
     * Minimum TVL remaining to NOT trigger emergency
     */
    MIN_TVL_USD: 10_000,  // Below $10k = emergency
    
    /**
     * Fee velocity decay windows required for post-hold exit
     * FEE PREDATOR: Requires 5 windows of persistent decay
     */
    FEE_VELOCITY_DECAY_WINDOWS: FEE_PREDATOR_MODE_ENABLED 
        ? PREDATOR_HOLD_CONFIG.FEE_VELOCITY_DECAY_WINDOWS_REQUIRED 
        : 3,
    
    /**
     * Fee velocity decay threshold — % drop from entry to trigger exit consideration
     * FEE PREDATOR: 70% drop required (more conservative)
     */
    FEE_VELOCITY_DECAY_THRESHOLD: FEE_PREDATOR_MODE_ENABLED 
        ? PREDATOR_HOLD_CONFIG.FEE_VELOCITY_DECAY_THRESHOLD 
        : 0.50,
    
    /**
     * Target payback hours for fee amortization gate
     * Fees/hour must be < entry_cost / this value to allow exit
     */
    TARGET_PAYBACK_HOURS: 4,
    
    /**
     * Minimum decay confirmation windows for temporary slowdown filtering
     */
    MIN_DECAY_CONFIRMATION_WINDOWS: FEE_PREDATOR_MODE_ENABLED 
        ? PREDATOR_HOLD_CONFIG.MIN_DECAY_CONFIRMATION_WINDOWS 
        : 2,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TRUE EMERGENCY EXIT TYPES — EXISTENTIAL THREATS ONLY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * TRUE emergencies that bypass minimum hold
 * These are existential threats to the position
 */
export const TRUE_EMERGENCY_TYPES = [
    // Pool lifecycle threats
    'POOL_MIGRATION',
    'POOL_DEPRECATED',
    'POOL_CLOSED',
    
    // Liquidity collapse
    'TVL_COLLAPSE',
    'LIQUIDITY_DRAIN',
    
    // On-chain failures
    'MINT_MISMATCH',
    'DECIMALS_ERROR',
    'ONCHAIN_REVERT',
    'TRANSACTION_FAILURE',
    
    // Rug/scam detection
    'RUG_PULL',
    'FREEZE_AUTHORITY_USED',
    'MINT_AUTHORITY_ACTIVE',
    
    // Infrastructure failures
    'CAPITAL_ERROR',
    'LEDGER_CORRUPTION',
    'DB_SYNC_FAILURE',
] as const;

export type TrueEmergencyType = typeof TRUE_EMERGENCY_TYPES[number];

/**
 * NOT emergencies — These are now NOISE exits that respect min hold
 * 
 * These were previously in RISK_EXIT_TYPES but are NOT existential
 * 
 * FEE PREDATOR MODE: All of these are DISABLED for CLASS_A_FEE_FOUNTAIN pools
 */
export const NOT_EMERGENCY_TYPES = [
    // Score-based (NOT EMERGENCY)
    'SCORE_DROP',
    'TIER4_SCORE_DROP',
    'MHI_DROP',
    'SCORE_DECAY_EXIT',
    
    // Regime-based (NOT EMERGENCY)
    'REGIME_FLIP',
    'CHAOS_REGIME',
    'TIER4_CHAOS',
    'MARKET_CRASH',
    'MARKET_CRASH_EXIT',
    'REGIME_BASED_EXIT',
    
    // Velocity-based (NOT EMERGENCY)
    'FEE_VELOCITY_LOW',
    'SWAP_VELOCITY_LOW',
    'VELOCITY_DIP',
    'VELOCITY_COLLAPSE_EXIT',
    
    // Fee-based (NOT EMERGENCY)
    'FEE_BLEED_ACTIVE',
    'FEE_BLEED_DEFENSE',
    'BLEED_EXIT',
    'FEE_INTENSITY_COLLAPSE',
    
    // Health signals (NOT EMERGENCY — use fee amortization instead)
    'HARMONIC_EXIT',
    'HARMONIC',
    'MICROSTRUCTURE_EXIT',
    'MICROSTRUCTURE',
    'ENTROPY_BASED_EXIT',
    
    // Ranking-based (NOT EMERGENCY)
    'KILL_SWITCH',
    'KILL_SWITCH_EXIT',
    
    // Short-term signals (NOT EMERGENCY for FEE PREDATOR)
    'SHORT_TERM_SCORE_DECAY',
    'TEMPORARY_SLOWDOWN',
] as const;

export type NotEmergencyType = typeof NOT_EMERGENCY_TYPES[number];

// ═══════════════════════════════════════════════════════════════════════════════
// EMERGENCY DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

export interface EmergencyCheckResult {
    isEmergency: boolean;
    emergencyType?: TrueEmergencyType;
    reason: string;
    bypassMinHold: boolean;
}

/**
 * Check if an exit reason is a TRUE emergency
 */
export function isTrueEmergency(exitReason: string): boolean {
    const normalized = exitReason.toUpperCase().replace(/[^A-Z_]/g, '_');
    
    for (const emergencyType of TRUE_EMERGENCY_TYPES) {
        if (normalized.includes(emergencyType) || emergencyType.includes(normalized)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Check if an exit reason is explicitly NOT an emergency
 */
export function isNotEmergency(exitReason: string): boolean {
    const normalized = exitReason.toUpperCase().replace(/[^A-Z_]/g, '_');
    
    for (const notEmergency of NOT_EMERGENCY_TYPES) {
        if (normalized.includes(notEmergency) || notEmergency.includes(normalized)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Check if exit is valid for given pool class (FEE PREDATOR MODE)
 * 
 * For CLASS_A_FEE_FOUNTAIN pools, most exits are DISABLED.
 * Only TRUE emergencies and persistent fee velocity decay are allowed.
 */
export function isExitValidForPoolClass(exitReason: string, poolClass: PoolClass): boolean {
    if (!FEE_PREDATOR_MODE_ENABLED) {
        return true;  // All exits valid in non-predator mode
    }
    
    // Use the predator config's validation
    return isValidExitForClass(exitReason, poolClass);
}

/**
 * Get minimum hold minutes for pool class (FEE PREDATOR MODE)
 */
export function getMinHoldMinutesForClass(poolClass: PoolClass): number {
    if (!FEE_PREDATOR_MODE_ENABLED) {
        return EMERGENCY_CONFIG.MIN_HOLD_MINUTES;
    }
    
    return getMinHoldMinutes(poolClass);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MINIMUM HOLD ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export interface MinHoldCheckResult {
    allowed: boolean;
    holdTimeMinutes: number;
    minHoldMinutes: number;
    reason: string;
}

/**
 * Check if minimum hold time is satisfied
 * 
 * HARD RULE: NO EXIT of any kind (except true emergency) before MIN_HOLD_MINUTES
 * 
 * FEE PREDATOR MODE: Uses pool class to determine minimum hold
 * - CLASS_A_FEE_FOUNTAIN: 90 minutes
 * - CLASS_B_STABILITY: 60 minutes
 */
export function checkMinHold(
    entryTimestamp: number,
    exitReason: string,
    poolClass?: PoolClass
): MinHoldCheckResult {
    const now = Date.now();
    const holdTimeMs = now - entryTimestamp;
    const holdTimeMinutes = holdTimeMs / (60 * 1000);
    
    // Determine min hold based on pool class
    const minHoldMinutes = poolClass 
        ? getMinHoldMinutesForClass(poolClass)
        : EMERGENCY_CONFIG.MIN_HOLD_MINUTES;
    
    // True emergencies bypass min hold
    if (isTrueEmergency(exitReason)) {
        logger.info(
            `[MIN-HOLD] BYPASS | reason=${exitReason} | ` +
            `TRUE_EMERGENCY bypasses ${minHoldMinutes}m min hold`
        );
        return {
            allowed: true,
            holdTimeMinutes,
            minHoldMinutes,
            reason: 'TRUE_EMERGENCY_BYPASS',
        };
    }
    
    // FEE PREDATOR MODE: Check if exit is valid for pool class
    if (FEE_PREDATOR_MODE_ENABLED && poolClass === 'CLASS_A_FEE_FOUNTAIN') {
        if (!isExitValidForPoolClass(exitReason, poolClass)) {
            logger.info(
                `[MIN-HOLD] BLOCKED_PREDATOR | reason=${exitReason} | ` +
                `Exit type DISABLED for CLASS_A_FEE_FOUNTAIN pools`
            );
            return {
                allowed: false,
                holdTimeMinutes,
                minHoldMinutes,
                reason: `EXIT_DISABLED_FOR_CLASS_A: ${exitReason}`,
            };
        }
    }
    
    // Check hold time
    if (holdTimeMinutes < minHoldMinutes) {
        logger.debug(
            `[MIN-HOLD] BLOCKED | reason=${exitReason} | ` +
            `holdTime=${holdTimeMinutes.toFixed(1)}m < minHold=${minHoldMinutes}m | ` +
            `poolClass=${poolClass || 'UNKNOWN'}`
        );
        return {
            allowed: false,
            holdTimeMinutes,
            minHoldMinutes,
            reason: `MIN_HOLD_NOT_MET: ${holdTimeMinutes.toFixed(1)}m < ${minHoldMinutes}m`,
        };
    }
    
    return {
        allowed: true,
        holdTimeMinutes,
        minHoldMinutes,
        reason: 'MIN_HOLD_SATISFIED',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEE AMORTIZATION GATE — POST-HOLD ONLY
// ═══════════════════════════════════════════════════════════════════════════════

export interface FeeAmortizationCheckResult {
    allowed: boolean;
    feesPerHour: number;
    entryCostUsd: number;
    targetPaybackHours: number;
    requiredFeesPerHour: number;
    feeVelocityDecayWindows: number;
    reason: string;
}

/**
 * Fee Amortization Gate — After min hold is satisfied
 * 
 * Exits may occur only if:
 *   - Fee velocity decays for N windows AND
 *   - Fees/hour < entry_cost / target_payback_hours
 * 
 * No EV, no score, no MHI exits.
 */
export function checkFeeAmortizationGate(
    entryCostUsd: number,
    currentFeesPerHour: number,
    feeVelocityDecayWindows: number
): FeeAmortizationCheckResult {
    const targetPaybackHours = EMERGENCY_CONFIG.TARGET_PAYBACK_HOURS;
    const requiredFeesPerHour = entryCostUsd / targetPaybackHours;
    const requiredDecayWindows = EMERGENCY_CONFIG.FEE_VELOCITY_DECAY_WINDOWS;
    
    // Check if fee velocity has decayed enough for enough windows
    const velocityDecayed = currentFeesPerHour < requiredFeesPerHour;
    const enoughDecayWindows = feeVelocityDecayWindows >= requiredDecayWindows;
    
    if (!velocityDecayed) {
        return {
            allowed: false,
            feesPerHour: currentFeesPerHour,
            entryCostUsd,
            targetPaybackHours,
            requiredFeesPerHour,
            feeVelocityDecayWindows,
            reason: `FEE_VELOCITY_OK: $${currentFeesPerHour.toFixed(4)}/h >= $${requiredFeesPerHour.toFixed(4)}/h required`,
        };
    }
    
    if (!enoughDecayWindows) {
        return {
            allowed: false,
            feesPerHour: currentFeesPerHour,
            entryCostUsd,
            targetPaybackHours,
            requiredFeesPerHour,
            feeVelocityDecayWindows,
            reason: `DECAY_WINDOWS_INSUFFICIENT: ${feeVelocityDecayWindows}/${requiredDecayWindows} windows`,
        };
    }
    
    logger.info(
        `[FEE-AMORT-GATE] EXIT_ALLOWED | ` +
        `fees/h=$${currentFeesPerHour.toFixed(4)} < required=$${requiredFeesPerHour.toFixed(4)} | ` +
        `decayWindows=${feeVelocityDecayWindows}/${requiredDecayWindows}`
    );
    
    return {
        allowed: true,
        feesPerHour: currentFeesPerHour,
        entryCostUsd,
        targetPaybackHours,
        requiredFeesPerHour,
        feeVelocityDecayWindows,
        reason: 'FEE_VELOCITY_DECAYED_CONSISTENTLY',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TVL COLLAPSE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

export interface TvlCollapseCheckResult {
    isCollapse: boolean;
    currentTvl: number;
    entryTvl: number;
    dropPct: number;
    threshold: number;
    reason: string;
}

/**
 * Check for TVL collapse — TRUE EMERGENCY
 */
export function checkTvlCollapse(
    currentTvl: number,
    entryTvl: number
): TvlCollapseCheckResult {
    const dropPct = entryTvl > 0 ? (entryTvl - currentTvl) / entryTvl : 0;
    const threshold = EMERGENCY_CONFIG.TVL_COLLAPSE_THRESHOLD_PCT;
    const minTvl = EMERGENCY_CONFIG.MIN_TVL_USD;
    
    // Check if below minimum TVL
    if (currentTvl < minTvl) {
        return {
            isCollapse: true,
            currentTvl,
            entryTvl,
            dropPct,
            threshold,
            reason: `TVL_BELOW_MINIMUM: $${currentTvl.toFixed(0)} < $${minTvl}`,
        };
    }
    
    // Check for sudden drop
    if (dropPct >= threshold) {
        return {
            isCollapse: true,
            currentTvl,
            entryTvl,
            dropPct,
            threshold,
            reason: `TVL_DROPPED: ${(dropPct * 100).toFixed(0)}% >= ${(threshold * 100).toFixed(0)}% threshold`,
        };
    }
    
    return {
        isCollapse: false,
        currentTvl,
        entryTvl,
        dropPct,
        threshold,
        reason: 'TVL_STABLE',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED EXIT GATE
// ═══════════════════════════════════════════════════════════════════════════════

export interface ExitGateResult {
    allowed: boolean;
    exitCategory: 'TRUE_EMERGENCY' | 'FEE_AMORTIZATION' | 'BLOCKED';
    reason: string;
    minHoldCheck?: MinHoldCheckResult;
    feeAmortCheck?: FeeAmortizationCheckResult;
    tvlCheck?: TvlCollapseCheckResult;
}

/**
 * Combined Exit Gate — Single authority for exit decisions
 * 
 * PIPELINE:
 * 1. Check for TRUE emergency (bypasses all)
 * 2. Check minimum hold time (pool class aware)
 * 3. Check fee amortization gate
 * 
 * FEE PREDATOR MODE: Uses pool class for exit validation
 * - CLASS_A: 90m hold, most exits disabled
 * - CLASS_B: 60m hold, standard exits
 * 
 * Returns whether exit is allowed and why
 */
export function evaluateExitGate(
    entryTimestamp: number,
    exitReason: string,
    entryCostUsd: number,
    currentFeesPerHour: number,
    feeVelocityDecayWindows: number,
    currentTvl: number,
    entryTvl: number,
    poolClass?: PoolClass
): ExitGateResult {
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: TVL Collapse (TRUE EMERGENCY)
    // ═══════════════════════════════════════════════════════════════════════════
    const tvlCheck = checkTvlCollapse(currentTvl, entryTvl);
    if (tvlCheck.isCollapse) {
        logger.warn(
            `[EXIT-GATE] TRUE_EMERGENCY=TVL_COLLAPSE | ${tvlCheck.reason}`
        );
        return {
            allowed: true,
            exitCategory: 'TRUE_EMERGENCY',
            reason: tvlCheck.reason,
            tvlCheck,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: Other TRUE emergencies
    // ═══════════════════════════════════════════════════════════════════════════
    if (isTrueEmergency(exitReason)) {
        logger.warn(
            `[EXIT-GATE] TRUE_EMERGENCY=${exitReason} | Bypassing all gates`
        );
        return {
            allowed: true,
            exitCategory: 'TRUE_EMERGENCY',
            reason: `TRUE_EMERGENCY: ${exitReason}`,
            tvlCheck,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 3: Minimum hold time (pool class aware)
    // ═══════════════════════════════════════════════════════════════════════════
    const minHoldCheck = checkMinHold(entryTimestamp, exitReason, poolClass);
    if (!minHoldCheck.allowed) {
        return {
            allowed: false,
            exitCategory: 'BLOCKED',
            reason: minHoldCheck.reason,
            minHoldCheck,
            tvlCheck,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 4: Fee amortization gate (post-hold)
    // ═══════════════════════════════════════════════════════════════════════════
    const feeAmortCheck = checkFeeAmortizationGate(
        entryCostUsd,
        currentFeesPerHour,
        feeVelocityDecayWindows
    );
    
    if (!feeAmortCheck.allowed) {
        return {
            allowed: false,
            exitCategory: 'BLOCKED',
            reason: feeAmortCheck.reason,
            minHoldCheck,
            feeAmortCheck,
            tvlCheck,
        };
    }
    
    // All checks passed — exit allowed
    return {
        allowed: true,
        exitCategory: 'FEE_AMORTIZATION',
        reason: 'FEE_VELOCITY_DECAY_EXIT',
        minHoldCheck,
        feeAmortCheck,
        tvlCheck,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logEmergencyDefinition(): void {
    logger.info(`[EMERGENCY] ═══════════════════════════════════════════════════════`);
    logger.info(`[EMERGENCY] TRUE EMERGENCIES (bypass min hold):`);
    logger.info(`[EMERGENCY]   - Pool migration/deprecation`);
    logger.info(`[EMERGENCY]   - TVL collapse (>${EMERGENCY_CONFIG.TVL_COLLAPSE_THRESHOLD_PCT * 100}% drop or <$${EMERGENCY_CONFIG.MIN_TVL_USD})`);
    logger.info(`[EMERGENCY]   - Decimals/mint inconsistency`);
    logger.info(`[EMERGENCY]   - On-chain failure/revert loop`);
    logger.info(`[EMERGENCY]   - Rug pull / freeze authority used`);
    
    if (FEE_PREDATOR_MODE_ENABLED) {
        logger.info(`[EMERGENCY] ═══════════════════════════════════════════════════════`);
        logger.info(`[EMERGENCY] FEE PREDATOR MODE — CLASS A POOLS:`);
        logger.info(`[EMERGENCY]   - MIN HOLD: ${PREDATOR_HOLD_CONFIG.MIN_HOLD_MINUTES_CLASS_A}m (absolute, no exceptions except TRUE emergency)`);
        logger.info(`[EMERGENCY]   - DISABLED: Harmonic, entropy, velocity, regime, score exits`);
        logger.info(`[EMERGENCY]   - VALID: Fee velocity persistent decay (${PREDATOR_HOLD_CONFIG.FEE_VELOCITY_DECAY_WINDOWS_REQUIRED} windows)`);
    }
    
    logger.info(`[EMERGENCY] ═══════════════════════════════════════════════════════`);
    logger.info(`[EMERGENCY] NOT EMERGENCIES (respect ${EMERGENCY_CONFIG.MIN_HOLD_MINUTES}m min hold):`);
    logger.info(`[EMERGENCY]   - Score/MHI drops`);
    logger.info(`[EMERGENCY]   - Regime changes`);
    logger.info(`[EMERGENCY]   - Velocity dips`);
    logger.info(`[EMERGENCY]   - Fee velocity underperformance`);
    logger.info(`[EMERGENCY]   - Any ranking-based signal`);
    logger.info(`[EMERGENCY]   - Temporary slowdowns (noise)`);
    logger.info(`[EMERGENCY] ═══════════════════════════════════════════════════════`);
}

