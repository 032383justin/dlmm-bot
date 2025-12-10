/**
 * Execution Quality Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Measure live execution quality using recent trades and apply a penalty
 * multiplier to position sizing and entry permission.
 * 
 * METRICS TRACKED:
 * - Realized slippage vs expected
 * - TX success rate
 * - TX latency / confirmation time
 * - Execution attempts per entry
 * - Failed or reverted transactions
 * - Fill price deviation
 * 
 * SCORE CALCULATION:
 * executionQuality = 
 *   (1 - normalizedSlippage) * 0.40 +
 *   (txSuccessRate)          * 0.35 +
 *   (normalizedLatency)      * 0.25
 * 
 * BEHAVIOR:
 * - If executionQuality < 0.35 → block entries
 * - If < 0.50 → reduce position size by 60%
 * - If > 0.80 → allow normal sizing
 * 
 * INTEGRATION:
 * executionQuality becomes an argument into getPositionMultiplier()
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Type exports
export type {
    ExecutionEvent,
    ExecutionMetrics,
    ExecutionQualityResult,
    ExecutionQualityConfig,
    ExecutionQualityWeights,
    TradingStateWithExecution,
} from './types';

// Config exports
export {
    DEFAULT_CONFIG,
    DEFAULT_WEIGHTS,
    createConfig,
} from './config';

// Tracker exports
export {
    recordExecutionEvent,
    recordSuccessfulExecution,
    recordFailedExecution,
    computeExecutionMetrics,
    getEventsInWindow,
    clearExecutionEvents,
    getEventCount,
    getRecentFailures,
} from './tracker';

// Scoring exports
export {
    computeExecutionQuality,
    shouldBlockOnExecutionQuality,
    getExecutionQualityMultiplier,
} from './scoring';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API - getExecutionQuality
// ═══════════════════════════════════════════════════════════════════════════════

import { TradingState } from '../adaptive_sizing/types';
import { computeExecutionQuality } from './scoring';

/**
 * Get the execution quality score for the current trading state.
 * 
 * This is the primary API for the Execution Quality module.
 * 
 * @param state - Current trading state (for context, not currently used for scoring)
 * @returns Execution quality score between 0 and 1
 * 
 * @example
 * ```typescript
 * const state: TradingState = { ... };
 * const quality = getExecutionQuality(state);
 * 
 * if (quality < 0.35) {
 *     // Block entries
 *     return;
 * }
 * 
 * if (quality < 0.50) {
 *     // Reduce position size by 60%
 *     positionSize *= 0.40;
 * }
 * ```
 */
export function getExecutionQuality(state: TradingState): number {
    // State is passed for future use (e.g., per-pool quality tracking)
    // Currently we compute global execution quality
    const result = computeExecutionQuality();
    return result.score;
}

/**
 * Get full execution quality result with metrics and reasoning
 */
export function getExecutionQualityResult(state?: TradingState) {
    return computeExecutionQuality();
}

/**
 * Check if entries should be blocked due to poor execution quality
 */
export function isExecutionQualityBlocked(state?: TradingState): boolean {
    const result = computeExecutionQuality();
    return result.blockEntries;
}

/**
 * Get execution quality position multiplier
 * Returns 0 if blocked, 0.40 if reduced, 1.0 if normal
 */
export function getExecutionQualityPositionMultiplier(state?: TradingState): number {
    const result = computeExecutionQuality();
    return result.positionMultiplier;
}

