/**
 * Congestion Mode - Scoring Logic
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Compute congestion score from network metrics.
 * 
 * BEHAVIOR:
 * - congestionScore > 0.85 → block trading
 * - congestionScore > 0.70 → halve position size
 * - congestionScore > 0.60 → reduce frequency
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { 
    NetworkMetrics, 
    CongestionResult, 
    CongestionLevel,
    CongestionConfig 
} from './types';
import { computeNetworkMetrics } from './tracker';
import { DEFAULT_CONFIG } from './config';
import logger from '../../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp a value between 0 and 1
 */
function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/**
 * Normalize a value to 0-1 scale
 */
function normalize(value: number, baseline: number, max: number): number {
    if (value <= baseline) return 0;
    if (value >= max) return 1;
    return (value - baseline) / (max - baseline);
}

/**
 * Determine congestion level from score
 */
function getCongestionLevel(score: number, config: CongestionConfig): CongestionLevel {
    if (score >= config.blockThreshold) return 'severe';
    if (score >= config.halfPositionThreshold) return 'high';
    if (score >= config.reduceFrequencyThreshold) return 'elevated';
    return 'normal';
}

/**
 * Compute position multiplier from congestion score
 */
function computePositionMultiplier(score: number, config: CongestionConfig): number {
    if (score >= config.blockThreshold) return 0;
    if (score >= config.halfPositionThreshold) return 0.5;
    if (score >= config.reduceFrequencyThreshold) {
        // Linear interpolation between 0.5 and 1.0
        const range = config.halfPositionThreshold - config.reduceFrequencyThreshold;
        const progress = (config.halfPositionThreshold - score) / range;
        return 0.5 + (progress * 0.5);
    }
    return 1.0;
}

/**
 * Compute frequency multiplier from congestion score
 */
function computeFrequencyMultiplier(score: number, config: CongestionConfig): number {
    if (score >= config.blockThreshold) return 0;
    if (score >= config.halfPositionThreshold) return 0.5;
    if (score >= config.reduceFrequencyThreshold) return 0.75;
    return 1.0;
}

/**
 * Generate reason string
 */
function generateReason(
    score: number,
    level: CongestionLevel,
    metrics: NetworkMetrics,
    config: CongestionConfig
): string {
    const parts: string[] = [];
    
    // Add level indicator
    switch (level) {
        case 'severe':
            parts.push('SEVERE CONGESTION');
            break;
        case 'high':
            parts.push('HIGH CONGESTION');
            break;
        case 'elevated':
            parts.push('ELEVATED CONGESTION');
            break;
        default:
            parts.push('NORMAL');
    }
    
    // Add score
    parts.push(`score=${(score * 100).toFixed(1)}%`);
    
    // Add key metrics
    if (metrics.failedTxRate > 0.1) {
        parts.push(`failRate=${(metrics.failedTxRate * 100).toFixed(1)}%`);
    }
    
    if (metrics.avgConfirmationTimeMs > config.baselineConfirmationMs * 2) {
        parts.push(`confirmTime=${metrics.avgConfirmationTimeMs.toFixed(0)}ms`);
    }
    
    if (metrics.rpcLatencyMs > config.baselineRpcLatencyMs * 2) {
        parts.push(`rpcLatency=${metrics.rpcLatencyMs.toFixed(0)}ms`);
    }
    
    return parts.join(' | ');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCORING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute congestion score and determine trading behavior
 */
export function computeCongestionScore(
    metrics?: NetworkMetrics,
    config: CongestionConfig = DEFAULT_CONFIG
): CongestionResult {
    const now = Date.now();
    
    // Get metrics if not provided
    const effectiveMetrics = metrics ?? computeNetworkMetrics(config);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // NORMALIZE INDIVIDUAL METRICS
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Confirmation time (higher = worse)
    const normalizedConfirmation = normalize(
        effectiveMetrics.avgConfirmationTimeMs,
        config.baselineConfirmationMs,
        config.maxConfirmationMs
    );
    
    // Failed TX rate (already 0-1)
    const normalizedFailRate = clamp01(effectiveMetrics.failedTxRate);
    
    // Blocktime deviation
    const normalizedBlocktime = normalize(
        effectiveMetrics.blocktimeDeviation,
        config.baselineBlocktimeDeviation,
        config.maxBlocktimeDeviation
    );
    
    // Pending signatures
    const normalizedPending = clamp01(
        effectiveMetrics.pendingSignatureCount / config.pendingSignatureCritical
    );
    
    // RPC latency
    const normalizedRpc = normalize(
        effectiveMetrics.rpcLatencyMs,
        config.baselineRpcLatencyMs,
        config.maxRpcLatencyMs
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE WEIGHTED SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    
    const { weights } = config;
    
    const score = clamp01(
        (normalizedConfirmation * weights.confirmationTime) +
        (normalizedFailRate * weights.failedTxRate) +
        (normalizedBlocktime * weights.blocktimeDeviation) +
        (normalizedPending * weights.pendingSignatures) +
        (normalizedRpc * weights.rpcLatency)
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DETERMINE BEHAVIOR
    // ═══════════════════════════════════════════════════════════════════════════
    
    const level = getCongestionLevel(score, config);
    const positionMultiplier = computePositionMultiplier(score, config);
    const frequencyMultiplier = computeFrequencyMultiplier(score, config);
    
    const blockTrading = score >= config.blockThreshold;
    const reducePositions = score >= config.halfPositionThreshold;
    const reduceFrequency = score >= config.reduceFrequencyThreshold;
    
    const reason = generateReason(score, level, effectiveMetrics, config);
    
    // Log if congested
    if (blockTrading) {
        logger.warn(`[CONGESTION_MODE] ⛔ ${reason}`);
    } else if (reducePositions) {
        logger.info(`[CONGESTION_MODE] ⚠️ ${reason}`);
    } else if (reduceFrequency) {
        logger.debug(`[CONGESTION_MODE] 📊 ${reason}`);
    }
    
    return {
        congestionScore: score,
        level,
        positionMultiplier,
        frequencyMultiplier,
        blockTrading,
        reducePositions,
        reduceFrequency,
        reason,
        metrics: effectiveMetrics,
        timestamp: now,
    };
}

/**
 * Get the congestion multiplier for position sizing
 * This is the main integration point for position sizing.
 */
export function getCongestionMultiplier(
    metrics?: NetworkMetrics,
    config: CongestionConfig = DEFAULT_CONFIG
): number {
    const result = computeCongestionScore(metrics, config);
    return result.positionMultiplier;
}

/**
 * Check if trading should be blocked due to congestion
 */
export function isCongestionBlocked(
    metrics?: NetworkMetrics,
    config: CongestionConfig = DEFAULT_CONFIG
): boolean {
    const result = computeCongestionScore(metrics, config);
    return result.blockTrading;
}

