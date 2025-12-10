/**
 * Execution Quality Optimizer - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Comprehensive execution quality tracking with adaptive position sizing.
 * 
 * This extends the basic execution_quality module with deeper metrics:
 * - Transaction success/failure tracking
 * - Confirmation latency monitoring
 * - Realized slippage measurement
 * - Quality-based sizing adjustments
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Individual transaction execution record
 */
export interface ExecutionRecord {
    /** Unique transaction ID */
    txId: string;
    
    /** Pool address */
    poolAddress: string;
    
    /** Timestamp of execution attempt */
    timestamp: number;
    
    /** Whether the transaction succeeded */
    success: boolean;
    
    /** Time to confirm (ms), null if failed */
    confirmationLatencyMs: number | null;
    
    /** Expected price at submission */
    expectedPrice: number;
    
    /** Actual fill price (null if failed) */
    actualPrice: number | null;
    
    /** Realized slippage as decimal (0.01 = 1%) */
    slippageRealized: number | null;
    
    /** Transaction type */
    type: 'entry' | 'exit';
    
    /** Size in USD */
    sizeUSD: number;
    
    /** Number of retry attempts */
    retryCount: number;
    
    /** Failure reason if failed */
    failureReason?: string;
}

/**
 * Aggregated execution metrics over a time window
 */
export interface ExecutionMetrics {
    /** Window start timestamp */
    windowStart: number;
    
    /** Window end timestamp */
    windowEnd: number;
    
    /** Total number of transactions */
    totalTx: number;
    
    /** Number of successful transactions */
    successfulTx: number;
    
    /** Number of failed transactions */
    failedTx: number;
    
    /** Transaction success rate (0-1) */
    txSuccessRate: number;
    
    /** Average confirmation latency (ms) */
    avgConfirmationLatencyMs: number;
    
    /** P95 confirmation latency (ms) */
    p95ConfirmationLatencyMs: number;
    
    /** Average realized slippage (decimal) */
    avgSlippage: number;
    
    /** Maximum realized slippage (decimal) */
    maxSlippage: number;
    
    /** Failed transaction rate (0-1) */
    failedTxRate: number;
    
    /** Average retry count */
    avgRetryCount: number;
    
    /** Entry-specific success rate */
    entrySuccessRate: number;
    
    /** Exit-specific success rate */
    exitSuccessRate: number;
}

/**
 * Execution quality score with sizing recommendation
 */
export interface ExecutionQualityScore {
    /** Overall quality score (0-1) */
    score: number;
    
    /** Whether entries should be blocked */
    blockEntries: boolean;
    
    /** Position size multiplier (0-1) */
    positionMultiplier: number;
    
    /** Sizing action: 'BLOCK' | 'REDUCE_60' | 'NORMAL' */
    sizingAction: 'BLOCK' | 'REDUCE_60' | 'NORMAL';
    
    /** Underlying metrics used */
    metrics: ExecutionMetrics;
    
    /** Breakdown of score components */
    scoreBreakdown: {
        slippageComponent: number;
        successRateComponent: number;
        latencyComponent: number;
    };
    
    /** Reason for current state */
    reason: string;
    
    /** Timestamp of computation */
    timestamp: number;
}

/**
 * Configuration for execution quality optimizer
 */
export interface ExecutionQualityConfig {
    /** Time window for metrics calculation (ms) */
    metricsWindowMs: number;
    
    /** Minimum transactions required for valid scoring */
    minTransactionsForScoring: number;
    
    /** Default score when insufficient data */
    defaultScore: number;
    
    /** Score thresholds */
    thresholds: {
        /** Below this, block entries */
        blockThreshold: number;
        
        /** Below this, reduce size by 60% */
        reducedThreshold: number;
        
        /** Above this, allow normal sizing */
        normalThreshold: number;
    };
    
    /** Component weights for score calculation */
    weights: {
        slippage: number;
        successRate: number;
        latency: number;
    };
    
    /** Latency normalization (ms) */
    latencyNormalization: {
        /** Latency below this is considered excellent */
        excellentMs: number;
        
        /** Latency above this is considered poor */
        poorMs: number;
    };
    
    /** Slippage normalization */
    slippageNormalization: {
        /** Slippage below this is excellent */
        excellentPct: number;
        
        /** Slippage above this is poor */
        poorPct: number;
    };
}

/**
 * Pool-specific execution quality tracking
 */
export interface PoolExecutionQuality {
    poolAddress: string;
    score: number;
    totalTransactions: number;
    successRate: number;
    avgSlippage: number;
    lastUpdated: number;
}

/**
 * Execution quality state for persistence
 */
export interface ExecutionQualityState {
    records: ExecutionRecord[];
    poolQualities: Map<string, PoolExecutionQuality>;
    lastCleanupTime: number;
}

