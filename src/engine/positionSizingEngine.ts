/**
 * Position Sizing Engine - Tier 4 Architecture
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Implements Tier 4 position sizing with:
 * - Regime-aware entry sizing
 * - Dynamic bin width based on score
 * - Score-based entry sizing (2-4% of wallet)
 * - Momentum-based scale sizing (6-12% of wallet)
 * - Hard exposure cap (30% of wallet)
 * 
 * Tier 4 Bin Width Rules:
 * - score > 45 → narrow bins (5-12)
 * - score > 35 → medium bins (8-18)
 * - else → wide bins (12-26)
 * 
 * Dynamic Entry Thresholds:
 * - BULL: 28
 * - NEUTRAL: 32
 * - BEAR: 36
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { getMomentumSlopes } from '../scoring/momentumEngine';
import { MarketRegime, BinWidthConfig } from '../types';

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
    regime: MarketRegime;   // Market regime used
}

/**
 * Scale sizing result
 */
export interface ScaleSizeResult extends PositionSizeResult {
    canScale: boolean;
    currentExposure: number;
    remainingExposure: number;
}

/**
 * Bin width result
 */
export interface BinWidthResult {
    config: BinWidthConfig;
    halfWidth: number;
    bins: number[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dynamic entry thresholds per regime
 */
const REGIME_ENTRY_THRESHOLDS: Record<MarketRegime, number> = {
    BULL: 28,
    NEUTRAL: 32,
    BEAR: 36,
};

/**
 * Entry sizing by score tiers
 */
const ENTRY_TIERS = {
    tier1: { minScore: 0, maxScore: 45, percent: 0.02 },    // 2%
    tier2: { minScore: 45, maxScore: 60, percent: 0.03 },   // 3%
    tier3: { minScore: 60, maxScore: 100, percent: 0.04 }, // 4%
};

/**
 * Scale sizing
 */
const SCALE_CONFIG = {
    minScore: 45,
    minPercent: 0.06,   // 6%
    maxPercent: 0.12,   // 12%
};

/**
 * Exposure caps
 */
export const MAX_EXPOSURE = 0.30;  // 30% of wallet

/**
 * Tier 4 bin width configurations
 */
const BIN_WIDTH_CONFIGS: Record<string, BinWidthConfig> = {
    narrow: { min: 5, max: 12, label: 'NARROW (high score)' },
    medium: { min: 8, max: 18, label: 'MEDIUM (moderate score)' },
    wide: { min: 12, max: 26, label: 'WIDE (low score)' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY THRESHOLDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get dynamic entry threshold based on regime
 */
export function getEntryThreshold(regime: MarketRegime): number {
    return REGIME_ENTRY_THRESHOLDS[regime];
}

/**
 * Check if score meets entry threshold for regime
 */
export function meetsEntryThreshold(score: number, regime: MarketRegime): boolean {
    return score >= getEntryThreshold(regime);
}

// Legacy export for backwards compatibility
export const ENTRY_THRESHOLDS = {
    refuseBelow: REGIME_ENTRY_THRESHOLDS.NEUTRAL, // Default to NEUTRAL
    tier1: 32,
    tier2: 45,
    tier3: 60,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 BIN WIDTH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Tier 4 bin width based on score
 * 
 * score > 45 → narrow bins (5-12)
 * score > 35 → medium bins (8-18)
 * else → wide bins (12-26)
 */
export function calcBinWidth(tier4Score: number, activeBin: number): BinWidthResult {
    let config: BinWidthConfig;
    
    if (tier4Score > 45) {
        config = BIN_WIDTH_CONFIGS.narrow;
    } else if (tier4Score > 35) {
        config = BIN_WIDTH_CONFIGS.medium;
    } else {
        config = BIN_WIDTH_CONFIGS.wide;
    }
    
    // Calculate half width (for symmetric distribution around active bin)
    const avgWidth = Math.floor((config.min + config.max) / 2);
    const halfWidth = Math.floor(avgWidth / 2);
    
    // Generate bin array
    const bins: number[] = [];
    for (let i = -halfWidth; i <= halfWidth; i++) {
        bins.push(activeBin + i);
    }
    
    logger.info(
        `[BIN WIDTH] ${config.label} (${config.min}-${config.max}) ` +
        `score=${tier4Score.toFixed(1)} bins=[${activeBin - halfWidth}...${activeBin + halfWidth}]`
    );
    
    return {
        config,
        halfWidth,
        bins,
    };
}

/**
 * Get bin width config based on score (without logging)
 */
export function getBinWidthConfig(tier4Score: number): BinWidthConfig {
    if (tier4Score > 45) {
        return BIN_WIDTH_CONFIGS.narrow;
    }
    if (tier4Score > 35) {
        return BIN_WIDTH_CONFIGS.medium;
    }
    return BIN_WIDTH_CONFIGS.wide;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY SIZING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate entry position size based on Tier 4 score and regime.
 * 
 * Rules:
 * - score < regime threshold → refuse entry
 * - threshold ≤ score < 45 → size = 2% of wallet
 * - 45 ≤ score < 60 → size = 3% of wallet
 * - score ≥ 60 → size = 4% of wallet
 */
export function calcEntrySize(
    score: number,
    volatility: number,
    walletBalance: number,
    regime: MarketRegime = 'NEUTRAL'
): PositionSizeResult {
    const maxExposure = MAX_EXPOSURE * walletBalance;
    const entryThreshold = getEntryThreshold(regime);
    
    // Gate: Refuse entry if score below regime threshold
    if (score < entryThreshold) {
        logger.info(
            `[POSITION] ENTRY REFUSED score=${score.toFixed(1)} < ${entryThreshold} (${regime})`
        );
        
        return {
            size: 0,
            maxExposure,
            sizePercent: 0,
            reason: `Score ${score.toFixed(1)} below ${regime} threshold ${entryThreshold}`,
            regime,
        };
    }
    
    // Determine base size tier
    let basePercent: number;
    let tier: string;
    
    if (score >= ENTRY_TIERS.tier3.minScore) {
        basePercent = ENTRY_TIERS.tier3.percent;  // 4%
        tier = 'TIER3 (≥60)';
    } else if (score >= ENTRY_TIERS.tier2.minScore) {
        basePercent = ENTRY_TIERS.tier2.percent;  // 3%
        tier = 'TIER2 (45-60)';
    } else {
        basePercent = ENTRY_TIERS.tier1.percent;  // 2%
        tier = 'TIER1 (threshold-45)';
    }
    
    // Apply volatility adjustment
    const volatilityMultiplier = 1.1 - (volatility * 0.3);
    const adjustedPercent = basePercent * Math.max(0.8, Math.min(1.1, volatilityMultiplier));
    
    // Calculate absolute size
    const size = adjustedPercent * walletBalance;
    
    logger.info(
        `[POSITION] ENTRY size=${(adjustedPercent * 100).toFixed(1)}% ` +
        `wallet=$${walletBalance.toFixed(0)} amount=$${size.toFixed(2)} ` +
        `tier=${tier} score=${score.toFixed(1)} regime=${regime} volatility=${volatility.toFixed(2)}`
    );
    
    return {
        size,
        maxExposure,
        sizePercent: adjustedPercent,
        reason: `${tier}: ${(adjustedPercent * 100).toFixed(1)}% of wallet (${regime})`,
        regime,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCALE SIZING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate scale (add-on) position size.
 * 
 * Rules:
 * - score ≥ 45 AND positive slopes → allow scale
 * - Scale size: 6-12% of wallet (interpolated by score)
 * - Hard cap: Total exposure cannot exceed 30% of wallet
 */
export function calcScaleSize(
    score: number,
    volatility: number,
    walletBalance: number,
    poolId?: string,
    currentExposure: number = 0,
    regime: MarketRegime = 'NEUTRAL'
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
    
    // Gate: Refuse scale if score below threshold
    if (score < SCALE_CONFIG.minScore) {
        logger.info(
            `[POSITION] SCALE REFUSED score=${score.toFixed(1)} < ${SCALE_CONFIG.minScore}`
        );
        
        return {
            size: 0,
            maxExposure,
            sizePercent: 0,
            reason: `Score ${score.toFixed(1)} below minimum ${SCALE_CONFIG.minScore}`,
            regime,
            canScale: false,
            currentExposure,
            remainingExposure,
        };
    }
    
    // Gate: Check slopes if poolId provided
    if (poolId && velocitySlope <= 0) {
        logger.info(
            `[POSITION] SCALE REFUSED velocitySlope=${velocitySlope.toFixed(6)} <= 0`
        );
        
        return {
            size: 0,
            maxExposure,
            sizePercent: 0,
            reason: `Velocity slope ${velocitySlope.toFixed(6)} not positive`,
            regime,
            canScale: false,
            currentExposure,
            remainingExposure,
        };
    }
    
    if (poolId && liquiditySlope <= 0) {
        logger.info(
            `[POSITION] SCALE REFUSED liquiditySlope=${liquiditySlope.toFixed(6)} <= 0`
        );
        
        return {
            size: 0,
            maxExposure,
            sizePercent: 0,
            reason: `Liquidity slope ${liquiditySlope.toFixed(6)} not positive`,
            regime,
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
            regime,
            canScale: false,
            currentExposure,
            remainingExposure,
        };
    }
    
    // Calculate scale size (6-12% interpolated by score)
    const scoreRange = 100 - SCALE_CONFIG.minScore;
    const scoreProgress = Math.min(1, (score - SCALE_CONFIG.minScore) / scoreRange);
    const scaleRange = SCALE_CONFIG.maxPercent - SCALE_CONFIG.minPercent;
    const basePercent = SCALE_CONFIG.minPercent + (scoreProgress * scaleRange);
    
    // Apply volatility adjustment
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
        `score=${score.toFixed(1)} regime=${regime} ` +
        `slopeV=${velocitySlope.toFixed(6)} slopeL=${liquiditySlope.toFixed(6)}`
    );
    
    return {
        size,
        maxExposure,
        sizePercent: actualPercent,
        reason: `Scale: ${(actualPercent * 100).toFixed(1)}% of wallet (score ${score.toFixed(1)}, ${regime})`,
        regime,
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
    REGIME_ENTRY_THRESHOLDS,
    ENTRY_TIERS,
    SCALE_CONFIG,
    BIN_WIDTH_CONFIGS,
};

// Legacy exports
export const ENTRY_SIZES = {
    tier1: ENTRY_TIERS.tier1.percent,
    tier2: ENTRY_TIERS.tier2.percent,
    tier3: ENTRY_TIERS.tier3.percent,
};

export const SCALE_THRESHOLDS = {
    minScore: SCALE_CONFIG.minScore,
};

export const SCALE_SIZES = {
    min: SCALE_CONFIG.minPercent,
    max: SCALE_CONFIG.maxPercent,
};
