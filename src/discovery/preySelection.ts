/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREY SELECTION — PREDATOR MODE v1 POOL DISCOVERY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module replaces traditional pool discovery with "Prey Selection" —
 * an aggressive pool filtering system optimized for fee extraction.
 * 
 * REMOVED / DE-EMPHASIZED:
 * - Short-term EV gating
 * - Early negative payback rejection  
 * - Microstructure fear-based filters
 * 
 * ADDED / PRIORITIZED:
 * - Hard filters for pool age, volume persistence, TVL range
 * - Soft scoring for mean-reversion, oscillation, human LP dominance
 * - Meme pool prioritization (PIPPIN/SOL, BRAIN/SOL, etc.)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    PREDATOR_MODE_V1_ENABLED,
    PREY_SELECTION_HARD_FILTERS,
    PREY_SELECTION_SOFT_SCORING,
    HIGH_VALUE_PREY_TOKENS,
    isHighValuePrey,
    meetsHardFilters,
    calculatePreyScore,
} from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PreyCandidate {
    poolAddress: string;
    poolName: string;
    tokenX: string;
    tokenY: string;
    
    // Hard filter metrics
    ageInDays: number;
    volume24hUsd: number;
    tvlUsd: number;
    volumeDaysOf7: number;  // Days with volume in last 7
    
    // Soft scoring metrics (0-100)
    meanReversionScore: number;
    binOscillationScore: number;
    humanLpDominanceScore: number;
    volumeConsistencyScore: number;
    
    // Derived
    preyScore: number;
    isHighValuePrey: boolean;
    passesHardFilters: boolean;
    hardFilterFailures: string[];
    
    // Raw metrics for downstream use
    feeRate?: number;
    binStep?: number;
    activeBinId?: number;
    feesPerHour?: number;
    swapsPerMinute?: number;
}

export interface PreySelectionResult {
    eligiblePrey: PreyCandidate[];
    rejectedPrey: PreyCandidate[];
    highValuePreyCount: number;
    totalScanned: number;
    timestamp: number;
}

export interface PoolMetricsForPrey {
    poolAddress: string;
    poolName: string;
    tokenX: string;
    tokenY: string;
    tvlUsd: number;
    volume24hUsd: number;
    feeRate?: number;
    binStep?: number;
    activeBinId?: number;
    
    // Historical metrics (if available)
    poolCreatedAt?: number;
    volumeHistory7d?: number[];
    priceHistory24h?: number[];
    binCrossings24h?: number;
    swapsPerMinute?: number;
    feesPerHour?: number;
    
    // LP metrics (if available)
    uniqueLps?: number;
    avgLpBinSpread?: number;
    
