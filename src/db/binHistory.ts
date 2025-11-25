import { supabase } from './supabase';
import { BinSnapshot } from '../core/dlmmTelemetry';
import logger from '../utils/logger';

/**
 * Saves a bin snapshot to Supabase bin_history table
 * 
 * IMPORTANT: Only call this for ACTIVE pools every 5-10 seconds
 * to prevent excessive database writes and costs
 */
export async function saveBinSnapshot(poolAddress: string, snapshot: BinSnapshot): Promise<void> {
    try {
        const { error } = await supabase
            .from('bin_history')
            .insert({
                pool: poolAddress,
                timestamp: snapshot.timestamp,
                active_bin: snapshot.activeBin,
                bin_liquidity: snapshot.bins,
                bin_swaps: Object.fromEntries(
                    Object.entries(snapshot.bins).map(([binId, data]) => [binId, data.swaps])
                ),
                refill_time: Object.fromEntries(
                    Object.entries(snapshot.bins).map(([binId, data]) => [binId, data.refillTimeMs])
                )
            });

        if (error) {
            logger.error(`Failed to save bin snapshot for ${poolAddress}:`, error);
        }
    } catch (error) {
        logger.error(`Error saving bin snapshot for ${poolAddress}:`, error);
    }
}

/**
 * Loads recent bin history for a pool
 * 
 * @param poolAddress Pool address
 * @param limit Number of snapshots to load (default: 20)
 * @returns Array of bin snapshots, newest first
 */
export async function loadBinHistory(poolAddress: string, limit: number = 20): Promise<BinSnapshot[]> {
    try {
        const { data, error } = await supabase
            .from('bin_history')
            .select('*')
            .eq('pool', poolAddress)
            .order('timestamp', { ascending: false })
            .limit(limit);

        if (error) {
            logger.error(`Failed to load bin history for ${poolAddress}:`, error);
            return [];
        }

        if (!data || data.length === 0) {
            return [];
        }

        // Convert database records back to BinSnapshot format
        return data.map(record => ({
            timestamp: record.timestamp,
            activeBin: record.active_bin,
            bins: record.bin_liquidity // Already in correct format
        }));
    } catch (error) {
        logger.error(`Error loading bin history for ${poolAddress}:`, error);
        return [];
    }
}

/**
 * Deletes old bin history to save storage costs
 * 
 * @param daysToKeep Number of days of history to keep (default: 7)
 */
export async function cleanupOldBinHistory(daysToKeep: number = 7): Promise<void> {
    try {
        const cutoffTimestamp = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

        const { error } = await supabase
            .from('bin_history')
            .delete()
            .lt('timestamp', cutoffTimestamp);

        if (error) {
            logger.error('Failed to cleanup old bin history:', error);
        } else {
            logger.info(`Cleaned up bin history older than ${daysToKeep} days`);
        }
    } catch (error) {
        logger.error('Error cleaning up old bin history:', error);
    }
}
