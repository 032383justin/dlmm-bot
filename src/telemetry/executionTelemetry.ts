/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXECUTION TELEMETRY — TIER-5 RPC HEALTH & EXECUTION GATING
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides execution-grade RPC telemetry and gating for the DLMM
 * trading system. It actively influences trading decisions by:
 * 
 * 1. Tracking RPC call latency, errors, and timeouts in rolling windows
 * 2. Monitoring transaction confirmation times and slot drift
 * 3. Computing an RPC health score (0-100)
 * 4. Providing execution gating that can suppress trades under hostile conditions
 * 
 * FAIL-CLOSED DESIGN:
 * - If telemetry cannot be computed → execution is suppressed
 * - If health score is degraded → entries are blocked
 * - FORCED_EXIT always bypasses gating (capital protection)
 * 
 * READ-ONLY FROM STRATEGY:
 * - Strategy modules call getRpcHealthScore(), getConfirmationStats(), shouldAllowExecution()
 * - They cannot modify telemetry state
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    FEE_BULLY_MODE_ENABLED,
    FEE_BULLY_TELEMETRY,
    FEE_BULLY_TAGS,
    INFRASTRUCTURE_KILL_SWITCH,
    activateSafeMode,
    deactivateSafeMode,
    isSafeModeActive,
} from '../config/feeBullyConfig';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get entry health threshold based on Fee Bully mode
 */
function getEntryBlockHealthThreshold(): number {
    if (FEE_BULLY_MODE_ENABLED) {
        return FEE_BULLY_TELEMETRY.ENTRY_HEALTH_THRESHOLD; // 45
    }
    return 60; // Default
}

/**
 * Execution telemetry configuration
 */
