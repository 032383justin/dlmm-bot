/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXIT PNL AUTHORIZATION — CANONICAL PNL AT EXIT TIME
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module is the ONLY place where exit PnL should be authorized.
 * It computes the canonical PnL at exit time and provides the authoritative
 * values for all downstream consumers.
 * 
 * FLOW:
 * 1. Exit is triggered
 * 2. authorizeExitPnL() is called with all trade details
 * 3. Canonical PnL is computed and cached
 * 4. All downstream consumers (logger, DB, capital) use the cached values
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    CanonicalPnL,
    computeCanonicalPnL,
    getCanonicalPnL,
    formatPnLForLog,
    logCanonicalPnL,
    getDbFields,
    applyToCapital,
    validatePnLReasonable,
} from './canonicalPnL';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ExitTradeInput {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    
    // Entry details (from trade record)
    entryNotionalUsd: number;
    entryFeesUsd: number;
    entrySlippageUsd: number;
    entryTime: number;
    
    // Exit details (current)
    exitNotionalUsd: number;
    exitFeesUsd: number;
    exitSlippageUsd: number;
    exitTime: number;
    exitReason: string;
}

export interface ExitAuthorization {
    authorized: boolean;
    canonicalPnl: CanonicalPnL | null;
    reason: string;
    warnings: string[];
    
    // Pre-formatted for downstream consumers
    dbFields: {
        grossPnlUsd: number;
        netPnlUsd: number;
        netPnlPct: number;
        totalFeesUsd: number;
        totalSlippageUsd: number;
    } | null;
    
