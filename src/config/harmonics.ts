/**
 * Harmonic Stops Configuration - Tier 4 Microstructure-Driven Exit Controller
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * STOP HARMONICS: State-based exits driven by microstructure health, NOT price
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Monitors live microstructure "health" per open trade:
 * - vSlope, lSlope, eSlope (velocity/liquidity/entropy slopes)
 * - binVelocity, swapVelocity, poolEntropy, liquidityFlowPct, feeIntensity
 * 
 * Compares current metrics vs entry baseline and decides HOLD vs FULL_EXIT
 * based on harmonic "health bands" that are tier-dependent:
 * 
 * - Tier A (CORE): wide bands, tolerant, exits only on severe collapse
 * - Tier B (MOMENTUM): medium tolerance
 * - Tier C (SPECULATIVE): tight bands, quick exits
 * 
 * This is a PURE microstructure health controller, not TP/SL logic.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { RiskTier } from '../engine/riskBucketEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER-SPECIFIC THRESHOLDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * How many consecutive bad health checks before triggering exit.
 * More tolerance for higher-quality pools.
 */
export const MIN_BAD_SAMPLES: Record<RiskTier, number> = {
    A: 3,  // Core: need 3 consecutive bad samples
    B: 2,  // Momentum: need 2 consecutive bad samples
    C: 1,  // Speculative: single bad sample triggers exit
    D: 0,  // Noise: should never have positions here
};

/**
 * Velocity drop factor threshold per tier.
 * Current velocity must be > (baseline * factor) to be healthy.
 * Lower factor = more tolerant.
 */
export const VELOCITY_DROP_FACTOR: Record<RiskTier, number> = {
    A: 0.20,  // Core: tolerate up to 80% drop
    B: 0.30,  // Momentum: tolerate up to 70% drop
    C: 0.40,  // Speculative: tolerate only 60% drop
    D: 1.00,  // Noise: not used
};

/**
 * Entropy drop factor threshold per tier.
 * Current entropy must be > (baseline * factor) to be healthy.
 */
export const ENTROPY_DROP_FACTOR: Record<RiskTier, number> = {
    A: 0.40,  // Core: tolerate up to 60% entropy drop
    B: 0.50,  // Momentum: tolerate up to 50% entropy drop
    C: 0.60,  // Speculative: tolerate only 40% entropy drop
    D: 1.00,  // Noise: not used
};

/**
 * Liquidity outflow threshold per tier (as percentage, negative = outflow).
 * More negative = worse. If liquidityFlowPct < threshold → unhealthy.
 */
export const LIQUIDITY_OUTFLOW_PCT: Record<RiskTier, number> = {
    A: -0.10,  // Core: tolerate up to 10% outflow
    B: -0.07,  // Momentum: tolerate up to 7% outflow
    C: -0.05,  // Speculative: tolerate only 5% outflow
    D: 0.00,   // Noise: not used
};

// ═══════════════════════════════════════════════════════════════════════════════
// ABSOLUTE FLOOR THRESHOLDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Absolute minimum thresholds - if below these, pool is dead regardless of baseline.
 * These are safety floors that apply uniformly.
 */
export const harmonicConfig = {
    // ═══════════════════════════════════════════════════════════════════════════
    // CONSECUTIVE BAD SAMPLES BEFORE EXIT (tier-dependent)
    // ═══════════════════════════════════════════════════════════════════════════
    minBadSamples: MIN_BAD_SAMPLES,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RELATIVE THRESHOLDS VS BASELINE (tier-dependent)
    // ═══════════════════════════════════════════════════════════════════════════
    velocityDropFactor: VELOCITY_DROP_FACTOR,
    entropyDropFactor: ENTROPY_DROP_FACTOR,
    liquidityOutflowPct: LIQUIDITY_OUTFLOW_PCT,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ABSOLUTE FLOOR THRESHOLDS (all tiers)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Minimum bin velocity (bins/second) - below this, market is dead
    minBinVelocity: 0.02,
    
    // Minimum swap velocity (swaps/second) - below this, no trading activity
    minSwapVelocity: 0.05,
    
    // Minimum pool entropy - below this, pool is unbalanced/unhealthy
    minPoolEntropy: 0.40,
    
    // Minimum fee intensity ratio - below this, fees not generating
    minFeeIntensity: 0.01,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SLOPE THRESHOLDS (direction of change)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Maximum negative slope for liquidity (strong outflow detection)
    maxNegativeSlopeL: -0.30,
    
    // Maximum negative slope for entropy (health deterioration)
    maxNegativeSlopeE: -0.30,
    
    // Maximum negative slope for velocity (activity dying)
    maxNegativeSlopeV: -0.25,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMBINED HEALTH SCORE THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Health score weights (must sum to 1.0)
    healthWeights: {
        velocityRatio: 0.25,     // How velocity compares to baseline
        entropyRatio: 0.20,      // How entropy compares to baseline
        liquidityFlow: 0.20,     // Liquidity flow direction
        slopeHealth: 0.20,       // Combined slope health
        absoluteFloors: 0.15,    // Absolute floor violations
    },
    
    // Minimum combined health score per tier to HOLD (below this → EXIT candidate)
    minHealthScore: {
        A: 0.30,  // Core: very tolerant, only exit on severe collapse
        B: 0.40,  // Momentum: moderate tolerance
        C: 0.50,  // Speculative: stricter, exit on moderate deterioration
        D: 1.00,  // Noise: not used
    } as Record<RiskTier, number>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIMING CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Minimum hold time before harmonic stops activate (grace period in ms)
    // This prevents premature exits on initial volatility
    minHoldTimeMs: 60_000,  // 1 minute grace period
    
    // Maximum time between health checks (if no update, consider stale)
    maxStaleCheckMs: 120_000,  // 2 minutes
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the minimum bad samples threshold for a tier.
 */
export function getMinBadSamples(tier: RiskTier): number {
    return harmonicConfig.minBadSamples[tier];
}

/**
 * Get the velocity drop factor for a tier.
 */
export function getVelocityDropFactor(tier: RiskTier): number {
    return harmonicConfig.velocityDropFactor[tier];
}

/**
 * Get the entropy drop factor for a tier.
 */
export function getEntropyDropFactor(tier: RiskTier): number {
    return harmonicConfig.entropyDropFactor[tier];
}

/**
 * Get the liquidity outflow threshold for a tier.
 */
export function getLiquidityOutflowPct(tier: RiskTier): number {
    return harmonicConfig.liquidityOutflowPct[tier];
}

/**
 * Get the minimum health score for a tier.
 */
export function getMinHealthScore(tier: RiskTier): number {
    return harmonicConfig.minHealthScore[tier];
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default harmonicConfig;

