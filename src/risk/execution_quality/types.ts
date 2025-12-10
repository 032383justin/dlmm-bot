/**
 * Execution Quality Module - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Track live execution quality using recent trades and apply a penalty
 * multiplier to position sizing and entry permission.
 * 
 * METRICS TRACKED:
 * - Realized slippage vs expected
 * - TX success rate
 * - TX latency / confirmation time
 * - Execution attempts per entry
 * - Failed or reverted transactions
 * - Fill price deviation
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { TradingState } from '../adaptive_sizing/types';

/**
 * Single execution event record
 */
export interface ExecutionEvent {
    /** Unique identifier for the execution attempt */
    id: string;
    
    /** Timestamp when execution was initiated */
    initiatedAt: number;
    
    /** Timestamp when execution was confirmed (or failed) */
    completedAt?: number;
    
    /** Whether the execution succeeded */
    success: boolean;
    
    /** Expected slippage (as decimal, e.g., 0.01 = 1%) */
    expectedSlippage: number;
    
    /** Realized slippage (as decimal) */
    realizedSlippage?: number;
    
    /** Expected fill price */
    expectedPrice: number;
    
    /** Actual fill price */
    actualPrice?: number;
    
    /** Number of attempts for this execution */
    attempts: number;
    
    /** Transaction signature if available */
    signature?: string;
    
    /** Reason for failure if failed */
    failureReason?: string;
    
    /** Pool address */
    poolAddress: string;
    
    /** Trade type */
    tradeType: 'entry' | 'exit';
}

/**
 * Aggregated execution metrics over a time window
 */
export interface ExecutionMetrics {
    /** Time window start */
    windowStartMs: number;
    
    /** Time window end */
    windowEndMs: number;
    
    /** Total number of execution events in window */
    totalExecutions: number;
    
    /** Number of successful executions */
    successfulExecutions: number;
    
    /** Number of failed executions */
    failedExecutions: number;
    
    /** TX success rate (0-1) */
    txSuccessRate: number;
    
    /** Average slippage (actual - expected) */
    avgSlippageDeviation: number;
    
    /** Max slippage observed */
    maxSlippage: number;
    
    /** Average TX latency in ms */
    avgLatencyMs: number;
    
    /** Average attempts per execution */
    avgAttemptsPerExecution: number;
    
    /** Fill price deviation (average) */
    avgFillPriceDeviation: number;
    
    /** Reverted transaction count */
    revertedTxCount: number;
}

/**
 * Execution quality score result
 */
export interface ExecutionQualityResult {
    /** Composite quality score (0-1) */
    score: number;
    
    /** Whether entries should be blocked */
    blockEntries: boolean;
    
    /** Position size multiplier based on quality */
    positionMultiplier: number;
    
    /** Reason for the score */
    reason: string;
    
    /** Underlying metrics */
    metrics: ExecutionMetrics;
    
    /** Timestamp of calculation */
    timestamp: number;
}

/**
 * Configuration for execution quality thresholds
 */
export interface ExecutionQualityConfig {
    /** Score below which entries are blocked */
    blockThreshold: number;
    
    /** Score below which position size is reduced */
    reduceThreshold: number;
    
    /** Score above which normal sizing is allowed */
    normalThreshold: number;
    
    /** Position reduction factor when below reduceThreshold */
    reductionFactor: number;
    
    /** Time window for metrics in ms */
    metricsWindowMs: number;
    
    /** Minimum executions required for valid score */
    minExecutionsRequired: number;
    
    /** Weights for score calculation */
    weights: ExecutionQualityWeights;
    
    /** Baseline latency considered "good" in ms */
    baselineLatencyMs: number;
    
    /** Max latency for normalization in ms */
    maxLatencyMs: number;
    
    /** Baseline slippage considered "good" (as decimal) */
    baselineSlippage: number;
    
    /** Max slippage for normalization (as decimal) */
    maxSlippage: number;
}

/**
 * Weights for execution quality score components
 */
export interface ExecutionQualityWeights {
    slippage: number;
    txSuccessRate: number;
    latency: number;
}

/**
 * Extended TradingState with execution quality
 */
export interface TradingStateWithExecution extends TradingState {
    /** Execution quality score (0-1) */
    execution_quality: number;
}

