/**
 * Execution Quality Optimizer Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Track realized execution quality and adapt position sizing.
 * 
 * METRICS TRACKED:
 * - Realized slippage
 * - TX success rate
 * - Confirmation latency
 * - Failed TX rate
 * 
 * SCORING:
 * executionQuality = 
 *   (1 - normalizedSlippage) * 0.40 +
 *   (txSuccessRate)          * 0.35 +
 *   (normalizedLatency)      * 0.25
 * 
 * BEHAVIOR:
 * - If executionQuality < 0.35 → block new entries
 * - If 0.35-0.50 → reduce size by 60%
 * - If > 0.80 → allow normal sizing
 * 
 * Multiply entry sizing by executionQuality
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Type exports
export type {
    ExecutionRecord,
    ExecutionMetrics,
    ExecutionQualityScore,
    ExecutionQualityConfig,
    PoolExecutionQuality,
    ExecutionQualityState,
} from './types';

// Config exports
export {
    DEFAULT_CONFIG,
    AGGRESSIVE_CONFIG,
    CONSERVATIVE_CONFIG,
    createConfig,
} from './config';

// Tracker exports
export {
    recordExecution,
    recordSuccessfulTx,
    recordFailedTx,
    computeMetrics,
    getRecordsInWindow,
    getPoolExecutionQuality,
    getAllPoolQualities,
    getRecordCount,
    getRecentFailedCount,
    clearAllRecords,
} from './tracker';

// Scoring exports
export {
    computeExecutionQualityScore,
    shouldBlockOnExecutionQuality,
    getExecutionQualityMultiplier,
    getExecutionQualityScoreValue,
} from './scoring';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

import { computeExecutionQualityScore, getExecutionQualityMultiplier as getMultiplier } from './scoring';
import { getPoolExecutionQuality } from './tracker';
import { ExecutionQualityScore, PoolExecutionQuality } from './types';
import { DEFAULT_CONFIG } from './config';

/**
 * Get current execution quality result.
 * This is the primary API for the Execution Quality Optimizer.
 */
export function getExecutionQuality(): ExecutionQualityScore {
    return computeExecutionQualityScore(undefined, DEFAULT_CONFIG);
}

/**
 * Get execution quality multiplier for position sizing.
 * Returns 0 if blocked, 0.40 if reduced, up to 1.0 for normal.
 */
export function getExecutionQualityPositionMultiplier(): number {
    return getMultiplier(DEFAULT_CONFIG);
}

/**
 * Check if entries should be blocked due to poor execution quality.
 */
export function isExecutionQualityBlocked(): boolean {
    const result = computeExecutionQualityScore(undefined, DEFAULT_CONFIG);
    return result.blockEntries;
}

/**
 * Get pool-specific execution quality score (0-1).
 * Returns undefined if no data for this pool.
 */
export function getPoolQuality(poolAddress: string): number | undefined {
    const quality = getPoolExecutionQuality(poolAddress);
    return quality?.score;
}

/**
 * Get pool-specific execution quality details.
 */
export function getPoolQualityDetails(poolAddress: string): PoolExecutionQuality | undefined {
    return getPoolExecutionQuality(poolAddress);
}

/**
 * Determine if a specific pool should be penalized based on its execution history.
 * Returns a multiplier (0-1) to apply to position sizing.
 */
export function getPoolExecutionMultiplier(poolAddress: string): number {
    const quality = getPoolExecutionQuality(poolAddress);
    
    if (!quality) {
        return 1.0; // No data = no penalty
    }
    
    // Pool-specific penalty based on its success rate and slippage
    // Higher slippage or lower success = lower multiplier
    const slippagePenalty = Math.max(0, 1 - quality.avgSlippage * 25); // 4% slippage = 0 multiplier
    const successPenalty = quality.successRate;
    
    return Math.min(1, slippagePenalty * successPenalty);
}

