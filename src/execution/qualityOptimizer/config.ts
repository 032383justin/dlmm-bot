/**
 * Execution Quality Optimizer - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Configurable thresholds and weights for execution quality scoring.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { ExecutionQualityConfig } from './types';

/**
 * Default configuration for execution quality optimizer
 */
export const DEFAULT_CONFIG: ExecutionQualityConfig = {
    // Time window for metrics calculation (30 minutes)
    metricsWindowMs: 30 * 60 * 1000,
    
    // Minimum transactions required for valid scoring
    minTransactionsForScoring: 3,
    
    // Default score when insufficient data (assume decent quality)
    defaultScore: 0.75,
    
    // Score thresholds
    thresholds: {
        // Below 0.35 → block entries
        blockThreshold: 0.35,
        
        // Between 0.35 and 0.50 → reduce size by 60%
        reducedThreshold: 0.50,
        
        // Above 0.80 → allow normal sizing
        normalThreshold: 0.80,
    },
    
    // Component weights for score calculation
    weights: {
        slippage: 0.40,        // 40% weight on slippage control
        successRate: 0.35,     // 35% weight on TX success
        latency: 0.25,         // 25% weight on confirmation speed
    },
    
    // Latency normalization (ms)
    latencyNormalization: {
        excellentMs: 500,      // Under 500ms is excellent
        poorMs: 5000,          // Over 5 seconds is poor
    },
    
    // Slippage normalization
    slippageNormalization: {
        excellentPct: 0.001,   // Under 0.1% is excellent
        poorPct: 0.02,         // Over 2% is poor
    },
};

/**
 * Aggressive configuration for volatile conditions
 */
export const AGGRESSIVE_CONFIG: ExecutionQualityConfig = {
    ...DEFAULT_CONFIG,
    
    metricsWindowMs: 15 * 60 * 1000,  // Shorter window
    
    thresholds: {
        blockThreshold: 0.25,          // More lenient block
        reducedThreshold: 0.40,
        normalThreshold: 0.70,
    },
    
    slippageNormalization: {
        excellentPct: 0.002,           // Higher tolerance
        poorPct: 0.05,
    },
};

/**
 * Conservative configuration for stable conditions
 */
export const CONSERVATIVE_CONFIG: ExecutionQualityConfig = {
    ...DEFAULT_CONFIG,
    
    metricsWindowMs: 60 * 60 * 1000,  // Longer window
    
    thresholds: {
        blockThreshold: 0.45,          // Stricter block
        reducedThreshold: 0.60,
        normalThreshold: 0.85,
    },
    
    slippageNormalization: {
        excellentPct: 0.0005,          // Tighter tolerance
        poorPct: 0.01,
    },
};

/**
 * Create custom configuration with overrides
 */
export function createConfig(overrides: Partial<ExecutionQualityConfig>): ExecutionQualityConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
        thresholds: {
            ...DEFAULT_CONFIG.thresholds,
            ...(overrides.thresholds || {}),
        },
        weights: {
            ...DEFAULT_CONFIG.weights,
            ...(overrides.weights || {}),
        },
        latencyNormalization: {
            ...DEFAULT_CONFIG.latencyNormalization,
            ...(overrides.latencyNormalization || {}),
        },
        slippageNormalization: {
            ...DEFAULT_CONFIG.slippageNormalization,
            ...(overrides.slippageNormalization || {}),
        },
    };
}

