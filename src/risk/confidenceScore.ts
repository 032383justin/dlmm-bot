/**
 * Confidence Score Calculator — Deterministic Metrics-Based Confidence
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 5 PRODUCTION CONFIDENCE SCORING (NO ML)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Computes a confidence score from the last N minutes of internal metrics.
 * Used to unlock higher deployment caps when conditions are favorable.
 * 
 * INPUTS (normalized 0-1):
 *   - exitSuppressionRate: Higher = better (bot avoids churn)
 *   - forcedExitRate: Lower = better
 *   - avgHealthScore: Higher = better
 *   - pnlStability: Lower variance = better
 *   - marketHealth: From kill switch (0-100)
 *   - aliveRatio: From kill switch (0-1)
 *   - dataQuality: RPC/API error rate
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { ConfidenceInputs, CONFIDENCE_WEIGHTS, CAPITAL_CONFIG } from './capitalManager';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

interface MetricsSample {
    timestamp: number;
    
    // Exit metrics
    exitTriggeredCount: number;
    exitSuppressedCount: number;
    exitExecutedCount: number;
    forcedExitCount: number;
    
    // Health metrics
    positionHealthScores: number[];
    
    // PnL metrics
    unrealizedPnlUsd: number;
    
    // Market metrics
    marketHealth: number;
    aliveRatio: number;
    
    // Data quality
    rpcErrors: number;
    apiErrors: number;
    totalRequests: number;
}

const metricsHistory: MetricsSample[] = [];
const METRICS_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_SAMPLES = 360; // 10-second intervals for 1 hour

// Current cycle accumulators
let currentCycleSample: Partial<MetricsSample> = {};
let cycleStartTime = Date.now();

// ═══════════════════════════════════════════════════════════════════════════════
// SAMPLE RECORDING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record exit triggered event
 */
export function recordExitTriggered(): void {
    currentCycleSample.exitTriggeredCount = (currentCycleSample.exitTriggeredCount || 0) + 1;
}

/**
 * Record exit suppressed event
 */
export function recordExitSuppressed(): void {
    currentCycleSample.exitSuppressedCount = (currentCycleSample.exitSuppressedCount || 0) + 1;
}

/**
 * Record exit executed event
 */
export function recordExitExecuted(): void {
    currentCycleSample.exitExecutedCount = (currentCycleSample.exitExecutedCount || 0) + 1;
}

/**
 * Record forced exit event
 */
export function recordForcedExit(): void {
    currentCycleSample.forcedExitCount = (currentCycleSample.forcedExitCount || 0) + 1;
}

/**
 * Record position health score
 */
export function recordPositionHealth(healthScore: number): void {
    if (!currentCycleSample.positionHealthScores) {
        currentCycleSample.positionHealthScores = [];
    }
    currentCycleSample.positionHealthScores.push(healthScore);
}

/**
 * Record unrealized PnL
 */
export function recordUnrealizedPnl(pnlUsd: number): void {
    currentCycleSample.unrealizedPnlUsd = pnlUsd;
}

/**
 * Record market metrics from kill switch
 */
export function recordMarketMetrics(marketHealth: number, aliveRatio: number): void {
    currentCycleSample.marketHealth = marketHealth;
    currentCycleSample.aliveRatio = aliveRatio;
}

/**
 * Record RPC error
 */
export function recordRpcError(): void {
    currentCycleSample.rpcErrors = (currentCycleSample.rpcErrors || 0) + 1;
}

/**
 * Record API error
 */
export function recordApiError(): void {
    currentCycleSample.apiErrors = (currentCycleSample.apiErrors || 0) + 1;
}

/**
 * Record successful request
 */
