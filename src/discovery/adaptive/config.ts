/**
 * Adaptive Pool Selection - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Configurable parameters for pool universe management.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { AdaptivePoolConfig } from './types';

/**
 * Default configuration for adaptive pool selection
 */
export const DEFAULT_CONFIG: AdaptivePoolConfig = {
    // Maximum 50 pools in active universe
    maxActivePoolCount: 50,
    
    // Minimum 10 pools to maintain
    minActivePoolCount: 10,
    
    // Refresh 20% of universe each cycle
    discoveryRefreshFraction: 0.20,
    
    // Refresh discovery every 30 minutes
    discoveryRefreshIntervalMs: 30 * 60 * 1000,
    
    // Block pools with Sharpe < -1.0
    blockSharpeThreshold: -1.0,
    
    // Probation for Sharpe < 0.3
    probationSharpeThreshold: 0.3,
    
    // Graduate from probation if Sharpe > 0.5
    activeSharpeThreshold: 0.5,
    
    // Minimum 3 trades before Sharpe evaluation
    minTradesForEvaluation: 3,
    
    // Consider stale after 24 hours of inactivity
    staleTimeMs: 24 * 60 * 60 * 1000,
    
    // Permanently remove after 3 blocks
    maxBlockCount: 3,
    
    // Priority score weights
    priorityWeights: {
        sharpe: 0.50,      // 50% weight on Sharpe
        discovery: 0.30,   // 30% weight on discovery score
        recency: 0.20,     // 20% weight on recent activity
    },
};

/**
 * Conservative configuration (stricter selection)
 */
export const CONSERVATIVE_CONFIG: AdaptivePoolConfig = {
    ...DEFAULT_CONFIG,
    maxActivePoolCount: 30,
    discoveryRefreshFraction: 0.10,
    blockSharpeThreshold: -0.5,
    probationSharpeThreshold: 0.5,
    activeSharpeThreshold: 0.8,
    minTradesForEvaluation: 5,
    maxBlockCount: 2,
};

/**
 * Aggressive configuration (more exploration)
 */
export const AGGRESSIVE_CONFIG: AdaptivePoolConfig = {
    ...DEFAULT_CONFIG,
    maxActivePoolCount: 75,
    discoveryRefreshFraction: 0.30,
    blockSharpeThreshold: -2.0,
    probationSharpeThreshold: 0.0,
    activeSharpeThreshold: 0.3,
    minTradesForEvaluation: 2,
    maxBlockCount: 5,
};

/**
 * Create custom configuration with overrides
 */
export function createConfig(overrides: Partial<AdaptivePoolConfig>): AdaptivePoolConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
        priorityWeights: {
            ...DEFAULT_CONFIG.priorityWeights,
            ...(overrides.priorityWeights || {}),
        },
    };
}

