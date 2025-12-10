/**
 * Pool Sharpe Memory - Tracker
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tracks per-pool trade results and computes rolling performance metrics.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
    PoolTradeResult,
    PoolPerformanceMetrics,
    PoolRanking,
} from './types';
import { DEFAULT_CONFIG, PoolSharpeConfig } from './config';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const poolTrades: Map<string, PoolTradeResult[]> = new Map();
const poolMetrics: Map<string, PoolPerformanceMetrics> = new Map();
let lastCleanupTime = Date.now();

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE RECORDING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a completed trade for a pool
 */
export function recordPoolTrade(trade: PoolTradeResult): void {
    const poolAddress = trade.poolAddress;
    
    if (!poolTrades.has(poolAddress)) {
        poolTrades.set(poolAddress, []);
    }
    
    poolTrades.get(poolAddress)!.push(trade);
    
    // Recompute metrics for this pool
    recomputePoolMetrics(poolAddress);
    
    // Periodic cleanup
    const now = Date.now();
    if (now - lastCleanupTime > 60 * 60 * 1000) {
        cleanupOldTrades();
        lastCleanupTime = now;
    }
}

/**
 * Record a trade result from raw data
 */
export function recordTradeResult(
    tradeId: string,
    poolAddress: string,
    poolName: string,
    entryTime: number,
    exitTime: number,
    sizeUSD: number,
    realizedPnL: number,
    slippageImpact: number,
    entryScore: number,
    exitScore: number,
    riskAmount?: number
): void {
    const pnlPercent = sizeUSD > 0 ? realizedPnL / sizeUSD : 0;
    const rMultiple = riskAmount && riskAmount > 0 ? realizedPnL / riskAmount : pnlPercent * 10;
    
    recordPoolTrade({
        tradeId,
        poolAddress,
        poolName,
        entryTime,
        exitTime,
        sizeUSD,
        realizedPnL,
        pnlPercent,
        isWin: realizedPnL > 0,
        rMultiple,
        slippageImpact,
        holdDurationMs: exitTime - entryTime,
        entryScore,
        exitScore,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Recompute metrics for a specific pool
 */
function recomputePoolMetrics(
    poolAddress: string,
    config: PoolSharpeConfig = DEFAULT_CONFIG
): void {
    const trades = poolTrades.get(poolAddress);
    if (!trades || trades.length === 0) {
        poolMetrics.delete(poolAddress);
        return;
    }
    
    // Filter trades within rolling window
    const now = Date.now();
    const windowStart = now - config.rollingWindowMs;
    const recentTrades = trades.filter(t => t.exitTime >= windowStart);
    
    if (recentTrades.length === 0) {
        poolMetrics.delete(poolAddress);
        return;
    }
    
    // Compute basic metrics
    const winningTrades = recentTrades.filter(t => t.isWin);
    const losingTrades = recentTrades.filter(t => !t.isWin);
    const totalPnL = recentTrades.reduce((sum, t) => sum + t.realizedPnL, 0);
    const avgPnL = totalPnL / recentTrades.length;
    const avgRMultiple = recentTrades.reduce((sum, t) => sum + t.rMultiple, 0) / recentTrades.length;
    const avgSlippageImpact = recentTrades.reduce((sum, t) => sum + t.slippageImpact, 0) / recentTrades.length;
    const avgHoldDurationMs = recentTrades.reduce((sum, t) => sum + t.holdDurationMs, 0) / recentTrades.length;
    
    // Find best/worst trades
    const bestTradePnL = Math.max(...recentTrades.map(t => t.realizedPnL));
    const worstTradePnL = Math.min(...recentTrades.map(t => t.realizedPnL));
    
    // Calculate max drawdown
    const maxDrawdown = calculateMaxDrawdown(recentTrades);
    
    // Calculate Sharpe score
    const sharpeScore = calculateSharpeScore(recentTrades, config);
    
    const metrics: PoolPerformanceMetrics = {
        poolAddress,
        poolName: recentTrades[0].poolName,
        totalTrades: recentTrades.length,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRate: recentTrades.length > 0 ? winningTrades.length / recentTrades.length : 0,
        totalPnL,
        avgPnL,
        avgRMultiple,
        bestTradePnL,
        worstTradePnL,
        maxDrawdown,
        avgSlippageImpact,
        avgHoldDurationMs,
        firstTradeTime: Math.min(...recentTrades.map(t => t.entryTime)),
        lastTradeTime: Math.max(...recentTrades.map(t => t.exitTime)),
        sharpeScore,
        sharpeRank: 0, // Will be computed in ranking
        lastUpdated: now,
    };
    
    poolMetrics.set(poolAddress, metrics);
    
    // Update rankings
    updateRankings();
}

/**
 * Calculate max drawdown from trade sequence
 */
function calculateMaxDrawdown(trades: PoolTradeResult[]): number {
    if (trades.length === 0) return 0;
    
    // Sort by exit time
    const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
    
    let peak = 0;
    let maxDD = 0;
    let cumPnL = 0;
    
    for (const trade of sorted) {
        cumPnL += trade.realizedPnL;
        
        if (cumPnL > peak) {
            peak = cumPnL;
        }
        
        const drawdown = peak - cumPnL;
        if (drawdown > maxDD) {
            maxDD = drawdown;
        }
    }
    
    // Express as percentage of peak (or initial capital estimate)
    const totalValue = Math.max(1, sorted.reduce((sum, t) => sum + t.sizeUSD, 0) / sorted.length);
    return maxDD / totalValue;
}

/**
 * Calculate Sharpe score for a pool
 */
function calculateSharpeScore(
    trades: PoolTradeResult[],
    config: PoolSharpeConfig
): number {
    if (trades.length < config.minTradesForSharpe) {
        return config.defaultSharpe;
    }
    
    // Get returns as percentages with decay weighting
    const returns: number[] = [];
    const weights: number[] = [];
    
    // Sort by exit time (newest first)
    const sorted = [...trades].sort((a, b) => b.exitTime - a.exitTime);
    
    for (let i = 0; i < sorted.length; i++) {
        returns.push(sorted[i].pnlPercent);
        weights.push(Math.pow(config.decayFactor, i));
    }
    
    // Weighted mean return
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const weightedMean = returns.reduce((sum, r, i) => sum + r * weights[i], 0) / totalWeight;
    
    // Weighted standard deviation
    const weightedVariance = returns.reduce((sum, r, i) => {
        const diff = r - weightedMean;
        return sum + weights[i] * diff * diff;
    }, 0) / totalWeight;
    
    const stdDev = Math.sqrt(weightedVariance);
    
    // Avoid division by zero
    if (stdDev < 0.001) {
        return weightedMean > 0 ? 2.0 : -2.0; // Consistent returns
    }
    
    // Annualized Sharpe (assuming ~250 trades per year equivalent)
    const annualizationFactor = Math.sqrt(250 / Math.max(1, trades.length));
    const riskFreePerTrade = config.riskFreeRate / 250;
    
    const sharpe = ((weightedMean - riskFreePerTrade) / stdDev) * annualizationFactor;
    
    // Clamp to reasonable range
    return Math.max(-5, Math.min(5, sharpe));
}

/**
 * Update pool rankings based on Sharpe scores
 */
function updateRankings(): void {
    const allMetrics = Array.from(poolMetrics.values());
    
    // Sort by Sharpe score (descending)
    allMetrics.sort((a, b) => b.sharpeScore - a.sharpeScore);
    
    // Assign ranks
    for (let i = 0; i < allMetrics.length; i++) {
        allMetrics[i].sharpeRank = i + 1;
        poolMetrics.set(allMetrics[i].poolAddress, allMetrics[i]);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get performance metrics for a pool
 */
export function getPoolMetrics(poolAddress: string): PoolPerformanceMetrics | undefined {
    return poolMetrics.get(poolAddress);
}

/**
 * Get all pool metrics
 */
export function getAllPoolMetrics(): Map<string, PoolPerformanceMetrics> {
    return new Map(poolMetrics);
}

/**
 * Get pool rankings sorted by Sharpe score
 */
export function getPoolRankings(): PoolRanking[] {
    const rankings: PoolRanking[] = [];
    const now = Date.now();
    const activeWindow = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const metrics of poolMetrics.values()) {
        rankings.push({
            poolAddress: metrics.poolAddress,
            poolName: metrics.poolName,
            sharpeScore: metrics.sharpeScore,
            normalizedSharpe: normalizeSharpe(metrics.sharpeScore),
            rank: metrics.sharpeRank,
            totalTrades: metrics.totalTrades,
            winRate: metrics.winRate,
            totalPnL: metrics.totalPnL,
            isActive: now - metrics.lastTradeTime < activeWindow,
            lastTradeTime: metrics.lastTradeTime,
        });
    }
    
    return rankings.sort((a, b) => a.rank - b.rank);
}

/**
 * Get top performing pools
 */
export function getTopPools(n: number = 10): PoolRanking[] {
    return getPoolRankings().slice(0, n);
}

/**
 * Get worst performing pools
 */
export function getWorstPools(n: number = 10): PoolRanking[] {
    const rankings = getPoolRankings();
    return rankings.slice(-n);
}

/**
 * Get trades for a specific pool
 */
export function getPoolTrades(poolAddress: string): PoolTradeResult[] {
    return poolTrades.get(poolAddress) || [];
}

/**
 * Get total number of tracked pools
 */
export function getTrackedPoolCount(): number {
    return poolMetrics.size;
}

/**
 * Get total number of tracked trades
 */
export function getTotalTradeCount(): number {
    let total = 0;
    for (const trades of poolTrades.values()) {
        total += trades.length;
    }
    return total;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize Sharpe score to 0-1 range
 */
function normalizeSharpe(sharpe: number): number {
    // Map [-3, 3] to [0, 1]
    const normalized = (sharpe + 3) / 6;
    return Math.max(0, Math.min(1, normalized));
}

/**
 * Cleanup old trades outside the maximum window
 */
function cleanupOldTrades(config: PoolSharpeConfig = DEFAULT_CONFIG): void {
    const cutoff = Date.now() - config.rollingWindowMs * 2; // Keep 2x window for history
    
    for (const [poolAddress, trades] of poolTrades.entries()) {
        const filtered = trades.filter(t => t.exitTime >= cutoff);
        
        if (filtered.length === 0) {
            poolTrades.delete(poolAddress);
            poolMetrics.delete(poolAddress);
        } else if (filtered.length !== trades.length) {
            poolTrades.set(poolAddress, filtered);
            recomputePoolMetrics(poolAddress, config);
        }
    }
}

/**
 * Clear all data (for testing)
 */
export function clearAllData(): void {
    poolTrades.clear();
    poolMetrics.clear();
}

/**
 * Export Sharpe normalization for external use
 */
export { normalizeSharpe };

