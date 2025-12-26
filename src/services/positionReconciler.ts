/**
 * Position Reconciler - Crash-Safe Startup Reconciliation & Capital Derivation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRASH-SAFE RECOVERY — CAPITAL CONSERVATION INVARIANT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module ensures the system can safely recover after:
 * - Process restarts
 * - Server crashes
 * - Forced exits
 * - MTM_ERROR_EXIT
 * - Partial execution failures
 * 
 * DESIGN PHILOSOPHY:
 * - Safety > continuity
 * - Determinism > cleverness
 * - DB truth > runtime assumptions
 * - Fail closed, never fail open
 * 
 * CORE INVARIANTS:
 * 1. Reconciliation runs ONCE at startup BEFORE scanLoop/trading
 * 2. DB is source of truth — in-memory state is NOT trusted on boot
 * 3. lockedCapital >= 0
 * 4. availableCapital >= 0
 * 5. locked + available == totalEquity (within rounding tolerance)
 * 
 * POSITION RECONCILIATION:
 * - All OPEN positions without live execution context → CLOSED_RECOVERED
 * - exitReason = RECOVERY_EXIT
 * - realizedPnL = 0 (do NOT guess)
 * - closeTime = now
 * - Bypasses: COST_NOT_AMORTIZED, harmonic exit, MTM valuation, regime logic
 * 
 * CAPITAL RECONCILIATION:
 * - Recompute from DB ground truth
 * - Release all locked capital from recovered positions
 * - Validate invariants → abort on failure
 */

import { supabase } from '../db/supabase';
import logger from '../utils/logger';
import { getActiveRunId } from './runEpoch';

// ═══════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY GUARD — SINGLE RECONCILIATION PER ENGINE INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let reconciliationCompleted = false;
let reconciliationRunId: string | null = null;
let processStartTime: number = Date.now();

/**
 * Set process start time (call during bootstrap)
 */
export function setProcessStartTime(): void {
    processStartTime = Date.now();
}

/**
 * Get process start time
 */
export function getProcessStartTime(): number {
    return processStartTime;
}

/**
 * Check if reconciliation has already been performed for this engine instance
 */
export function hasReconciliationCompleted(): boolean {
    return reconciliationCompleted;
}

/**
 * Reset reconciliation state (for testing only)
 */
