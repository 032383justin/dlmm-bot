/**
 * No Trade Regime - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEFAULT THRESHOLDS FOR NO-TRADE REGIME DETECTION
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEE BULLY MODE UPDATE:
 * 
 * The original philosophy was "better to miss opportunities than enter bad trades."
 * Fee Bully Mode inverts this: "deploy by default with size penalties, only block
 * on true infrastructure failures."
 * 
 * We now use FEE_BULLY_CONFIG which has much more permissive thresholds.
 * The DEFAULT_CONFIG is kept for backwards compatibility with non-Fee-Bully mode.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { NoTradeConfig } from './types';

/**
 * Default no-trade regime configuration (conservative - for non-Fee-Bully mode)
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
 * FEE BULLY CONFIG - Deploy-by-default with only hard blocks on true red flags
 * 
 * This config is EXTREMELY permissive. It only blocks on:
 * - Extreme chaos (entropy > 0.95)
 * - Completely dead markets (velocity < 0.02)
 * 
 * All other conditions should apply PENALTIES via the Fee Bully Gate system,
 * not hard blocks via no_trade regime.
 */
export const FEE_BULLY_CONFIG: NoTradeConfig = {
    // VERY permissive thresholds - only block on true red flags
    consistencyThreshold: 0.10,          // Only block if < 10% consistency
    entropyThreshold: 0.95,              // Only block if > 95% entropy (extreme chaos)
    migrationConfidenceThreshold: 0.05,  // Only block if < 5% confidence
    liquidityFlowThreshold: 0.05,        // Only block if < 5% flow
    velocityThreshold: 0.02,             // Only block if < 2% velocity (truly dead)
    
    // Combined weak threshold (very low)
    combinedWeakThreshold: 0.10,         // Average of all signals below 10%
    
    // Short cooldowns (we want to retry quickly)
    defaultCooldownSeconds: 15,          // 15 second default cooldown
    maxCooldownSeconds: 60,              // 1 minute max cooldown
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

