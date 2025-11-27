/**
 * Position Sizing Engine - Tier 3 Architecture
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Implements elastic position sizing based on:
 * - Score-based entry sizing (2-4% of wallet)
 * - Momentum-based scale sizing (6-12% of wallet)
 * - Hard exposure cap (30% of wallet)
 * 
 * NO external config.
 * NO randomness.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { getMomentumSlopes } from '../scoring/momentumEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Position sizing result
 */
export interface PositionSizeResult {
    size: number;           // Absolute amount
    maxExposure: number;    // Maximum allowed exposure
    sizePercent: number;    // Size as percentage of wallet
    reason: string;         // Sizing decision reason
}

/**
 * Scale sizing result (extends position size)
 */
export interface ScaleSizeResult extends PositionSizeResult {
    canScale: boolean;      // Whether scaling is allowed
    currentExposure: number; // Current total exposure
    remainingExposure: number; // Space left before max
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS (HARDCODED - NO EXTERNAL CONFIG)
// ═══════════════════════════════════════════════════════════════════════════════

// Entry sizing thresholds
const ENTRY_THRESHOLDS = {
    refuseBelow: 32,        // score < 32 → refuse entry
    tier1: 32,              // 32 ≤ score < 45 → 2%
    tier2: 45,              // 45 ≤ score < 60 → 3%
    tier3: 60,              // score ≥ 60 → 4%
};

// Entry sizing percentages
const ENTRY_SIZES = {
    tier1: 0.02,            // 2% of wallet
    tier2: 0.03,            // 3% of wallet
    tier3: 0.04,            // 4% of wallet
};

// Scale sizing
const SCALE_THRESHOLDS = {
    minScore: 45,           // Minimum score to scale
};

const SCALE_SIZES = {
    min: 0.06,              // 6% of wallet
    max: 0.12,              // 12% of wallet
};

// Hard exposure cap
const MAX_EXPOSURE = 0.30;  // 30% of wallet

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY SIZING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate entry position size based on score and volatility.
 * 
 * Rules:
 * - score < 32 → refuse entry (size = 0)
 * - 32 ≤ score < 45 → size = 2% of wallet
 * - 45 ≤ score < 60 → size = 3% of wallet
 * - score ≥ 60 → size = 4% of wallet
 * 
 * Volatility adjustment:
 * - High volatility reduces size slightly for risk management
 * 
 * @param score - Pool score (typically 0-100+)
 * @param volatility - Volatility measure (0-1)
 * @param walletBalance - Current wallet balance
 * @returns Position size result
 */
export function calcEntrySize(
    score: number,
    volatility: number,
    walletBalance: number
): PositionSizeResult {
    const maxExposure = MAX_EXPOSURE * walletBalance;
    
    // Gate: Refuse entry if score < 32
    if (score < ENTRY_THRESHOLDS.refuseBelow) {
        logger.info(
            `[POSITION] ENTRY REFUSED score=${score.toFixed(1)} < ${ENTRY_THRESHOLDS.refuseBelow}`
        );
        
        return {
            size: 0,
            maxExposure,
            sizePercent: 0,
            reason: `Score ${score.toFixed(1)} below minimum ${ENTRY_THRESHOLDS.refuseBelow}`,
        };
    }
    
    // Determine base size tier
    let basePercent: number;
    let tier: string;
    
    if (score >= ENTRY_THRESHOLDS.tier3) {
        basePercent = ENTRY_SIZES.tier3;  // 4%
        tier = 'TIER3 (≥60)';
    } else if (score >= ENTRY_THRESHOLDS.tier2) {
        basePercent = ENTRY_SIZES.tier2;  // 3%
        tier = 'TIER2 (45-60)';
    } else {
        basePercent = ENTRY_SIZES.tier1;  // 2%
        tier = 'TIER1 (32-45)';
    }
    
    // Apply volatility adjustment (reduce size in high volatility)
    // Volatility 0.5 = no adjustment
    // Volatility 1.0 = 20% reduction
    // Volatility 0.0 = 10% increase
    const volatilityMultiplier = 1.1 - (volatility * 0.3);
    const adjustedPercent = basePercent * Math.max(0.8, Math.min(1.1, volatilityMultiplier));
    
    // Calculate absolute size
    const size = adjustedPercent * walletBalance;
    
    logger.info(
        `[POSITION] ENTRY size=${(adjustedPercent * 100).toFixed(1)}% ` +
        `wallet=$${walletBalance.toFixed(0)} amount=$${size.toFixed(2)} ` +
        `tier=${tier} score=${score.toFixed(1)} volatility=${volatility.toFixed(2)}`
    );
    
    return {
        size,
        maxExposure,
        sizePercent: adjustedPercent,
        reason: `${tier}: ${(adjustedPercent * 100).toFixed(1)}% of wallet`,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCALE SIZING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate scale (add-on) position size.
 * 
 * Rules:
 * - score ≥ 45 AND velocitySlope > 0 AND liquiditySlope > 0 → allow scale
 * - Scale size: 6-12% of wallet (interpolated by score)
 * - Hard cap: Total exposure cannot exceed 30% of wallet
 * 
 * @param score - Pool score (typically 0-100+)
 * @param volatility - Volatility measure (0-1)
 * @param walletBalance - Current wallet balance
 * @param poolId - Pool address (for slope lookup)
 * @param currentExposure - Current exposure in this pool (optional)
 * @returns Scale size result
 */
export function calcScaleSize(
    score: number,
    volatility: number,
    walletBalance: number,
    poolId?: string,
    currentExposure: number = 0
): ScaleSizeResult {
    const maxExposure = MAX_EXPOSURE * walletBalance;
    const remainingExposure = Math.max(0, maxExposure - currentExposure);
    
    // Check momentum slopes if poolId provided
    let velocitySlope = 0;
    let liquiditySlope = 0;
    
    if (poolId) {
        const slopes = getMomentumSlopes(poolId);
        if (slopes && slopes.valid) {
            velocitySlope = slopes.velocitySlope;
            liquiditySlope = slopes.liquiditySlope;
        }
    }
    
    // Gate: Refuse scale if conditions not met
    if (score < SCALE_THRESHOLDS.minScore) {
        logger.info(
            `[POSITION] SCALE REFUSED score=${score.toFixed(1)} < ${SCALE_THRESHOLDS.minScore}`
        );
        
        return {
            size: 0,
            maxExposure,
            sizePercent: 0,
            reason: `Score ${score.toFixed(1)} below minimum ${SCALE_THRESHOLDS.minScore}`,
            canScale: false,
            currentExposure,
            remainingExposure,
        };
    }
    
    if (velocitySlope <= 0 && poolId) {
        logger.info(
            `[POSITION] SCALE REFUSED velocitySlope=${velocitySlope.toFixed(6)} <= 0`
        );
        
        return {
            size: 0,
            maxExposure,
            sizePercent: 0,
            reason: `Velocity slope ${velocitySlope.toFixed(6)} not positive`,
            canScale: false,
            currentExposure,
            remainingExposure,
        };
    }
    
    if (liquiditySlope <= 0 && poolId) {
        logger.info(
            `[POSITION] SCALE REFUSED liquiditySlope=${liquiditySlope.toFixed(6)} <= 0`
        );
        
        return {
            size: 0,
            maxExposure,
            sizePercent: 0,
            reason: `Liquidity slope ${liquiditySlope.toFixed(6)} not positive`,
            canScale: false,
            currentExposure,
            remainingExposure,
        };
    }
    
    // Check remaining exposure
    if (remainingExposure <= 0) {
        logger.info(
            `[POSITION] SCALE REFUSED exposure=${currentExposure.toFixed(2)} at max=${maxExposure.toFixed(2)}`
        );
        
        return {
            size: 0,
            maxExposure,
            sizePercent: 0,
            reason: `At maximum exposure (${(MAX_EXPOSURE * 100).toFixed(0)}% of wallet)`,
            canScale: false,
            currentExposure,
            remainingExposure,
        };
    }
    
    // Calculate scale size (6-12% interpolated by score)
    // score 45 → 6%, score 100 → 12%
    const scoreRange = 100 - SCALE_THRESHOLDS.minScore; // 55
    const scoreProgress = Math.min(1, (score - SCALE_THRESHOLDS.minScore) / scoreRange);
    const scaleRange = SCALE_SIZES.max - SCALE_SIZES.min; // 0.06
    const basePercent = SCALE_SIZES.min + (scoreProgress * scaleRange);
    
    // Apply volatility adjustment (reduce in high volatility)
    const volatilityMultiplier = 1.1 - (volatility * 0.3);
    const adjustedPercent = basePercent * Math.max(0.8, Math.min(1.1, volatilityMultiplier));
    
    // Calculate absolute size
    let size = adjustedPercent * walletBalance;
    
    // Cap at remaining exposure
    if (size > remainingExposure) {
        size = remainingExposure;
        logger.info(
            `[POSITION] SCALE capped at remaining exposure $${remainingExposure.toFixed(2)}`
        );
    }
    
    const actualPercent = size / walletBalance;
    
    logger.info(
        `[POSITION] SCALE size=${(actualPercent * 100).toFixed(1)}% ` +
        `wallet=$${walletBalance.toFixed(0)} amount=$${size.toFixed(2)} ` +
        `score=${score.toFixed(1)} slopeV=${velocitySlope.toFixed(6)} slopeL=${liquiditySlope.toFixed(6)}`
    );
    
    return {
        size,
        maxExposure,
        sizePercent: actualPercent,
        reason: `Scale: ${(actualPercent * 100).toFixed(1)}% of wallet (score ${score.toFixed(1)})`,
        canScale: true,
        currentExposure,
        remainingExposure: remainingExposure - size,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPOSURE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if adding a position would exceed max exposure.
 * 
 * @param proposedSize - Size of proposed position
 * @param currentTotalExposure - Current total exposure across all positions
 * @param walletBalance - Current wallet balance
 * @returns Whether the position can be added
 */
export function canAddPosition(
    proposedSize: number,
    currentTotalExposure: number,
    walletBalance: number
): { allowed: boolean; reason: string } {
    const maxExposure = MAX_EXPOSURE * walletBalance;
    const newTotalExposure = currentTotalExposure + proposedSize;
    
    if (newTotalExposure > maxExposure) {
        return {
            allowed: false,
            reason: `Would exceed max exposure: $${newTotalExposure.toFixed(2)} > $${maxExposure.toFixed(2)} (${(MAX_EXPOSURE * 100).toFixed(0)}%)`,
        };
    }
    
    return {
        allowed: true,
        reason: `Within limits: $${newTotalExposure.toFixed(2)} / $${maxExposure.toFixed(2)}`,
    };
}

/**
 * Get maximum position size that can be added given current exposure.
 * 
 * @param currentTotalExposure - Current total exposure across all positions
 * @param walletBalance - Current wallet balance
 * @returns Maximum additional size allowed
 */
export function getMaxAddableSize(
    currentTotalExposure: number,
    walletBalance: number
): number {
    const maxExposure = MAX_EXPOSURE * walletBalance;
    return Math.max(0, maxExposure - currentTotalExposure);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    ENTRY_THRESHOLDS,
    ENTRY_SIZES,
    SCALE_THRESHOLDS,
    SCALE_SIZES,
    MAX_EXPOSURE,
};