export const EXECUTION_TELEMETRY_CONFIG = {
    // Rolling window for RPC metrics (ms)
    RPC_WINDOW_MS: 90_000, // 90 seconds
    
    // Rolling window for confirmation metrics (ms)
    CONFIRMATION_WINDOW_MS: 120_000, // 120 seconds
    
    // Maximum samples to retain per window
    MAX_RPC_SAMPLES: 500,
    MAX_CONFIRMATION_SAMPLES: 100,
    
    // RPC health score thresholds
    HEALTH_EXCELLENT: 90,
    HEALTH_GOOD: 75,
    HEALTH_DEGRADED: 60,
    HEALTH_CRITICAL: 40,
    
    // Gating thresholds - NOTE: ENTRY_BLOCK uses dynamic function
    ENTRY_BLOCK_HEALTH_THRESHOLD: 60, // Default, overridden by getEntryBlockHealthThreshold()
    EXIT_BLOCK_CONFIRMATION_P95_MS: 15_000, // 15s confirmation p95
    EXIT_BLOCK_SLOT_DELTA_P95: 10, // 10 slots drift
    
    // Latency thresholds for scoring
    LATENCY_EXCELLENT_MS: 200,
    LATENCY_GOOD_MS: 500,
    LATENCY_DEGRADED_MS: 1500,
    LATENCY_CRITICAL_MS: 3000,
    
    // Error rate thresholds for scoring
    ERROR_RATE_EXCELLENT: 0.01,
    ERROR_RATE_GOOD: 0.05,
    ERROR_RATE_DEGRADED: 0.15,
    ERROR_RATE_CRITICAL: 0.30,
    
    // Score weights
    WEIGHT_LATENCY: 0.40,
    WEIGHT_ERROR_RATE: 0.35,
    WEIGHT_TIMEOUT_RATE: 0.25,
    
    // Minimum samples for valid scoring
    MIN_RPC_SAMPLES_FOR_SCORE: 5,
    MIN_CONFIRMATION_SAMPLES_FOR_STATS: 3,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * RPC call sample for metrics tracking
 */
interface RpcCallSample {
    timestamp: number;
    method: string;
    durationMs: number;
    success: boolean;
    errorType?: 'timeout' | '429' | 'malformed' | 'network' | 'unknown';
}

/**
 * Transaction confirmation sample for slot/confirmation tracking
 */
interface ConfirmationSample {
    timestamp: number;
    slotAtSend: number;
    slotAtConfirmation: number;
    slotDelta: number;
    confirmationTimeMs: number;
    txSignature: string;
}

/**
 * Confirmation stats exposed to strategy modules
 */
export interface ConfirmationStats {
    medianMs: number;
    p95Ms: number;
    slotDeltaMedian: number;
    slotDeltaP95: number;
}

/**
 * Execution kind for gating decisions
 */
export type ExecutionKind = 'ENTRY' | 'EXIT' | 'FORCED_EXIT';

/**
 * Gating decision result
 */
export interface GatingDecision {
    allowed: boolean;
    reason: string;
    healthScore: number;
    confirmationStats: ConfirmationStats;
}

/**
 * Structured telemetry event for logging
 */
interface TelemetryEvent {
    type: 'RPC_DEGRADATION' | 'EXECUTION_SUPPRESSED' | 'EXIT_DEFERRED' | 'FORCED_OVERRIDE';
    timestamp: number;
    details: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE — ROLLING WINDOWS
// ═══════════════════════════════════════════════════════════════════════════════

const rpcSamples: RpcCallSample[] = [];
const confirmationSamples: ConfirmationSample[] = [];
let lastTelemetryLogTime = 0;
const TELEMETRY_LOG_INTERVAL = 60_000; // Log at most once per minute

// Cache for computed metrics
let cachedHealthScore: number | null = null;
let cachedHealthScoreTime = 0;
let cachedConfirmationStats: ConfirmationStats | null = null;
let cachedConfirmationStatsTime = 0;
const CACHE_TTL_MS = 3_000; // 3 second cache

// ═══════════════════════════════════════════════════════════════════════════════
// RPC INSTRUMENTATION — RECORD CALLS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record an RPC call result.
 * Called by the RPC wrapper after each call completes.
 */
export function recordRpcCall(
    method: string,
    durationMs: number,
    success: boolean,
    errorType?: 'timeout' | '429' | 'malformed' | 'network' | 'unknown'
): void {
    const sample: RpcCallSample = {
        timestamp: Date.now(),
        method,
        durationMs,
        success,
        errorType,
    };
    
    rpcSamples.push(sample);
    
    // Trim to max samples
    while (rpcSamples.length > EXECUTION_TELEMETRY_CONFIG.MAX_RPC_SAMPLES) {
        rpcSamples.shift();
    }
    
    // Invalidate cache
    cachedHealthScore = null;
    
    // Check for degradation and log if needed
    checkAndLogDegradation(sample);
}

/**
 * Record a transaction confirmation result.
 * Called after transaction confirmation completes.
 */
export function recordConfirmation(
    txSignature: string,
    slotAtSend: number,
    slotAtConfirmation: number,
    confirmationTimeMs: number
): void {
    const sample: ConfirmationSample = {
        timestamp: Date.now(),
        slotAtSend,
        slotAtConfirmation,
        slotDelta: slotAtConfirmation - slotAtSend,
        confirmationTimeMs,
        txSignature,
    };
    
    confirmationSamples.push(sample);
    
    // Trim to max samples
    while (confirmationSamples.length > EXECUTION_TELEMETRY_CONFIG.MAX_CONFIRMATION_SAMPLES) {
        confirmationSamples.shift();
    }
    
    // Invalidate cache
    cachedConfirmationStats = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get RPC samples within the rolling window
 */
function getRecentRpcSamples(): RpcCallSample[] {
    const cutoff = Date.now() - EXECUTION_TELEMETRY_CONFIG.RPC_WINDOW_MS;
    return rpcSamples.filter(s => s.timestamp >= cutoff);
}

/**
 * Get confirmation samples within the rolling window
 */
function getRecentConfirmationSamples(): ConfirmationSample[] {
    const cutoff = Date.now() - EXECUTION_TELEMETRY_CONFIG.CONFIRMATION_WINDOW_MS;
    return confirmationSamples.filter(s => s.timestamp >= cutoff);
}

/**
 * Compute percentile from sorted array
 */
function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

/**
 * Compute median from sorted array
 */
function median(sorted: number[]): number {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

/**
 * Compute RPC health score (0-100)
 * 
 * Score = weighted combination of:
 * - Latency score (0-100)
 * - Error rate score (0-100)
 * - Timeout rate score (0-100)
 */
function computeHealthScore(): number {
    const samples = getRecentRpcSamples();
    
    if (samples.length < EXECUTION_TELEMETRY_CONFIG.MIN_RPC_SAMPLES_FOR_SCORE) {
        // Not enough data - return conservative default
        return 85; // Assume healthy until proven otherwise
    }
    
    // Compute average latency
    const latencies = samples.map(s => s.durationMs);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    
    // Compute latency score (higher latency = lower score)
    let latencyScore: number;
    if (avgLatency <= EXECUTION_TELEMETRY_CONFIG.LATENCY_EXCELLENT_MS) {
        latencyScore = 100;
    } else if (avgLatency <= EXECUTION_TELEMETRY_CONFIG.LATENCY_GOOD_MS) {
        latencyScore = 85;
    } else if (avgLatency <= EXECUTION_TELEMETRY_CONFIG.LATENCY_DEGRADED_MS) {
        latencyScore = 60;
    } else if (avgLatency <= EXECUTION_TELEMETRY_CONFIG.LATENCY_CRITICAL_MS) {
        latencyScore = 35;
    } else {
        latencyScore = 10;
    }
    
    // Compute error rate
    const errorCount = samples.filter(s => !s.success).length;
    const errorRate = errorCount / samples.length;
    
    // Compute error rate score
    let errorScore: number;
    if (errorRate <= EXECUTION_TELEMETRY_CONFIG.ERROR_RATE_EXCELLENT) {
        errorScore = 100;
    } else if (errorRate <= EXECUTION_TELEMETRY_CONFIG.ERROR_RATE_GOOD) {
        errorScore = 80;
    } else if (errorRate <= EXECUTION_TELEMETRY_CONFIG.ERROR_RATE_DEGRADED) {
        errorScore = 50;
    } else if (errorRate <= EXECUTION_TELEMETRY_CONFIG.ERROR_RATE_CRITICAL) {
        errorScore = 25;
    } else {
        errorScore = 0;
    }
    
    // Compute timeout rate (subset of errors)
    const timeoutCount = samples.filter(s => s.errorType === 'timeout').length;
    const timeoutRate = timeoutCount / samples.length;
    
    // Compute timeout score
    let timeoutScore: number;
    if (timeoutRate === 0) {
        timeoutScore = 100;
    } else if (timeoutRate < 0.02) {
        timeoutScore = 85;
    } else if (timeoutRate < 0.05) {
        timeoutScore = 60;
    } else if (timeoutRate < 0.10) {
        timeoutScore = 35;
    } else {
        timeoutScore = 10;
    }
    
    // Weighted combination
    const score = 
        latencyScore * EXECUTION_TELEMETRY_CONFIG.WEIGHT_LATENCY +
        errorScore * EXECUTION_TELEMETRY_CONFIG.WEIGHT_ERROR_RATE +
        timeoutScore * EXECUTION_TELEMETRY_CONFIG.WEIGHT_TIMEOUT_RATE;
    
    return Math.round(score);
}

/**
 * Compute confirmation stats for the rolling window
 */
function computeConfirmationStats(): ConfirmationStats {
    const samples = getRecentConfirmationSamples();
    
    if (samples.length < EXECUTION_TELEMETRY_CONFIG.MIN_CONFIRMATION_SAMPLES_FOR_STATS) {
        // Not enough data - return conservative defaults
        return {
            medianMs: 2000,
            p95Ms: 5000,
            slotDeltaMedian: 2,
            slotDeltaP95: 5,
        };
    }
    
    // Sort confirmation times
    const confirmTimes = samples.map(s => s.confirmationTimeMs).sort((a, b) => a - b);
    
    // Sort slot deltas
    const slotDeltas = samples.map(s => s.slotDelta).sort((a, b) => a - b);
    
    return {
        medianMs: Math.round(median(confirmTimes)),
        p95Ms: Math.round(percentile(confirmTimes, 95)),
        slotDeltaMedian: Math.round(median(slotDeltas)),
        slotDeltaP95: Math.round(percentile(slotDeltas, 95)),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API — READ-ONLY FOR STRATEGY MODULES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current RPC health score (0-100)
 * 
 * Cached for 3 seconds to avoid recomputation.
 * Higher is better.
 */
export function getRpcHealthScore(): number {
    const now = Date.now();
    
    if (cachedHealthScore !== null && (now - cachedHealthScoreTime) < CACHE_TTL_MS) {
        return cachedHealthScore;
    }
    
    cachedHealthScore = computeHealthScore();
    cachedHealthScoreTime = now;
    
    return cachedHealthScore;
}

/**
 * Get confirmation statistics
 * 
 * Cached for 3 seconds to avoid recomputation.
 */
export function getConfirmationStats(): ConfirmationStats {
    const now = Date.now();
    
    if (cachedConfirmationStats !== null && (now - cachedConfirmationStatsTime) < CACHE_TTL_MS) {
        return cachedConfirmationStats;
    }
    
    cachedConfirmationStats = computeConfirmationStats();
    cachedConfirmationStatsTime = now;
    
    return cachedConfirmationStats;
}

/**
 * Determine if execution should be allowed based on current conditions.
 * 
 * RULES:
 * 1. FORCED_EXIT always bypasses gating (capital protection)
 * 2. ENTRY blocked if RPC_HEALTH_SCORE < 60
 * 3. EXIT blocked if confirmation p95 > threshold (unless FORCED)
 * 
 * @param kind - Type of execution: 'ENTRY' | 'EXIT' | 'FORCED_EXIT'
 * @returns true if execution is allowed, false if suppressed
 */
export function shouldAllowExecution(kind: ExecutionKind): boolean {
    const decision = getGatingDecision(kind);
    return decision.allowed;
}

/**
 * Check and update Safe Mode status based on current telemetry.
 * Called before gating decisions.
 */
function checkAndUpdateSafeMode(healthScore: number): void {
    if (!FEE_BULLY_MODE_ENABLED || !INFRASTRUCTURE_KILL_SWITCH.ENABLED) return;
    
    const rpcMetrics = getRawRpcMetrics();
    const triggers = INFRASTRUCTURE_KILL_SWITCH.SAFE_MODE_TRIGGERS;
    
    // Check Safe Mode triggers
    const shouldActivate = 
        healthScore < triggers.RPC_HEALTH_CRITICAL ||
        rpcMetrics.timeoutRate > triggers.TIMEOUT_RATE_CRITICAL ||
        rpcMetrics.errorRate > triggers.ERROR_RATE_CRITICAL;
    
    if (shouldActivate && !isSafeModeActive()) {
        let reason = 'Infrastructure failure: ';
        if (healthScore < triggers.RPC_HEALTH_CRITICAL) {
            reason += `RPC health ${healthScore} < ${triggers.RPC_HEALTH_CRITICAL}`;
        } else if (rpcMetrics.timeoutRate > triggers.TIMEOUT_RATE_CRITICAL) {
            reason += `Timeout rate ${(rpcMetrics.timeoutRate * 100).toFixed(1)}% > ${triggers.TIMEOUT_RATE_CRITICAL * 100}%`;
        } else {
            reason += `Error rate ${(rpcMetrics.errorRate * 100).toFixed(1)}% > ${triggers.ERROR_RATE_CRITICAL * 100}%`;
        }
        activateSafeMode(reason);
    } else if (!shouldActivate && isSafeModeActive()) {
        // Recovery detected
        deactivateSafeMode();
    }
}

/**
 * Get detailed gating decision with reasoning
 */
export function getGatingDecision(kind: ExecutionKind): GatingDecision {
    const healthScore = getRpcHealthScore();
    const confirmStats = getConfirmationStats();
    
    // Update Safe Mode status
    checkAndUpdateSafeMode(healthScore);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RULE 1: FORCED_EXIT always bypasses gating (including Safe Mode)
    // Capital protection takes priority over network health
    // ═══════════════════════════════════════════════════════════════════════════
    if (kind === 'FORCED_EXIT') {
        logTelemetryEvent({
            type: 'FORCED_OVERRIDE',
            timestamp: Date.now(),
            details: {
                healthScore,
                confirmStats,
                message: 'FORCED_EXIT bypasses all gating',
                safeModeActive: isSafeModeActive(),
            },
        });
        
        return {
            allowed: true,
            reason: 'FORCED_EXIT bypasses gating',
            healthScore,
            confirmationStats: confirmStats,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RULE 2: Block ENTRY if RPC health is degraded or Safe Mode is active
    // Fee Bully Mode uses lower threshold (45 vs 60)
    // ═══════════════════════════════════════════════════════════════════════════
    if (kind === 'ENTRY') {
        // Check Safe Mode first
        if (isSafeModeActive() && !INFRASTRUCTURE_KILL_SWITCH.SAFE_MODE_BEHAVIOR.ALLOW_ENTRIES) {
            logTelemetryEvent({
                type: 'EXECUTION_SUPPRESSED',
                timestamp: Date.now(),
                details: {
                    kind,
                    healthScore,
                    threshold: getEntryBlockHealthThreshold(),
                    message: 'ENTRY blocked due to SAFE_MODE',
                    safeModeActive: true,
                },
            });
            
            return {
                allowed: false,
                reason: 'Safe Mode active - entries blocked',
                healthScore,
                confirmationStats: confirmStats,
            };
        }
        
        // Use dynamic threshold based on Fee Bully mode
        const entryThreshold = getEntryBlockHealthThreshold();
        
        if (healthScore < entryThreshold) {
            logTelemetryEvent({
                type: 'EXECUTION_SUPPRESSED',
                timestamp: Date.now(),
                details: {
                    kind,
                    healthScore,
                    threshold: entryThreshold,
                    message: 'ENTRY blocked due to degraded RPC health',
                    feeBullyMode: FEE_BULLY_MODE_ENABLED,
                },
            });
            
            return {
                allowed: false,
                reason: `RPC health ${healthScore} < ${entryThreshold}`,
                healthScore,
                confirmationStats: confirmStats,
            };
        }
        
        return {
            allowed: true,
            reason: 'RPC health acceptable for entry',
            healthScore,
            confirmationStats: confirmStats,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RULE 3: Allow EXIT even in Safe Mode (except catastrophic failure)
    // This prevents exits that would suffer from slot drift
    // ═══════════════════════════════════════════════════════════════════════════
    if (kind === 'EXIT') {
        // In Safe Mode, allow exits unless confirmation is catastrophically bad
        if (isSafeModeActive() && INFRASTRUCTURE_KILL_SWITCH.SAFE_MODE_BEHAVIOR.ALLOW_EXITS) {
            // Only block if confirmation is extremely degraded
            if (confirmStats.p95Ms > EXECUTION_TELEMETRY_CONFIG.EXIT_BLOCK_CONFIRMATION_P95_MS * 2) {
                return {
                    allowed: false,
                    reason: `Safe Mode: catastrophic confirmation lag ${confirmStats.p95Ms}ms`,
                    healthScore,
                    confirmationStats: confirmStats,
                };
            }
            return {
                allowed: true,
                reason: 'Safe Mode: exits allowed',
                healthScore,
                confirmationStats: confirmStats,
            };
        }
        
        const confirmP95Exceeded = confirmStats.p95Ms > EXECUTION_TELEMETRY_CONFIG.EXIT_BLOCK_CONFIRMATION_P95_MS;
        const slotDriftExceeded = confirmStats.slotDeltaP95 > EXECUTION_TELEMETRY_CONFIG.EXIT_BLOCK_SLOT_DELTA_P95;
        
        if (confirmP95Exceeded || slotDriftExceeded) {
            logTelemetryEvent({
                type: 'EXIT_DEFERRED',
                timestamp: Date.now(),
                details: {
                    kind,
                    healthScore,
                    confirmP95: confirmStats.p95Ms,
                    slotDeltaP95: confirmStats.slotDeltaP95,
                    confirmThreshold: EXECUTION_TELEMETRY_CONFIG.EXIT_BLOCK_CONFIRMATION_P95_MS,
                    slotThreshold: EXECUTION_TELEMETRY_CONFIG.EXIT_BLOCK_SLOT_DELTA_P95,
                    message: 'EXIT deferred due to confirmation lag',
                },
            });
            
            let reason = 'Confirmation lag:';
            if (confirmP95Exceeded) {
                reason += ` p95=${confirmStats.p95Ms}ms > ${EXECUTION_TELEMETRY_CONFIG.EXIT_BLOCK_CONFIRMATION_P95_MS}ms`;
            }
            if (slotDriftExceeded) {
                reason += ` slotDelta=${confirmStats.slotDeltaP95} > ${EXECUTION_TELEMETRY_CONFIG.EXIT_BLOCK_SLOT_DELTA_P95}`;
            }
            
            return {
                allowed: false,
                reason,
                healthScore,
                confirmationStats: confirmStats,
            };
        }
        
        return {
            allowed: true,
            reason: 'Confirmation metrics acceptable for exit',
            healthScore,
            confirmationStats: confirmStats,
        };
    }
    
    // Default: allow (should never reach here)
    return {
        allowed: true,
        reason: 'Unknown execution kind - allowing by default',
        healthScore,
        confirmationStats: confirmStats,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEMETRY LOGGING — STRUCTURED, NO SPAM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check for RPC degradation and log if needed
 */
function checkAndLogDegradation(sample: RpcCallSample): void {
    // Only log degradation events, not every call
    if (!sample.success || sample.durationMs > EXECUTION_TELEMETRY_CONFIG.LATENCY_DEGRADED_MS) {
        const now = Date.now();
        
        // Rate limit logging
        if (now - lastTelemetryLogTime < TELEMETRY_LOG_INTERVAL) {
            return;
        }
        
        lastTelemetryLogTime = now;
        
        logTelemetryEvent({
            type: 'RPC_DEGRADATION',
            timestamp: now,
            details: {
                method: sample.method,
                durationMs: sample.durationMs,
                success: sample.success,
                errorType: sample.errorType,
                healthScore: getRpcHealthScore(),
            },
        });
    }
}

/**
 * Log a structured telemetry event
 */
function logTelemetryEvent(event: TelemetryEvent): void {
    const logPrefix = '[EXEC-TELEMETRY]';
    
    switch (event.type) {
        case 'RPC_DEGRADATION':
            logger.warn(`${logPrefix} RPC_DEGRADATION | health=${event.details.healthScore} | method=${event.details.method} | duration=${event.details.durationMs}ms | error=${event.details.errorType || 'none'}`);
            break;
            
        case 'EXECUTION_SUPPRESSED':
            logger.warn(`${logPrefix} EXECUTION_SUPPRESSED | kind=${event.details.kind} | health=${event.details.healthScore} | threshold=${event.details.threshold}`);
            break;
            
        case 'EXIT_DEFERRED':
            logger.info(`${logPrefix} EXIT_DEFERRED | confirmP95=${event.details.confirmP95}ms | slotDelta=${event.details.slotDeltaP95}`);
            break;
            
        case 'FORCED_OVERRIDE':
            logger.info(`${logPrefix} FORCED_OVERRIDE | health=${event.details.healthScore} | bypassing gating for capital protection`);
            break;
    }
}

/**
 * Log execution telemetry summary (call once per scan cycle)
 */
export function logTelemetrySummary(): void {
    const healthScore = getRpcHealthScore();
    const confirmStats = getConfirmationStats();
    const recentRpc = getRecentRpcSamples();
    const recentConfirm = getRecentConfirmationSamples();
    
    // Compute metrics
    const avgLatency = recentRpc.length > 0
        ? Math.round(recentRpc.reduce((a, b) => a + b.durationMs, 0) / recentRpc.length)
        : 0;
    const errorRate = recentRpc.length > 0
        ? (recentRpc.filter(s => !s.success).length / recentRpc.length * 100).toFixed(1)
        : '0.0';
    const timeoutRate = recentRpc.length > 0
        ? (recentRpc.filter(s => s.errorType === 'timeout').length / recentRpc.length * 100).toFixed(1)
        : '0.0';
    
    logger.info(`[EXEC-TELEMETRY] ═══ CYCLE SUMMARY ═══`);
    logger.info(`[EXEC-TELEMETRY] RPC Health: ${healthScore}/100 | avgLatency=${avgLatency}ms | errors=${errorRate}% | timeouts=${timeoutRate}%`);
    logger.info(`[EXEC-TELEMETRY] Confirmations: median=${confirmStats.medianMs}ms p95=${confirmStats.p95Ms}ms | slotDelta median=${confirmStats.slotDeltaMedian} p95=${confirmStats.slotDeltaP95}`);
    logger.info(`[EXEC-TELEMETRY] Samples: rpc=${recentRpc.length} confirm=${recentConfirm.length}`);
}

/**
 * Log startup telemetry status
 */
export function logStartupStatus(): void {
    logger.info('[EXEC-TELEMETRY] ═══════════════════════════════════════════════════════════════');
    logger.info('[EXEC-TELEMETRY] Execution Telemetry Module Initialized');
    logger.info(`[EXEC-TELEMETRY] RPC Health Score: ${getRpcHealthScore()}/100`);
    logger.info(`[EXEC-TELEMETRY] Entry Block Threshold: <${EXECUTION_TELEMETRY_CONFIG.ENTRY_BLOCK_HEALTH_THRESHOLD}`);
    logger.info(`[EXEC-TELEMETRY] Exit Block Confirmation P95: >${EXECUTION_TELEMETRY_CONFIG.EXIT_BLOCK_CONFIRMATION_P95_MS}ms`);
    logger.info(`[EXEC-TELEMETRY] Exit Block Slot Delta P95: >${EXECUTION_TELEMETRY_CONFIG.EXIT_BLOCK_SLOT_DELTA_P95}`);
    logger.info('[EXEC-TELEMETRY] ═══════════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get raw RPC metrics for debugging
 */
export function getRawRpcMetrics(): {
    sampleCount: number;
    avgLatencyMs: number;
    errorRate: number;
    timeoutRate: number;
    p95LatencyMs: number;
} {
    const samples = getRecentRpcSamples();
    
    if (samples.length === 0) {
        return {
            sampleCount: 0,
            avgLatencyMs: 0,
            errorRate: 0,
            timeoutRate: 0,
            p95LatencyMs: 0,
        };
    }
    
    const latencies = samples.map(s => s.durationMs).sort((a, b) => a - b);
    
    return {
        sampleCount: samples.length,
        avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        errorRate: samples.filter(s => !s.success).length / samples.length,
        timeoutRate: samples.filter(s => s.errorType === 'timeout').length / samples.length,
        p95LatencyMs: Math.round(percentile(latencies, 95)),
    };
}

/**
 * Clear all telemetry data (for testing or reset)
 */
export function clearTelemetryData(): void {
    rpcSamples.length = 0;
    confirmationSamples.length = 0;
    cachedHealthScore = null;
    cachedConfirmationStats = null;
    logger.info('[EXEC-TELEMETRY] All telemetry data cleared');
}

/**
 * Get health status as string for logging
 */
export function getHealthStatus(): 'EXCELLENT' | 'GOOD' | 'DEGRADED' | 'CRITICAL' {
    const score = getRpcHealthScore();
    
    if (score >= EXECUTION_TELEMETRY_CONFIG.HEALTH_EXCELLENT) return 'EXCELLENT';
    if (score >= EXECUTION_TELEMETRY_CONFIG.HEALTH_GOOD) return 'GOOD';
    if (score >= EXECUTION_TELEMETRY_CONFIG.HEALTH_DEGRADED) return 'DEGRADED';
    return 'CRITICAL';
}

