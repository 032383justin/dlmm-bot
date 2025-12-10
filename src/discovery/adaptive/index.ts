/**
 * Adaptive Pool Selection Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Self-optimizing pool universe using Sharpe scores.
 * 
 * BEHAVIOR:
 * - Remove worst-performers from candidate list
 * - Prioritize top performers
 * - Periodically reinsert new/unknown pools via discovery
 * - Maintain a dynamic active universe of best pools only
 * 
 * INTEGRATION:
 * During pool selection:
 *   const selection = getAdaptivePoolSelection();
 *   const candidates = selection.activePools;
 *   // Only trade pools in active universe
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Type exports
export type {
    PoolStatus,
    AdaptivePoolEntry,
    AdaptivePoolConfig,
    PoolSelectionResult,
    PoolFilterCriteria,
    UniverseUpdateEvent,
} from './types';

// Config exports
export {
    DEFAULT_CONFIG,
    CONSERVATIVE_CONFIG,
    AGGRESSIVE_CONFIG,
    createConfig,
} from './config';

// Tracker exports
export {
    addPoolToUniverse,
    removePoolFromUniverse,
    updatePoolStatus,
    refreshPoolMetrics,
    refreshAllPoolMetrics,
    getPoolEntry,
    getAllPools,
    getFilteredPools,
    getPoolSelectionResult,
    isPoolActive,
    isPoolBlocked,
    isPoolInUniverse,
    getPoolCountByStatus,
    removePermanentlyBlocked,
    expireStalePools,
    getUpdateHistory,
    clearUniverse,
    getUniverseSize,
} from './tracker';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

import {
    AdaptivePoolEntry,
    PoolSelectionResult,
    PoolFilterCriteria,
} from './types';
import {
    addPoolToUniverse as addPool,
    getPoolEntry,
    getFilteredPools,
    getPoolSelectionResult,
    isPoolActive as checkPoolActive,
    isPoolBlocked as checkPoolBlocked,
    refreshAllPoolMetrics,
    refreshPoolMetrics,
    removePermanentlyBlocked,
    expireStalePools,
} from './tracker';
import { DEFAULT_CONFIG } from './config';

/**
 * Get the current adaptive pool selection.
 * This is the primary API for the Adaptive Pool Selection module.
 */
export function getAdaptivePoolSelection(): PoolSelectionResult {
    return getPoolSelectionResult(DEFAULT_CONFIG);
}

/**
 * Get active trading pools sorted by priority.
 */
export function getActiveTradingPools(limit?: number): AdaptivePoolEntry[] {
    return getFilteredPools({
        activeOnly: true,
        limit,
    });
}

/**
 * Get pools that are allowed for trading (active + probation).
 */
export function getAllowedTradingPools(limit?: number): AdaptivePoolEntry[] {
    return getFilteredPools({
        includeProbation: true,
        limit,
    }).filter(p => p.status === 'ACTIVE' || p.status === 'PROBATION');
}

/**
 * Check if a pool is allowed for trading.
 */
export function isPoolAllowedForTrading(poolAddress: string): boolean {
    const entry = getPoolEntry(poolAddress);
    if (!entry) return false;
    return entry.status === 'ACTIVE' || entry.status === 'PROBATION';
}

/**
 * Get pool priority multiplier based on adaptive selection.
 * Returns 0 for blocked pools, 0.5 for probation, 1.0 for active.
 */
export function getPoolPriorityMultiplier(poolAddress: string): number {
    const entry = getPoolEntry(poolAddress);
    if (!entry) return 1.0; // Unknown pools get neutral multiplier
    
    switch (entry.status) {
        case 'ACTIVE':
            return 1.0 + (entry.priorityScore * 0.25); // Up to 1.25x for top pools
        case 'PROBATION':
            return 0.5;
        case 'DISCOVERY':
            return 0.7;
        case 'BLOCKED':
        case 'EXPIRED':
            return 0;
    }
}

/**
 * Add pools from discovery to the adaptive universe.
 */
export function addDiscoveredPools(
    pools: Array<{ address: string; name: string; score: number }>,
    origin: 'INITIAL' | 'REFRESH' | 'MANUAL' = 'REFRESH'
): number {
    let added = 0;
    
    for (const pool of pools) {
        addPool(pool.address, pool.name, pool.score, origin, DEFAULT_CONFIG);
        added++;
    }
    
    return added;
}

/**
 * Run maintenance on the adaptive universe.
 * Should be called periodically (e.g., every hour).
 */
export function runUniverseMaintenance(): {
    refreshed: boolean;
    permanentlyRemoved: number;
    expired: number;
} {
    // Refresh all pool metrics from Sharpe Memory
    refreshAllPoolMetrics(DEFAULT_CONFIG);
    
    // Remove permanently blocked pools
    const permanentlyRemoved = removePermanentlyBlocked(DEFAULT_CONFIG);
    
    // Mark stale pools as expired
    const expired = expireStalePools(DEFAULT_CONFIG);
    
    return {
        refreshed: true,
        permanentlyRemoved,
        expired,
    };
}

/**
 * Filter pool candidates through adaptive selection.
 * Returns only pools that pass the adaptive filter.
 */
export function filterPoolsThroughAdaptive(
    poolAddresses: string[]
): string[] {
    return poolAddresses.filter(addr => {
        const entry = getPoolEntry(addr);
        
        // Unknown pools are allowed (need to be added first)
        if (!entry) return true;
        
        // Only allow ACTIVE and PROBATION
        return entry.status === 'ACTIVE' || entry.status === 'PROBATION';
    });
}

/**
 * Get pool addresses that should be prioritized.
 */
export function getPrioritizedPoolAddresses(limit: number = 20): string[] {
    const pools = getFilteredPools({
        activeOnly: true,
        limit,
    });
    
    return pools.map(p => p.poolAddress);
}

/**
 * Get pool addresses that should be avoided.
 */
export function getBlockedPoolAddresses(): string[] {
    return getFilteredPools({})
        .filter(p => p.status === 'BLOCKED')
        .map(p => p.poolAddress);
}

/**
 * Refresh metrics for a specific pool.
 */
export function refreshPoolAdaptiveMetrics(poolAddress: string): void {
    refreshPoolMetrics(poolAddress, DEFAULT_CONFIG);
}

