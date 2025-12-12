/**
 * Tier-4 Scoring Thresholds
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER-4 SAFE RELAXED THRESHOLDS (Option A)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * These thresholds control entry gating decisions for the Tier-4 scoring system.
 * 
 * CHANGELOG:
 * - MIN_SCORE: 0.55 (was 0.65) - Lowered to allow more entries
 * - MIN_HEALTH_SCORE: 0.35 (was 0.45) - Lowered to allow entries during recovery
 * - MAX_VOLATILITY: 0.12 (was 0.09) - Raised to tolerate moderate volatility
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER-4 SAFE RELAXED THRESHOLDS (Option A)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimum composite tier4 score required for entry (normalized 0-1)
 * was 0.65
 */
export const MIN_SCORE = 0.55;

/**
 * Minimum microstructure health score required for entry
 * was 0.45
 */
export const MIN_HEALTH_SCORE = 0.35;

/**
 * Maximum volatility allowed for entry (normalized 0-1 scale)
 * was 0.09
 */
export const MAX_VOLATILITY = 0.12;

// ═══════════════════════════════════════════════════════════════════════════════
// GATING RESULT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gating result interface
 */
export interface Tier4GatingResult {
    allowed: boolean;
    reason: string;
    value: number;
    threshold: number;
}

/**
 * Create a gated (blocked) result
 */
export function gated(reason: string, value: number, threshold?: number): Tier4GatingResult {
    return {
        allowed: false,
        reason,
        value,
        threshold: threshold ?? 0,
    };
}

/**
 * Create an allowed result
 */
export function allowed(value: number): Tier4GatingResult {
    return {
        allowed: true,
        reason: 'All thresholds passed',
        value,
        threshold: 0,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATING EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate tier4 gating thresholds
 * 
 * @param score - The composite tier4 score (0-1 normalized)
 * @param healthScore - The microstructure health score (0-1)
 * @param volatility - The current volatility (0-1 normalized)
 * @returns Gating result with allowed flag and reason
 */
export function evaluateTier4Thresholds(
    score: number,
    healthScore: number,
    volatility: number
): Tier4GatingResult {
    // Check minimum score threshold
    if (score < MIN_SCORE) {
        return gated("Low tier4 score", score, MIN_SCORE);
    }
    
    // Check health score threshold
    if (healthScore < MIN_HEALTH_SCORE) {
        return gated("Low health score", healthScore, MIN_HEALTH_SCORE);
    }
    
    // Check volatility threshold
    if (volatility > MAX_VOLATILITY) {
        return gated("Volatility too high", volatility, MAX_VOLATILITY);
    }
    
    return allowed(score);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log active thresholds on module load
 */
export function logActiveThresholds(): void {
    logger.info(`[GATING] Relaxed thresholds active: MIN_SCORE=${MIN_SCORE}, MIN_HEALTH=${MIN_HEALTH_SCORE}, MAX_VOL=${MAX_VOLATILITY}`);
}

// Log on module initialization
logActiveThresholds();

