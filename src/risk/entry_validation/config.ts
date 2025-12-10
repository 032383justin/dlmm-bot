/**
 * Entry Validation Module - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEFAULT THRESHOLDS FOR PRE-TRADE VALIDATION
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { EntryValidationConfig } from './types';

// Re-export the type for convenience
export type { EntryValidationConfig } from './types';

/**
 * Default entry validation configuration
 * 
 * Evaluation order:
 * 1. isNoTradeRegime()
 * 2. shouldBlockEntryOnReversal()
 * 3. getExecutionQuality()
 * 4. getCongestionMultiplier()
 * 5. getPositionMultiplier()
 */
export const DEFAULT_CONFIG: EntryValidationConfig = {
    // Enable all checks by default
    enableNoTradeCheck: true,
    enableReversalCheck: true,
    enableExecutionCheck: true,
    enableCongestionCheck: true,
    
    // Execution quality thresholds
    executionBlockThreshold: 0.35,     // If < 0.35 → block entries
    executionReduceThreshold: 0.50,    // If < 0.50 → reduce position size by 60%
    executionNormalThreshold: 0.80,    // If > 0.80 → allow normal sizing
    executionReductionFactor: 0.40,    // 60% reduction = 40% of original
    
    // Congestion thresholds
    congestionBlockThreshold: 0.85,    // If > 0.85 → block trading
    congestionHalfThreshold: 0.70,     // If > 0.70 → halve position size
    congestionReduceThreshold: 0.60,   // If > 0.60 → reduce frequency
    
    // Combined multiplier threshold
    minCombinedMultiplier: 0.10,       // Minimum combined multiplier to allow entry
    
    // Cooldown settings
    defaultCooldownSeconds: 60,        // 1 minute default
    maxCooldownSeconds: 300,           // 5 minute max
};

/**
 * Conservative configuration (more blocking, less trading)
 */
export const CONSERVATIVE_CONFIG: EntryValidationConfig = {
    ...DEFAULT_CONFIG,
    executionBlockThreshold: 0.45,
    executionReduceThreshold: 0.60,
    executionNormalThreshold: 0.85,
    congestionBlockThreshold: 0.75,
    congestionHalfThreshold: 0.60,
    minCombinedMultiplier: 0.20,
    defaultCooldownSeconds: 120,
};

/**
 * Aggressive configuration (less blocking, more trading)
 */
export const AGGRESSIVE_CONFIG: EntryValidationConfig = {
    ...DEFAULT_CONFIG,
    executionBlockThreshold: 0.25,
    executionReduceThreshold: 0.40,
    executionNormalThreshold: 0.70,
    congestionBlockThreshold: 0.90,
    congestionHalfThreshold: 0.80,
    minCombinedMultiplier: 0.05,
    defaultCooldownSeconds: 30,
};

/**
 * Create a custom config with overrides
 */
export function createConfig(overrides: Partial<EntryValidationConfig>): EntryValidationConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
    };
}

