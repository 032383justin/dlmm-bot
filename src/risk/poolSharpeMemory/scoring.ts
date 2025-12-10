/**
 * Pool Sharpe Memory - Scoring
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Computes Sharpe-based scoring and sizing recommendations for pools.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
    PoolPerformanceMetrics,
    SharpeScoreResult,
    PoolSharpeConfig,
} from './types';
import { DEFAULT_CONFIG } from './config';
import { getPoolMetrics, normalizeSharpe } from './tracker';

/**
 * Compute Sharpe score result for a pool
 */
export function computePoolSharpeScore(
    poolAddress: string,
    config: PoolSharpeConfig = DEFAULT_CONFIG
): SharpeScoreResult {
    const now = Date.now();
    const metrics = getPoolMetrics(poolAddress);
    
    // If no metrics, return default score
    if (!metrics) {
        return {
            poolAddress,
            sharpeScore: config.defaultSharpe,
            normalizedSharpe: normalizeSharpe(config.defaultSharpe),
            sharpeMultiplier: 1.0,
            shouldBlock: false,
            reason: 'No trade history for this pool, using default Sharpe',
            metrics: createEmptyMetrics(poolAddress),
            timestamp: now,
        };
    }
    
    // Check if enough trades for valid Sharpe
    if (metrics.totalTrades < config.minTradesForSharpe) {
        return {
            poolAddress,
            sharpeScore: config.defaultSharpe,
            normalizedSharpe: normalizeSharpe(config.defaultSharpe),
            sharpeMultiplier: 1.0,
            shouldBlock: false,
            reason: `Insufficient trades (${metrics.totalTrades}/${config.minTradesForSharpe}), using default Sharpe`,
            metrics,
            timestamp: now,
        };
    }
    
    const sharpeScore = metrics.sharpeScore;
    const normalizedSharpe = normalizeSharpe(sharpeScore);
    
    let sharpeMultiplier: number;
    let shouldBlock: boolean;
    let reason: string;
    
    // Determine multiplier and blocking
    if (sharpeScore < config.blockThreshold) {
        sharpeMultiplier = 0;
        shouldBlock = true;
        reason = `Sharpe ${sharpeScore.toFixed(2)} < ${config.blockThreshold} block threshold`;
    } else if (sharpeScore < config.reduceThreshold) {
        sharpeMultiplier = config.poorSharpeMultiplier;
        shouldBlock = false;
        reason = `Sharpe ${sharpeScore.toFixed(2)} < ${config.reduceThreshold} → size reduced by ${((1 - config.poorSharpeMultiplier) * 100).toFixed(0)}%`;
    } else if (sharpeScore > config.boostThreshold) {
        sharpeMultiplier = config.excellentSharpeMultiplier;
        shouldBlock = false;
        reason = `Sharpe ${sharpeScore.toFixed(2)} > ${config.boostThreshold} → size boosted by ${((config.excellentSharpeMultiplier - 1) * 100).toFixed(0)}%`;
    } else {
        // Interpolate between reduceThreshold and boostThreshold
        const range = config.boostThreshold - config.reduceThreshold;
        const position = (sharpeScore - config.reduceThreshold) / range;
        sharpeMultiplier = config.poorSharpeMultiplier + position * (config.excellentSharpeMultiplier - config.poorSharpeMultiplier);
        shouldBlock = false;
        reason = `Sharpe ${sharpeScore.toFixed(2)} → interpolated multiplier ${sharpeMultiplier.toFixed(2)}`;
    }
    
    return {
        poolAddress,
        sharpeScore,
        normalizedSharpe,
        sharpeMultiplier,
        shouldBlock,
        reason,
        metrics,
        timestamp: now,
    };
}

/**
 * Check if a pool should be blocked due to poor Sharpe
 */
export function shouldBlockOnSharpe(
    poolAddress: string,
    config: PoolSharpeConfig = DEFAULT_CONFIG
): boolean {
    const result = computePoolSharpeScore(poolAddress, config);
    return result.shouldBlock;
}

/**
 * Get Sharpe-based position multiplier for a pool
 */
export function getPoolSharpeMultiplier(
    poolAddress: string,
    config: PoolSharpeConfig = DEFAULT_CONFIG
): number {
    const result = computePoolSharpeScore(poolAddress, config);
    return result.sharpeMultiplier;
}

/**
 * Get raw Sharpe score for a pool
 */
export function getPoolSharpeScoreValue(
    poolAddress: string,
    config: PoolSharpeConfig = DEFAULT_CONFIG
): number {
    const metrics = getPoolMetrics(poolAddress);
    return metrics?.sharpeScore ?? config.defaultSharpe;
}

/**
 * Check if a pool is in the top performers
 */
export function isTopPerformer(
    poolAddress: string,
    topN: number = 10
): boolean {
    const metrics = getPoolMetrics(poolAddress);
    if (!metrics) return false;
    return metrics.sharpeRank <= topN;
}

/**
 * Check if a pool is in the bottom performers
 */
export function isBottomPerformer(
    poolAddress: string,
    bottomN: number = 10,
    totalPools?: number
): boolean {
    const metrics = getPoolMetrics(poolAddress);
    if (!metrics) return false;
    
    // Need to know total pools to determine bottom
    const total = totalPools ?? metrics.sharpeRank; // Fallback to rank as estimate
    return metrics.sharpeRank > total - bottomN;
}

/**
 * Create empty metrics placeholder
 */
function createEmptyMetrics(poolAddress: string): PoolPerformanceMetrics {
    return {
        poolAddress,
        poolName: 'Unknown',
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnL: 0,
        avgPnL: 0,
        avgRMultiple: 0,
        bestTradePnL: 0,
        worstTradePnL: 0,
        maxDrawdown: 0,
        avgSlippageImpact: 0,
        avgHoldDurationMs: 0,
        firstTradeTime: 0,
        lastTradeTime: 0,
        sharpeScore: 0,
        sharpeRank: 0,
        lastUpdated: Date.now(),
    };
}