    // Calculated metrics (if pre-computed)
    entropy?: number;
    binVelocity?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREY ANALYSIS FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate pool age in days from creation timestamp
 */
function calculatePoolAgeDays(createdAtMs?: number): number {
    if (!createdAtMs || createdAtMs <= 0) {
        // Default to 14 days if unknown (assume established)
        return 14;
    }
    return Math.floor((Date.now() - createdAtMs) / (24 * 60 * 60 * 1000));
}

/**
 * Calculate volume persistence (days with volume in last 7)
 */
function calculateVolumePersistence(volumeHistory7d?: number[]): number {
    if (!volumeHistory7d || volumeHistory7d.length === 0) {
        // Default to 5 if no history (assume consistent)
        return 5;
    }
    return volumeHistory7d.filter(v => v > 10_000).length;  // >$10k counts as active
}

/**
 * Calculate mean reversion score (0-100)
 * Higher = more mean-reverting price behavior
 */
function calculateMeanReversionScore(priceHistory24h?: number[]): number {
    if (!priceHistory24h || priceHistory24h.length < 10) {
        return 50;  // Neutral
    }
    
    // Count reversals (direction changes)
    let reversals = 0;
    let lastDirection = 0;
    
    for (let i = 1; i < priceHistory24h.length; i++) {
        const diff = priceHistory24h[i] - priceHistory24h[i - 1];
        const direction = diff > 0 ? 1 : (diff < 0 ? -1 : 0);
        
        if (direction !== 0 && direction !== lastDirection && lastDirection !== 0) {
            reversals++;
        }
        if (direction !== 0) {
            lastDirection = direction;
        }
    }
    
    // More reversals = more mean-reverting
    const maxReversals = priceHistory24h.length - 1;
    const reversalRatio = reversals / Math.max(1, maxReversals);
    
    return Math.min(100, reversalRatio * 150);  // Scale and cap
}

/**
 * Calculate bin oscillation score (0-100)
 * Higher = more consistent bin crossings
 */
function calculateBinOscillationScore(
    binCrossings24h?: number,
    swapsPerMinute?: number
): number {
    // Combine bin crossings with swap frequency
    const crossingScore = Math.min(50, (binCrossings24h || 0) * 2);
    const swapScore = Math.min(50, (swapsPerMinute || 0) * 100);
    
    return crossingScore + swapScore;
}

/**
 * Calculate human LP dominance score (0-100)
 * Higher = more retail/manual LPs (easier to bully)
 */
function calculateHumanLpDominanceScore(
    uniqueLps?: number,
    avgLpBinSpread?: number
): number {
    // Fewer unique LPs with wider spreads = more human = easier to bully
    let score = 50;  // Neutral default
    
    if (uniqueLps !== undefined) {
        // Fewer LPs = easier to dominate
        if (uniqueLps < 10) score += 25;
        else if (uniqueLps < 25) score += 15;
        else if (uniqueLps < 50) score += 5;
        else score -= 10;
    }
    
    if (avgLpBinSpread !== undefined) {
        // Wider spreads = less sophisticated LPs
        if (avgLpBinSpread > 20) score += 20;
        else if (avgLpBinSpread > 10) score += 10;
        else if (avgLpBinSpread < 3) score -= 15;
    }
    
    return Math.max(0, Math.min(100, score));
}

/**
 * Calculate volume consistency score (0-100)
 * Higher = more consistent daily volume regardless of price action
 */
function calculateVolumeConsistencyScore(volumeHistory7d?: number[]): number {
    if (!volumeHistory7d || volumeHistory7d.length < 3) {
        return 50;  // Neutral
    }
    
    // Calculate coefficient of variation (lower = more consistent)
    const mean = volumeHistory7d.reduce((a, b) => a + b, 0) / volumeHistory7d.length;
    if (mean === 0) return 0;
    
    const variance = volumeHistory7d.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / volumeHistory7d.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / mean;
    
    // Lower CV = higher score (more consistent)
    // CV of 0 = 100, CV of 2+ = 0
    return Math.max(0, Math.min(100, (1 - cv / 2) * 100));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE PREY SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a single pool as potential prey
 */
export function evaluatePrey(metrics: PoolMetricsForPrey, positionSizeUsd: number = 100): PreyCandidate {
    const ageInDays = calculatePoolAgeDays(metrics.poolCreatedAt);
    const volumeDaysOf7 = calculateVolumePersistence(metrics.volumeHistory7d);
    const meanReversionScore = calculateMeanReversionScore(metrics.priceHistory24h);
    const binOscillationScore = calculateBinOscillationScore(
        metrics.binCrossings24h,
        metrics.swapsPerMinute
    );
    const humanLpDominanceScore = calculateHumanLpDominanceScore(
        metrics.uniqueLps,
        metrics.avgLpBinSpread
    );
    const volumeConsistencyScore = calculateVolumeConsistencyScore(metrics.volumeHistory7d);
    
    // Check hard filters
    const hardFilterResult = meetsHardFilters({
        ageInDays,
        volume24hUsd: metrics.volume24hUsd,
        tvlUsd: metrics.tvlUsd,
        volumeDaysOf7,
        positionSizeUsd,
    });
    
    // Calculate prey score (soft scoring)
    const tokenSymbol = metrics.tokenX || metrics.poolName.split('-')[0] || '';
    const preyScore = calculatePreyScore({
        meanReversionScore,
        binOscillationScore,
        humanLpDominanceScore,
        volumeConsistencyScore,
        tokenSymbol,
    });
    
    return {
        poolAddress: metrics.poolAddress,
        poolName: metrics.poolName,
        tokenX: metrics.tokenX,
        tokenY: metrics.tokenY,
        ageInDays,
        volume24hUsd: metrics.volume24hUsd,
        tvlUsd: metrics.tvlUsd,
        volumeDaysOf7,
        meanReversionScore,
        binOscillationScore,
        humanLpDominanceScore,
        volumeConsistencyScore,
        preyScore,
        isHighValuePrey: isHighValuePrey(tokenSymbol) || isHighValuePrey(metrics.tokenY || ''),
        passesHardFilters: hardFilterResult.passes,
        hardFilterFailures: hardFilterResult.failedReasons,
        feeRate: metrics.feeRate,
        binStep: metrics.binStep,
        activeBinId: metrics.activeBinId,
        feesPerHour: metrics.feesPerHour,
        swapsPerMinute: metrics.swapsPerMinute,
    };
}

/**
 * Select prey from a list of pool metrics
 * Returns sorted by prey score (best prey first)
 */
export function selectPrey(
    pools: PoolMetricsForPrey[],
    positionSizeUsd: number = 100,
    maxPrey: number = 50
): PreySelectionResult {
    if (!PREDATOR_MODE_V1_ENABLED) {
        // Return all pools unsorted if predator mode disabled
        const allPrey = pools.map(p => evaluatePrey(p, positionSizeUsd));
        return {
            eligiblePrey: allPrey.slice(0, maxPrey),
            rejectedPrey: [],
            highValuePreyCount: 0,
            totalScanned: pools.length,
            timestamp: Date.now(),
        };
    }
    
    const candidates = pools.map(p => evaluatePrey(p, positionSizeUsd));
    
    // Separate eligible and rejected
    const eligible = candidates.filter(c => c.passesHardFilters);
    const rejected = candidates.filter(c => !c.passesHardFilters);
    
    // Sort eligible by prey score (highest first)
    // High-value prey get boosted to top
    eligible.sort((a, b) => {
        // High-value prey always comes first
        if (a.isHighValuePrey && !b.isHighValuePrey) return -1;
        if (!a.isHighValuePrey && b.isHighValuePrey) return 1;
        // Then by prey score
        return b.preyScore - a.preyScore;
    });
    
    const result: PreySelectionResult = {
        eligiblePrey: eligible.slice(0, maxPrey),
        rejectedPrey: rejected,
        highValuePreyCount: eligible.filter(p => p.isHighValuePrey).length,
        totalScanned: pools.length,
        timestamp: Date.now(),
    };
    
    // Log summary
    logPreySelectionSummary(result);
    
    return result;
}

/**
 * Force-surface high-value prey pools that might otherwise be filtered
 * Use when we want to ensure PIPPIN/SOL, BRAIN/SOL, etc. are always considered
 */
export function forceSurfaceHighValuePrey(
    pools: PoolMetricsForPrey[],
    existingPrey: PreyCandidate[],
    maxToAdd: number = 5
): PreyCandidate[] {
    if (!PREDATOR_MODE_V1_ENABLED) return [];
    
    const existingAddresses = new Set(existingPrey.map(p => p.poolAddress));
    
    const highValueNotIncluded = pools
        .filter(p => {
            const tokenX = p.tokenX || p.poolName.split('-')[0] || '';
            const tokenY = p.tokenY || p.poolName.split('-')[1] || '';
            return (isHighValuePrey(tokenX) || isHighValuePrey(tokenY)) &&
                   !existingAddresses.has(p.poolAddress);
        })
        .map(p => evaluatePrey(p))
        .filter(c => c.volume24hUsd >= PREY_SELECTION_HARD_FILTERS.MIN_VOLUME_24H_USD * 0.5)  // 50% threshold for force-surface
        .slice(0, maxToAdd);
    
    if (highValueNotIncluded.length > 0) {
        logger.info(
            `[PREY-SELECTION] 🎯 Force-surfacing ${highValueNotIncluded.length} high-value prey: ` +
            highValueNotIncluded.map(p => p.poolName).join(', ')
        );
    }
    
    return highValueNotIncluded;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logPreySelectionSummary(result: PreySelectionResult): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('🎯 PREY SELECTION SUMMARY');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`  Scanned: ${result.totalScanned} pools`);
    logger.info(`  Eligible Prey: ${result.eligiblePrey.length}`);
    logger.info(`  High-Value Prey: ${result.highValuePreyCount} (meme/retail pools)`);
    logger.info(`  Rejected: ${result.rejectedPrey.length}`);
    
    if (result.eligiblePrey.length > 0) {
        logger.info('  Top 5 Prey:');
        result.eligiblePrey.slice(0, 5).forEach((prey, i) => {
            const hvTag = prey.isHighValuePrey ? '🔥' : '  ';
            logger.info(
                `    ${i + 1}. ${hvTag} ${prey.poolName} | ` +
                `score=${prey.preyScore.toFixed(0)} | ` +
                `vol=$${(prey.volume24hUsd / 1000).toFixed(0)}k | ` +
                `tvl=$${(prey.tvlUsd / 1000).toFixed(0)}k | ` +
                `age=${prey.ageInDays}d`
            );
        });
    }
    
    if (result.rejectedPrey.length > 0 && result.rejectedPrey.length <= 10) {
        logger.debug('  Rejection reasons:');
        result.rejectedPrey.forEach(prey => {
            logger.debug(`    ❌ ${prey.poolName}: ${prey.hardFilterFailures.join(', ')}`);
        });
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

export function logPreyCandidate(prey: PreyCandidate): void {
    const hvTag = prey.isHighValuePrey ? '🔥' : '  ';
    const passTag = prey.passesHardFilters ? '✅' : '❌';
    
    logger.info(
        `[PREY] ${hvTag}${passTag} ${prey.poolName} | ` +
        `score=${prey.preyScore.toFixed(0)} | ` +
        `vol=$${(prey.volume24hUsd / 1000).toFixed(0)}k | ` +
        `tvl=$${(prey.tvlUsd / 1000).toFixed(0)}k | ` +
        `age=${prey.ageInDays}d | ` +
        `persist=${prey.volumeDaysOf7}/7 | ` +
        `meanRev=${prey.meanReversionScore.toFixed(0)} | ` +
        `oscil=${prey.binOscillationScore.toFixed(0)} | ` +
        `humanLP=${prey.humanLpDominanceScore.toFixed(0)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    evaluatePrey,
    selectPrey,
    forceSurfaceHighValuePrey,
    logPreySelectionSummary,
    logPreyCandidate,
    // Constants
    PREY_SELECTION_HARD_FILTERS,
    PREY_SELECTION_SOFT_SCORING,
    HIGH_VALUE_PREY_TOKENS,
};

