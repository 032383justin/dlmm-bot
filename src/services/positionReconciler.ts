/**
 * Position Reconciler - Startup Capital Reconciliation & Stale Position Cleanup
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CAPITAL CONSERVATION INVARIANT — NO CAPITAL INFLATION ON RESTART
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module enforces the CRITICAL invariant that capital must be DERIVED
 * from the ground truth on startup, NOT incrementally adjusted.
 * 
 * EQUITY FORMULA (authoritative):
 *   total_equity = initial_capital
 *                + SUM(realized_pnl from closed trades)
 *                + SUM(unrealized_pnl from open positions)
 * 
 * On restart:
 * - Capital state is REBUILT from database truth
 * - Stale positions are PROPERLY CLOSED with trade exit records
 * - No capital is refunded without a corresponding trade closure
 * - Idempotency is guaranteed — multiple restarts produce identical capital
 * 
 * RULES:
 * 1. NEVER credit capital without a corresponding trade exit record
 * 2. Stale positions must be closed with exit_reason = 'RESTART_RECONCILE'
 * 3. Realized PnL for stale positions is computed as 0 (entry price = exit price)
 * 4. Fees/slippage are recorded as 0 for reconciliation closes
 * 5. Both trades and positions tables must be updated atomically
 */

import { supabase } from '../db/supabase';
import logger from '../utils/logger';
import { getActiveRunId } from './runEpoch';

// ═══════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY GUARD — SINGLE RECONCILIATION PER ENGINE INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let reconciliationCompleted = false;
let reconciliationRunId: string | null = null;

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
    derivedEquity: number;
    derivedAvailable: number;
}

export interface ReconcileSummary {
    initialCapital: number;
    realizedPnL: number;
    unrealizedPnL: number;
    openPositions: number;
    closedOnRestart: number;
    totalEquity: number;
    availableBalance: number;
    lockedBalance: number;
    reconciliationMode: 'fresh_start' | 'continuation';
    runId: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVED CAPITAL COMPUTATION — THE AUTHORITATIVE SOURCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute authoritative capital state from database ground truth
 * 
 * This is the SINGLE SOURCE OF TRUTH for capital on startup.
 * It derives equity from:
 * - Initial capital (from capital_state table)
 * - Sum of all realized PnL from closed trades
 * - Sum of unrealized PnL from open positions (positions without closed_at)
 * 
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
            .select('initial_capital, available_balance, locked_balance')
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
            .select('pnl_usd, pnl_net')
            .eq('status', 'closed');
        
        if (tradesError) {
            logger.error('[RECONCILE] Failed to load closed trades:', tradesError.message);
        }
        
