/**
 * Position Reconciler - Cleanup stale positions and restore capital on startup
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREVENTS GHOST POSITIONS FROM CORRUPTING PnL AND LOCKING CAPITAL
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * On bot restart, positions that were "open" in DB but not properly closed
 * (due to crashes, force kills, etc.) can cause:
 * - Corrupted PnL calculations
 * - Duplicate position tracking
 * - Memory leaks from orphaned state
 * - Locked capital that's never released
 * 
 * This module force-closes any stale open positions at boot time
 * AND refunds the locked capital back to available balance.
 */

import { supabase } from '../db/supabase';
import logger from '../utils/logger';
import { capitalManager } from './capitalManager';

/**
 * Result of position reconciliation
 */
export interface ReconciliationResult {
    closed: number;
    refundedUSD: number;
}

/**
 * Close all stale open positions in the database and refund locked capital
 * 
 * Called during bootstrap before engine initialization.
 * Marks any "open" positions as force-closed with zero PnL.
 * Refunds the locked capital back to available balance.
 * 
 * @returns Number of positions closed and total USD refunded
 */
export async function closeStalePositions(): Promise<ReconciliationResult> {
    logger.info('[RECONCILE] Checking for stale open positions...');

    try {
        // Query for positions without closed_at (open positions)
        const { data: openPositions, error } = await supabase
            .from('positions')
            .select('*')
            .is('closed_at', null);

        if (error) {
            logger.error('[RECONCILE] Failed to load open positions', { error: error.message });
            return { closed: 0, refundedUSD: 0 };
        }

        if (!openPositions || openPositions.length === 0) {
            logger.info('[RECONCILE] No stale positions found');
            return { closed: 0, refundedUSD: 0 };
        }

        let refundTotal = 0;
        const now = new Date().toISOString();

        // Close each stale position and calculate refund
        let closedCount = 0;

        for (const position of openPositions) {
            // Get the position size for refund
            const positionSize = Number(position.size_usd || 0);
            
            const { error: updateError } = await supabase
                .from('positions')
                .update({
                    closed_at: now,
                    exit_reason: 'FORCE_CLOSED_ON_BOOT',
                    pnl_usd: 0,
                    updated_at: now,
                })
                .eq('trade_id', position.trade_id);

            if (updateError) {
                logger.error(`[RECONCILE] Failed to close position ${position.trade_id}`, { error: updateError.message });
            } else {
                closedCount++;
                refundTotal += positionSize;
                logger.warn(
                    `[RECONCILE] Force-closed stale position: ${position.trade_id?.slice(0, 8)}... | ` +
                    `pool=${position.pool_address?.slice(0, 8)}... | size=$${positionSize.toFixed(2)}`
                );
            }
        }

        // Refund total locked capital back to available balance
        if (refundTotal > 0) {
            try {
                await capitalManager.credit(refundTotal, 'STALE_POSITION_REFUND');
                logger.warn(
                    `[RECONCILE] Refunded $${refundTotal.toFixed(2)} back to capital_state (stale positions)`
                );
            } catch (creditErr: any) {
                logger.error(`[RECONCILE] Failed to credit refund: ${creditErr.message}`);
            }
        }

        if (closedCount > 0) {
            logger.warn(`[RECONCILE] Auto-closed ${closedCount} stale positions`);
        }

        return {
            closed: closedCount,
            refundedUSD: refundTotal,
        };

    } catch (err: any) {
        logger.error(`[RECONCILE] Error during position reconciliation: ${err.message}`);
        return { closed: 0, refundedUSD: 0 };
    }
}

/**
 * Also reconcile trades table - close any orphaned open trades and refund capital
 */
export async function closeStaleOpenTrades(): Promise<ReconciliationResult> {
    logger.info('[RECONCILE] Checking for stale open trades...');

    try {
        const { data: openTrades, error } = await supabase
            .from('trades')
            .select('id, pool_name, size')
            .eq('status', 'open');

        if (error) {
            logger.error('[RECONCILE] Failed to load open trades', { error: error.message });
            return { closed: 0, refundedUSD: 0 };
        }

        if (!openTrades || openTrades.length === 0) {
            logger.info('[RECONCILE] No stale trades found');
            return { closed: 0, refundedUSD: 0 };
        }

        // Calculate total refund from trade sizes
        let refundTotal = 0;
        for (const trade of openTrades) {
            refundTotal += Number(trade.size || 0);
        }

        const now = new Date().toISOString();

        const { error: updateError } = await supabase
            .from('trades')
            .update({
                status: 'closed',
                exit_reason: 'FORCE_CLOSED_ON_BOOT',
                exit_time: now,
                pnl_usd: 0,
                pnl_net: 0,
            })
            .eq('status', 'open');

        if (updateError) {
            logger.error('[RECONCILE] Failed to close stale trades', { error: updateError.message });
            return { closed: 0, refundedUSD: 0 };
        }

        // Note: We don't double-refund here since positions and trades share the same capital lock
        // The capital refund is handled by closeStalePositions() or by clearing capital_locks

        logger.warn(`[RECONCILE] Auto-closed ${openTrades.length} stale trades`);
        
        return {
            closed: openTrades.length,
            refundedUSD: refundTotal, // For informational purposes
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
        
        // Delete orphaned locks and refund
        let totalRefund = 0;
        for (const lock of orphanedLocks) {
            const { error: deleteError } = await supabase
                .from('capital_locks')
                .delete()
                .eq('trade_id', lock.trade_id);
            
            if (!deleteError) {
                totalRefund += Number(lock.amount || 0);
                logger.warn(`[RECONCILE] Cleared orphaned lock: ${lock.trade_id?.slice(0, 8)}... | $${lock.amount}`);
            }
        }
        
        // Refund the orphaned locked capital
        if (totalRefund > 0) {
            try {
                await capitalManager.credit(totalRefund, 'ORPHANED_LOCK_REFUND');
                logger.warn(`[RECONCILE] Refunded $${totalRefund.toFixed(2)} from orphaned locks`);
            } catch (creditErr: any) {
                logger.error(`[RECONCILE] Failed to credit orphaned lock refund: ${creditErr.message}`);
            }
        }
        
        return orphanedLocks.length;
        
    } catch (err: any) {
        logger.error(`[RECONCILE] Error clearing orphaned locks: ${err.message}`);
        return 0;
    }
}

/**
 * Run full reconciliation - positions, trades, and capital locks
 */
export async function runFullReconciliation(): Promise<{
    positions: ReconciliationResult;
    trades: ReconciliationResult;
    orphanedLocks: number;
}> {
    const positions = await closeStalePositions();
    const trades = await closeStaleOpenTrades();
    const orphanedLocks = await clearOrphanedCapitalLocks();
    
    return { positions, trades, orphanedLocks };
}
