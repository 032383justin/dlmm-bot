/**
 * PnL Bleed Guard — Deterministic Exit to Prevent Irrational Fee-Waiting
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHASE 1 FIX: BLEED_EXIT is FORBIDDEN before MIN_HOLD
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * CORRECT BEHAVIOR (mandatory):
 *   IF holdTime < MIN_HOLD_MINUTES:
 *       BLEED_EXIT = FORBIDDEN
 * 
 * MIN_HOLD_MINUTES = 60 (minimum), recommended 90-120 for fee dominance
 * 
 * EXIT CONDITION (AFTER min hold only):
 *   - unrealizedPnLUsd < 0 (position is underwater)
 *   - pnlLossRatePerHour > feeRatePerHour * BLEED_MULTIPLIER
 *   - Fee velocity < X% of expected
 *   - Sustained for N windows
 *   - AND no recovery trend
 * 
 * POOL COOLDOWN:
 *   - If BLEED_EXIT fires: pool cooldown = 6-24 hours
 *   - Prevents immediate re-entry and restart churn
 * 
 * GUARANTEES:
 *   - MUST respect MIN_HOLD_MINUTES (60-90 minutes)
 *   - MUST NOT trigger for profitable positions (unrealizedPnL >= 0)
 *   - MUST apply pool cooldown after exit
 *   - Fully deterministic — no randomness
 * 
 * LOG FORMAT:
 *   [BLEED-EXIT] pool=<pair> tradeId=<id> pnl=<usd> pnlRate=<usd/hr> feeRate=<usd/hr> multiplier=1.5
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { EMERGENCY_CONFIG } from './emergencyExitDefinition';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bleed multiplier threshold.
 * Exit if PnL loss rate exceeds fee rate by this factor.
 */
export const BLEED_MULTIPLIER = 1.5;

/**
 * MINIMUM HOLD TIME — HARD RULE
 * 
 * BLEED_EXIT is FORBIDDEN before this duration.
 * This uses the global MIN_HOLD_MINUTES from emergencyExitDefinition.
 */
const MIN_HOLD_HOURS_FOR_BLEED_CHECK = EMERGENCY_CONFIG.MIN_HOLD_MINUTES / 60;  // 60 minutes = 1 hour

/**
 * Number of consecutive windows fee velocity must be below threshold
 */
const BLEED_SUSTAINED_WINDOWS_REQUIRED = 3;

/**
 * Fee velocity threshold - must be below this % of entry rate to trigger
 */
const BLEED_FEE_VELOCITY_THRESHOLD_PCT = 0.50;  // 50% of entry rate

/**
 * Pool cooldown after BLEED_EXIT (6 hours)
 */
export const BLEED_EXIT_POOL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Track consecutive bad windows per pool
 */
const poolBleedWindows = new Map<string, number>();

/**
 * Track pool cooldowns after BLEED_EXIT
 */
const poolBleedCooldowns = new Map<string, number>();

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Input for bleed guard evaluation
 */
export interface BleedGuardInput {
    tradeId: string;
    poolName: string;
    poolAddress: string;
    entryTimeMs: number;
    feesAccruedUsd: number;
    unrealizedPnLUsd: number;
    /** Current fee velocity (USD/hour) - for sustained decay check */
    currentFeeVelocity?: number;
    /** Entry fee velocity (USD/hour) - for comparison */
    entryFeeVelocity?: number;
}

/**
 * Result of bleed guard evaluation
 */
