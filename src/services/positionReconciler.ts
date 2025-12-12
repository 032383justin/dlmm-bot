/**
 * Position Reconciler - Cleanup stale positions on startup
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREVENTS GHOST POSITIONS FROM CORRUPTING PnL
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * On bot restart, positions that were "open" in DB but not properly closed
 * (due to crashes, force kills, etc.) can cause:
 * - Corrupted PnL calculations
 * - Duplicate position tracking
 * - Memory leaks from orphaned state
 * 
 * This module force-closes any stale open positions at boot time.
 */

import { supabase } from '../db/supabase';
import logger from '../utils/logger';

/**
 * Close all stale open positions in the database
 * 
 * Called during bootstrap before engine initialization.
 * Marks any "open" positions as force-closed with zero PnL.
 * 
 * @returns Number of positions closed
 */
export async function closeStalePositions(): Promise<number> {
    logger.info('[RECONCILE] Checking for stale open positions...');

    try {
        // Query for positions without closed_at (open positions)
        const { data, error } = await supabase
            .from('positions')
            .select('*')
            .is('closed_at', null);

        if (error) {
            logger.error('[RECONCILE] Failed to load open positions', { error: error.message });
            return 0;
        }

        if (!data || data.length === 0) {
            logger.info('[RECONCILE] No stale positions found');
            return 0;
        }

        // Close each stale position
        const now = new Date().toISOString();
        let closedCount = 0;

        for (const position of data) {
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
                logger.warn(`[RECONCILE] Force-closed stale position: ${position.trade_id?.slice(0, 8)}... | pool=${position.pool_address?.slice(0, 8)}...`);
            }
        }

        if (closedCount > 0) {
            logger.warn(`[RECONCILE] Auto-closed ${closedCount} stale positions`);
        }

        return closedCount;

    } catch (err: any) {
        logger.error(`[RECONCILE] Error during position reconciliation: ${err.message}`);
        return 0;
    }
}

/**
 * Also reconcile trades table - close any orphaned open trades
 */
export async function closeStaleOpenTrades(): Promise<number> {
    logger.info('[RECONCILE] Checking for stale open trades...');

    try {
        const { data, error } = await supabase
            .from('trades')
            .select('id, pool_name, size')
            .eq('status', 'open');

        if (error) {
            logger.error('[RECONCILE] Failed to load open trades', { error: error.message });
            return 0;
        }

        if (!data || data.length === 0) {
            logger.info('[RECONCILE] No stale trades found');
            return 0;
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
            return 0;
        }

        logger.warn(`[RECONCILE] Auto-closed ${data.length} stale trades`);
        return data.length;

    } catch (err: any) {
        logger.error(`[RECONCILE] Error during trade reconciliation: ${err.message}`);
        return 0;
    }
}

/**
 * Run full reconciliation - positions and trades
 */
export async function runFullReconciliation(): Promise<{ positions: number; trades: number }> {
    const positions = await closeStalePositions();
    const trades = await closeStaleOpenTrades();
    return { positions, trades };
}

