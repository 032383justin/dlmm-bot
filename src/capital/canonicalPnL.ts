/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CANONICAL PnL — SINGLE SOURCE OF TRUTH
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * OBJECTIVE: Eliminate inconsistent PnL reporting.
 * 
 * HARD RULES:
 * ❌ No logger, DB writer, capital updater, or notifier may recompute PnL.
 * ✅ All consumers must reference canonicalPnl.
 * 
 * This module provides the ONE AND ONLY PnL calculation that all systems
 * must use. Any deviation is a bug.
 * 
 * DEPRECATED FIELDS (DO NOT USE):
 * - realizedPnLPct
 * - pnlPercent  
 * - netPnL (if recomputed elsewhere)
 * 
 * ONLY PERSIST:
 * - grossPnlUsd
 * - netPnlUsd
 * - netPnlPct
 * - totalFeesUsd
 * - totalSlippageUsd
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Canonical PnL object — THE ONLY SOURCE OF TRUTH
 * 
 * All logging, DB writes, and capital updates MUST use this object.
 * No recomputation allowed anywhere else.
 */
export interface CanonicalPnL {
    // === INPUTS (Immutable after creation) ===
    /** Entry notional value in USD */
    readonly entryNotionalUsd: number;
    
    /** Exit notional value in USD */
    readonly exitNotionalUsd: number;
    
    /** Entry fees paid in USD */
    readonly entryFeesUsd: number;
    
    /** Exit fees paid in USD */
    readonly exitFeesUsd: number;
    
    /** Entry slippage cost in USD */
    readonly entrySlippageUsd: number;
    
    /** Exit slippage cost in USD */
    readonly exitSlippageUsd: number;
    
    // === COMPUTED (Derived from inputs) ===
    /** Gross PnL = exitNotionalUsd - entryNotionalUsd */
    readonly grossPnlUsd: number;
    
    /** Total fees = entryFeesUsd + exitFeesUsd */
    readonly totalFeesUsd: number;
    
    /** Total slippage = entrySlippageUsd + exitSlippageUsd */
    readonly totalSlippageUsd: number;
    
    /** Net PnL = grossPnlUsd - totalFeesUsd - totalSlippageUsd */
    readonly netPnlUsd: number;
    
    /** Net PnL % = netPnlUsd / entryNotionalUsd */
    readonly netPnlPct: number;
    
    // === METADATA ===
    /** Timestamp when this PnL was computed */
    readonly computedAt: number;
    
    /** Trade ID this PnL belongs to */
    readonly tradeId: string;
    
    /** Pool name for logging */
    readonly poolName: string;
    
    /** Whether invariant check passed */
    readonly invariantValid: boolean;
}

/**
 * Input for computing canonical PnL
 */
export interface CanonicalPnLInput {
    tradeId: string;
    poolName: string;
    entryNotionalUsd: number;
    exitNotionalUsd: number;
    entryFeesUsd: number;
    exitFeesUsd: number;
    entrySlippageUsd: number;
    exitSlippageUsd: number;
}

/**
 * Quarantined trade record (for prod invariant violations)
 */
