/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DOMINANCE ELIGIBILITY — POOL DISCOVERY FOR BIN BULLYING
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * We update pool discovery to favor DOMINANCE-FRIENDLY pools, not just safety.
 * 
 * MANDATORY TRAITS:
 * - High intraday volume
 * - Tight bin reuse (same bins traded repeatedly)
 * - Predictable reversion
 * - Trader impatience (frequent cross-bin swaps)
 * 
 * THESE POOLS:
 * - Can be bullied
 * - Cannot be "set and forget"
 * - Reward aggression disproportionately
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { PREDATOR_MODE_V1_ENABLED } from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DominanceEligibilityInput {
    poolAddress: string;
    poolName: string;
    
    // Volume metrics
    volume24hUsd: number;
    volumeIntradayUsd: number;  // Last 4 hours
    volumeConsistencyScore: number;  // 0-1, higher = more consistent
    
    // Bin metrics
    activeBinCount: number;
    binReuseRate: number;  // 0-1, how often same bins are traded
    avgBinCrossingsPerHour: number;
    dominantBinConcentration: number;  // % of volume in top bin
    
    // Trader behavior
    avgTradeSize: number;
    tradeFrequencyPerHour: number;
    slippageTolerance: number;  // Avg slippage traders accept
    urgencyScore: number;  // 0-1, higher = more impatient traders
    
    // Reversion metrics
    meanReversionScore: number;  // 0-1, how predictable price returns
    oscillationAmplitude: number;  // Typical price swing %
    oscillationFrequency: number;  // Cycles per hour
    
    // Competition
    lpCount: number;
    avgLpSize: number;
    humanLpRatio: number;  // 0-1, proportion of human vs bot LPs
}

