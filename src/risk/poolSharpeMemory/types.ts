/**
 * Pool Sharpe Memory - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Track per-pool performance metrics to compute rolling Sharpe scores.
 * 
 * METRICS TRACKED:
 * - Realized PnL
 * - Win rate
 * - Average R multiple
 * - Drawdown
 * - Slippage impact
 * 
 * Sharpe score becomes a gating and sizing factor.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Individual trade result for a pool
 */
export interface PoolTradeResult {
    /** Trade ID */
    tradeId: string;
    
    /** Pool address */
    poolAddress: string;
    
    /** Pool name for display */
    poolName: string;
    
    /** Entry timestamp */
    entryTime: number;
    
    /** Exit timestamp */
    exitTime: number;
    
    /** Position size in USD */
    sizeUSD: number;
    
    /** Realized PnL in USD */
    realizedPnL: number;
    
    /** PnL percentage */
    pnlPercent: number;
    
    /** Whether trade was a win (positive PnL) */
    isWin: boolean;
    
    /** R multiple (PnL / risk amount) */
    rMultiple: number;
    
    /** Slippage impact (actual vs expected) */
    slippageImpact: number;
    
    /** Hold duration (ms) */
    holdDurationMs: number;
    
    /** Entry score */
    entryScore: number;
    
    /** Exit score */
    exitScore: number;
}

/**
 * Pool performance metrics
 */
export interface PoolPerformanceMetrics {
    /** Pool address */
    poolAddress: string;
    
    /** Pool name */
    poolName: string;
    
    /** Total trades */
    totalTrades: number;
    
    /** Winning trades */
    winningTrades: number;
    
    /** Losing trades */
    losingTrades: number;
    
    /** Win rate (0-1) */
    winRate: number;
    
    /** Total realized PnL */
    totalPnL: number;
    
    /** Average PnL per trade */
    avgPnL: number;
    
    /** Average R multiple */
    avgRMultiple: number;
    
    /** Best trade PnL */
    bestTradePnL: number;
    
    /** Worst trade PnL (most negative) */
    worstTradePnL: number;
    
    /** Maximum drawdown (from peak to trough) */
    maxDrawdown: number;
    
    /** Average slippage impact */
    avgSlippageImpact: number;
    
    /** Average hold duration (ms) */
    avgHoldDurationMs: number;
    
    /** First trade timestamp */
    firstTradeTime: number;
    
    /** Last trade timestamp */
    lastTradeTime: number;
    
    /** Rolling Sharpe score */
    sharpeScore: number;
    
    /** Sharpe-based rank (lower is better) */
    sharpeRank: number;
    
    /** Last update timestamp */
    lastUpdated: number;
}

/**
 * Sharpe score result with sizing recommendation
 */
export interface SharpeScoreResult {
    /** Pool address */
    poolAddress: string;
    
    /** Computed Sharpe score (-5 to +5 typical range) */
    sharpeScore: number;
    
    /** Normalized Sharpe (0-1) for multiplier use */
    normalizedSharpe: number;
    
    /** Position size multiplier based on Sharpe */
    sharpeMultiplier: number;
    
    /** Whether pool should be blocked due to poor Sharpe */
    shouldBlock: boolean;
    
    /** Reason for recommendation */
    reason: string;
    
    /** Underlying metrics */
    metrics: PoolPerformanceMetrics;
    
    /** Timestamp */
    timestamp: number;
}

/**
 * Configuration for Pool Sharpe Memory
 */
export interface PoolSharpeConfig {
    /** Minimum trades required for valid Sharpe calculation */
    minTradesForSharpe: number;
    
    /** Default Sharpe for pools with insufficient data */
    defaultSharpe: number;
    
    /** Sharpe threshold below which to block entries */
    blockThreshold: number;
    
    /** Sharpe threshold below which to reduce size */
    reduceThreshold: number;
    
    /** Maximum Sharpe for size boost */
    boostThreshold: number;
    
    /** Size reduction multiplier for poor Sharpe */
    poorSharpeMultiplier: number;
    
    /** Size boost multiplier for excellent Sharpe */
    excellentSharpeMultiplier: number;
    
    /** Risk-free rate for Sharpe calculation (annualized) */
    riskFreeRate: number;
    
    /** Rolling window for Sharpe calculation (ms) */
    rollingWindowMs: number;
    
    /** Decay factor for older trades (exponential decay) */
    decayFactor: number;
}

/**
 * Pool ranking entry
 */
export interface PoolRanking {
    poolAddress: string;
    poolName: string;
    sharpeScore: number;
    normalizedSharpe: number;
    rank: number;
    totalTrades: number;
    winRate: number;
    totalPnL: number;
    isActive: boolean;
    lastTradeTime: number;
}