export function recordSuccessfulRequest(): void {
    currentCycleSample.totalRequests = (currentCycleSample.totalRequests || 0) + 1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Complete current cycle and store sample
 * Call this at the end of each scan loop cycle
 */
export function completeCycle(): void {
    const now = Date.now();
    
    // Build complete sample
    const sample: MetricsSample = {
        timestamp: now,
        exitTriggeredCount: currentCycleSample.exitTriggeredCount || 0,
        exitSuppressedCount: currentCycleSample.exitSuppressedCount || 0,
        exitExecutedCount: currentCycleSample.exitExecutedCount || 0,
        forcedExitCount: currentCycleSample.forcedExitCount || 0,
        positionHealthScores: currentCycleSample.positionHealthScores || [],
        unrealizedPnlUsd: currentCycleSample.unrealizedPnlUsd || 0,
        marketHealth: currentCycleSample.marketHealth || 50,
        aliveRatio: currentCycleSample.aliveRatio || 0.5,
        rpcErrors: currentCycleSample.rpcErrors || 0,
        apiErrors: currentCycleSample.apiErrors || 0,
        totalRequests: currentCycleSample.totalRequests || 1,
    };
    
    metricsHistory.push(sample);
    
    // Prune old samples
    while (metricsHistory.length > MAX_SAMPLES) {
        metricsHistory.shift();
    }
    
    // Reset for next cycle
    currentCycleSample = {};
    cycleStartTime = now;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute confidence inputs from metrics history
 */
export function computeConfidenceInputs(windowMs?: number): ConfidenceInputs {
    const now = Date.now();
    const window = windowMs ?? CAPITAL_CONFIG.CONFIDENCE_WINDOW_MS;
    const cutoff = now - window;
    
    // Filter to window
    const samples = metricsHistory.filter(s => s.timestamp >= cutoff);
    
    if (samples.length === 0) {
        // No data — return neutral
        return {
            exitSuppressionRate: 0.5,
            forcedExitRate: 0.5,
            avgHealthScore: 0.5,
            pnlStabilityInverse: 0.5,
            marketHealth: 50,
            aliveRatio: 0.5,
            dataQuality: 0.9,
        };
    }
    
    // Aggregate metrics
    let totalExitTriggered = 0;
    let totalExitSuppressed = 0;
    let totalExitExecuted = 0;
    let totalForcedExit = 0;
    const allHealthScores: number[] = [];
    const pnlValues: number[] = [];
    let sumMarketHealth = 0;
    let sumAliveRatio = 0;
    let totalRpcErrors = 0;
    let totalApiErrors = 0;
    let totalRequests = 0;
    
    for (const sample of samples) {
        totalExitTriggered += sample.exitTriggeredCount;
        totalExitSuppressed += sample.exitSuppressedCount;
        totalExitExecuted += sample.exitExecutedCount;
        totalForcedExit += sample.forcedExitCount;
        allHealthScores.push(...sample.positionHealthScores);
        pnlValues.push(sample.unrealizedPnlUsd);
        sumMarketHealth += sample.marketHealth;
        sumAliveRatio += sample.aliveRatio;
        totalRpcErrors += sample.rpcErrors;
        totalApiErrors += sample.apiErrors;
        totalRequests += sample.totalRequests;
    }
    
    // Calculate exit suppression rate (higher = better)
    // exitSuppressionRate = suppressed / triggered
    const exitSuppressionRate = totalExitTriggered > 0 
        ? Math.min(1, totalExitSuppressed / totalExitTriggered)
        : 0.8; // Default high if no exits triggered
    
    // Calculate forced exit rate (lower = better)
    // forcedExitRate = forced / total exits
    const totalExits = totalExitExecuted + totalForcedExit;
    const forcedExitRate = totalExits > 0 
        ? totalForcedExit / totalExits
        : 0; // Default 0 if no exits
    
    // Calculate average health score (higher = better)
    const avgHealthScore = allHealthScores.length > 0
        ? allHealthScores.reduce((a, b) => a + b, 0) / allHealthScores.length
        : 0.5;
    
    // Calculate PnL stability (lower variance = better)
    // Convert to 0-1 where higher = more stable
    let pnlStabilityInverse = 0.5;
    if (pnlValues.length >= 3) {
        const mean = pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length;
        const variance = pnlValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / pnlValues.length;
        const stdDev = Math.sqrt(variance);
        // Normalize: stdDev of $10 = 1.0, stdDev of $100 = 0.1
        // Cap at reasonable range
        const normalizedStdDev = Math.min(1, stdDev / 100);
        pnlStabilityInverse = 1 - normalizedStdDev;
    }
    
    // Average market health
    const marketHealth = samples.length > 0 
        ? sumMarketHealth / samples.length 
        : 50;
    
    // Average alive ratio
    const aliveRatio = samples.length > 0 
        ? sumAliveRatio / samples.length 
        : 0.5;
    
    // Data quality (fewer errors = better)
    const totalErrors = totalRpcErrors + totalApiErrors;
    const dataQuality = totalRequests > 0 
        ? Math.max(0, 1 - (totalErrors / totalRequests))
        : 0.9;
    
    return {
        exitSuppressionRate,
        forcedExitRate,
        avgHealthScore,
        pnlStabilityInverse,
        marketHealth,
        aliveRatio,
        dataQuality,
    };
}

/**
 * Compute single confidence score (0-1)
 */
export function computeConfidenceScore(inputs?: ConfidenceInputs): number {
    const i = inputs ?? computeConfidenceInputs();
    
    let score = 0;
    score += CONFIDENCE_WEIGHTS.exitSuppressionRate * i.exitSuppressionRate;
    score += CONFIDENCE_WEIGHTS.forcedExitRate * (1 - i.forcedExitRate);
    score += CONFIDENCE_WEIGHTS.avgHealthScore * i.avgHealthScore;
    score += CONFIDENCE_WEIGHTS.pnlStability * i.pnlStabilityInverse;
    score += CONFIDENCE_WEIGHTS.marketHealth * (i.marketHealth / 100);
    score += CONFIDENCE_WEIGHTS.aliveRatio * i.aliveRatio;
    score += CONFIDENCE_WEIGHTS.dataQuality * i.dataQuality;
    
    return Math.min(1, Math.max(0, score));
}

/**
 * Check if conditions are met to unlock max capacity
 */
export function checkUnlockConditions(inputs?: ConfidenceInputs): {
    unlocked: boolean;
    failedConditions: string[];
} {
    const i = inputs ?? computeConfidenceInputs();
    const config = CAPITAL_CONFIG;
    const failedConditions: string[] = [];
    
    if (i.marketHealth < config.UNLOCK_MIN_MARKET_HEALTH) {
        failedConditions.push(`marketHealth ${i.marketHealth.toFixed(1)} < ${config.UNLOCK_MIN_MARKET_HEALTH}`);
    }
    
    if (i.aliveRatio < config.UNLOCK_MIN_ALIVE_RATIO) {
        failedConditions.push(`aliveRatio ${(i.aliveRatio * 100).toFixed(1)}% < ${config.UNLOCK_MIN_ALIVE_RATIO * 100}%`);
    }
    
    if (i.forcedExitRate > config.UNLOCK_MAX_FORCED_EXIT_RATE) {
        failedConditions.push(`forcedExitRate ${(i.forcedExitRate * 100).toFixed(1)}% > ${config.UNLOCK_MAX_FORCED_EXIT_RATE * 100}%`);
    }
    
    if (i.exitSuppressionRate < config.UNLOCK_MIN_EXIT_SUPPRESSION_RATE) {
        failedConditions.push(`exitSuppressionRate ${(i.exitSuppressionRate * 100).toFixed(1)}% < ${config.UNLOCK_MIN_EXIT_SUPPRESSION_RATE * 100}%`);
    }
    
    if (i.avgHealthScore < config.UNLOCK_MIN_AVG_HEALTH_SCORE) {
        failedConditions.push(`avgHealthScore ${(i.avgHealthScore * 100).toFixed(1)}% < ${config.UNLOCK_MIN_AVG_HEALTH_SCORE * 100}%`);
    }
    
    return {
        unlocked: failedConditions.length === 0,
        failedConditions,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log confidence score breakdown
 */
export function logConfidenceBreakdown(): void {
    const inputs = computeConfidenceInputs();
    const score = computeConfidenceScore(inputs);
    const unlock = checkUnlockConditions(inputs);
    
    logger.info(
        `[CONFIDENCE] score=${(score * 100).toFixed(0)}% ` +
        `exitSuppress=${(inputs.exitSuppressionRate * 100).toFixed(0)}% ` +
        `forcedExit=${(inputs.forcedExitRate * 100).toFixed(0)}% ` +
        `health=${(inputs.avgHealthScore * 100).toFixed(0)}% ` +
        `mktHealth=${inputs.marketHealth.toFixed(0)} ` +
        `aliveRatio=${(inputs.aliveRatio * 100).toFixed(0)}% ` +
        `dataQuality=${(inputs.dataQuality * 100).toFixed(0)}% ` +
        `unlocked=${unlock.unlocked}`
    );
    
    if (!unlock.unlocked && unlock.failedConditions.length > 0) {
        logger.debug(`[CONFIDENCE] Unlock blocked: ${unlock.failedConditions.join(' | ')}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get metrics history length
 */
export function getMetricsHistoryLength(): number {
    return metricsHistory.length;
}

/**
 * Reset all state (for testing)
 */
export function resetConfidenceState(): void {
    metricsHistory.length = 0;
    currentCycleSample = {};
    cycleStartTime = Date.now();
}

/**
 * Get summary stats
 */
export function getConfidenceSummary(): {
    samplesCount: number;
    windowMs: number;
    score: number;
    unlocked: boolean;
} {
    const inputs = computeConfidenceInputs();
    const unlock = checkUnlockConditions(inputs);
    
    return {
        samplesCount: metricsHistory.length,
        windowMs: CAPITAL_CONFIG.CONFIDENCE_WINDOW_MS,
        score: computeConfidenceScore(inputs),
        unlocked: unlock.unlocked,
    };
}

