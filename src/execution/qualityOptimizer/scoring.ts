/**
 * Execution Quality Optimizer - Scoring
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Computes execution quality score and sizing recommendations.
 * 
 * SCORING FORMULA:
 * executionQuality = 
 *   (1 - normalizedSlippage) * 0.40 +
 *   (txSuccessRate)          * 0.35 +
 *   (normalizedLatency)      * 0.25
 * 
 * SIZING RULES:
 * - score < 0.35  → BLOCK (multiplier = 0)
 * - score 0.35-0.50 → REDUCE_60 (multiplier = 0.40)
 * - score > 0.80  → NORMAL (multiplier = 1.0)
 * - else → INTERPOLATE (multiplier = score)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
    ExecutionMetrics,
    ExecutionQualityScore,
    ExecutionQualityConfig,
} from './types';
import { DEFAULT_CONFIG } from './config';
import { computeMetrics } from './tracker';

/**
 * Normalize a value to 0-1 range
 */
function normalize(value: number, excellent: number, poor: number): number {
    if (value <= excellent) return 1;
    if (value >= poor) return 0;
    return 1 - (value - excellent) / (poor - excellent);
}

/**
 * Compute execution quality score from metrics
 */
export function computeExecutionQualityScore(
    metrics?: ExecutionMetrics,
    config: ExecutionQualityConfig = DEFAULT_CONFIG
): ExecutionQualityScore {
    const now = Date.now();
    const actualMetrics = metrics ?? computeMetrics(config.metricsWindowMs);
    
    // If insufficient data, return default score
    if (actualMetrics.totalTx < config.minTransactionsForScoring) {
        return {
            score: config.defaultScore,
            blockEntries: false,
            positionMultiplier: config.defaultScore,
            sizingAction: 'NORMAL',
            metrics: actualMetrics,
            scoreBreakdown: {
                slippageComponent: 1,
                successRateComponent: 1,
                latencyComponent: 1,
            },
            reason: `Insufficient data (${actualMetrics.totalTx}/${config.minTransactionsForScoring} transactions), using default score`,
            timestamp: now,
        };
    }
    
    // Normalize slippage (lower is better)
    const slippageNorm = normalize(
        actualMetrics.avgSlippage,
        config.slippageNormalization.excellentPct,
        config.slippageNormalization.poorPct
    );
    
    // Success rate is already 0-1
    const successNorm = actualMetrics.txSuccessRate;
    
    // Normalize latency (lower is better)
    const latencyNorm = normalize(
        actualMetrics.avgConfirmationLatencyMs,
        config.latencyNormalization.excellentMs,
        config.latencyNormalization.poorMs
    );
    
    // Compute weighted score
    const score = 
        slippageNorm * config.weights.slippage +
        successNorm * config.weights.successRate +
        latencyNorm * config.weights.latency;
    
    // Determine sizing action
    let sizingAction: 'BLOCK' | 'REDUCE_60' | 'NORMAL';
    let positionMultiplier: number;
    let blockEntries: boolean;
    let reason: string;
    
    if (score < config.thresholds.blockThreshold) {
        sizingAction = 'BLOCK';
        positionMultiplier = 0;
        blockEntries = true;
        reason = `Execution quality ${(score * 100).toFixed(1)}% < ${(config.thresholds.blockThreshold * 100).toFixed(0)}% block threshold`;
    } else if (score < config.thresholds.reducedThreshold) {
        sizingAction = 'REDUCE_60';
        positionMultiplier = 0.40; // Reduce size by 60%
        blockEntries = false;
        reason = `Execution quality ${(score * 100).toFixed(1)}% in reduced zone (${(config.thresholds.blockThreshold * 100).toFixed(0)}%-${(config.thresholds.reducedThreshold * 100).toFixed(0)}%)`;
    } else if (score >= config.thresholds.normalThreshold) {
        sizingAction = 'NORMAL';
        positionMultiplier = 1.0;
        blockEntries = false;
        reason = `Execution quality ${(score * 100).toFixed(1)}% >= ${(config.thresholds.normalThreshold * 100).toFixed(0)}% normal threshold`;
    } else {
        // Interpolate between reduced and normal
        sizingAction = 'NORMAL';
        positionMultiplier = score; // Use score directly as multiplier
        blockEntries = false;
        reason = `Execution quality ${(score * 100).toFixed(1)}% interpolated`;
    }
    
    return {
        score,
        blockEntries,
        positionMultiplier,
        sizingAction,
        metrics: actualMetrics,
        scoreBreakdown: {
            slippageComponent: slippageNorm,
            successRateComponent: successNorm,
            latencyComponent: latencyNorm,
        },
        reason,
        timestamp: now,
    };
}

/**
 * Check if entries should be blocked based on execution quality
 */
export function shouldBlockOnExecutionQuality(
    config: ExecutionQualityConfig = DEFAULT_CONFIG
): boolean {
    const result = computeExecutionQualityScore(undefined, config);
    return result.blockEntries;
}

/**
 * Get execution quality multiplier for position sizing
 */
export function getExecutionQualityMultiplier(
    config: ExecutionQualityConfig = DEFAULT_CONFIG
): number {
    const result = computeExecutionQualityScore(undefined, config);
    return result.positionMultiplier;
}

/**
 * Get the raw execution quality score (0-1)
 */
export function getExecutionQualityScoreValue(
    config: ExecutionQualityConfig = DEFAULT_CONFIG
): number {
    const result = computeExecutionQualityScore(undefined, config);
    return result.score;
}