    logString: string;
    capitalAdjustment: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE AUTHORIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Authorize exit and compute canonical PnL
 * 
 * This is the ONLY function that should be called at exit time.
 * It computes the canonical PnL and provides all values for downstream use.
 * 
 * DOWNSTREAM CONSUMERS MUST USE THE RETURNED VALUES, NOT RECOMPUTE.
 */
export function authorizeExitPnL(input: ExitTradeInput): ExitAuthorization {
    try {
        // Compute canonical PnL
        const canonicalPnl = computeCanonicalPnL({
            tradeId: input.tradeId,
            poolName: input.poolName,
            entryNotionalUsd: input.entryNotionalUsd,
            exitNotionalUsd: input.exitNotionalUsd,
            entryFeesUsd: input.entryFeesUsd,
            exitFeesUsd: input.exitFeesUsd,
            entrySlippageUsd: input.entrySlippageUsd,
            exitSlippageUsd: input.exitSlippageUsd,
        });
        
        // Validate reasonableness
        const validation = validatePnLReasonable(canonicalPnl);
        
        // Get pre-formatted values for downstream
        const dbFields = getDbFields(input.tradeId);
        const logString = formatPnLForLog(input.tradeId);
        
        // Log the canonical PnL
        logCanonicalPnL(input.tradeId);
        
        // Log warnings if any
        if (validation.warnings.length > 0) {
            for (const warning of validation.warnings) {
                logger.warn(`[EXIT-AUTH] ⚠️ ${input.poolName} | ${warning}`);
            }
        }
        
        logger.info(
            `[EXIT-AUTH] ✅ AUTHORIZED | ${input.poolName} | ` +
            `${logString} | reason=${input.exitReason}`
        );
        
        return {
            authorized: true,
            canonicalPnl,
            reason: 'PNL_COMPUTED',
            warnings: validation.warnings,
            dbFields,
            logString,
            capitalAdjustment: canonicalPnl.netPnlUsd,
        };
        
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        
        logger.error(
            `[EXIT-AUTH] ❌ FAILED | ${input.poolName} | ` +
            `tradeId=${input.tradeId} | error=${errorMsg}`
        );
        
        return {
            authorized: false,
            canonicalPnl: null,
            reason: `PNL_COMPUTATION_FAILED: ${errorMsg}`,
            warnings: [errorMsg],
            dbFields: null,
            logString: `[PNL: COMPUTATION_FAILED]`,
            capitalAdjustment: 0,
        };
    }
}

/**
 * Get the authorized PnL for a trade (must have been authorized first)
 */
export function getAuthorizedPnL(tradeId: string): CanonicalPnL | null {
    return getCanonicalPnL(tradeId) || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL UPDATE — ONLY WAY TO UPDATE CAPITAL FROM EXIT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply exit PnL to capital
 * 
 * HARD RULE: This is the ONLY function that should update capital from a trade exit.
 * It uses canonicalPnl.netPnlUsd and nothing else.
 */
export function applyExitToCapital(
    tradeId: string,
    currentCapitalUsd: number
): {
    newCapitalUsd: number;
    applied: boolean;
    adjustment: number;
    pnl: CanonicalPnL | null;
} {
    const pnl = getCanonicalPnL(tradeId);
    
    if (!pnl) {
        logger.error(
            `[EXIT-AUTH] ❌ CAPITAL_UPDATE_BLOCKED | tradeId=${tradeId} | ` +
            `No canonical PnL found - exit not authorized`
        );
        return {
            newCapitalUsd: currentCapitalUsd,
            applied: false,
            adjustment: 0,
            pnl: null,
        };
    }
    
    const result = applyToCapital(tradeId, currentCapitalUsd);
    
    return {
        newCapitalUsd: result.newCapitalUsd,
        applied: result.applied,
        adjustment: result.adjustment,
        pnl,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DB PERSISTENCE — GET VALUES FOR DATABASE WRITE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the PnL fields for database persistence
 * 
 * ONLY THESE FIELDS SHOULD BE WRITTEN TO DB:
 * - grossPnlUsd
 * - netPnlUsd
 * - netPnlPct
 * - totalFeesUsd
 * - totalSlippageUsd
 * 
 * DEPRECATED FIELDS (do not write):
 * - realizedPnLPct
 * - pnlPercent
 * - any recomputed values
 */
export function getDbPersistenceFields(tradeId: string): {
    fields: {
        gross_pnl_usd: number;
        net_pnl_usd: number;
        net_pnl_pct: number;
        total_fees_usd: number;
        total_slippage_usd: number;
    } | null;
    success: boolean;
    error?: string;
} {
    const pnl = getCanonicalPnL(tradeId);
    
    if (!pnl) {
        return {
            fields: null,
            success: false,
            error: `No canonical PnL for tradeId=${tradeId}`,
        };
    }
    
    if (!pnl.invariantValid) {
        return {
            fields: null,
            success: false,
            error: `Invariant invalid for tradeId=${tradeId}`,
        };
    }
    
    return {
        fields: {
            gross_pnl_usd: pnl.grossPnlUsd,
            net_pnl_usd: pnl.netPnlUsd,
            net_pnl_pct: pnl.netPnlPct,
            total_fees_usd: pnl.totalFeesUsd,
            total_slippage_usd: pnl.totalSlippageUsd,
        },
        success: true,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING — USE THESE FOR CONSISTENT OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get formatted log string for a trade
 * 
 * ALL LOG STATEMENTS SHOWING PNL MUST USE THIS.
 */
export function getLogString(tradeId: string): string {
    return formatPnLForLog(tradeId);
}

/**
 * Log exit summary with canonical PnL
 */
export function logExitSummary(
    input: ExitTradeInput,
    authorization: ExitAuthorization
): void {
    if (!authorization.canonicalPnl) {
        logger.error(
            `[EXIT-SUMMARY] ❌ ${input.poolName} | ` +
            `Exit failed: ${authorization.reason}`
        );
        return;
    }
    
    const pnl = authorization.canonicalPnl;
    const holdTimeMinutes = (input.exitTime - input.entryTime) / (60 * 1000);
    const sign = pnl.netPnlUsd >= 0 ? '+' : '';
    const emoji = pnl.netPnlUsd >= 0 ? '🟢' : '🔴';
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`${emoji} EXIT SUMMARY | ${input.poolName}`);
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`  Trade ID: ${input.tradeId}`);
    logger.info(`  Exit Reason: ${input.exitReason}`);
    logger.info(`  Hold Time: ${holdTimeMinutes.toFixed(0)} minutes`);
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`  Entry Notional: $${pnl.entryNotionalUsd.toFixed(4)}`);
    logger.info(`  Exit Notional:  $${pnl.exitNotionalUsd.toFixed(4)}`);
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`  Gross PnL:      ${sign}$${pnl.grossPnlUsd.toFixed(4)}`);
    logger.info(`  Total Fees:     -$${pnl.totalFeesUsd.toFixed(4)}`);
    logger.info(`  Total Slippage: -$${pnl.totalSlippageUsd.toFixed(4)}`);
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`  NET PnL:        ${sign}$${pnl.netPnlUsd.toFixed(4)} (${sign}${(pnl.netPnlPct * 100).toFixed(2)}%)`);
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`  Capital Adjustment: ${sign}$${authorization.capitalAdjustment.toFixed(4)}`);
    
    if (authorization.warnings.length > 0) {
        logger.warn('  ⚠️ Warnings:');
        for (const warning of authorization.warnings) {
            logger.warn(`    - ${warning}`);
        }
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    authorizeExitPnL,
    getAuthorizedPnL,
    applyExitToCapital,
    getDbPersistenceFields,
    getLogString,
    logExitSummary,
};

