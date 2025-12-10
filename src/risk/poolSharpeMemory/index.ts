/**
 * Pool Sharpe Memory Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Track per-pool performance and compute rolling Sharpe scores.
 * 
 * METRICS TRACKED:
 * - Realized PnL
 * - Win rate
 * - Average R multiple
 * - Drawdown
 * - Slippage impact
 * 
 * BEHAVIOR:
 * - Continuously downrank pools with poor Sharpe
 * - Up-rank pools with strong Sharpe
 * - Sharpe score becomes a gating and sizing factor
 * 
 * INTEGRATION:
 * Before entry:
 *   const sharpeResult = getPoolSharpe(poolAddress);
 *   if (sharpeResult.shouldBlock) { /* abort */ }
 *   positionSize *= sharpeResult.sharpeMultiplier;
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Type exports
export type {
    PoolTradeResult,
    PoolPerformanceMetrics,
    SharpeScoreResult,
    PoolSharpeConfig,
    PoolRanking,
} from './types';

// Config exports
export {
    DEFAULT_CONFIG,
    CONSERVATIVE_CONFIG,
    AGGRESSIVE_CONFIG,
    createConfig,
} from './config';

// Tracker exports
export {
    recordPoolTrade,
    recordTradeResult,
    getPoolMetrics,
    getAllPoolMetrics,
    getPoolRankings,
    getTopPools,
    getWorstPools,
    getPoolTrades,
    getTrackedPoolCount,
    getTotalTradeCount,
    clearAllData,
    normalizeSharpe,
} from './tracker';

// Scoring exports
export {
    computePoolSharpeScore,
    shouldBlockOnSharpe,
    getPoolSharpeMultiplier,
    getPoolSharpeScoreValue,
    isTopPerformer,
    isBottomPerformer,
} from './scoring';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

import { SharpeScoreResult, PoolRanking } from './types';
import { computePoolSharpeScore, getPoolSharpeMultiplier as getMultiplier, shouldBlockOnSharpe as checkBlock } from './scoring';
import { getPoolRankings, getTopPools, getWorstPools, getPoolMetrics, recordTradeResult as recordTrade } from './tracker';
import { DEFAULT_CONFIG } from './config';

/**
 * Get Sharpe score result for a pool.
 * This is the primary API for the Pool Sharpe Memory module.
 */
export function getPoolSharpe(poolAddress: string): SharpeScoreResult {
    return computePoolSharpeScore(poolAddress, DEFAULT_CONFIG);
}

/**
 * Get Sharpe-based position multiplier.
 */
export function getPoolSharpePositionMultiplier(poolAddress: string): number {
    return getMultiplier(poolAddress, DEFAULT_CONFIG);
}

/**
 * Check if entry should be blocked due to poor Sharpe.
 */
export function isPoolSharpeBlocked(poolAddress: string): boolean {
    return checkBlock(poolAddress, DEFAULT_CONFIG);
}

/**
 * Record a trade result.
 * Should be called on every trade exit.
 */
export function recordCompletedTrade(
    tradeId: string,
    poolAddress: string,
    poolName: string,
    entryTime: number,
    exitTime: number,
    sizeUSD: number,
    realizedPnL: number,
    slippageImpact: number = 0,
    entryScore: number = 0,
    exitScore: number = 0,
    riskAmount?: number
): void {
    recordTrade(
        tradeId,
        poolAddress,
        poolName,
        entryTime,
        exitTime,
        sizeUSD,
        realizedPnL,
        slippageImpact,
        entryScore,
        exitScore,
        riskAmount
    );
}

/**
 * Get pools sorted by Sharpe score (best first).
 */
export function getSharpeRankedPools(): PoolRanking[] {
    return getPoolRankings();
}

/**
 * Get top N performing pools.
 */
export function getTopPerformingPools(n: number = 10): PoolRanking[] {
    return getTopPools(n);
}

/**
 * Get bottom N performing pools.
 */
export function getBottomPerformingPools(n: number = 10): PoolRanking[] {
    return getWorstPools(n);
}

/**
 * Check if a pool has sufficient trade history.
 */
export function hasPoolTradeHistory(poolAddress: string): boolean {
    const metrics = getPoolMetrics(poolAddress);
    return metrics !== undefined && metrics.totalTrades >= DEFAULT_CONFIG.minTradesForSharpe;
}

/**
 * Get pool win rate if available.
 */
export function getPoolWinRate(poolAddress: string): number | undefined {
    const metrics = getPoolMetrics(poolAddress);
    return metrics?.winRate;
}

/**
 * Get pool total PnL if available.
 */
export function getPoolTotalPnL(poolAddress: string): number | undefined {
    const metrics = getPoolMetrics(poolAddress);
    return metrics?.totalPnL;
}

