/**
 * Execution Quality Module - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEFAULT THRESHOLDS AND WEIGHTS
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { ExecutionQualityConfig, ExecutionQualityWeights } from './types';

/**
 * Default weights for execution quality score
 * 
 * Formula:
 * executionQuality = 
 *   (1 - normalizedSlippage) * 0.40 +
 *   (txSuccessRate)          * 0.35 +
 *   (normalizedLatency)      * 0.25
 */
export const DEFAULT_WEIGHTS: ExecutionQualityWeights = {
    slippage: 0.40,
    txSuccessRate: 0.35,
    latency: 0.25,
};

/**
 * Default execution quality configuration
 */
export const DEFAULT_CONFIG: ExecutionQualityConfig = {
    // Score thresholds
    blockThreshold: 0.35,      // If executionQuality < 0.35 → block entries
    reduceThreshold: 0.50,     // If < 0.50 → reduce position size by 60%
    normalThreshold: 0.80,     // If > 0.80 → allow normal sizing
    reductionFactor: 0.40,     // Reduce to 40% (60% reduction)
    
    // Metrics window (15 minutes)
    metricsWindowMs: 15 * 60 * 1000,
    
    // Minimum executions for valid score
    minExecutionsRequired: 3,
    
    // Weights
    weights: DEFAULT_WEIGHTS,
    
    // Latency normalization
    baselineLatencyMs: 500,    // 500ms is "good"
    maxLatencyMs: 10000,       // 10s is "very bad"
    
    // Slippage normalization
    baselineSlippage: 0.005,   // 0.5% slippage is "good"
    maxSlippage: 0.10,         // 10% slippage is "very bad"
};

/**
 * Create a custom config with overrides
 */
export function createConfig(overrides: Partial<ExecutionQualityConfig>): ExecutionQualityConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
        weights: {
            ...DEFAULT_CONFIG.weights,
            ...(overrides.weights ?? {}),
        },
    };
}

