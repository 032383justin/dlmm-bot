/**
 * No Trade Regime - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEFAULT THRESHOLDS FOR NO-TRADE REGIME DETECTION
 * 
 * These thresholds are based on the principle that it's better to miss
 * opportunities than to enter bad trades.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { NoTradeConfig } from './types';

/**
 * Default no-trade regime configuration
 * 
 * Rules:
 * - if consistency < 0.35 → no trade (unreliable signals)
 * - if entropy > 0.80 → chaos → no trade
 * - if migration confidence < 0.25 → no trade (unclear direction)
 * - if liquidityFlowScore < 0.20 → no trade (thin liquidity)
 */
export const DEFAULT_CONFIG: NoTradeConfig = {
    // Individual thresholds
    consistencyThreshold: 0.35,          // Below 35% consistency = unreliable
    entropyThreshold: 0.80,              // Above 80% entropy = chaos
    migrationConfidenceThreshold: 0.25,  // Below 25% confidence = unclear
    liquidityFlowThreshold: 0.20,        // Below 20% flow = thin
    velocityThreshold: 0.15,             // Below 15% velocity = dead market
    
    // Combined weak threshold
    combinedWeakThreshold: 0.30,         // Average of all signals below 30%
    
    // Cooldown settings
    defaultCooldownSeconds: 60,          // 1 minute default cooldown
    maxCooldownSeconds: 300,             // 5 minute max cooldown
};

/**
 * Conservative config for higher risk aversion
 */
export const CONSERVATIVE_CONFIG: NoTradeConfig = {
    consistencyThreshold: 0.45,
    entropyThreshold: 0.70,
    migrationConfidenceThreshold: 0.35,
    liquidityFlowThreshold: 0.30,
    velocityThreshold: 0.25,
    combinedWeakThreshold: 0.40,
    defaultCooldownSeconds: 120,
    maxCooldownSeconds: 600,
};

/**
 * Aggressive config for lower risk aversion (more trades)
 */
export const AGGRESSIVE_CONFIG: NoTradeConfig = {
    consistencyThreshold: 0.25,
    entropyThreshold: 0.90,
    migrationConfidenceThreshold: 0.15,
    liquidityFlowThreshold: 0.10,
    velocityThreshold: 0.10,
    combinedWeakThreshold: 0.20,
    defaultCooldownSeconds: 30,
    maxCooldownSeconds: 120,
};

/**
 * Create a custom config with overrides
 */
export function createConfig(overrides: Partial<NoTradeConfig>): NoTradeConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
    };
}

