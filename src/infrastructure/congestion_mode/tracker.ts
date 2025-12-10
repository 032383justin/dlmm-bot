/**
 * Congestion Mode - Metrics Tracker
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Collect and aggregate network metrics for congestion detection.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { NetworkMetrics, CongestionSample, CongestionConfig } from './types';
import { DEFAULT_CONFIG } from './config';
import logger from '../../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// SAMPLE STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

const samples: CongestionSample[] = [];
const MAX_SAMPLES = 500;

// Current metrics cache (updated periodically)
let cachedMetrics: NetworkMetrics | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 5000; // 5 seconds

// ═══════════════════════════════════════════════════════════════════════════════
// SAMPLE RECORDING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a transaction confirmation sample
 */
export function recordTxSample(params: {
    confirmationTimeMs?: number;
    success: boolean;
    rpcLatencyMs?: number;
}): void {
    samples.push({
        timestamp: Date.now(),
        confirmationTimeMs: params.confirmationTimeMs,
        txSuccess: params.success,
        rpcLatencyMs: params.rpcLatencyMs,
    });
    
    // Trim old samples
    if (samples.length > MAX_SAMPLES) {
        samples.splice(0, samples.length - MAX_SAMPLES);
    }
    
    // Invalidate cache
    cachedMetrics = null;
}

/**
 * Record RPC latency sample
 */
export function recordRpcLatency(latencyMs: number): void {
    samples.push({
        timestamp: Date.now(),
        txSuccess: true, // RPC latency doesn't represent tx success
        rpcLatencyMs: latencyMs,
    });
    
    if (samples.length > MAX_SAMPLES) {
        samples.splice(0, samples.length - MAX_SAMPLES);
    }
    
    cachedMetrics = null;
}

/**
 * Record blocktime deviation sample
 */
export function recordBlocktimeDeviation(deviation: number): void {
    samples.push({
        timestamp: Date.now(),
        txSuccess: true,
        blocktimeDeviation: deviation,
    });
    
    if (samples.length > MAX_SAMPLES) {
        samples.splice(0, samples.length - MAX_SAMPLES);
    }
    
    cachedMetrics = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get samples within a time window
 */
function getSamplesInWindow(windowMs: number): CongestionSample[] {
    const cutoff = Date.now() - windowMs;
    return samples.filter(s => s.timestamp >= cutoff);
}

/**
 * Compute aggregated network metrics from samples
 */
export function computeNetworkMetrics(
    config: CongestionConfig = DEFAULT_CONFIG
): NetworkMetrics {
    const now = Date.now();
    
    // Return cached metrics if still valid
    if (cachedMetrics && (now - cacheTimestamp) < CACHE_TTL_MS) {
        return cachedMetrics;
    }
    
    const recentSamples = getSamplesInWindow(config.metricsWindowMs);
    
    // Default metrics for no data
    if (recentSamples.length === 0) {
        const defaultMetrics: NetworkMetrics = {
            avgConfirmationTimeMs: config.baselineConfirmationMs,
            failedTxRate: 0,
            blocktimeDeviation: 0,
            pendingSignatureCount: 0,
            rpcLatencyMs: config.baselineRpcLatencyMs,
        };
        cachedMetrics = defaultMetrics;
        cacheTimestamp = now;
        return defaultMetrics;
    }
    
    // Compute average confirmation time
    const confirmationSamples = recentSamples.filter(s => s.confirmationTimeMs !== undefined);
    const avgConfirmationTimeMs = confirmationSamples.length > 0
        ? confirmationSamples.reduce((sum, s) => sum + (s.confirmationTimeMs ?? 0), 0) / confirmationSamples.length
        : config.baselineConfirmationMs;
    
    // Compute failed TX rate
    const txSamples = recentSamples.filter(s => s.confirmationTimeMs !== undefined || !s.txSuccess);
    const failedCount = txSamples.filter(s => !s.txSuccess).length;
    const failedTxRate = txSamples.length > 0
        ? failedCount / txSamples.length
        : 0;
    
    // Compute average blocktime deviation
    const blocktimeSamples = recentSamples.filter(s => s.blocktimeDeviation !== undefined);
    const blocktimeDeviation = blocktimeSamples.length > 0
        ? blocktimeSamples.reduce((sum, s) => sum + (s.blocktimeDeviation ?? 0), 0) / blocktimeSamples.length
        : 0;
    
    // Compute average RPC latency
    const rpcSamples = recentSamples.filter(s => s.rpcLatencyMs !== undefined);
    const rpcLatencyMs = rpcSamples.length > 0
        ? rpcSamples.reduce((sum, s) => sum + (s.rpcLatencyMs ?? 0), 0) / rpcSamples.length
        : config.baselineRpcLatencyMs;
    
    const metrics: NetworkMetrics = {
        avgConfirmationTimeMs,
        failedTxRate,
        blocktimeDeviation,
        pendingSignatureCount: 0, // Would need external source
        rpcLatencyMs,
    };
    
    cachedMetrics = metrics;
    cacheTimestamp = now;
    
    return metrics;
}

/**
 * Update pending signature count (from external source)
 */
export function updatePendingSignatures(count: number): void {
    if (cachedMetrics) {
        cachedMetrics = {
            ...cachedMetrics,
            pendingSignatureCount: count,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clear all samples (for testing or reset)
 */
export function clearSamples(): void {
    samples.length = 0;
    cachedMetrics = null;
    logger.info('[CONGESTION_MODE] Samples cleared');
}

/**
 * Get total sample count
 */
export function getSampleCount(): number {
    return samples.length;
}

/**
 * Get recent failed transaction count
 */
export function getRecentFailedTxCount(windowMs: number = DEFAULT_CONFIG.metricsWindowMs): number {
    const recentSamples = getSamplesInWindow(windowMs);
    return recentSamples.filter(s => !s.txSuccess).length;
}

/**
 * Check if we have sufficient samples for reliable metrics
 */
export function hasSufficientSamples(minSamples: number = 5): boolean {
    return samples.length >= minSamples;
}

