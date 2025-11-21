// Multi-Pool Arbitrage Detection

import { Pool } from '../core/normalizePools';

interface TokenPair {
    readonly tokenA: string;
    readonly tokenB: string;
    readonly normalized: string; // e.g., "SOL-USDC" (alphabetically sorted)
}

interface PoolGroup {
    readonly pair: TokenPair;
    readonly pools: Pool[];
    readonly bestPool: Pool;
}

/**
 * Parse pool name into token pair
 */
function parseTokenPair(poolName: string): TokenPair {
    const parts = poolName.split('-');
    if (parts.length !== 2) {
        return {
            tokenA: poolName,
            tokenB: '',
            normalized: poolName,
        };
    }

    const [tokenA, tokenB] = parts;
    const normalized = [tokenA, tokenB].sort().join('-');

    return { tokenA, tokenB, normalized };
}

/**
 * Group pools by token pair
 */
export function groupPoolsByPair(pools: readonly Pool[]): Map<string, Pool[]> {
    const groups = new Map<string, Pool[]>();

    for (const pool of pools) {
        const pair = parseTokenPair(pool.name);
        const existing = groups.get(pair.normalized) || [];
        existing.push(pool);
        groups.set(pair.normalized, existing);
    }

    return groups;
}

/**
 * Calculate pool efficiency score (fees per unit of liquidity)
 */
function calculateEfficiency(pool: Pool): number {
    if (pool.liquidity === 0) return 0;

    // Efficiency = daily fees / liquidity
    // Higher is better (more fees per dollar of liquidity)
    return pool.fees24h / pool.liquidity;
}

/**
 * Select best pool from a group of duplicate pairs
 */
function selectBestPool(pools: Pool[]): Pool {
    if (pools.length === 0) throw new Error('No pools to select from');
    if (pools.length === 1) return pools[0];

    // Sort by efficiency (fees/liquidity ratio)
    const sorted = [...pools].sort((a, b) => {
        const effA = calculateEfficiency(a);
        const effB = calculateEfficiency(b);
        return effB - effA; // Descending
    });

    return sorted[0];
}

/**
 * Detect and resolve multi-pool arbitrage opportunities
 * Returns deduplicated list with best pool per pair
 */
export function deduplicatePools(pools: readonly Pool[]): Pool[] {
    const groups = groupPoolsByPair(pools);
    const deduplicated: Pool[] = [];

    for (const [pairName, poolGroup] of groups.entries()) {
        if (poolGroup.length > 1) {
            // Multiple pools for same pair - pick the best one
            const best = selectBestPool(poolGroup);
            deduplicated.push(best);
        } else {
            // Only one pool for this pair
            deduplicated.push(poolGroup[0]);
        }
    }

    return deduplicated;
}

/**
 * Check if a pool is a duplicate of existing positions
 */
export function isDuplicatePair(pool: Pool, existingPools: readonly Pool[]): boolean {
    const newPair = parseTokenPair(pool.name);

    for (const existing of existingPools) {
        const existingPair = parseTokenPair(existing.name);
        if (newPair.normalized === existingPair.normalized) {
            return true;
        }
    }

    return false;
}
