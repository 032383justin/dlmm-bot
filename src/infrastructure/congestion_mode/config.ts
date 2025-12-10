/**
 * Congestion Mode - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEFAULT THRESHOLDS FOR SOLANA CONGESTION DETECTION
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { CongestionConfig, CongestionWeights } from './types';

/**
 * Default weights for congestion score
 */
export const DEFAULT_WEIGHTS: CongestionWeights = {
    confirmationTime: 0.30,
    failedTxRate: 0.30,
    blocktimeDeviation: 0.15,
    pendingSignatures: 0.10,
    rpcLatency: 0.15,
};

/**
 * Default congestion configuration
 * 
 * Behavior:
 * - congestionScore > 0.85 → block trading
 * - congestionScore > 0.70 → halve position size
 * - congestionScore > 0.60 → reduce frequency
 */
export const DEFAULT_CONFIG: CongestionConfig = {
    // Score thresholds
    blockThreshold: 0.85,
    halfPositionThreshold: 0.70,
    reduceFrequencyThreshold: 0.60,
    
    // Confirmation time baselines (Solana typical)
    baselineConfirmationMs: 500,    // 500ms is good
    maxConfirmationMs: 30000,       // 30s is very bad
    
    // RPC latency baselines
    baselineRpcLatencyMs: 100,      // 100ms is good
    maxRpcLatencyMs: 5000,          // 5s is very bad
    
    // Blocktime deviation baselines
    baselineBlocktimeDeviation: 0.05,  // 5% deviation is ok
    maxBlocktimeDeviation: 0.50,       // 50% deviation is bad
    
    // Pending signatures
    pendingSignatureWarning: 10,
    pendingSignatureCritical: 50,
    
    // Weights
    weights: DEFAULT_WEIGHTS,
    
    // Metrics window (5 minutes)
    metricsWindowMs: 5 * 60 * 1000,
};

/**
 * Conservative config for higher sensitivity
 */
export const CONSERVATIVE_CONFIG: CongestionConfig = {
    ...DEFAULT_CONFIG,
    blockThreshold: 0.75,
    halfPositionThreshold: 0.60,
    reduceFrequencyThreshold: 0.50,
    baselineConfirmationMs: 400,
    maxConfirmationMs: 20000,
};

/**
 * Create a custom config with overrides
 */
export function createConfig(overrides: Partial<CongestionConfig>): CongestionConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
        weights: {
            ...DEFAULT_CONFIG.weights,
            ...(overrides.weights ?? {}),
        },
    };
}

