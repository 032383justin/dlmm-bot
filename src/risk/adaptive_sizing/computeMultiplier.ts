/**
 * Adaptive Position Sizing Engine - Core Computation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Purpose: Compute position multiplier based on regime strength and microstructure.
 * 
 * Formula:
 * 1. Compute weighted mean:
 *    r = (migrationDirection_confidence * 0.35) +
 *        (liquidityFlow_score * 0.25) +
 *        (entropy_score * 0.15) +
 *        (consistency_score * 0.15) +
 *        (velocity_score * 0.10)
 * 
 * 2. Apply power curve to exaggerate strong regimes:
 *    regimeConfidence = r^1.5
 * 
 * 3. Compute final multiplier:
 *    position_multiplier = clamp(regimeConfidence, 0, 1.8)
 * 
 * Behavior Rules:
 * - regimeConfidence < 0.20 → return 0 (block trading)
 * - 0.20-0.50 → scale down aggressively
 * - > 0.60 → allow larger position
 * - > 0.80 → near-max expansion
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { 
    TradingState, 
    AdaptiveSizingResult, 
    AdaptiveSizingConfig,
    AdaptiveSizingWeights 
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default weights for adaptive sizing formula.
 * These weights sum to 1.0 for a normalized weighted mean.
 */
export const DEFAULT_WEIGHTS: AdaptiveSizingWeights = {
    migrationDirection_confidence: 0.35,
    liquidityFlow_score: 0.25,
    entropy_score: 0.15,
    consistency_score: 0.15,
    velocity_score: 0.10,
};

/**
 * Default configuration for adaptive sizing
 */
export const DEFAULT_CONFIG: AdaptiveSizingConfig = {
    minRegimeConfidence: 0.20,
    maxMultiplier: 1.8,
    powerExponent: 1.5,
    weights: DEFAULT_WEIGHTS,
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Validate that a score is in the expected 0-1 range.
 * If out of range, clamp it.
 */
function normalizeScore(score: number): number {
    if (!isFinite(score)) return 0;
    return clamp(score, 0, 1);
}

/**
 * Determine sizing reason based on regime confidence
 */
function getSizingReason(regimeConfidence: number, tradingBlocked: boolean): string {
    if (tradingBlocked) {
        return `BLOCKED: regime confidence ${regimeConfidence.toFixed(3)} < 0.20`;
    }
    
    if (regimeConfidence >= 0.80) {
        return `NEAR-MAX: regime confidence ${regimeConfidence.toFixed(3)} ≥ 0.80`;
    }
    
    if (regimeConfidence >= 0.60) {
        return `LARGE: regime confidence ${regimeConfidence.toFixed(3)} ≥ 0.60`;
    }
    
    if (regimeConfidence >= 0.50) {
        return `MODERATE: regime confidence ${regimeConfidence.toFixed(3)} ≥ 0.50`;
    }
    
    return `SCALED-DOWN: regime confidence ${regimeConfidence.toFixed(3)} < 0.50`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute the position multiplier based on trading state.
 * 
 * This is the main computation function that implements the adaptive sizing formula.
 * 
 * @param state - Current trading state with all microstructure signals
 * @param config - Optional configuration override
 * @returns AdaptiveSizingResult with multiplier and metadata
 */
export function computePositionMultiplier(
    state: TradingState,
    config: AdaptiveSizingConfig = DEFAULT_CONFIG
): AdaptiveSizingResult {
    const { weights, minRegimeConfidence, maxMultiplier, powerExponent } = config;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Normalize all input scores to 0-1 range
    // ═══════════════════════════════════════════════════════════════════════════
    
    const entropy = normalizeScore(state.entropy_score);
    const liquidityFlow = normalizeScore(state.liquidityFlow_score);
    const migrationConfidence = normalizeScore(state.migrationDirection_confidence);
    const consistency = normalizeScore(state.consistency_score);
    const velocity = normalizeScore(state.velocity_score);
    
    // execution_quality is currently a placeholder (fixed at 1)
    // Future: incorporate into formula when real execution tracking is available
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Compute weighted mean
    // ═══════════════════════════════════════════════════════════════════════════
    
    const r = 
        (migrationConfidence * weights.migrationDirection_confidence) +
        (liquidityFlow * weights.liquidityFlow_score) +
        (entropy * weights.entropy_score) +
        (consistency * weights.consistency_score) +
        (velocity * weights.velocity_score);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Apply power curve to exaggerate strong regimes
    // ═══════════════════════════════════════════════════════════════════════════
    
    const regimeConfidence = Math.pow(r, powerExponent);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Determine if trading is blocked
    // ═══════════════════════════════════════════════════════════════════════════
    
    const tradingBlocked = regimeConfidence < minRegimeConfidence;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: Compute final multiplier
    // ═══════════════════════════════════════════════════════════════════════════
    
    let position_multiplier: number;
    
    if (tradingBlocked) {
        // Block trading entirely when regime confidence is too low
        position_multiplier = 0;
    } else {
        // Clamp multiplier to [0, maxMultiplier]
        position_multiplier = clamp(regimeConfidence, 0, maxMultiplier);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: Build result
    // ═══════════════════════════════════════════════════════════════════════════
    
    return {
        position_multiplier,
        raw_score: r,
        regime_confidence: regimeConfidence,
        trading_blocked: tradingBlocked,
        reason: getSizingReason(regimeConfidence, tradingBlocked),
        timestamp: Date.now(),
    };
}

/**
 * Quick computation that returns just the multiplier value.
 * Use this when you only need the multiplier without metadata.
 * 
 * @param state - Current trading state
 * @returns Position multiplier between 0 and 1.8
 */
export function computeMultiplierValue(state: TradingState): number {
    const result = computePositionMultiplier(state);
    return result.position_multiplier;
}

