/**
 * Reverse Entry Guard - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEFAULT THRESHOLDS FOR REVERSAL DETECTION
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { ReversalGuardConfig } from './types';

/**
 * Default reversal guard configuration
 */
export const DEFAULT_CONFIG: ReversalGuardConfig = {
    // Tick analysis windows
    recentTickCount: 3,           // Analyze last 1-3 ticks for current direction
    historicalTickCount: 10,       // Compare against last 5-10 ticks
    
    // Sustained migration requirement
    minSustainedMigrations: 3,     // Require 3 consecutive migrations in same direction
    
    // Cooldown settings
    cooldownSeconds: 60,           // Base cooldown: 60 seconds
    maxCooldownSeconds: 120,       // Max cooldown: 120 seconds
    
    // Detection thresholds
    entropyChangeThreshold: 0.15,  // 15% entropy change indicates instability
    liquidityFlowReversalThreshold: 0.10, // 10% flow reversal threshold
};

/**
 * Create a custom config with overrides
 */
export function createConfig(overrides: Partial<ReversalGuardConfig>): ReversalGuardConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
    };
}

