/**
 * Adaptive Position Sizing Engine - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Purpose: Dynamically scale position size based on current regime strength,
 * execution quality, and microstructure signals.
 * 
 * This module is ADDITIVE - it does not replace existing risk guards.
 * The multiplier is applied ONLY at entry sizing.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Trading state containing all microstructure signals needed for adaptive sizing.
 * These values are extracted from the existing telemetry system.
 */
export interface TradingState {
    /**
     * Shannon entropy of bin distribution (0-1)
     * Higher values indicate healthier price discovery
     */
    entropy_score: number;
    
    /**
     * Liquidity flow score (0-1)
     * Measures LP inflow/outflow as percentage of TVL
     */
    liquidityFlow_score: number;
    
    /**
     * Migration direction confidence (0-1)
     * Confidence in the detected liquidity migration direction
     */
    migrationDirection_confidence: number;
    
    /**
     * Consistency score (0-1)
     * Higher values indicate more consistent activity over time
     */
    consistency_score: number;
    
    /**
     * Velocity score (0-1)
     * Combined bin/swap velocity normalized score
     */
    velocity_score: number;
    
    /**
     * Execution quality (0-1)
     * Placeholder for future execution quality tracking
     * Currently hardcoded to 1
     */
    execution_quality: number;
}

/**
 * Result of adaptive sizing computation
 */
export interface AdaptiveSizingResult {
    /**
     * Position multiplier between 0 and 1.8
     * - 0: Block trading (regime too weak)
     * - 0.20-0.50: Scaled down aggressively
     * - 0.60+: Allow larger position
     * - 0.80+: Near-max expansion
     */
    position_multiplier: number;
    
    /**
     * Raw weighted mean before power curve
     */
    raw_score: number;
    
    /**
     * Regime confidence after power curve
     */
    regime_confidence: number;
    
    /**
     * Whether trading is blocked due to low regime confidence
     */
    trading_blocked: boolean;
    
    /**
     * Reason for the sizing decision
     */
    reason: string;
    
    /**
     * Timestamp of computation
     */
    timestamp: number;
}

/**
 * Weights for the adaptive sizing formula
 */
export interface AdaptiveSizingWeights {
    migrationDirection_confidence: number;
    liquidityFlow_score: number;
    entropy_score: number;
    consistency_score: number;
    velocity_score: number;
}

/**
 * Configuration for adaptive sizing thresholds
 */
export interface AdaptiveSizingConfig {
    /** Minimum regime confidence to allow trading */
    minRegimeConfidence: number;
    
    /** Maximum position multiplier */
    maxMultiplier: number;
    
    /** Power curve exponent for regime confidence */
    powerExponent: number;
    
    /** Weights for each input signal */
    weights: AdaptiveSizingWeights;
}

