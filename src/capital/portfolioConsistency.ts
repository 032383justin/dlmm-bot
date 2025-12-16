/**
 * Portfolio State Consistency Check — Risk State Verification
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 DOMINANT — MODULE 6: PORTFOLIO INVARIANT ENFORCEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Ensure portfolio risk state always reflects real deployment.
 * 
 * INVARIANT:
 *   sum(open_positions.notional_usd) === reported_deployed_capital
 * 
 * If mismatch > $1 → [PORTFOLIO-ERROR] Deployed capital mismatch detected
 * 
 * This check runs every scan cycle to catch any drift between:
 * - Actual position sizes (from trading.ts active trades)
 * - Reported deployed capital (from capital manager)
 * - Internal position tracking (from scanLoop)
 * - Portfolio Ledger state (SINGLE SOURCE OF TRUTH)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { 
    getLedgerState, 
    isLedgerInitialized, 
    assertLedgerInvariants,
    checkLedgerInvariants,
} from './portfolioLedger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const PORTFOLIO_CONSISTENCY_CONFIG = {
    /**
     * Maximum allowed mismatch in USD before triggering error
     * Justification: Small rounding differences are acceptable,
     * but anything > $1 indicates a real inconsistency
     */
    maxMismatchUSD: 1.0,
    
    /**
     * Maximum allowed mismatch as percentage of deployed capital
     * Justification: For larger portfolios, allow proportional tolerance
     */
    maxMismatchPct: 0.001, // 0.1%
    
    /**
     * Enable strict mode (throws errors instead of logging)
     * Set via DEV_MODE environment variable
     */
    strictMode: process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development',
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Position for consistency checking
 */
export interface PositionForConsistency {
    poolAddress: string;
    poolName?: string;
    notionalUSD: number;
    entryTime?: number;
}

/**
 * Portfolio consistency check result
 */
export interface PortfolioConsistencyResult {
    consistent: boolean;
    
    // Calculated values
    sumPositionsUSD: number;
    reportedDeployedUSD: number;
    mismatchUSD: number;
    mismatchPct: number;
    
    // Position details
    positionCount: number;
    positions: PositionForConsistency[];
    
    // Error details (if inconsistent)
    errorType?: 'MISMATCH' | 'MISSING_POSITIONS' | 'ORPHAN_CAPITAL';
    errorMessage?: string;
    
    timestamp: number;
}

/**
 * Portfolio state snapshot for auditing
 */