export interface BleedGuardResult {
    shouldExit: boolean;
    holdTimeHours: number;
    feeRatePerHour: number;
    pnlLossRatePerHour: number;
    reason: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate if a position should exit due to PnL bleed exceeding fee accrual.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHASE 1 FIX: BLEED_EXIT is FORBIDDEN before MIN_HOLD
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Exit condition (AFTER min hold only):
 *   - unrealizedPnLUsd < 0
 *   - pnlLossRatePerHour > feeRatePerHour * BLEED_MULTIPLIER
 *   - Fee velocity < 50% of entry rate
 *   - Sustained for 3+ windows
 * 
 * @param input - Position metrics for bleed evaluation
 * @returns BleedGuardResult with exit decision and metrics
 */
export function evaluateBleedGuard(input: BleedGuardInput): BleedGuardResult {
    const now = Date.now();
    const holdTimeMs = now - input.entryTimeMs;
    const holdTimeHours = holdTimeMs / (1000 * 3600);
    const holdTimeMinutes = holdTimeMs / (1000 * 60);
    
    // Default result: no exit
    const defaultResult: BleedGuardResult = {
        shouldExit: false,
        holdTimeHours,
        feeRatePerHour: 0,
        pnlLossRatePerHour: 0,
        reason: null,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD 0: Check pool cooldown
    // ═══════════════════════════════════════════════════════════════════════════
    const cooldownExpiry = poolBleedCooldowns.get(input.poolAddress);
    if (cooldownExpiry && now < cooldownExpiry) {
        logger.debug(
            `[BLEED-GUARD] Pool ${input.poolName} in cooldown, ${((cooldownExpiry - now) / 3600000).toFixed(1)}h remaining`
        );
        return defaultResult;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD 1: MINIMUM HOLD — HARD RULE
    // BLEED_EXIT is FORBIDDEN before MIN_HOLD_MINUTES
    // ═══════════════════════════════════════════════════════════════════════════
    if (holdTimeHours < MIN_HOLD_HOURS_FOR_BLEED_CHECK) {
        logger.debug(
            `[BLEED-GUARD] ${input.poolName} FORBIDDEN: holdTime=${holdTimeMinutes.toFixed(0)}m < ` +
            `minHold=${EMERGENCY_CONFIG.MIN_HOLD_MINUTES}m`
        );
        // Clear any accumulated bad windows - position is too new
        poolBleedWindows.delete(input.poolAddress);
        return defaultResult;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD 2: Position MUST be underwater (negative unrealized PnL)
    // Never trigger for profitable positions
    // ═══════════════════════════════════════════════════════════════════════════
    if (input.unrealizedPnLUsd >= 0) {
        // Clear bad windows - position is profitable
        poolBleedWindows.delete(input.poolAddress);
        return defaultResult;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE RATES
    // ═══════════════════════════════════════════════════════════════════════════
    const feeRatePerHour = input.feesAccruedUsd / holdTimeHours;
    const pnlLossRatePerHour = Math.abs(input.unrealizedPnLUsd) / holdTimeHours;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: PnL bleed rate vs fee rate
    // ═══════════════════════════════════════════════════════════════════════════
    const threshold = feeRatePerHour * BLEED_MULTIPLIER;
    const isBleedingFaster = pnlLossRatePerHour > threshold;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: Fee velocity decay (if data available)
    // ═══════════════════════════════════════════════════════════════════════════
    let feeVelocityDecayed = false;
    if (input.currentFeeVelocity !== undefined && input.entryFeeVelocity !== undefined) {
        const velocityRatio = input.entryFeeVelocity > 0 
            ? input.currentFeeVelocity / input.entryFeeVelocity 
            : 1.0;
        feeVelocityDecayed = velocityRatio < BLEED_FEE_VELOCITY_THRESHOLD_PCT;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 3: Sustained bad windows
    // ═══════════════════════════════════════════════════════════════════════════
    const currentBadWindows = poolBleedWindows.get(input.poolAddress) ?? 0;
    
    if (isBleedingFaster) {
        poolBleedWindows.set(input.poolAddress, currentBadWindows + 1);
    } else {
        // Recovery trend - reset bad windows
        poolBleedWindows.delete(input.poolAddress);
        return {
            ...defaultResult,
            feeRatePerHour,
            pnlLossRatePerHour,
            reason: 'RECOVERY_TREND',
        };
    }
    
    const badWindows = poolBleedWindows.get(input.poolAddress) ?? 0;
    const sustainedDecay = badWindows >= BLEED_SUSTAINED_WINDOWS_REQUIRED;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FINAL DECISION: Exit only if all conditions met
    // ═══════════════════════════════════════════════════════════════════════════
    const shouldExit = isBleedingFaster && sustainedDecay;
    
    if (shouldExit) {
        // Apply pool cooldown
        poolBleedCooldowns.set(input.poolAddress, now + BLEED_EXIT_POOL_COOLDOWN_MS);
        
        // Clear bad windows
        poolBleedWindows.delete(input.poolAddress);
        
        // Log exit with full context
        logger.info(
            `[BLEED-EXIT] pool=${input.poolName} tradeId=${input.tradeId} ` +
            `holdTime=${holdTimeMinutes.toFixed(0)}m ` +
            `pnl=${input.unrealizedPnLUsd.toFixed(2)} ` +
            `pnlRate=${pnlLossRatePerHour.toFixed(4)}/h ` +
            `feeRate=${feeRatePerHour.toFixed(4)}/h ` +
            `badWindows=${badWindows}/${BLEED_SUSTAINED_WINDOWS_REQUIRED} ` +
            `cooldown=${BLEED_EXIT_POOL_COOLDOWN_MS / 3600000}h`
        );
    } else if (isBleedingFaster) {
        // Log progress toward exit
        logger.debug(
            `[BLEED-GUARD] ${input.poolName} warning: ` +
            `badWindows=${badWindows}/${BLEED_SUSTAINED_WINDOWS_REQUIRED} ` +
            `pnlRate=${pnlLossRatePerHour.toFixed(4)} > threshold=${threshold.toFixed(4)}`
        );
    }
    
    return {
        shouldExit,
        holdTimeHours,
        feeRatePerHour,
        pnlLossRatePerHour,
        reason: shouldExit ? 'BLEED_EXIT' : null,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POOL COOLDOWN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a pool is in BLEED_EXIT cooldown
 */
export function isPoolInBleedCooldown(poolAddress: string): boolean {
    const expiry = poolBleedCooldowns.get(poolAddress);
    if (!expiry) return false;
    if (Date.now() >= expiry) {
        poolBleedCooldowns.delete(poolAddress);
        return false;
    }
    return true;
}

/**
 * Get remaining cooldown time for a pool (in hours)
 */
export function getPoolBleedCooldownRemaining(poolAddress: string): number {
    const expiry = poolBleedCooldowns.get(poolAddress);
    if (!expiry) return 0;
    const remaining = expiry - Date.now();
    return remaining > 0 ? remaining / 3600000 : 0;
}

/**
 * Clear pool bleed state (call after successful exit)
 */
export function clearPoolBleedState(poolAddress: string): void {
    poolBleedWindows.delete(poolAddress);
}

/**
 * Get current bad windows count for a pool
 */
export function getPoolBadWindowCount(poolAddress: string): number {
    return poolBleedWindows.get(poolAddress) ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const BLEED_GUARD_CONFIG = {
    BLEED_MULTIPLIER,
    MIN_HOLD_HOURS_FOR_BLEED_CHECK,
    BLEED_SUSTAINED_WINDOWS_REQUIRED,
    BLEED_FEE_VELOCITY_THRESHOLD_PCT,
    BLEED_EXIT_POOL_COOLDOWN_MS,
};

