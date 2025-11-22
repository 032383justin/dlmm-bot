import { Pool } from '../core/normalizePools';
/**
 * Group pools by token pair
 */
export declare function groupPoolsByPair(pools: readonly Pool[]): Map<string, Pool[]>;
/**
 * Detect and resolve multi-pool arbitrage opportunities
 * Returns deduplicated list with best pool per pair
 */
export declare function deduplicatePools(pools: readonly Pool[]): Pool[];
/**
 * Check if a pool is a duplicate of existing positions
 */
export declare function isDuplicatePair(pool: Pool, existingPools: readonly Pool[]): boolean;
//# sourceMappingURL=arbitrage.d.ts.map