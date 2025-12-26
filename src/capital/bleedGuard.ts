/**
 * PnL Bleed Guard — Deterministic Exit to Prevent Irrational Fee-Waiting
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Prevent economically irrational behavior where a position waits for
 * fee accumulation while unrealized PnL bleeds faster than fees accrue.
 * 
 * EXIT CONDITION:
 *   - unrealizedPnLUsd < 0 (position is underwater)
 *   - pnlLossRatePerHour > feeRatePerHour * BLEED_MULTIPLIER
 * 
 * GUARANTEES:
 *   - MUST bypass COST_NOT_AMORTIZED suppression (via RISK_EXIT_TYPES inclusion)
 *   - MUST NOT trigger for profitable positions (unrealizedPnL >= 0)
 *   - MUST clear edge score state and bin width state on exit
 *   - Fully deterministic — no randomness, no config changes
 * 
 * LOG FORMAT:
 *   [BLEED-EXIT] pool=<pair> tradeId=<id> pnl=<usd> pnlRate=<usd/hr> feeRate=<usd/hr> multiplier=1.5
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bleed multiplier threshold.
 * Exit if PnL loss rate exceeds fee rate by this factor.
 */
export const BLEED_MULTIPLIER = 1.5;

/**
 * Minimum hold time in hours before bleed guard evaluation.
 * Prevents spurious triggers on very new positions.
 */
const MIN_HOLD_HOURS_FOR_BLEED_CHECK = 0.1; // 6 minutes minimum

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
 * Deterministic exit condition:
 *   - unrealizedPnLUsd < 0
 *   - pnlLossRatePerHour > feeRatePerHour * BLEED_MULTIPLIER
 * 
 * @param input - Position metrics for bleed evaluation
 * @returns BleedGuardResult with exit decision and metrics
 */
export function evaluateBleedGuard(input: BleedGuardInput): BleedGuardResult {
    const now = Date.now();
    const holdTimeMs = now - input.entryTimeMs;
    const holdTimeHours = holdTimeMs / (1000 * 3600);
    
    // Default result: no exit
    const defaultResult: BleedGuardResult = {
        shouldExit: false,
        holdTimeHours,
        feeRatePerHour: 0,
        pnlLossRatePerHour: 0,
        reason: null,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD 1: Position must be held long enough for rate calculations
    // ═══════════════════════════════════════════════════════════════════════════
    if (holdTimeHours < MIN_HOLD_HOURS_FOR_BLEED_CHECK) {
        return defaultResult;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD 2: Position MUST be underwater (negative unrealized PnL)
    // Never trigger for profitable positions
    // ═══════════════════════════════════════════════════════════════════════════
    if (input.unrealizedPnLUsd >= 0) {
        return defaultResult;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE RATES
    // ═══════════════════════════════════════════════════════════════════════════
    const feeRatePerHour = input.feesAccruedUsd / holdTimeHours;
    const pnlLossRatePerHour = Math.abs(input.unrealizedPnLUsd) / holdTimeHours;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BLEED CHECK: Exit if loss rate exceeds fee rate by BLEED_MULTIPLIER
    // ═══════════════════════════════════════════════════════════════════════════
    const threshold = feeRatePerHour * BLEED_MULTIPLIER;
    const shouldExit = pnlLossRatePerHour > threshold;
    
    if (shouldExit) {
        // Emit exactly one INFO log per trigger
        logger.info(
            `[BLEED-EXIT] pool=${input.poolName} tradeId=${input.tradeId} ` +
            `pnl=${input.unrealizedPnLUsd.toFixed(2)} ` +
            `pnlRate=${pnlLossRatePerHour.toFixed(4)} ` +
            `feeRate=${feeRatePerHour.toFixed(4)} ` +
            `multiplier=${BLEED_MULTIPLIER}`
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
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const BLEED_GUARD_CONFIG = {
    BLEED_MULTIPLIER,
    MIN_HOLD_HOURS_FOR_BLEED_CHECK,
};