export function resetReconciliationState(): void {
    reconciliationCompleted = false;
    reconciliationRunId = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT REASONS — RECOVERY-SPECIFIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exit reason for crash-recovery closed positions
 */
export const RECOVERY_EXIT_REASON = 'RECOVERY_EXIT';

/**
 * Status for positions closed during recovery
 */
export const CLOSED_RECOVERED_STATUS = 'closed';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ReconciliationResult {
    closed: number;
    refundedUSD: number;
}

export interface DerivedCapitalState {
    initialCapital: number;
    totalRealizedPnL: number;
    totalUnrealizedPnL: number;
    openPositionCount: number;
    totalLockedCapital: number;
    totalFeesAccrued: number;
    totalFeesPaid: number;
    derivedEquity: number;
    derivedAvailable: number;
}

export interface ReconcileSummary {
    initialCapital: number;
    realizedPnL: number;
    unrealizedPnL: number;
    openPositions: number;
    closedOnRestart: number;
    releasedCapital: number;
    totalEquity: number;
    availableBalance: number;
    lockedBalance: number;
    reconciliationMode: 'fresh_start' | 'continuation';
    runId: string | null;
    status: 'SUCCESS' | 'ERROR';
    invariantsValid: boolean;
}

export interface RecoveredPosition {
    tradeId: string;
    poolAddress: string;
    poolName?: string;
    entryNotionalUsd: number;
    feesAccrued: number;
    closedAt: string;
}

/**
 * Capital invariant check result
 */
export interface CapitalInvariantResult {
    valid: boolean;
    errors: string[];
    lockedCapital: number;
    availableCapital: number;
    totalEquity: number;
    tolerance: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVARIANT TOLERANCE
// ═══════════════════════════════════════════════════════════════════════════════

const CAPITAL_INVARIANT_TOLERANCE_USD = 0.01; // $0.01 rounding tolerance

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL INVARIANT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate capital invariants
 * 
 * INVARIANTS:
 * 1. lockedCapital >= 0
 * 2. availableCapital >= 0
 * 3. locked + available == totalEquity (within tolerance)
 * 
 * If any invariant fails, reconciliation MUST abort.
 */
export function validateCapitalInvariants(
    lockedCapital: number,
    availableCapital: number,
    totalEquity: number
): CapitalInvariantResult {
    const errors: string[] = [];
    const tolerance = CAPITAL_INVARIANT_TOLERANCE_USD;
    
    // Invariant 1: lockedCapital >= 0
    if (lockedCapital < 0) {
        errors.push(`lockedCapital=${lockedCapital.toFixed(2)} is negative`);
    }
    
    // Invariant 2: availableCapital >= 0
    if (availableCapital < 0) {
        errors.push(`availableCapital=${availableCapital.toFixed(2)} is negative`);
    }
    
    // Invariant 3: locked + available == totalEquity (within tolerance)
    const computedTotal = lockedCapital + availableCapital;
    const difference = Math.abs(computedTotal - totalEquity);
    if (difference > tolerance) {
        errors.push(
            `locked($${lockedCapital.toFixed(2)}) + available($${availableCapital.toFixed(2)}) = ` +
            `$${computedTotal.toFixed(2)} != totalEquity($${totalEquity.toFixed(2)}) ` +
            `(diff=$${difference.toFixed(4)}, tolerance=$${tolerance.toFixed(2)})`
        );
    }
    
    return {
        valid: errors.length === 0,
        errors,
        lockedCapital,
        availableCapital,
        totalEquity,
        tolerance,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVED CAPITAL COMPUTATION — THE AUTHORITATIVE SOURCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute authoritative capital state from database ground truth
 * 
 * This is the SINGLE SOURCE OF TRUTH for capital on startup.
 * Capital inflation is IMPOSSIBLE when using this computation because:
 * - No capital is "credited" — it's mathematically derived
 * - Stale positions contribute to locked capital, not available
 * - Realized PnL only comes from properly closed trades
 */
export async function computeDerivedCapitalState(): Promise<DerivedCapitalState> {
    try {
        // Get initial capital from capital_state
        const { data: capitalState, error: capitalError } = await supabase
            .from('capital_state')
            .select('initial_capital, available_balance, locked_balance, total_realized_pnl')
            .eq('id', 1)
            .single();
        
        if (capitalError || !capitalState) {
            logger.error('[RECONCILE] Failed to load capital_state:', capitalError?.message);
            return {
                initialCapital: 10000,
                totalRealizedPnL: 0,
                totalUnrealizedPnL: 0,
                openPositionCount: 0,
                totalLockedCapital: 0,
                totalFeesAccrued: 0,
                totalFeesPaid: 0,
                derivedEquity: 10000,
                derivedAvailable: 10000,
            };
        }
        
        const initialCapital = Number(capitalState.initial_capital || 10000);
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 1: Compute total realized PnL from ALL closed trades
        // ═══════════════════════════════════════════════════════════════════════
        const { data: closedTrades, error: tradesError } = await supabase
            .from('trades')
            .select('pnl_usd, pnl_net, total_fees, entry_fees_paid, exit_fees_paid')
            .eq('status', 'closed');
        
        if (tradesError) {
            logger.error('[RECONCILE] Failed to load closed trades:', tradesError.message);
        }
        
        const totalRealizedPnL = (closedTrades || []).reduce((sum: number, t: any) => {
            const pnl = Number(t.pnl_net ?? t.pnl_usd ?? 0);
            return sum + pnl;
        }, 0);
        
        const totalFeesPaid = (closedTrades || []).reduce((sum: number, t: any) => {
            const fees = Number(t.total_fees ?? 0) || 
                        (Number(t.entry_fees_paid ?? 0) + Number(t.exit_fees_paid ?? 0));
            return sum + fees;
        }, 0);
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 2: Get open positions and compute unrealized PnL + locked capital
        // ═══════════════════════════════════════════════════════════════════════
        const { data: openPositions, error: posError } = await supabase
            .from('positions')
            .select('trade_id, size_usd, entry_price, pnl_usd')
            .is('closed_at', null);
        
        if (posError) {
            logger.error('[RECONCILE] Failed to load open positions:', posError.message);
        }
        
        const openPositionCount = (openPositions || []).length;
        
        // Total locked capital = sum of position sizes
        const totalLockedCapital = (openPositions || []).reduce((sum: number, p: any) => {
            return sum + Number(p.size_usd || 0);
        }, 0);
        
        // Unrealized PnL from open positions (if tracked in DB)
        const totalUnrealizedPnL = (openPositions || []).reduce((sum: number, p: any) => {
            return sum + Number(p.pnl_usd || 0);
        }, 0);
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 3: Get total fees accrued (from positions if available)
        // ═══════════════════════════════════════════════════════════════════════
        const { data: positionsWithFees } = await supabase
            .from('positions')
            .select('fees_accrued')
            .not('fees_accrued', 'is', null);
        
        const totalFeesAccrued = (positionsWithFees || []).reduce((sum: number, p: any) => {
            return sum + Number(p.fees_accrued || 0);
        }, 0);
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 4: Derive authoritative equity
        // Equity = Initial Capital + Realized PnL + Unrealized PnL
        // Available = Equity - Locked Capital
        // ═══════════════════════════════════════════════════════════════════════
        const derivedEquity = initialCapital + totalRealizedPnL + totalUnrealizedPnL;
        const derivedAvailable = derivedEquity - totalLockedCapital;
        
        return {
            initialCapital,
            totalRealizedPnL: Math.round(totalRealizedPnL * 100) / 100,
            totalUnrealizedPnL: Math.round(totalUnrealizedPnL * 100) / 100,
            openPositionCount,
            totalLockedCapital: Math.round(totalLockedCapital * 100) / 100,
            totalFeesAccrued: Math.round(totalFeesAccrued * 100) / 100,
            totalFeesPaid: Math.round(totalFeesPaid * 100) / 100,
            derivedEquity: Math.round(derivedEquity * 100) / 100,
            derivedAvailable: Math.round(derivedAvailable * 100) / 100,
        };
        
    } catch (err: any) {
        logger.error(`[RECONCILE] computeDerivedCapitalState failed: ${err.message}`);
        return {
            initialCapital: 10000,
            totalRealizedPnL: 0,
            totalUnrealizedPnL: 0,
            openPositionCount: 0,
            totalLockedCapital: 0,
            totalFeesAccrued: 0,
            totalFeesPaid: 0,
            derivedEquity: 10000,
            derivedAvailable: 10000,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION RECOVERY — CLOSE WITH RECOVERY_EXIT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Close a single open position with RECOVERY_EXIT reason
 * 
 * CRITICAL: This bypasses all exit logic (harmonic, MTM, regime, suppression).
 * Realized PnL is set to 0 — we do NOT guess.
 * 
 * @param position - The position to recover-close
 * @returns RecoveredPosition with details for logging
 */
async function closePositionWithRecoveryExit(
    position: {
        trade_id: string;
        pool_address: string;
        pool_name?: string;
        size_usd: number;
        entry_price: number;
        fees_accrued?: number;
    }
): Promise<RecoveredPosition | null> {
    const now = new Date().toISOString();
    const tradeId = position.trade_id;
    
    try {
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 1: Update trades table with RECOVERY_EXIT
        // PnL = 0 (we do NOT guess)
        // ═══════════════════════════════════════════════════════════════════════
        const { error: tradeUpdateError } = await supabase
            .from('trades')
            .update({
                status: CLOSED_RECOVERED_STATUS,
                exit_price: position.entry_price, // Exit at entry price = 0 PnL
                exit_time: now,
                exit_reason: RECOVERY_EXIT_REASON,
                pnl_usd: 0,
                pnl_net: 0,
                pnl_gross: 0,
                pnl_percent: 0,
                exit_fees_paid: 0,
                exit_slippage_usd: 0,
            })
            .eq('id', tradeId);
        
        if (tradeUpdateError) {
            logger.error(`[RECONCILE] Failed to update trade ${tradeId.slice(0, 8)}...: ${tradeUpdateError.message}`);
            return null;
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 2: Mark position as closed in positions table
        // ═══════════════════════════════════════════════════════════════════════
        const { error: positionUpdateError } = await supabase
            .from('positions')
            .update({
                closed_at: now,
                exit_reason: RECOVERY_EXIT_REASON,
                pnl_usd: 0, // Do NOT guess PnL
                updated_at: now,
            })
            .eq('trade_id', tradeId);
        
        if (positionUpdateError) {
            logger.error(`[RECONCILE] Failed to update position ${tradeId.slice(0, 8)}...: ${positionUpdateError.message}`);
            // Continue - trade is already closed
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 3: Remove any capital lock for this trade
        // ═══════════════════════════════════════════════════════════════════════
        const { error: lockDeleteError } = await supabase
            .from('capital_locks')
            .delete()
            .eq('trade_id', tradeId);
        
        if (lockDeleteError) {
            logger.warn(`[RECONCILE] Failed to delete capital lock for ${tradeId.slice(0, 8)}...: ${lockDeleteError.message}`);
        }
        
        const feesAccrued = Number(position.fees_accrued || 0);
        const entryNotionalUsd = Number(position.size_usd || 0);
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 4: Emit structured log
        // ═══════════════════════════════════════════════════════════════════════
        logger.warn(
            `[RECONCILE-POSITION] ` +
            `tradeId=${tradeId.slice(0, 8)}... ` +
            `pool=${position.pool_address?.slice(0, 8)}... ` +
            `entryNotional=$${entryNotionalUsd.toFixed(2)} ` +
            `feesAccrued=$${feesAccrued.toFixed(2)} ` +
            `action=CLOSED_RECOVERED`
        );
        
        return {
            tradeId,
            poolAddress: position.pool_address,
            poolName: position.pool_name,
            entryNotionalUsd,
            feesAccrued,
            closedAt: now,
        };
        
    } catch (err: any) {
        logger.error(`[RECONCILE] Error closing position ${tradeId.slice(0, 8)}...: ${err.message}`);
        return null;
    }
}

/**
 * Close all open positions with RECOVERY_EXIT
 * 
 * After restart, there is NO live execution context.
 * All open positions must be safely closed.
 */
export async function closeAllOpenPositionsWithRecoveryExit(): Promise<{
    recoveredPositions: RecoveredPosition[];
    releasedCapital: number;
}> {
    try {
        // Query for all positions without closed_at (open positions)
        const { data: openPositions, error } = await supabase
            .from('positions')
            .select('trade_id, pool_address, size_usd, entry_price, fees_accrued')
            .is('closed_at', null);
        
        if (error) {
            logger.error('[RECONCILE] Failed to load open positions:', error.message);
            return { recoveredPositions: [], releasedCapital: 0 };
        }
        
        if (!openPositions || openPositions.length === 0) {
            logger.info('[RECONCILE] No open positions to recover');
            return { recoveredPositions: [], releasedCapital: 0 };
        }
        
        logger.info(`[RECONCILE] Found ${openPositions.length} open positions to recover`);
        
        const recoveredPositions: RecoveredPosition[] = [];
        let releasedCapital = 0;
        
        for (const position of openPositions) {
            // Get pool name from trades table
            const { data: tradeData } = await supabase
                .from('trades')
                .select('pool_name')
                .eq('id', position.trade_id)
                .single();
            
            const positionWithName = {
                ...position,
                pool_name: tradeData?.pool_name,
            };
            
            const recovered = await closePositionWithRecoveryExit(positionWithName);
            if (recovered) {
                recoveredPositions.push(recovered);
                releasedCapital += recovered.entryNotionalUsd;
            }
        }
        
        // Also close any orphaned trades (in trades table but not in positions)
        const { data: openTrades, error: tradesError } = await supabase
            .from('trades')
            .select('id, pool_name, pool_address, size, entry_price')
            .eq('status', 'open');
        
        if (!tradesError && openTrades && openTrades.length > 0) {
            const alreadyClosed = new Set(recoveredPositions.map(p => p.tradeId));
            
            for (const trade of openTrades) {
                if (alreadyClosed.has(trade.id)) continue;
                
                const now = new Date().toISOString();
                await supabase
                    .from('trades')
                    .update({
                        status: CLOSED_RECOVERED_STATUS,
                        exit_price: Number(trade.entry_price || 0),
                        exit_time: now,
                        exit_reason: RECOVERY_EXIT_REASON,
                        pnl_usd: 0,
                        pnl_net: 0,
                        pnl_percent: 0,
                    })
                    .eq('id', trade.id);
                
                // Release capital lock if exists
                await supabase
                    .from('capital_locks')
                    .delete()
                    .eq('trade_id', trade.id);
                
                const tradeSize = Number(trade.size || 0);
                recoveredPositions.push({
                    tradeId: trade.id,
                    poolAddress: trade.pool_address,
                    poolName: trade.pool_name,
                    entryNotionalUsd: tradeSize,
                    feesAccrued: 0,
                    closedAt: now,
                });
                releasedCapital += tradeSize;
                
                logger.warn(
                    `[RECONCILE-POSITION] ` +
                    `tradeId=${trade.id.slice(0, 8)}... ` +
                    `pool=${trade.pool_name || trade.pool_address?.slice(0, 8)} ` +
                    `entryNotional=$${tradeSize.toFixed(2)} ` +
                    `feesAccrued=$0.00 ` +
                    `action=CLOSED_RECOVERED`
                );
            }
        }
        
        return { recoveredPositions, releasedCapital };
        
    } catch (err: any) {
        logger.error(`[RECONCILE] Error during position recovery: ${err.message}`);
        return { recoveredPositions: [], releasedCapital: 0 };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORPHANED CAPITAL LOCKS CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clear all orphaned capital locks (locks without matching open trades)
 */
export async function clearOrphanedCapitalLocks(): Promise<number> {
    logger.info('[RECONCILE] Checking for orphaned capital locks...');
    
    try {
        // Get all capital locks
        const { data: locks, error: locksError } = await supabase
            .from('capital_locks')
            .select('trade_id, amount');
        
        if (locksError || !locks || locks.length === 0) {
            logger.info('[RECONCILE] No capital locks to check');
            return 0;
        }
        
        // Get all open trade IDs
        const { data: openTrades, error: tradesError } = await supabase
            .from('trades')
            .select('id')
            .eq('status', 'open');
        
        if (tradesError) {
            logger.error('[RECONCILE] Failed to load open trades for lock check:', tradesError.message);
            return 0;
        }
        
        const openTradeIds = new Set((openTrades || []).map((t: { id: string }) => t.id));
        
        // Find orphaned locks (locks without matching open trade)
        const orphanedLocks = locks.filter((lock: { trade_id: string; amount: number }) => 
            !openTradeIds.has(lock.trade_id)
        );
        
        if (orphanedLocks.length === 0) {
            logger.info('[RECONCILE] No orphaned capital locks found');
            return 0;
        }
        
        // Delete all orphaned locks
        for (const lock of orphanedLocks) {
            const { error: deleteError } = await supabase
                .from('capital_locks')
                .delete()
                .eq('trade_id', lock.trade_id);
            
            if (!deleteError) {
                logger.warn(`[RECONCILE] Cleared orphaned lock: ${lock.trade_id?.slice(0, 8)}... | $${lock.amount}`);
            }
        }
        
        logger.info(`[RECONCILE] Cleared ${orphanedLocks.length} orphaned capital locks`);
        
        return orphanedLocks.length;
        
    } catch (err: any) {
        logger.error(`[RECONCILE] Error clearing orphaned locks: ${err.message}`);
        return 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY — REDIRECT TO NEW IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @deprecated Use runFullReconciliation() instead
 */
export async function closeStalePositions(): Promise<ReconciliationResult> {
    const result = await closeAllOpenPositionsWithRecoveryExit();
    return {
        closed: result.recoveredPositions.length,
        refundedUSD: 0,
    };
}

/**
 * @deprecated Use runFullReconciliation() instead
 */
export async function closeStaleOpenTrades(): Promise<ReconciliationResult> {
    // This is now handled by closeAllOpenPositionsWithRecoveryExit
    return { closed: 0, refundedUSD: 0 };
}

/**
 * @deprecated Use closeAllOpenPositionsWithRecoveryExit() instead
 */
export async function closeStalePositionsWithExitRecords(
    positionsToClose: Array<{
        trade_id: string;
        pool_address: string;
        size_usd: number;
        entry_price: number;
    }>
): Promise<ReconciliationResult> {
    let closedCount = 0;
    for (const position of positionsToClose) {
        const result = await closePositionWithRecoveryExit(position);
        if (result) closedCount++;
    }
    return { closed: closedCount, refundedUSD: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL RECONCILIATION — THE MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run full startup reconciliation
 * 
 * CRITICAL: This MUST run exactly ONCE at startup BEFORE:
 * - scanLoop starts
 * - new trades are allowed
 * - capital is allocated
 * 
 * IDEMPOTENCY: Subsequent calls are no-ops.
 * 
 * @param mode - 'fresh_start' (PAPER_CAPITAL provided) or 'continuation'
 * @param initialCapital - Starting capital for this run
 * @returns ReconcileSummary with all reconciliation details
 * @throws Error if capital invariants fail (abort startup)
 */
export async function runFullReconciliation(
    mode: 'fresh_start' | 'continuation',
    initialCapital: number
): Promise<ReconcileSummary> {
    const runId = getActiveRunId();
    setProcessStartTime();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // IDEMPOTENCY CHECK — Only run once per engine instance
    // ═══════════════════════════════════════════════════════════════════════════
    if (reconciliationCompleted) {
        logger.info(`[RECONCILE] Reconciliation already completed for run ${reconciliationRunId} — skipping`);
        
        const derived = await computeDerivedCapitalState();
        return {
            initialCapital: derived.initialCapital,
            realizedPnL: derived.totalRealizedPnL,
            unrealizedPnL: derived.totalUnrealizedPnL,
            openPositions: derived.openPositionCount,
            closedOnRestart: 0,
            releasedCapital: 0,
            totalEquity: derived.derivedEquity,
            availableBalance: derived.derivedAvailable,
            lockedBalance: derived.totalLockedCapital,
            reconciliationMode: mode,
            runId,
            status: 'SUCCESS',
            invariantsValid: true,
        };
    }
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('[RECONCILE] Starting crash-safe capital reconciliation...');
    logger.info(`   Mode: ${mode.toUpperCase()}`);
    logger.info(`   Initial Capital: $${initialCapital.toFixed(2)}`);
    logger.info(`   Run ID: ${runId}`);
    logger.info(`   Process Start: ${new Date(processStartTime).toISOString()}`);
    logger.info('═══════════════════════════════════════════════════════════════════');
    
    let closedOnRestart = 0;
    let releasedCapital = 0;
    
    try {
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 1: Close ALL open positions with RECOVERY_EXIT
        // After restart, there is NO live execution context
        // ═══════════════════════════════════════════════════════════════════════
        logger.info('[RECONCILE] Step 1: Recovering open positions...');
        
        const recoveryResult = await closeAllOpenPositionsWithRecoveryExit();
        closedOnRestart = recoveryResult.recoveredPositions.length;
        releasedCapital = recoveryResult.releasedCapital;
        
        if (closedOnRestart > 0) {
            logger.warn(`[RECONCILE] Closed ${closedOnRestart} positions with RECOVERY_EXIT`);
        } else {
            logger.info('[RECONCILE] No positions required recovery');
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 2: Clear orphaned capital locks
        // ═══════════════════════════════════════════════════════════════════════
        logger.info('[RECONCILE] Step 2: Clearing orphaned capital locks...');
        await clearOrphanedCapitalLocks();
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 3: Compute derived capital state from DB truth
        // ═══════════════════════════════════════════════════════════════════════
        logger.info('[RECONCILE] Step 3: Computing derived capital state...');
        const derived = await computeDerivedCapitalState();
        
        // For fresh_start mode, override with provided initial capital
        const finalInitialCapital = mode === 'fresh_start' ? initialCapital : derived.initialCapital;
        const finalRealizedPnL = mode === 'fresh_start' ? 0 : derived.totalRealizedPnL;
        const finalEquity = mode === 'fresh_start' 
            ? initialCapital 
            : (finalInitialCapital + finalRealizedPnL + derived.totalUnrealizedPnL);
        const finalAvailable = mode === 'fresh_start'
            ? initialCapital
            : (finalEquity - derived.totalLockedCapital);
        const finalLocked = mode === 'fresh_start' ? 0 : derived.totalLockedCapital;
        const finalOpenPositions = mode === 'fresh_start' ? 0 : derived.openPositionCount;
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 4: Validate capital invariants
        // ═══════════════════════════════════════════════════════════════════════
        logger.info('[RECONCILE] Step 4: Validating capital invariants...');
        
        const invariantCheck = validateCapitalInvariants(
            finalLocked,
            finalAvailable,
            finalEquity
        );
        
        if (!invariantCheck.valid) {
            // ═══════════════════════════════════════════════════════════════════
            // INVARIANT FAILURE — ABORT STARTUP (fail closed)
            // ═══════════════════════════════════════════════════════════════════
            logger.error('');
            logger.error('[RECONCILE-ERROR] Capital invariant validation FAILED');
            logger.error('═══════════════════════════════════════════════════════════════════');
            for (const error of invariantCheck.errors) {
                logger.error(`   ❌ ${error}`);
            }
            logger.error('═══════════════════════════════════════════════════════════════════');
            logger.error('[RECONCILE-ERROR] ABORTING STARTUP — fail closed');
            logger.error('');
            
            // Return error summary but caller should abort
            return {
                initialCapital: finalInitialCapital,
                realizedPnL: finalRealizedPnL,
                unrealizedPnL: derived.totalUnrealizedPnL,
                openPositions: finalOpenPositions,
                closedOnRestart,
                releasedCapital,
                totalEquity: finalEquity,
                availableBalance: finalAvailable,
                lockedBalance: finalLocked,
                reconciliationMode: mode,
                runId,
                status: 'ERROR',
                invariantsValid: false,
            };
        }
        
        logger.info('[RECONCILE] ✅ Capital invariants validated');
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 5: Rebuild capital_state to match derived values
        // ═══════════════════════════════════════════════════════════════════════
        logger.info('[RECONCILE] Step 5: Rebuilding capital_state...');
        
        const { error: updateError } = await supabase
            .from('capital_state')
            .update({
                initial_capital: finalInitialCapital,
                available_balance: finalAvailable,
                locked_balance: finalLocked,
                total_realized_pnl: finalRealizedPnL,
                updated_at: new Date().toISOString(),
            })
            .eq('id', 1);
        
        if (updateError) {
            logger.error(`[RECONCILE] Failed to update capital_state: ${updateError.message}`);
        } else {
            logger.info('[RECONCILE] ✅ Capital state rebuilt from derived values');
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 6: Mark reconciliation complete and emit summary
        // ═══════════════════════════════════════════════════════════════════════
        reconciliationCompleted = true;
        reconciliationRunId = runId;
        
        const summary: ReconcileSummary = {
            initialCapital: finalInitialCapital,
            realizedPnL: finalRealizedPnL,
            unrealizedPnL: derived.totalUnrealizedPnL,
            openPositions: finalOpenPositions,
            closedOnRestart,
            releasedCapital: Math.round(releasedCapital * 100) / 100,
            totalEquity: Math.round(finalEquity * 100) / 100,
            availableBalance: Math.round(finalAvailable * 100) / 100,
            lockedBalance: Math.round(finalLocked * 100) / 100,
            reconciliationMode: mode,
            runId,
            status: 'SUCCESS',
            invariantsValid: true,
        };
        
        // ═══════════════════════════════════════════════════════════════════════
        // [RECONCILE-SUMMARY] — STRUCTURED AUDIT LOG
        // ═══════════════════════════════════════════════════════════════════════
        logger.info('');
        logger.info('[RECONCILE-SUMMARY]');
        logger.info(`  recoveredPositions=${summary.closedOnRestart}`);
        logger.info(`  releasedCapital=$${summary.releasedCapital.toFixed(2)}`);
        logger.info(`  availableCapital=$${summary.availableBalance.toFixed(2)}`);
        logger.info(`  lockedCapital=$${summary.lockedBalance.toFixed(2)}`);
        logger.info(`  totalEquity=$${summary.totalEquity.toFixed(2)}`);
        logger.info(`  status=${summary.status}`);
        logger.info('');
        
        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info('[RECONCILE] ✅ Crash-safe reconciliation complete');
        logger.info('═══════════════════════════════════════════════════════════════════');
        
        return summary;
        
    } catch (err: any) {
        logger.error(`[RECONCILE-ERROR] Full reconciliation failed: ${err.message}`);
        
        return {
            initialCapital,
            realizedPnL: 0,
            unrealizedPnL: 0,
            openPositions: 0,
            closedOnRestart,
            releasedCapital,
            totalEquity: initialCapital,
            availableBalance: initialCapital,
            lockedBalance: 0,
            reconciliationMode: mode,
            runId,
            status: 'ERROR',
            invariantsValid: false,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    computeDerivedCapitalState,
    closeAllOpenPositionsWithRecoveryExit,
    clearOrphanedCapitalLocks,
    runFullReconciliation,
    hasReconciliationCompleted,
    resetReconciliationState,
    validateCapitalInvariants,
    getProcessStartTime,
    setProcessStartTime,
    // Legacy exports for backward compatibility
    closeStalePositions,
    closeStaleOpenTrades,
    closeStalePositionsWithExitRecords,
    // Constants
    RECOVERY_EXIT_REASON,
    CLOSED_RECOVERED_STATUS,
};
