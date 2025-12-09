/**
 * Adaptive Position Sizing Engine
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Dynamically scale position size based on current regime strength,
 * execution quality, and microstructure signals.
 * 
 * BEHAVIOR:
 * - Applied ONLY at entry sizing
 * - NEVER overrides existing safety limits
 * - Does NOT place orders - only returns a float multiplier
 * - ADDITIVE to existing risk system
 * 
 * OUTPUT: position_multiplier between 0 and 1.8
 * - 0: Block trading (regime too weak)
 * - 0.20-0.50: Scaled down aggressively
 * - 0.60+: Allow larger position
 * - 0.80+: Near-max expansion
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export type { 
    TradingState, 
    AdaptiveSizingResult, 
    AdaptiveSizingConfig, 
    AdaptiveSizingWeights 
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTION EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { 
    computePositionMultiplier, 
    computeMultiplierValue,
    DEFAULT_CONFIG,
    DEFAULT_WEIGHTS,
} from './computeMultiplier';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

import { TradingState } from './types';
import { computeMultiplierValue } from './computeMultiplier';

/**
 * Get the position multiplier for a given trading state.
 * 
 * This is the primary API for the Adaptive Position Sizing Engine.
 * 
 * @param state - Current trading state with microstructure signals:
 *   - entropy_score (0-1): Shannon entropy of bin distribution
 *   - liquidityFlow_score (0-1): LP inflow/outflow as % of TVL
 *   - migrationDirection_confidence (0-1): Confidence in migration direction
 *   - consistency_score (0-1): Consistency of activity over time
 *   - velocity_score (0-1): Combined bin/swap velocity
 *   - execution_quality (0-1): Placeholder, currently fixed at 1
 * 
 * @returns Position multiplier between 0 and 1.8
 * 
 * @example
 * ```typescript
 * const state: TradingState = {
 *     entropy_score: 0.75,
 *     liquidityFlow_score: 0.60,
 *     migrationDirection_confidence: 0.80,
 *     consistency_score: 0.70,
 *     velocity_score: 0.65,
 *     execution_quality: 1, // Hardcoded placeholder
 * };
 * 
 * const multiplier = getPositionMultiplier(state);
 * // multiplier ≈ 0.62 (scaled based on regime strength)
 * 
 * const effectiveSize = basePositionSize * multiplier;
 * ```
 */
export function getPositionMultiplier(state: TradingState): number {
    return computeMultiplierValue(state);
}

/**
 * Create a TradingState from raw telemetry values.
 * 
 * Helper function to normalize scores from various sources into
 * the TradingState format expected by the adaptive sizing engine.
 * 
 * @param params - Raw telemetry values (all normalized to 0-1)
 * @returns TradingState ready for position multiplier calculation
 */
export function createTradingState(params: {
    entropy?: number;
    liquidityFlow?: number;
    migrationConfidence?: number;
    consistency?: number;
    velocity?: number;
    executionQuality?: number;
}): TradingState {
    return {
        entropy_score: params.entropy ?? 0,
        liquidityFlow_score: params.liquidityFlow ?? 0,
        migrationDirection_confidence: params.migrationConfidence ?? 0,
        consistency_score: params.consistency ?? 0,
        velocity_score: params.velocity ?? 0,
        execution_quality: params.executionQuality ?? 1, // Default to 1 (placeholder)
    };
}

/**
 * Check if trading should be blocked based on regime confidence.
 * 
 * Convenience function that returns true if the regime confidence
 * is too low to allow any trading (multiplier would be 0).
 * 
 * @param state - Current trading state
 * @returns true if trading should be blocked, false otherwise
 */
export function isTradingBlocked(state: TradingState): boolean {
    return getPositionMultiplier(state) === 0;
}