export interface DominanceEligibilityResult {
    eligible: boolean;
    score: number;  // 0-100
    tier: 'S' | 'A' | 'B' | 'C' | 'REJECT';
    reasons: string[];
    traits: {
        highVolume: boolean;
        tightBinReuse: boolean;
        predictableReversion: boolean;
        traderImpatience: boolean;
    };
    recommendation: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const DOMINANCE_ELIGIBILITY_CONFIG = {
    // Volume thresholds
    MIN_VOLUME_24H_USD: 500_000,
    MIN_VOLUME_INTRADAY_USD: 50_000,
    VOLUME_CONSISTENCY_MIN: 0.60,
    
    // Bin behavior thresholds
    MAX_ACTIVE_BINS: 10,  // Fewer bins = easier to dominate
    MIN_BIN_REUSE_RATE: 0.50,  // At least 50% reuse
    MIN_BIN_CROSSINGS_PER_HOUR: 5,
    MIN_DOMINANT_BIN_CONCENTRATION: 0.30,  // 30% in top bin
    
    // Trader behavior thresholds
    MIN_TRADE_FREQUENCY_PER_HOUR: 10,
    MIN_URGENCY_SCORE: 0.40,
    MIN_SLIPPAGE_TOLERANCE: 0.005,  // 0.5%
    
    // Reversion thresholds
    MIN_MEAN_REVERSION_SCORE: 0.50,
    MIN_OSCILLATION_FREQUENCY: 2,  // At least 2 cycles per hour
    
    // Competition thresholds
    MAX_LP_COUNT: 50,  // Fewer LPs = less competition
    MIN_HUMAN_LP_RATIO: 0.50,  // More humans = easier to outcompete
    
    // Scoring weights
    WEIGHTS: {
        VOLUME: 0.20,
        BIN_BEHAVIOR: 0.25,
        TRADER_BEHAVIOR: 0.25,
        REVERSION: 0.20,
        COMPETITION: 0.10,
    },
    
    // Tier thresholds
    TIER_THRESHOLDS: {
        S: 85,  // Elite dominance target
        A: 70,  // Excellent target
        B: 55,  // Good target
        C: 40,  // Marginal target
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CORE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate pool for dominance eligibility
 */
export function evaluateDominanceEligibility(
    input: DominanceEligibilityInput
): DominanceEligibilityResult {
    const reasons: string[] = [];
    const config = DOMINANCE_ELIGIBILITY_CONFIG;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRAIT 1: High Volume
    // ═══════════════════════════════════════════════════════════════════════════
    const volumeScore = calculateVolumeScore(input, reasons);
    const highVolume = volumeScore >= 60;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRAIT 2: Tight Bin Reuse
    // ═══════════════════════════════════════════════════════════════════════════
    const binScore = calculateBinBehaviorScore(input, reasons);
    const tightBinReuse = binScore >= 60;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRAIT 3: Predictable Reversion
    // ═══════════════════════════════════════════════════════════════════════════
    const reversionScore = calculateReversionScore(input, reasons);
    const predictableReversion = reversionScore >= 60;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRAIT 4: Trader Impatience
    // ═══════════════════════════════════════════════════════════════════════════
    const traderScore = calculateTraderBehaviorScore(input, reasons);
    const traderImpatience = traderScore >= 60;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPETITION SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    const competitionScore = calculateCompetitionScore(input, reasons);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FINAL SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    const weights = config.WEIGHTS;
    const finalScore = 
        volumeScore * weights.VOLUME +
        binScore * weights.BIN_BEHAVIOR +
        traderScore * weights.TRADER_BEHAVIOR +
        reversionScore * weights.REVERSION +
        competitionScore * weights.COMPETITION;
    
    // Determine tier
    let tier: 'S' | 'A' | 'B' | 'C' | 'REJECT';
    if (finalScore >= config.TIER_THRESHOLDS.S) {
        tier = 'S';
    } else if (finalScore >= config.TIER_THRESHOLDS.A) {
        tier = 'A';
    } else if (finalScore >= config.TIER_THRESHOLDS.B) {
        tier = 'B';
    } else if (finalScore >= config.TIER_THRESHOLDS.C) {
        tier = 'C';
    } else {
        tier = 'REJECT';
    }
    
    // Count mandatory traits
    const mandatoryTraitCount = [highVolume, tightBinReuse, predictableReversion, traderImpatience]
        .filter(Boolean).length;
    
    // Eligibility: Need at least 3 of 4 traits AND tier >= C
    const eligible = mandatoryTraitCount >= 3 && tier !== 'REJECT';
    
    // Generate recommendation
    const recommendation = generateRecommendation(
        tier,
        eligible,
        { highVolume, tightBinReuse, predictableReversion, traderImpatience }
    );
    
    return {
        eligible,
        score: Math.round(finalScore),
        tier,
        reasons,
        traits: {
            highVolume,
            tightBinReuse,
            predictableReversion,
            traderImpatience,
        },
        recommendation,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function calculateVolumeScore(input: DominanceEligibilityInput, reasons: string[]): number {
    const config = DOMINANCE_ELIGIBILITY_CONFIG;
    let score = 0;
    
    // 24h volume
    if (input.volume24hUsd >= config.MIN_VOLUME_24H_USD) {
        const volumeMultiple = input.volume24hUsd / config.MIN_VOLUME_24H_USD;
        score += Math.min(40, 20 + volumeMultiple * 5);
        reasons.push(`✅ 24h volume: $${(input.volume24hUsd / 1000).toFixed(0)}k`);
    } else {
        reasons.push(`❌ 24h volume: $${(input.volume24hUsd / 1000).toFixed(0)}k < $${(config.MIN_VOLUME_24H_USD / 1000).toFixed(0)}k`);
    }
    
    // Intraday volume
    if (input.volumeIntradayUsd >= config.MIN_VOLUME_INTRADAY_USD) {
        score += 30;
        reasons.push(`✅ Intraday volume: $${(input.volumeIntradayUsd / 1000).toFixed(0)}k`);
    }
    
    // Consistency
    if (input.volumeConsistencyScore >= config.VOLUME_CONSISTENCY_MIN) {
        score += 30;
        reasons.push(`✅ Volume consistency: ${(input.volumeConsistencyScore * 100).toFixed(0)}%`);
    }
    
    return Math.min(100, score);
}

function calculateBinBehaviorScore(input: DominanceEligibilityInput, reasons: string[]): number {
    const config = DOMINANCE_ELIGIBILITY_CONFIG;
    let score = 0;
    
    // Active bin count (fewer is better)
    if (input.activeBinCount <= config.MAX_ACTIVE_BINS) {
        const binBonus = (config.MAX_ACTIVE_BINS - input.activeBinCount) * 3;
        score += Math.min(30, 15 + binBonus);
        reasons.push(`✅ Active bins: ${input.activeBinCount} (concentrated)`);
    } else {
        reasons.push(`❌ Active bins: ${input.activeBinCount} > ${config.MAX_ACTIVE_BINS} (too spread)`);
    }
    
    // Bin reuse rate
    if (input.binReuseRate >= config.MIN_BIN_REUSE_RATE) {
        score += 25;
        reasons.push(`✅ Bin reuse: ${(input.binReuseRate * 100).toFixed(0)}%`);
    }
    
    // Bin crossings per hour
    if (input.avgBinCrossingsPerHour >= config.MIN_BIN_CROSSINGS_PER_HOUR) {
        score += 25;
        reasons.push(`✅ Crossings/hr: ${input.avgBinCrossingsPerHour.toFixed(1)}`);
    }
    
    // Dominant bin concentration
    if (input.dominantBinConcentration >= config.MIN_DOMINANT_BIN_CONCENTRATION) {
        score += 20;
        reasons.push(`✅ Top bin: ${(input.dominantBinConcentration * 100).toFixed(0)}% of volume`);
    }
    
    return Math.min(100, score);
}

function calculateTraderBehaviorScore(input: DominanceEligibilityInput, reasons: string[]): number {
    const config = DOMINANCE_ELIGIBILITY_CONFIG;
    let score = 0;
    
    // Trade frequency
    if (input.tradeFrequencyPerHour >= config.MIN_TRADE_FREQUENCY_PER_HOUR) {
        score += 35;
        reasons.push(`✅ Trade freq: ${input.tradeFrequencyPerHour.toFixed(1)}/hr`);
    }
    
    // Urgency score
    if (input.urgencyScore >= config.MIN_URGENCY_SCORE) {
        score += 35;
        reasons.push(`✅ Trader urgency: ${(input.urgencyScore * 100).toFixed(0)}%`);
    }
    
    // Slippage tolerance
    if (input.slippageTolerance >= config.MIN_SLIPPAGE_TOLERANCE) {
        score += 30;
        reasons.push(`✅ Slippage tolerance: ${(input.slippageTolerance * 100).toFixed(1)}%`);
    }
    
    return Math.min(100, score);
}

function calculateReversionScore(input: DominanceEligibilityInput, reasons: string[]): number {
    const config = DOMINANCE_ELIGIBILITY_CONFIG;
    let score = 0;
    
    // Mean reversion
    if (input.meanReversionScore >= config.MIN_MEAN_REVERSION_SCORE) {
        score += 50;
        reasons.push(`✅ Mean reversion: ${(input.meanReversionScore * 100).toFixed(0)}%`);
    }
    
    // Oscillation frequency
    if (input.oscillationFrequency >= config.MIN_OSCILLATION_FREQUENCY) {
        score += 30;
        reasons.push(`✅ Oscillations: ${input.oscillationFrequency.toFixed(1)}/hr`);
    }
    
    // Oscillation amplitude (sweet spot: 0.5-2%)
    if (input.oscillationAmplitude >= 0.005 && input.oscillationAmplitude <= 0.03) {
        score += 20;
        reasons.push(`✅ Amplitude: ${(input.oscillationAmplitude * 100).toFixed(2)}%`);
    }
    
    return Math.min(100, score);
}

function calculateCompetitionScore(input: DominanceEligibilityInput, reasons: string[]): number {
    const config = DOMINANCE_ELIGIBILITY_CONFIG;
    let score = 0;
    
    // LP count (fewer is better)
    if (input.lpCount <= config.MAX_LP_COUNT) {
        const lpBonus = (config.MAX_LP_COUNT - input.lpCount) * 1.5;
        score += Math.min(50, 25 + lpBonus);
        reasons.push(`✅ LP count: ${input.lpCount} (low competition)`);
    } else {
        reasons.push(`❌ LP count: ${input.lpCount} > ${config.MAX_LP_COUNT} (crowded)`);
    }
    
    // Human LP ratio (more humans = easier)
    if (input.humanLpRatio >= config.MIN_HUMAN_LP_RATIO) {
        score += 50;
        reasons.push(`✅ Human LPs: ${(input.humanLpRatio * 100).toFixed(0)}%`);
    }
    
    return Math.min(100, score);
}

function generateRecommendation(
    tier: 'S' | 'A' | 'B' | 'C' | 'REJECT',
    eligible: boolean,
    traits: { highVolume: boolean; tightBinReuse: boolean; predictableReversion: boolean; traderImpatience: boolean }
): string {
    if (!eligible) {
        const missing = [];
        if (!traits.highVolume) missing.push('volume');
        if (!traits.tightBinReuse) missing.push('bin reuse');
        if (!traits.predictableReversion) missing.push('reversion');
        if (!traits.traderImpatience) missing.push('trader urgency');
        return `REJECT: Missing ${missing.join(', ')}`;
    }
    
    switch (tier) {
        case 'S':
            return 'ELITE TARGET: Maximum aggression, full bin dominance';
        case 'A':
            return 'PRIME TARGET: High aggression, single-bin focus';
        case 'B':
            return 'GOOD TARGET: Moderate aggression, monitor closely';
        case 'C':
            return 'MARGINAL: Low allocation, quick rotation if underperforms';
        default:
            return 'REJECT: Does not meet dominance criteria';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logDominanceEligibility(
    poolName: string,
    result: DominanceEligibilityResult
): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    const statusEmoji = result.eligible ? '✅' : '❌';
    const tierEmoji = {
        S: '🏆',
        A: '🥇',
        B: '🥈',
        C: '🥉',
        REJECT: '🚫',
    }[result.tier];
    
    logger.info(
        `[DOM-ELIG] ${statusEmoji} ${poolName} | ` +
        `tier=${tierEmoji}${result.tier} | ` +
        `score=${result.score} | ` +
        `${result.recommendation}`
    );
    
    if (result.eligible) {
        const traits = [];
        if (result.traits.highVolume) traits.push('VOL');
        if (result.traits.tightBinReuse) traits.push('BIN');
        if (result.traits.predictableReversion) traits.push('REV');
        if (result.traits.traderImpatience) traits.push('URG');
        logger.debug(`  Traits: ${traits.join(', ')}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    evaluateDominanceEligibility,
    logDominanceEligibility,
    DOMINANCE_ELIGIBILITY_CONFIG,
};