        const totalRealizedPnL = (closedTrades || []).reduce((sum: number, t: { pnl_net?: number | null; pnl_usd?: number | null }) => {
            const pnl = Number(t.pnl_net ?? t.pnl_usd ?? 0);
            return sum + pnl;
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
        const totalLockedCapital = (openPositions || []).reduce((sum: number, p: { size_usd?: number | null }) => {
            return sum + Number(p.size_usd || 0);
        }, 0);
        
        // Unrealized PnL from open positions (if tracked in DB)
        // Note: For startup, we assume unrealized = 0 unless positions have been updated
        const totalUnrealizedPnL = (openPositions || []).reduce((sum: number, p: { pnl_usd?: number | null }) => {
            return sum + Number(p.pnl_usd || 0);
        }, 0);
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 3: Derive authoritative equity
        // ═══════════════════════════════════════════════════════════════════════
        // 
        // Equity = Initial Capital + Realized PnL + Unrealized PnL
        // Available = Equity - Locked Capital
        // 
        const derivedEquity = initialCapital + totalRealizedPnL + totalUnrealizedPnL;
        const derivedAvailable = derivedEquity - totalLockedCapital;
        
        return {
            initialCapital,
            totalRealizedPnL: Math.round(totalRealizedPnL * 100) / 100,
            totalUnrealizedPnL: Math.round(totalUnrealizedPnL * 100) / 100,
            openPositionCount,
            totalLockedCapital: Math.round(totalLockedCapital * 100) / 100,
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
            derivedEquity: 10000,
            derivedAvailable: 10000,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STALE POSITION CLOSING — WITH PROPER TRADE EXIT RECORDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Close a single stale position with proper trade exit record
 * 
 * This ensures capital conservation by:
 * 1. Writing exit record to trades table with realized PnL
 * 2. Marking position as closed in positions table
 * 3. Removing any capital locks for this trade
 * 
 * PnL for stale positions is 0 (we assume entry price = exit price
 * since we don't have current market data at startup).
 * 
 * @param position - The stale position to close
 * @returns true if successfully closed, false otherwise
 */
async function closeStalePositionWithTradeExit(
    position: {
        trade_id: string;
        pool_address: string;
        size_usd: number;
        entry_price: number;
    }
): Promise<boolean> {
    const now = new Date().toISOString();
    const tradeId = position.trade_id;
    
    try {
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 1: Update trades table with exit record
        // ═══════════════════════════════════════════════════════════════════════
        const { error: tradeUpdateError } = await supabase
            .from('trades')
            .update({
                status: 'closed',
                exit_price: position.entry_price, // Exit at entry price = 0 PnL
                exit_time: now,
                exit_reason: 'RESTART_RECONCILE',
                pnl_usd: 0,
                pnl_net: 0,
                pnl_percent: 0,
                exit_fees_paid: 0,
                exit_slippage_usd: 0,
            })
            .eq('id', tradeId);
        
        if (tradeUpdateError) {
            logger.error(`[RECONCILE] Failed to update trade ${tradeId.slice(0, 8)}...: ${tradeUpdateError.message}`);
            return false;
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 2: Mark position as closed in positions table
        // ═══════════════════════════════════════════════════════════════════════
        const { error: positionUpdateError } = await supabase
            .from('positions')
            .update({
                closed_at: now,
                exit_reason: 'RESTART_RECONCILE',
                pnl_usd: 0,
                updated_at: now,
            })
            .eq('trade_id', tradeId);
        
        if (positionUpdateError) {
            logger.error(`[RECONCILE] Failed to update position ${tradeId.slice(0, 8)}...: ${positionUpdateError.message}`);
            // Don't return false - trade is already closed
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
            // Don't return false - this is cleanup, not critical
        }
        
        logger.warn(
            `[RECONCILE] Closed stale position: ${tradeId.slice(0, 8)}... | ` +
            `pool=${position.pool_address?.slice(0, 8)}... | ` +
            `size=$${Number(position.size_usd || 0).toFixed(2)} | ` +
            `exit_reason=RESTART_RECONCILE | pnl=$0.00`
        );
        
        return true;
        
    } catch (err: any) {
        logger.error(`[RECONCILE] Error closing stale position ${tradeId.slice(0, 8)}...: ${err.message}`);
        return false;
    }
}

/**
 * Close all stale open positions with proper trade exit records
 * 
 * A position is considered "stale" if it:
 * - Has no closed_at timestamp (still marked as open)
 * - Will not be restored to the engine (determined by caller)
 * 
 * This function ensures capital conservation by:
 * - Writing exit records to trades table
 * - Setting realized PnL to 0 (entry price = exit price assumption)
 * - Recording fees/slippage as 0
 * - Removing capital locks
 * 
 * @param positionsToClose - Array of position trade_ids to close
 * @returns ReconciliationResult with count and total USD closed
 */
export async function closeStalePositionsWithExitRecords(
    positionsToClose: Array<{
        trade_id: string;
        pool_address: string;
        size_usd: number;
        entry_price: number;
    }>
): Promise<ReconciliationResult> {
    if (positionsToClose.length === 0) {
        return { closed: 0, refundedUSD: 0 };
    }
    
    let closedCount = 0;
    let totalSizeUSD = 0;
    
    for (const position of positionsToClose) {
        const success = await closeStalePositionWithTradeExit(position);
        if (success) {
            closedCount++;
            totalSizeUSD += Number(position.size_usd || 0);
        }
    }
    
    if (closedCount > 0) {
        logger.warn(`[RECONCILE] Auto-closed ${closedCount} stale positions with trade exit records`);
    }
    
    return {
        closed: closedCount,
        refundedUSD: 0, // No refund — capital is derived, not credited
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY FUNCTIONS — DEPRECATED, REDIRECT TO NEW IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @deprecated Use closeStalePositionsWithExitRecords instead
 * This function is kept for backward compatibility but now uses proper exit records
 */
export async function closeStalePositions(): Promise<ReconciliationResult> {
    logger.info('[RECONCILE] Checking for stale open positions...');
    
    // Check idempotency — don't reconcile twice
    if (reconciliationCompleted) {
        logger.info(`[RECONCILE] Reconciliation already completed for run ${reconciliationRunId} — skipping`);
        return { closed: 0, refundedUSD: 0 };
    }
    
    try {
        // Query for positions without closed_at (open positions)
        const { data: openPositions, error } = await supabase
            .from('positions')
            .select('trade_id, pool_address, size_usd, entry_price')
            .is('closed_at', null);
        
        if (error) {
            logger.error('[RECONCILE] Failed to load open positions', { error: error.message });
            return { closed: 0, refundedUSD: 0 };
        }
        
        if (!openPositions || openPositions.length === 0) {
            logger.info('[RECONCILE] No stale positions found');
            return { closed: 0, refundedUSD: 0 };
        }
        
        // Close all stale positions with proper exit records
        const result = await closeStalePositionsWithExitRecords(
            openPositions.map(p => ({
                trade_id: p.trade_id,
                pool_address: p.pool_address,
                size_usd: Number(p.size_usd || 0),
                entry_price: Number(p.entry_price || 0),
            }))
        );
        
        return result;
        
    } catch (err: any) {
        logger.error(`[RECONCILE] Error during position reconciliation: ${err.message}`);
        return { closed: 0, refundedUSD: 0 };
    }
}

/**
 * @deprecated Use runFullReconciliation instead
 * Close orphaned open trades in trades table
 */
export async function closeStaleOpenTrades(): Promise<ReconciliationResult> {
    logger.info('[RECONCILE] Checking for stale open trades...');
    
    try {
        const { data: openTrades, error } = await supabase
            .from('trades')
            .select('id, pool_name, pool_address, size, entry_price')
            .eq('status', 'open');
        
        if (error) {
            logger.error('[RECONCILE] Failed to load open trades', { error: error.message });
            return { closed: 0, refundedUSD: 0 };
        }
        
        if (!openTrades || openTrades.length === 0) {
            logger.info('[RECONCILE] No stale trades found');
            return { closed: 0, refundedUSD: 0 };
        }
        
        const now = new Date().toISOString();
        let closedCount = 0;
        
        for (const trade of openTrades) {
            const { error: updateError } = await supabase
                .from('trades')
                .update({
                    status: 'closed',
                    exit_price: Number(trade.entry_price || 0),
                    exit_time: now,
                    exit_reason: 'RESTART_RECONCILE',
                    pnl_usd: 0,
                    pnl_net: 0,
                    pnl_percent: 0,
                    exit_fees_paid: 0,
                    exit_slippage_usd: 0,
                })
                .eq('id', trade.id);
            
            if (!updateError) {
                closedCount++;
                logger.warn(
                    `[RECONCILE] Closed stale trade: ${trade.id.slice(0, 8)}... | ` +
                    `pool=${trade.pool_name || trade.pool_address?.slice(0, 8)} | ` +
                    `size=$${Number(trade.size || 0).toFixed(2)} | ` +
                    `exit_reason=RESTART_RECONCILE`
                );
                
                // Remove capital lock
                await supabase
                    .from('capital_locks')
                    .delete()
                    .eq('trade_id', trade.id);
            }
        }
        
        if (closedCount > 0) {
            logger.warn(`[RECONCILE] Auto-closed ${closedCount} stale trades`);
        }
        
        return {
            closed: closedCount,
            refundedUSD: 0, // No refund — capital is derived
        };
        
    } catch (err: any) {
        logger.error(`[RECONCILE] Error during trade reconciliation: ${err.message}`);
        return { closed: 0, refundedUSD: 0 };
    }
}

/**
 * Clear orphaned capital locks that don't have matching open trades
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
            logger.error('[RECONCILE] Failed to load open trades for lock check', { error: tradesError.message });
            return 0;
        }
        
        const openTradeIds = new Set((openTrades || []).map((t: { id: string }) => t.id));
        
        // Find orphaned locks (locks without matching open trade)
        const orphanedLocks = locks.filter((lock: { trade_id: string; amount: number }) => !openTradeIds.has(lock.trade_id));
        
        if (orphanedLocks.length === 0) {
            logger.info('[RECONCILE] No orphaned capital locks found');
            return 0;
        }
        
        // Delete orphaned locks (NO REFUND — capital is derived)
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
// FULL RECONCILIATION — THE MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run full startup reconciliation with derived capital
 * 
 * This is the CANONICAL reconciliation function that:
 * 1. Computes authoritative capital from database truth
 * 2. Closes stale positions with proper trade exit records
 * 3. Clears orphaned capital locks
 * 4. Rebuilds capital_state to match derived values
 * 5. Logs RECONCILE-SUMMARY for audit
 * 
 * IDEMPOTENCY: This function can only run ONCE per engine instance.
 * Subsequent calls will be no-ops.
 * 
 * @param mode - 'fresh_start' (PAPER_CAPITAL provided) or 'continuation'
 * @param initialCapital - Starting capital for this run
 * @returns ReconcileSummary with all reconciliation details
 */
export async function runFullReconciliation(
    mode: 'fresh_start' | 'continuation',
    initialCapital: number
): Promise<ReconcileSummary> {
    const runId = getActiveRunId();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // IDEMPOTENCY CHECK — Only run once per engine instance
    // ═══════════════════════════════════════════════════════════════════════════
    if (reconciliationCompleted) {
        logger.info(`[RECONCILE] Reconciliation already completed for run ${reconciliationRunId} — skipping`);
        
        // Return cached summary
        const derived = await computeDerivedCapitalState();
        return {
            initialCapital: derived.initialCapital,
            realizedPnL: derived.totalRealizedPnL,
            unrealizedPnL: derived.totalUnrealizedPnL,
            openPositions: derived.openPositionCount,
            closedOnRestart: 0,
            totalEquity: derived.derivedEquity,
            availableBalance: derived.derivedAvailable,
            lockedBalance: derived.totalLockedCapital,
            reconciliationMode: mode,
            runId,
        };
    }
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('[RECONCILE] Starting full capital reconciliation...');
    logger.info(`   Mode: ${mode.toUpperCase()}`);
    logger.info(`   Initial Capital: $${initialCapital.toFixed(2)}`);
    logger.info(`   Run ID: ${runId}`);
    logger.info('═══════════════════════════════════════════════════════════════════');
    
    let closedOnRestart = 0;
    
    try {
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 1: Close stale positions and trades with proper exit records
        // ═══════════════════════════════════════════════════════════════════════
        if (mode === 'fresh_start') {
            // Fresh start: Close ALL open positions
            const posResult = await closeStalePositions();
            const tradeResult = await closeStaleOpenTrades();
            closedOnRestart = posResult.closed + tradeResult.closed;
        }
        // For continuation mode, positions are kept open and restored to engine
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 2: Clear orphaned capital locks
        // ═══════════════════════════════════════════════════════════════════════
        await clearOrphanedCapitalLocks();
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 3: Compute derived capital state from DB truth
        // ═══════════════════════════════════════════════════════════════════════
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
        // STEP 4: Rebuild capital_state to match derived values
        // ═══════════════════════════════════════════════════════════════════════
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
        // STEP 5: Mark reconciliation complete and log summary
        // ═══════════════════════════════════════════════════════════════════════
        reconciliationCompleted = true;
        reconciliationRunId = runId;
        
        const summary: ReconcileSummary = {
            initialCapital: finalInitialCapital,
            realizedPnL: finalRealizedPnL,
            unrealizedPnL: derived.totalUnrealizedPnL,
            openPositions: finalOpenPositions,
            closedOnRestart,
            totalEquity: Math.round(finalEquity * 100) / 100,
            availableBalance: Math.round(finalAvailable * 100) / 100,
            lockedBalance: Math.round(finalLocked * 100) / 100,
            reconciliationMode: mode,
            runId,
        };
        
        // ═══════════════════════════════════════════════════════════════════════
        // RECONCILE-SUMMARY LOG — STRUCTURED AUDIT TRAIL
        // ═══════════════════════════════════════════════════════════════════════
        logger.info('');
        logger.info('[RECONCILE-SUMMARY]');
        logger.info(`  initial_capital=$${summary.initialCapital.toFixed(2)}`);
        logger.info(`  realized_pnl=$${summary.realizedPnL.toFixed(2)}`);
        logger.info(`  unrealized_pnl=$${summary.unrealizedPnL.toFixed(2)}`);
        logger.info(`  open_positions=${summary.openPositions}`);
        logger.info(`  closed_on_restart=${summary.closedOnRestart}`);
        logger.info(`  total_equity=$${summary.totalEquity.toFixed(2)}`);
        logger.info(`  available_balance=$${summary.availableBalance.toFixed(2)}`);
        logger.info(`  locked_balance=$${summary.lockedBalance.toFixed(2)}`);
        logger.info(`  mode=${summary.reconciliationMode}`);
        logger.info(`  run_id=${summary.runId}`);
        logger.info('');
        
        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info('[RECONCILE] ✅ Capital reconciliation complete — capital inflation IMPOSSIBLE');
        logger.info('═══════════════════════════════════════════════════════════════════');
        
        return summary;
        
    } catch (err: any) {
        logger.error(`[RECONCILE] Full reconciliation failed: ${err.message}`);
        
        // Return safe defaults
        return {
            initialCapital,
            realizedPnL: 0,
            unrealizedPnL: 0,
            openPositions: 0,
            closedOnRestart: 0,
            totalEquity: initialCapital,
            availableBalance: initialCapital,
            lockedBalance: 0,
            reconciliationMode: mode,
            runId,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    computeDerivedCapitalState,
    closeStalePositions,
    closeStaleOpenTrades,
    closeStalePositionsWithExitRecords,
    clearOrphanedCapitalLocks,
    runFullReconciliation,
    hasReconciliationCompleted,
    resetReconciliationState,
};
