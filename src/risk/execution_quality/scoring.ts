/**
 * Execution Quality Scoring
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Compute composite execution quality score from metrics.
 * 
 * FORMULA:
 * executionQuality = 
 *   (1 - normalizedSlippage) * 0.40 +
 *   (txSuccessRate)          * 0.35 +
 *   (normalizedLatency)      * 0.25
 * 
 * BEHAVIOR:
 * - If executionQuality < 0.35 → block entries
 * - If < 0.50 → reduce position size by 60%
 * - If > 0.80 → allow normal sizing
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { 
    ExecutionMetrics, 
    ExecutionQualityResult, 
    ExecutionQualityConfig 
} from './types';
import { computeExecutionMetrics } from './tracker';
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
 * Normalize slippage to 0-1 scale (higher = worse)
 * Returns value where 0 = baseline (good), 1 = max (bad)
 */
function normalizeSlippage(
    avgSlippageDeviation: number,
    config: ExecutionQualityConfig
): number {
    // If slippage is negative (better than expected), return 0
    if (avgSlippageDeviation <= 0) return 0;
    
    // Normalize between baseline and max
    const range = config.maxSlippage - config.baselineSlippage;
    if (range <= 0) return 0;
    
    const normalized = (avgSlippageDeviation - config.baselineSlippage) / range;
    return clamp01(normalized);
}

/**
 * Normalize latency to 0-1 scale (1 = good, 0 = bad)
 * Inverted because lower latency is better
 */
function normalizeLatency(
    avgLatencyMs: number,
    config: ExecutionQualityConfig
): number {
    // If latency is at or below baseline, return 1 (perfect)
    if (avgLatencyMs <= config.baselineLatencyMs) return 1;
    
    // If latency exceeds max, return 0 (very bad)
    if (avgLatencyMs >= config.maxLatencyMs) return 0;
    
    // Linear interpolation between baseline and max
    const range = config.maxLatencyMs - config.baselineLatencyMs;
    const excess = avgLatencyMs - config.baselineLatencyMs;
    
    // Invert so higher latency = lower score
    return clamp01(1 - (excess / range));
}

/**
 * Determine position multiplier based on quality score
 */
function computePositionMultiplier(
    score: number,
    config: ExecutionQualityConfig
): number {
    // Block entries if quality too low
    if (score < config.blockThreshold) {
        return 0;
    }
    
    // Reduce position size if below reduce threshold
    if (score < config.reduceThreshold) {
        return config.reductionFactor;
    }
    
    // Normal sizing if above normal threshold
    if (score >= config.normalThreshold) {
        return 1.0;
    }
    
    // Linear interpolation between reduce and normal thresholds
    const range = config.normalThreshold - config.reduceThreshold;
    const progress = (score - config.reduceThreshold) / range;
    
    return config.reductionFactor + (progress * (1.0 - config.reductionFactor));
}

/**
 * Generate reason string for quality result
 */
function generateReason(
    score: number,
    metrics: ExecutionMetrics,
    config: ExecutionQualityConfig
): string {
    if (metrics.totalExecutions < config.minExecutionsRequired) {
        return `Insufficient execution data (${metrics.totalExecutions}/${config.minExecutionsRequired} required)`;
    }
    
    if (score < config.blockThreshold) {
        return `BLOCKED: execution quality ${score.toFixed(3)} < ${config.blockThreshold} threshold | ` +
            `txSuccess=${(metrics.txSuccessRate * 100).toFixed(1)}% | ` +
            `avgLatency=${metrics.avgLatencyMs.toFixed(0)}ms | ` +
            `slippage=${(metrics.avgSlippageDeviation * 100).toFixed(2)}%`;
    }
    
    if (score < config.reduceThreshold) {
        return `REDUCED (${(config.reductionFactor * 100).toFixed(0)}%): execution quality ${score.toFixed(3)} | ` +
            `txSuccess=${(metrics.txSuccessRate * 100).toFixed(1)}%`;
    }
    
    if (score >= config.normalThreshold) {
        return `NORMAL: execution quality ${score.toFixed(3)} ≥ ${config.normalThreshold}`;
    }
    
    return `SCALED: execution quality ${score.toFixed(3)} | ` +
        `txSuccess=${(metrics.txSuccessRate * 100).toFixed(1)}%`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCORING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute execution quality score from current metrics
 */
export function computeExecutionQuality(
    config: ExecutionQualityConfig = DEFAULT_CONFIG
): ExecutionQualityResult {
    const metrics = computeExecutionMetrics(config);
    const now = Date.now();
    
    // If insufficient executions, return optimistic score
    if (metrics.totalExecutions < config.minExecutionsRequired) {
        return {
            score: 0.85, // Assume good quality when no data
            blockEntries: false,
            positionMultiplier: 1.0,
            reason: generateReason(0.85, metrics, config),
            metrics,
            timestamp: now,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE COMPOSITE SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Normalize slippage (0 = good, 1 = bad)
    const normalizedSlippage = normalizeSlippage(metrics.avgSlippageDeviation, config);
    
    // Slippage component: (1 - normalizedSlippage) gives higher score for lower slippage
    const slippageComponent = (1 - normalizedSlippage) * config.weights.slippage;
    
    // TX success rate component (already 0-1)
    const successComponent = metrics.txSuccessRate * config.weights.txSuccessRate;
    
    // Latency component (normalized, 1 = good, 0 = bad)
    const normalizedLatency = normalizeLatency(metrics.avgLatencyMs, config);
    const latencyComponent = normalizedLatency * config.weights.latency;
    
    // Sum components
    const rawScore = slippageComponent + successComponent + latencyComponent;
    
    // Clamp final score
    const score = clamp01(rawScore);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DETERMINE BEHAVIOR
    // ═══════════════════════════════════════════════════════════════════════════
    
    const blockEntries = score < config.blockThreshold;
    const positionMultiplier = computePositionMultiplier(score, config);
    const reason = generateReason(score, metrics, config);
    
    // Log if degraded
    if (blockEntries) {
        logger.warn(`[EXECUTION_QUALITY] ⛔ ${reason}`);
    } else if (positionMultiplier < 1.0) {
        logger.info(`[EXECUTION_QUALITY] ⚠️ ${reason}`);
    }
    
    return {
        score,
        blockEntries,
        positionMultiplier,
        reason,
        metrics,
        timestamp: now,
    };
}

/**
 * Quick check if entries should be blocked based on execution quality
 */
export function shouldBlockOnExecutionQuality(
    config: ExecutionQualityConfig = DEFAULT_CONFIG
): boolean {
    const result = computeExecutionQuality(config);
    return result.blockEntries;
}

/**
 * Get position multiplier based on execution quality
 */
export function getExecutionQualityMultiplier(
    config: ExecutionQualityConfig = DEFAULT_CONFIG
): number {
    const result = computeExecutionQuality(config);
    return result.positionMultiplier;
}

