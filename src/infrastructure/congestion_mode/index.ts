/**
 * Congestion Mode Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Detect when Solana network congestion makes trading unreliable.
 * 
 * METRICS COLLECTED:
 * - Average TX confirmation time over last N
 * - Failed TX % global
 * - Blocktime deviation
 * - Pending signature queue
 * - RPC latency
 * 
 * BEHAVIOR:
 * - congestionScore > 0.85 → block trading
 * - congestionScore > 0.70 → halve position size
 * - congestionScore > 0.60 → reduce frequency
 * 
 * INTEGRATION:
 * positionMultiplier *= getCongestionMultiplier(metrics);
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Type exports
export type {
    NetworkMetrics,
    CongestionLevel,
    CongestionResult,
    CongestionConfig,
    CongestionWeights,
    CongestionSample,
} from './types';

// Config exports
export {
    DEFAULT_CONFIG,
    DEFAULT_WEIGHTS,
    CONSERVATIVE_CONFIG,
    createConfig,
} from './config';

// Tracker exports
export {
    recordTxSample,
    recordRpcLatency,
    recordBlocktimeDeviation,
    computeNetworkMetrics,
    updatePendingSignatures,
    clearSamples,
    getSampleCount,
    getRecentFailedTxCount,
    hasSufficientSamples,
} from './tracker';

// Scoring exports
export {
    computeCongestionScore,
    getCongestionMultiplier,
    isCongestionBlocked,
} from './scoring';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

import { NetworkMetrics, CongestionResult } from './types';
import { computeCongestionScore, getCongestionMultiplier as getMultiplier } from './scoring';
import { computeNetworkMetrics, recordTxSample } from './tracker';
import { DEFAULT_CONFIG } from './config';

/**
 * Get the congestion multiplier for position sizing.
 * 
 * This is the primary API for the Congestion Mode module.
 * 
 * @param metrics - Optional network metrics (computed from samples if not provided)
 * @returns Position multiplier between 0 and 1
 * 
 * @example
 * ```typescript
 * // Use with collected samples
 * const multiplier = getCongestionMultiplier();
 * positionSize *= multiplier;
 * 
 * // Use with provided metrics
 * const metrics: NetworkMetrics = {
 *     avgConfirmationTimeMs: 2000,
 *     failedTxRate: 0.25,
 *     // ...
 * };
 * const multiplier = getCongestionMultiplier(metrics);
 * ```
 */
export function getCongestionPositionMultiplier(metrics?: NetworkMetrics): number {
    return getMultiplier(metrics, DEFAULT_CONFIG);
}

/**
 * Get full congestion result with all details
 */
export function getCongestionResult(metrics?: NetworkMetrics): CongestionResult {
    return computeCongestionScore(metrics, DEFAULT_CONFIG);
}

/**
 * Check if trading should be blocked due to congestion
 */
export function shouldBlockOnCongestion(metrics?: NetworkMetrics): boolean {
    const result = computeCongestionScore(metrics, DEFAULT_CONFIG);
    return result.blockTrading;
}

/**
 * Record a successful transaction for congestion tracking
 */
export function recordSuccessfulTx(confirmationTimeMs: number, rpcLatencyMs?: number): void {
    recordTxSample({
        confirmationTimeMs,
        success: true,
        rpcLatencyMs,
    });
}

/**
 * Record a failed transaction for congestion tracking
 */
export function recordFailedTx(rpcLatencyMs?: number): void {
    recordTxSample({
        success: false,
        rpcLatencyMs,
    });
}

/**
 * Get current congestion level as string
 */
export function getCongestionLevel(metrics?: NetworkMetrics): string {
    const result = computeCongestionScore(metrics, DEFAULT_CONFIG);
    return result.level;
}

/**
 * Get current congestion score (0-1)
 */
export function getCongestionScore(metrics?: NetworkMetrics): number {
    const result = computeCongestionScore(metrics, DEFAULT_CONFIG);
    return result.congestionScore;
}

