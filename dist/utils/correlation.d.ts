import { Pool } from '../core/normalizePools';
/**
 * Calculate price movement correlation between two pools
 * Uses velocity (volume) as proxy for price movement
 */
export declare function calculatePoolCorrelation(poolA: Pool, poolB: Pool, historicalData?: Map<string, number[]>): number;
/**
 * Check if a new pool is highly correlated with existing positions
 */
export declare function isHighlyCorrelated(newPool: Pool, existingPools: readonly Pool[], threshold?: number, historicalData?: Map<string, number[]>): boolean;
/**
 * Find pools that are not correlated with existing positions
 */
export declare function filterUncorrelatedPools(candidates: readonly Pool[], existingPools: readonly Pool[], threshold?: number, historicalData?: Map<string, number[]>): Pool[];
//# sourceMappingURL=correlation.d.ts.map