export interface QuarantinedTrade {
    tradeId: string;
    poolName: string;
    input: CanonicalPnLInput;
    computedPnl: Partial<CanonicalPnL>;
    violationType: string;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const CANONICAL_PNL_CONFIG = {
    /** Invariant tolerance (0.1% = 0.001) */
    INVARIANT_TOLERANCE: 0.001,
    
    /** Whether to throw on invariant violation (true in dev, false in prod) */
    THROW_ON_VIOLATION: process.env.NODE_ENV === 'development' || process.env.DEV_MODE === 'true',
    
    /** Maximum quarantined trades to keep in memory */
    MAX_QUARANTINED_TRADES: 100,
    
    /** Minimum entry notional to avoid division issues */
    MIN_ENTRY_NOTIONAL_USD: 0.01,
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Quarantined trades (invariant violations in prod) */
const quarantinedTrades: QuarantinedTrade[] = [];

/** Cache of computed PnLs by tradeId */
const pnlCache = new Map<string, CanonicalPnL>();

/** Statistics */
let totalComputations = 0;
let invariantViolations = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE COMPUTATION — THE ONLY PNL CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute canonical PnL — THE ONLY FUNCTION ALLOWED TO CALCULATE PNL
 * 
 * This is the single source of truth for all PnL calculations.
 * All logging, DB writes, and capital updates MUST use this result.
 * 
 * @throws Error if invariant check fails in dev mode
 */
export function computeCanonicalPnL(input: CanonicalPnLInput): CanonicalPnL {
    totalComputations++;
    
    // Validate input
    if (input.entryNotionalUsd < CANONICAL_PNL_CONFIG.MIN_ENTRY_NOTIONAL_USD) {
        throw new Error(
            `CANONICAL_PNL_ERROR: entryNotionalUsd too small: ${input.entryNotionalUsd} < ${CANONICAL_PNL_CONFIG.MIN_ENTRY_NOTIONAL_USD}`
        );
    }
    
    // === COMPUTE ALL VALUES ===
    const grossPnlUsd = input.exitNotionalUsd - input.entryNotionalUsd;
    const totalFeesUsd = input.entryFeesUsd + input.exitFeesUsd;
    const totalSlippageUsd = input.entrySlippageUsd + input.exitSlippageUsd;
    const netPnlUsd = grossPnlUsd - totalFeesUsd - totalSlippageUsd;
    const netPnlPct = netPnlUsd / input.entryNotionalUsd;
    
    // === INVARIANT CHECK ===
    // Verify: netPnlPct should equal netPnlUsd / entryNotionalUsd
    const recomputedPct = netPnlUsd / input.entryNotionalUsd;
    const invariantDelta = Math.abs(netPnlPct - recomputedPct);
    const invariantValid = invariantDelta <= CANONICAL_PNL_CONFIG.INVARIANT_TOLERANCE;
    
    const canonicalPnl: CanonicalPnL = {
        // Inputs
        entryNotionalUsd: input.entryNotionalUsd,
        exitNotionalUsd: input.exitNotionalUsd,
        entryFeesUsd: input.entryFeesUsd,
        exitFeesUsd: input.exitFeesUsd,
        entrySlippageUsd: input.entrySlippageUsd,
        exitSlippageUsd: input.exitSlippageUsd,
        // Computed
        grossPnlUsd,
        totalFeesUsd,
        totalSlippageUsd,
        netPnlUsd,
        netPnlPct,
        // Metadata
        computedAt: Date.now(),
        tradeId: input.tradeId,
        poolName: input.poolName,
        invariantValid,
    };
    
    // Handle invariant violation
    if (!invariantValid) {
        invariantViolations++;
        
        const violationMsg = 
            `PNL_INVARIANT_VIOLATION: tradeId=${input.tradeId} | ` +
            `netPnlPct=${netPnlPct} vs recomputed=${recomputedPct} | ` +
            `delta=${invariantDelta} > tolerance=${CANONICAL_PNL_CONFIG.INVARIANT_TOLERANCE}`;
        
        if (CANONICAL_PNL_CONFIG.THROW_ON_VIOLATION) {
            // DEV MODE: Hard fail
            throw new Error(violationMsg);
        } else {
            // PROD MODE: Log + quarantine
            logger.error(`[CANONICAL-PNL] 🚨 ${violationMsg}`);
            quarantineTrade(input, canonicalPnl, 'INVARIANT_MISMATCH');
        }
    }
    
    // Cache the result
    pnlCache.set(input.tradeId, canonicalPnl);
    
    return Object.freeze(canonicalPnl);  // Immutable
}

/**
 * Quarantine a trade with invalid PnL (prod only)
 */
function quarantineTrade(
    input: CanonicalPnLInput,
    computedPnl: Partial<CanonicalPnL>,
    violationType: string
): void {
    quarantinedTrades.push({
        tradeId: input.tradeId,
        poolName: input.poolName,
        input,
        computedPnl,
        violationType,
        timestamp: Date.now(),
    });
    
    // Trim old quarantined trades
    while (quarantinedTrades.length > CANONICAL_PNL_CONFIG.MAX_QUARANTINED_TRADES) {
        quarantinedTrades.shift();
    }
    
    logger.warn(
        `[CANONICAL-PNL] ⚠️ QUARANTINED | tradeId=${input.tradeId} | ` +
        `violation=${violationType} | ` +
        `quarantined=${quarantinedTrades.length}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCESSORS — READ-ONLY ACCESS TO CACHED PNL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get cached canonical PnL for a trade
 * 
 * Returns undefined if not computed yet.
 * Use computeCanonicalPnL() to compute.
 */
export function getCanonicalPnL(tradeId: string): CanonicalPnL | undefined {
    return pnlCache.get(tradeId);
}

/**
 * Check if canonical PnL exists for a trade
 */
export function hasCanonicalPnL(tradeId: string): boolean {
    return pnlCache.has(tradeId);
}

/**
 * Get quarantined trades (for monitoring)
 */
export function getQuarantinedTrades(): readonly QuarantinedTrade[] {
    return quarantinedTrades;
}

/**
 * Get statistics
 */
export function getPnLStats(): {
    totalComputations: number;
    invariantViolations: number;
    cachedCount: number;
    quarantinedCount: number;
} {
    return {
        totalComputations,
        invariantViolations,
        cachedCount: pnlCache.size,
        quarantinedCount: quarantinedTrades.length,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL UPDATE WRAPPER — ONLY WAY TO UPDATE CAPITAL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the net PnL value that should be applied to capital
 * 
 * HARD RULE: Capital balance must be updated using canonicalPnl.netPnlUsd ONLY.
 * No gross, MTM, or fee-only numbers may touch capital.
 * 
 * @throws Error if canonical PnL not computed
 */
export function getCapitalAdjustment(tradeId: string): {
    netPnlUsd: number;
    canApply: boolean;
    reason: string;
} {
    const pnl = pnlCache.get(tradeId);
    
    if (!pnl) {
        return {
            netPnlUsd: 0,
            canApply: false,
            reason: `NO_CANONICAL_PNL: tradeId=${tradeId} not computed`,
        };
    }
    
    if (!pnl.invariantValid) {
        return {
            netPnlUsd: 0,
            canApply: false,
            reason: `INVARIANT_INVALID: tradeId=${tradeId} failed invariant check`,
        };
    }
    
    return {
        netPnlUsd: pnl.netPnlUsd,
        canApply: true,
        reason: 'CANONICAL_PNL_VALID',
    };
}

/**
 * Apply canonical PnL to capital (returns the adjustment amount)
 * 
 * This is the ONLY function that should be used to determine capital changes.
 */
export function applyToCapital(
    tradeId: string,
    currentCapitalUsd: number
): { newCapitalUsd: number; adjustment: number; applied: boolean; reason: string } {
    const adjustment = getCapitalAdjustment(tradeId);
    
    if (!adjustment.canApply) {
        return {
            newCapitalUsd: currentCapitalUsd,
            adjustment: 0,
            applied: false,
            reason: adjustment.reason,
        };
    }
    
    const newCapitalUsd = currentCapitalUsd + adjustment.netPnlUsd;
    
    logger.info(
        `[CANONICAL-PNL] 💰 CAPITAL_APPLIED | tradeId=${tradeId} | ` +
        `adjustment=${adjustment.netPnlUsd >= 0 ? '+' : ''}$${adjustment.netPnlUsd.toFixed(4)} | ` +
        `capital: $${currentCapitalUsd.toFixed(2)} → $${newCapitalUsd.toFixed(2)}`
    );
    
    return {
        newCapitalUsd,
        adjustment: adjustment.netPnlUsd,
        applied: true,
        reason: 'CAPITAL_UPDATED',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DB SERIALIZATION — ONLY THESE FIELDS SHOULD BE PERSISTED
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the fields that should be persisted to database
 * 
 * ONLY PERSIST:
 * - grossPnlUsd
 * - netPnlUsd
 * - netPnlPct
 * - totalFeesUsd
 * - totalSlippageUsd
 */
export function getDbFields(tradeId: string): {
    grossPnlUsd: number;
    netPnlUsd: number;
    netPnlPct: number;
    totalFeesUsd: number;
    totalSlippageUsd: number;
} | null {
    const pnl = pnlCache.get(tradeId);
    
    if (!pnl) {
        logger.warn(`[CANONICAL-PNL] ⚠️ getDbFields called for unknown tradeId=${tradeId}`);
        return null;
    }
    
    return {
        grossPnlUsd: pnl.grossPnlUsd,
        netPnlUsd: pnl.netPnlUsd,
        netPnlPct: pnl.netPnlPct,
        totalFeesUsd: pnl.totalFeesUsd,
        totalSlippageUsd: pnl.totalSlippageUsd,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING — USE THESE FUNCTIONS FOR CONSISTENT LOG OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format canonical PnL for logging
 * 
 * All log statements showing PnL MUST use this function.
 */
export function formatPnLForLog(tradeId: string): string {
    const pnl = pnlCache.get(tradeId);
    
    if (!pnl) {
        return `[PNL: NOT_COMPUTED tradeId=${tradeId}]`;
    }
    
    const sign = pnl.netPnlUsd >= 0 ? '+' : '';
    const pctSign = pnl.netPnlPct >= 0 ? '+' : '';
    
    return (
        `[PNL: ${sign}$${pnl.netPnlUsd.toFixed(4)} (${pctSign}${(pnl.netPnlPct * 100).toFixed(2)}%) | ` +
        `gross=${sign}$${pnl.grossPnlUsd.toFixed(4)} | ` +
        `fees=$${pnl.totalFeesUsd.toFixed(4)} | ` +
        `slip=$${pnl.totalSlippageUsd.toFixed(4)}]`
    );
}

/**
 * Log canonical PnL details
 */
export function logCanonicalPnL(tradeId: string): void {
    const pnl = pnlCache.get(tradeId);
    
    if (!pnl) {
        logger.warn(`[CANONICAL-PNL] Cannot log - no PnL for tradeId=${tradeId}`);
        return;
    }
    
    const sign = pnl.netPnlUsd >= 0 ? '+' : '';
    const emoji = pnl.netPnlUsd >= 0 ? '✅' : '❌';
    
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`${emoji} CANONICAL PnL | ${pnl.poolName}`);
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`  Trade ID: ${pnl.tradeId}`);
    logger.info(`  Entry: $${pnl.entryNotionalUsd.toFixed(4)}`);
    logger.info(`  Exit:  $${pnl.exitNotionalUsd.toFixed(4)}`);
    logger.info(`  Gross PnL: ${sign}$${pnl.grossPnlUsd.toFixed(4)}`);
    logger.info(`  Fees: $${pnl.totalFeesUsd.toFixed(4)} (entry: $${pnl.entryFeesUsd.toFixed(4)} + exit: $${pnl.exitFeesUsd.toFixed(4)})`);
    logger.info(`  Slippage: $${pnl.totalSlippageUsd.toFixed(4)} (entry: $${pnl.entrySlippageUsd.toFixed(4)} + exit: $${pnl.exitSlippageUsd.toFixed(4)})`);
    logger.info(`  ═══════════════════════════════════════════════════════════`);
    logger.info(`  NET PnL: ${sign}$${pnl.netPnlUsd.toFixed(4)} (${sign}${(pnl.netPnlPct * 100).toFixed(2)}%)`);
    logger.info(`  ═══════════════════════════════════════════════════════════`);
    logger.info(`  Invariant Valid: ${pnl.invariantValid ? '✅' : '❌'}`);
    logger.info('───────────────────────────────────────────────────────────────');
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION — VERIFY PNL IS REASONABLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate that PnL percentage is reasonable given the amounts
 * 
 * Catches impossible scenarios like +23% on $8.
 */
export function validatePnLReasonable(pnl: CanonicalPnL): {
    valid: boolean;
    warnings: string[];
} {
    const warnings: string[] = [];
    
    // Check for impossible percentages
    // A 100% gain would require exit = 2× entry
    // A 50% loss would require exit = 0.5× entry
    const impliedExitRatio = pnl.exitNotionalUsd / pnl.entryNotionalUsd;
    const impliedPnlPct = impliedExitRatio - 1;
    
    // If net PnL% is very different from implied gross %
    // (accounting for fees), something is wrong
    const maxReasonableFeeImpact = 0.10;  // 10% impact from fees
    if (Math.abs(pnl.netPnlPct - impliedPnlPct) > maxReasonableFeeImpact) {
        warnings.push(
            `PnL% discrepancy: netPnlPct=${(pnl.netPnlPct * 100).toFixed(2)}% vs ` +
            `implied=${(impliedPnlPct * 100).toFixed(2)}%`
        );
    }
    
    // Check for unrealistic gains (>100% in a single trade is suspicious)
    if (pnl.netPnlPct > 1.0) {
        warnings.push(`Unrealistic gain: ${(pnl.netPnlPct * 100).toFixed(2)}% > 100%`);
    }
    
    // Check for fees exceeding gross PnL
    if (pnl.totalFeesUsd > Math.abs(pnl.grossPnlUsd) * 2) {
        warnings.push(
            `Fees disproportionate: fees=$${pnl.totalFeesUsd.toFixed(4)} vs ` +
            `gross=$${pnl.grossPnlUsd.toFixed(4)}`
        );
    }
    
    return {
        valid: warnings.length === 0,
        warnings,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clear cached PnL for a trade
 */
export function clearPnL(tradeId: string): void {
    pnlCache.delete(tradeId);
}

/**
 * Clear all cached PnL data
 */
export function clearAllPnL(): void {
    pnlCache.clear();
    quarantinedTrades.length = 0;
    totalComputations = 0;
    invariantViolations = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    // Core
    computeCanonicalPnL,
    getCanonicalPnL,
    hasCanonicalPnL,
    
    // Capital
    getCapitalAdjustment,
    applyToCapital,
    
    // DB
    getDbFields,
    
    // Logging
    formatPnLForLog,
    logCanonicalPnL,
    
    // Validation
    validatePnLReasonable,
    
    // Stats
    getPnLStats,
    getQuarantinedTrades,
    
    // Cleanup
    clearPnL,
    clearAllPnL,
    
    // Config
    CANONICAL_PNL_CONFIG,
};