export interface PortfolioStateSnapshot {
    timestamp: number;
    sumPositionsUSD: number;
    reportedDeployedUSD: number;
    positionCount: number;
    consistent: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

const consistencyHistory: PortfolioStateSnapshot[] = [];
const MAX_HISTORY = 100;

let lastCheckResult: PortfolioConsistencyResult | null = null;
let consecutiveErrors = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE CONSISTENCY CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MODULE 6: Check portfolio state consistency
 * 
 * INVARIANT:
 *   sum(open_positions.notional_usd) === reported_deployed_capital
 *   AND ledger.deployedUsd === sum(positions)
 * 
 * @param positions - Current open positions with notional values
 * @param reportedDeployedUSD - Reported deployed capital from capital manager
 * @returns Consistency check result
 * 
 * @throws Error in strict mode if mismatch exceeds threshold
 */
export function checkPortfolioConsistency(
    positions: PositionForConsistency[],
    reportedDeployedUSD: number
): PortfolioConsistencyResult {
    const now = Date.now();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LEDGER VALIDATION: Check ledger invariants first (single source of truth)
    // ═══════════════════════════════════════════════════════════════════════════
    if (isLedgerInitialized()) {
        const ledgerCheck = checkLedgerInvariants();
        if (!ledgerCheck.valid) {
            logger.error(
                `[PORTFOLIO-CONSISTENCY] Ledger invariant violation detected:\n` +
                ledgerCheck.errors.map(e => `  - ${e}`).join('\n')
            );
            
            // Still run the assertion (may throw in DEV_MODE)
            try {
                assertLedgerInvariants();
            } catch (err) {
                // Logged by assertion, continue to legacy check
            }
        }
        
        // Compare positions count with ledger
        const ledgerState = getLedgerState();
        if (positions.length !== ledgerState.positionCount) {
            logger.warn(
                `[PORTFOLIO-CONSISTENCY] Position count mismatch: ` +
                `input=${positions.length} ledger=${ledgerState.positionCount}`
            );
        }
    }
    
    // Calculate sum of position notionals
    const sumPositionsUSD = positions.reduce((sum, pos) => sum + pos.notionalUSD, 0);
    
    // Calculate mismatch
    const mismatchUSD = Math.abs(sumPositionsUSD - reportedDeployedUSD);
    const mismatchPct = reportedDeployedUSD > 0 
        ? mismatchUSD / reportedDeployedUSD 
        : (sumPositionsUSD > 0 ? 1 : 0);
    
    // Determine if consistent
    const withinAbsoluteTolerance = mismatchUSD <= PORTFOLIO_CONSISTENCY_CONFIG.maxMismatchUSD;
    const withinPercentTolerance = mismatchPct <= PORTFOLIO_CONSISTENCY_CONFIG.maxMismatchPct;
    const consistent = withinAbsoluteTolerance || withinPercentTolerance;
    
    // Determine error type if inconsistent
    let errorType: 'MISMATCH' | 'MISSING_POSITIONS' | 'ORPHAN_CAPITAL' | undefined;
    let errorMessage: string | undefined;
    
    if (!consistent) {
        if (sumPositionsUSD < reportedDeployedUSD) {
            errorType = 'ORPHAN_CAPITAL';
            errorMessage = `Orphan capital detected: reported=$${reportedDeployedUSD.toFixed(2)} but positions sum to $${sumPositionsUSD.toFixed(2)}`;
        } else if (sumPositionsUSD > reportedDeployedUSD) {
            errorType = 'MISSING_POSITIONS';
            errorMessage = `Missing capital: positions sum to $${sumPositionsUSD.toFixed(2)} but reported=$${reportedDeployedUSD.toFixed(2)}`;
        } else {
            errorType = 'MISMATCH';
            errorMessage = `Capital mismatch: positions=$${sumPositionsUSD.toFixed(2)} reported=$${reportedDeployedUSD.toFixed(2)}`;
        }
    }
    
    const result: PortfolioConsistencyResult = {
        consistent,
        sumPositionsUSD,
        reportedDeployedUSD,
        mismatchUSD,
        mismatchPct,
        positionCount: positions.length,
        positions,
        errorType,
        errorMessage,
        timestamp: now,
    };
    
    // Update tracking
    lastCheckResult = result;
    
    // Record snapshot
    consistencyHistory.push({
        timestamp: now,
        sumPositionsUSD,
        reportedDeployedUSD,
        positionCount: positions.length,
        consistent,
    });
    
    while (consistencyHistory.length > MAX_HISTORY) {
        consistencyHistory.shift();
    }
    
    // Handle inconsistency
    if (!consistent) {
        consecutiveErrors++;
        
        // Log error
        logger.error(
            `[PORTFOLIO-ERROR] Deployed capital mismatch detected\n` +
            `  sumPositions=$${sumPositionsUSD.toFixed(2)}\n` +
            `  reportedDeployed=$${reportedDeployedUSD.toFixed(2)}\n` +
            `  mismatch=$${mismatchUSD.toFixed(2)} (${(mismatchPct * 100).toFixed(2)}%)\n` +
            `  positionCount=${positions.length}\n` +
            `  errorType=${errorType}\n` +
            `  consecutiveErrors=${consecutiveErrors}`
        );
        
        // Log position details
        if (positions.length > 0) {
            const positionDetails = positions
                .map(p => `    ${p.poolName || p.poolAddress.slice(0, 8)}: $${p.notionalUSD.toFixed(2)}`)
                .join('\n');
            logger.error(`[PORTFOLIO-ERROR] Position breakdown:\n${positionDetails}`);
        }
        
        // Throw in strict mode
        if (PORTFOLIO_CONSISTENCY_CONFIG.strictMode) {
            throw new Error(`[PORTFOLIO-CONSISTENCY-VIOLATION] ${errorMessage}`);
        }
    } else {
        consecutiveErrors = 0;
    }
    
    return result;
}

/**
 * Log portfolio consistency status
 */
export function logPortfolioConsistency(result?: PortfolioConsistencyResult): void {
    const r = result || lastCheckResult;
    if (!r) {
        logger.info('[PORTFOLIO-CHECK] No consistency check performed yet');
        return;
    }
    
    const emoji = r.consistent ? '✅' : '❌';
    
    logger.info(
        `[PORTFOLIO-CHECK] ${emoji} ` +
        `positions=$${r.sumPositionsUSD.toFixed(2)} ` +
        `reported=$${r.reportedDeployedUSD.toFixed(2)} ` +
        `mismatch=$${r.mismatchUSD.toFixed(2)} ` +
        `count=${r.positionCount}`
    );
}

/**
 * Get consistency history for analysis
 */
export function getConsistencyHistory(limit: number = 20): PortfolioStateSnapshot[] {
    return consistencyHistory.slice(-limit);
}

/**
 * Get last consistency check result
 */
export function getLastConsistencyResult(): PortfolioConsistencyResult | null {
    return lastCheckResult;
}

/**
 * Get consecutive error count
 */
export function getConsecutiveErrorCount(): number {
    return consecutiveErrors;
}

/**
 * Reset consistency tracking (for testing)
 */
export function resetConsistencyTracking(): void {
    consistencyHistory.length = 0;
    lastCheckResult = null;
    consecutiveErrors = 0;
    logger.info('[PORTFOLIO-CHECK] Consistency tracking reset');
}

/**
 * Quick check if portfolio is currently consistent
 */
export function isPortfolioConsistent(): boolean {
    return lastCheckResult?.consistent ?? true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// PORTFOLIO_CONSISTENCY_CONFIG is already exported at declaration

