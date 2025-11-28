/**
 * Predator Configuration - Tier 4 Microstructure Predator Settings
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * UNIFIED CONFIGURATION FOR ALL PREDATOR MODULES
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This file centralizes all configuration for:
 * - Microstructure Health Index (MHI)
 * - Non-Equilibrium Reinjection
 * - Cross-Pool Reflexivity
 * - Adaptive Snapshot Frequency
 * - Dynamic Stop Harmonics
 * - Pool Personality Profiling
 * 
 * Modify these values to tune predator behavior.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// MICROSTRUCTURE HEALTH INDEX (MHI) CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const MHI_CONFIG = {
    // Component weights (must sum to 1.0)
    weights: {
        binVelocity: 0.25,
        swapVelocity: 0.25,
        entropy: 0.25,
        liquidityFlow: 0.25,
    },
    
    // Slope penalty weight (subtracted from base score)
    slopePenaltyWeight: 0.20,
    
    // Normalization ranges
    normalization: {
        binVelocity: { min: 0, max: 0.10 },
        swapVelocity: { min: 0, max: 0.50 },
        entropy: { min: 0.40, max: 0.85 },
        liquidityFlow: { min: -0.10, max: 0.05 },
    },
    
    // Sizing tiers (MHI range -> size multiplier)
    sizingTiers: {
        max: { min: 0.80, max: 1.00, multiplier: 1.00 },
        high: { min: 0.70, max: 0.80, multiplier: 0.80 },
        medium: { min: 0.60, max: 0.70, multiplier: 0.65 },
        low: { min: 0.45, max: 0.60, multiplier: 0.50 },
        blocked: { min: 0, max: 0.45, multiplier: 0 },
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// REINJECTION ENGINE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const REINJECTION_CONFIG = {
    // Cooldown timing
    minCooldownMs: 2 * 60 * 1000,       // 2 minutes minimum wait
    maxTrackingTimeMs: 30 * 60 * 1000,  // Stop tracking after 30 minutes
    
    // Snapshots
    minSnapshotsForEval: 2,
    maxSnapshotsToWait: 5,
    
    // Healing thresholds
    minHealingMHI: 0.55,
    minEntropyRecovery: 0.80,           // 80% of exit value
    minLiquidityFlowRecovery: 0,        // Must be non-negative
    minSwapVelocityRecovery: 0.50,      // 50% of baseline
    
    // Confidence
    minConfidenceToReinject: 0.65,
    minConsecutiveHealing: 2,
    
    // Size adjustment by confidence
    sizingByConfidence: {
        high: { minConfidence: 0.85, multiplier: 1.0 },
        medium: { minConfidence: 0.70, multiplier: 0.75 },
        low: { minConfidence: 0.55, multiplier: 0.50 },
    },
    
    // Severe exit blacklist duration
    severeExitBlacklistMs: 60 * 60 * 1000,  // 1 hour
};

// ═══════════════════════════════════════════════════════════════════════════════
// REFLEXIVITY ENGINE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const REFLEXIVITY_CONFIG = {
    // Score calculation
    scorePerDrainingNeighbor: 0.03,     // +3% per draining neighbor
    maxReflexivityBonus: 0.15,          // Cap at +15%
    
    // Pool classification thresholds
    dormantMHI: 0.40,
    drainingFlowThreshold: -0.02,       // -2% = draining
    growingFlowThreshold: 0.02,         // +2% = growing
    
    // Signal thresholds
    minNeighborsForSignal: 2,
    predatorOpportunityThreshold: 3,    // 3+ draining neighbors
    migrationTargetThreshold: 0.10,     // 10%+ reflexivity score
};

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTIVE SNAPSHOT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const ADAPTIVE_SNAPSHOT_CONFIG = {
    // Hard bounds
    minIntervalMs: 10_000,              // 10 seconds minimum
    maxIntervalMs: 60_000,              // 60 seconds maximum
    baselineIntervalMs: 30_000,         // 30 seconds default
    
    // Activity thresholds (swaps/sec)
    activityThresholds: {
        hyperactive: 0.50,
        active: 0.20,
        normal: 0.05,
        dormant: 0.01,
    },
    
    // Interval multipliers by activity
    intervalMultipliers: {
        hyperactive: 0.33,              // 10s
        active: 0.50,                   // 15s
        normal: 1.00,                   // 30s
        dormant: 1.50,                  // 45s
        dead: 2.00,                     // 60s
    },
    
    // Smoothing
    smoothingFactor: 0.3,               // 30% new, 70% old
    minIntervalChangePct: 0.10,         // 10% minimum change
    
    // Market pressure thresholds
    marketPressure: {
        high: 0.30,                     // 30%+ active pools
        medium: 0.15,                   // 15%+ active pools
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMIC HARMONICS CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const DYNAMIC_HARMONICS_CONFIG = {
    // Volatility calculation
    volatilityWindow: 15,               // Last 15 snapshots
    minHistoryForVolatility: 5,
    
    // Volatility level thresholds (stddev)
    volatilityLevels: {
        high: 0.15,                     // 15%+ stddev
        medium: 0.08,                   // 8%+ stddev
        low: 0.03,                      // 3%+ stddev
    },
    
    // Band multipliers by volatility
    bandMultipliers: {
        high: 1.5,                      // Widen 50%
        medium: 1.2,                    // Widen 20%
        low: 1.0,                       // Normal
        minimal: 0.8,                   // Tighten 20%
    },
    
    // Structural decay thresholds
    structuralDecay: {
        consecutiveSlopesForExit: 3,    // Exit after 3 consecutive
        mildThreshold: 1,
        moderateThreshold: 2,
        severeThreshold: 3,
    },
    
    // Band limits
    minBandMultiplier: 0.5,
    maxBandMultiplier: 2.0,
    
    // Volatility component weights
    volatilityWeights: {
        entropy: 0.40,
        swapVelocity: 0.35,
        liquidityFlow: 0.25,
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// POOL PERSONALITY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const PERSONALITY_CONFIG = {
    // History requirements
    maxHistoryLength: 100,
    minHistoryForProfile: 10,
    
    // Update intervals
    profileUpdateIntervalMs: 60_000,    // 1 minute
    
    // Trust score weights
    trustWeights: {
        winRate: 0.40,
        avgPnL: 0.30,
        mhiStability: 0.30,
    },
    
    // Specialist thresholds
    minTradesForSpecialist: 5,
    minTrustForSpecialist: 0.70,
};

// ═══════════════════════════════════════════════════════════════════════════════
// PREDATOR CONTROLLER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_CONTROLLER_CONFIG = {
    // Entry priorities
    priorityThresholds: {
        high: { minMHI: 0.75, minReflexivity: 0.10 },
        medium: { minMHI: 0.60, minReflexivity: 0.05 },
        low: { minMHI: 0.45, minReflexivity: 0 },
    },
    
    // Specialist focus (CRITICAL: Bots that trade 5 pools like predators WIN)
    maxSimultaneousPools: 5,
    preferSpecialistPools: true,
    specialistBonus: 0.10,              // +10% size for trusted pools
    
    // Reflexivity integration
    maxReflexivityBonus: 0.15,          // Cap at 15%
    
    // Logging
    verboseLogging: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT STRATEGY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const EXIT_STRATEGY_CONFIG = {
    /**
     * CRITICAL: NEVER EXIT ON PRICE
     * 
     * Exit ONLY on structural decay:
     * - slopeE < 0 AND slopeL < 0 for ≥ 3 consecutive snapshots
     * 
     * No profit targets.
     * No trailing stops.
     * You are trading MICROSTRUCTURE, not chart shapes.
     */
    
    // Structural decay
    consecutiveSlopesForExit: 3,
    
    // These should NOT be used for exits (kept for reference only)
    DEPRECATED_profitTarget: null,      // DO NOT USE
    DEPRECATED_stopLoss: null,          // DO NOT USE
    DEPRECATED_trailingStop: null,      // DO NOT USE
    
    // Only structural signals trigger exits
    exitOnStructuralDecay: true,
    exitOnPriceChange: false,           // NEVER
    exitOnProfitTarget: false,          // NEVER
    exitOnStopLoss: false,              // NEVER
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_CONFIG = {
    mhi: MHI_CONFIG,
    reinjection: REINJECTION_CONFIG,
    reflexivity: REFLEXIVITY_CONFIG,
    adaptiveSnapshot: ADAPTIVE_SNAPSHOT_CONFIG,
    dynamicHarmonics: DYNAMIC_HARMONICS_CONFIG,
    personality: PERSONALITY_CONFIG,
    controller: PREDATOR_CONTROLLER_CONFIG,
    exitStrategy: EXIT_STRATEGY_CONFIG,
};

export default PREDATOR_CONFIG;

