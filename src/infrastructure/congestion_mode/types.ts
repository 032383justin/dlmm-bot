/**
 * Congestion Mode - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Detect when Solana network congestion makes trading unreliable.
 * 
 * When the network is congested, transactions fail more often, latency increases,
 * and execution quality degrades. This module provides awareness of network
 * conditions to adjust trading behavior accordingly.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Network metrics for congestion detection
 */
export interface NetworkMetrics {
    /** Average TX confirmation time in ms (recent window) */
    avgConfirmationTimeMs: number;
    
    /** Failed TX percentage (0-1) */
    failedTxRate: number;
    
    /** Block time deviation from expected (normalized) */
    blocktimeDeviation: number;
    
    /** Pending signature queue depth */
    pendingSignatureCount: number;
    
    /** RPC latency in ms */
    rpcLatencyMs: number;
    
    /** Current TPS (transactions per second) */
    currentTPS?: number;
    
    /** Recent slot skip rate */
    slotSkipRate?: number;
}

/**
 * Congestion level classification
 */
export type CongestionLevel = 'normal' | 'elevated' | 'high' | 'severe';

/**
 * Congestion detection result
 */
export interface CongestionResult {
    /** Congestion score (0-1, higher = more congested) */
    congestionScore: number;
    
    /** Congestion level classification */
    level: CongestionLevel;
    
    /** Position size multiplier based on congestion */
    positionMultiplier: number;
    
    /** Frequency multiplier (for scan interval adjustment) */
    frequencyMultiplier: number;
    
    /** Whether trading should be blocked */
    blockTrading: boolean;
    
    /** Whether position size should be reduced */
    reducePositions: boolean;
    
    /** Whether scan frequency should be reduced */
    reduceFrequency: boolean;
    
    /** Reason for the result */
    reason: string;
    
    /** Underlying metrics */
    metrics: NetworkMetrics;
    
    /** Timestamp of detection */
    timestamp: number;
}

/**
 * Configuration for congestion detection
 */
export interface CongestionConfig {
    // Score thresholds
    blockThreshold: number;       // > 0.85 → block trading
    halfPositionThreshold: number; // > 0.70 → halve position size
    reduceFrequencyThreshold: number; // > 0.60 → reduce frequency
    
    // Metric normalization baselines
    baselineConfirmationMs: number;  // "Good" confirmation time
    maxConfirmationMs: number;       // "Very bad" confirmation time
    
    baselineRpcLatencyMs: number;    // "Good" RPC latency
    maxRpcLatencyMs: number;         // "Very bad" RPC latency
    
    baselineBlocktimeDeviation: number; // "Good" deviation
    maxBlocktimeDeviation: number;      // "Very bad" deviation
    
    // Pending signature thresholds
    pendingSignatureWarning: number;  // Warning level
    pendingSignatureCritical: number; // Critical level
    
    // Weights for congestion score
    weights: CongestionWeights;
    
    // Metrics collection window
    metricsWindowMs: number;
}

/**
 * Weights for congestion score components
 */
export interface CongestionWeights {
    confirmationTime: number;
    failedTxRate: number;
    blocktimeDeviation: number;
    pendingSignatures: number;
    rpcLatency: number;
}

/**
 * Single congestion metric sample
 */
export interface CongestionSample {
    timestamp: number;
    confirmationTimeMs?: number;
    txSuccess: boolean;
    rpcLatencyMs?: number;
    blocktimeDeviation?: number;
}

