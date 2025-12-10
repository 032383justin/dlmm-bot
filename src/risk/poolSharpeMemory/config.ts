/**
 * Pool Sharpe Memory - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Configurable thresholds for Sharpe-based pool scoring.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { PoolSharpeConfig } from './types';

// Re-export the type for use in other modules
export type { PoolSharpeConfig } from './types';

/**
 * Default configuration for Pool Sharpe Memory
 */
export const DEFAULT_CONFIG: PoolSharpeConfig = {
    // Minimum 3 trades for valid Sharpe calculation
    minTradesForSharpe: 3,
    
    // Default Sharpe when insufficient data (slightly positive)
    defaultSharpe: 0.5,
    
    // Block entries if Sharpe < -1.0 (consistently losing)
    blockThreshold: -1.0,
    
    // Reduce size if Sharpe < 0.3 (marginally profitable)
    reduceThreshold: 0.3,
    
    // Boost size if Sharpe > 1.5 (consistently profitable)
    boostThreshold: 1.5,
    
    // Reduce size by 50% for poor Sharpe pools
    poorSharpeMultiplier: 0.50,
    
    // Boost size by 25% for excellent Sharpe pools
    excellentSharpeMultiplier: 1.25,
    
    // Risk-free rate (annualized SOL staking yield ~5%)
    riskFreeRate: 0.05,
    
    // Rolling window of 7 days
    rollingWindowMs: 7 * 24 * 60 * 60 * 1000,
    
    // Decay factor for older trades (0.9 = 10% decay per step)
    decayFactor: 0.9,
};

/**
 * Conservative configuration (stricter thresholds)
 */
export const CONSERVATIVE_CONFIG: PoolSharpeConfig = {
    ...DEFAULT_CONFIG,
    minTradesForSharpe: 5,
    blockThreshold: -0.5,
    reduceThreshold: 0.5,
    boostThreshold: 2.0,
    poorSharpeMultiplier: 0.30,
    excellentSharpeMultiplier: 1.15,
};

/**
 * Aggressive configuration (more lenient)
 */
export const AGGRESSIVE_CONFIG: PoolSharpeConfig = {
    ...DEFAULT_CONFIG,
    minTradesForSharpe: 2,
    blockThreshold: -2.0,
    reduceThreshold: 0.0,
    boostThreshold: 1.0,
    poorSharpeMultiplier: 0.70,
    excellentSharpeMultiplier: 1.40,
};

/**
 * Create custom configuration with overrides
 */
export function createConfig(overrides: Partial<PoolSharpeConfig>): PoolSharpeConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
    };
}

