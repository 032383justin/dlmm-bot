/**
 * Execution Quality Tracker
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Track and record execution events for quality scoring.
 * This module maintains a rolling window of execution events.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { v4 as uuidv4 } from 'uuid';
import { ExecutionEvent, ExecutionMetrics, ExecutionQualityConfig } from './types';
import { DEFAULT_CONFIG } from './config';
import logger from '../../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION EVENT STORE
// Rolling window of execution events
// ═══════════════════════════════════════════════════════════════════════════════

const executionEvents: ExecutionEvent[] = [];
const MAX_EVENTS = 500; // Maximum events to keep in memory

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT RECORDING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a new execution event (entry or exit attempt)
 */
export function recordExecutionEvent(event: Omit<ExecutionEvent, 'id'>): ExecutionEvent {
    const fullEvent: ExecutionEvent = {
        ...event,
        id: uuidv4(),
    };
    
    executionEvents.push(fullEvent);
    
    // Trim old events to prevent memory bloat
    if (executionEvents.length > MAX_EVENTS) {
        executionEvents.splice(0, executionEvents.length - MAX_EVENTS);
    }
    
    return fullEvent;
}

/**
 * Record a successful execution
 */
export function recordSuccessfulExecution(params: {
    poolAddress: string;
    tradeType: 'entry' | 'exit';
    expectedSlippage: number;
    realizedSlippage: number;
    expectedPrice: number;
    actualPrice: number;
    attempts: number;
    latencyMs: number;
    signature?: string;
}): ExecutionEvent {
    const now = Date.now();
    
    return recordExecutionEvent({
        poolAddress: params.poolAddress,
        tradeType: params.tradeType,
        initiatedAt: now - params.latencyMs,
        completedAt: now,
        success: true,
        expectedSlippage: params.expectedSlippage,
        realizedSlippage: params.realizedSlippage,
        expectedPrice: params.expectedPrice,
        actualPrice: params.actualPrice,
        attempts: params.attempts,
        signature: params.signature,
    });
}

/**
 * Record a failed execution
 */
export function recordFailedExecution(params: {
    poolAddress: string;
    tradeType: 'entry' | 'exit';
    expectedSlippage: number;
    expectedPrice: number;
    attempts: number;
    latencyMs: number;
    failureReason: string;
    reverted?: boolean;
}): ExecutionEvent {
    const now = Date.now();
    
    return recordExecutionEvent({
        poolAddress: params.poolAddress,
        tradeType: params.tradeType,
        initiatedAt: now - params.latencyMs,
        completedAt: now,
        success: false,
        expectedSlippage: params.expectedSlippage,
        expectedPrice: params.expectedPrice,
        attempts: params.attempts,
        failureReason: params.reverted 
            ? `REVERTED: ${params.failureReason}` 
            : params.failureReason,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get execution events within a time window
 */
export function getEventsInWindow(windowMs: number = DEFAULT_CONFIG.metricsWindowMs): ExecutionEvent[] {
    const cutoff = Date.now() - windowMs;
    return executionEvents.filter(e => e.initiatedAt >= cutoff);
}

/**
 * Compute aggregated execution metrics from recent events
 */
export function computeExecutionMetrics(
    config: ExecutionQualityConfig = DEFAULT_CONFIG
): ExecutionMetrics {
    const now = Date.now();
    const windowStart = now - config.metricsWindowMs;
    const recentEvents = getEventsInWindow(config.metricsWindowMs);
    
    // Initialize metrics with defaults for empty window
    if (recentEvents.length === 0) {
        return {
            windowStartMs: windowStart,
            windowEndMs: now,
            totalExecutions: 0,
            successfulExecutions: 0,
            failedExecutions: 0,
            txSuccessRate: 1.0, // Assume good if no data (conservative)
            avgSlippageDeviation: 0,
            maxSlippage: 0,
            avgLatencyMs: 0,
            avgAttemptsPerExecution: 1,
            avgFillPriceDeviation: 0,
            revertedTxCount: 0,
        };
    }
    
    // Compute aggregates
    const successful = recentEvents.filter(e => e.success);
    const failed = recentEvents.filter(e => !e.success);
    const reverted = failed.filter(e => e.failureReason?.startsWith('REVERTED'));
    
    // Success rate
    const txSuccessRate = recentEvents.length > 0 
        ? successful.length / recentEvents.length 
        : 1.0;
    
    // Slippage metrics (only from successful executions with slippage data)
    const slippageEvents = successful.filter(e => 
        e.realizedSlippage !== undefined && e.expectedSlippage !== undefined
    );
    
    let avgSlippageDeviation = 0;
    let maxSlippage = 0;
    
    if (slippageEvents.length > 0) {
        const slippageDeviations = slippageEvents.map(e => 
            (e.realizedSlippage ?? 0) - e.expectedSlippage
        );
        avgSlippageDeviation = slippageDeviations.reduce((a, b) => a + b, 0) / slippageDeviations.length;
        maxSlippage = Math.max(...slippageEvents.map(e => e.realizedSlippage ?? 0));
    }
    
    // Latency metrics
    const latencyEvents = recentEvents.filter(e => 
        e.completedAt !== undefined && e.initiatedAt !== undefined
    );
    
    let avgLatencyMs = config.baselineLatencyMs; // Default to baseline
    if (latencyEvents.length > 0) {
        const latencies = latencyEvents.map(e => (e.completedAt ?? 0) - e.initiatedAt);
        avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    }
    
    // Attempts per execution
    const avgAttemptsPerExecution = recentEvents.length > 0
        ? recentEvents.reduce((sum, e) => sum + e.attempts, 0) / recentEvents.length
        : 1;
    
    // Fill price deviation (only from successful executions)
    const priceEvents = successful.filter(e => 
        e.actualPrice !== undefined && e.expectedPrice !== undefined && e.expectedPrice > 0
    );
    
    let avgFillPriceDeviation = 0;
    if (priceEvents.length > 0) {
        const priceDeviations = priceEvents.map(e => 
            Math.abs((e.actualPrice ?? 0) - e.expectedPrice) / e.expectedPrice
        );
        avgFillPriceDeviation = priceDeviations.reduce((a, b) => a + b, 0) / priceDeviations.length;
    }
    
    return {
        windowStartMs: windowStart,
        windowEndMs: now,
        totalExecutions: recentEvents.length,
        successfulExecutions: successful.length,
        failedExecutions: failed.length,
        txSuccessRate,
        avgSlippageDeviation,
        maxSlippage,
        avgLatencyMs,
        avgAttemptsPerExecution,
        avgFillPriceDeviation,
        revertedTxCount: reverted.length,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clear all execution events (for testing or reset)
 */
export function clearExecutionEvents(): void {
    executionEvents.length = 0;
    logger.info('[EXECUTION_QUALITY] Execution events cleared');
}

/**
 * Get total number of tracked events
 */
export function getEventCount(): number {
    return executionEvents.length;
}

/**
 * Get recent failed executions for debugging
 */
export function getRecentFailures(count: number = 10): ExecutionEvent[] {
    return executionEvents
        .filter(e => !e.success)
        .slice(-count);
}

