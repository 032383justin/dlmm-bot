/**
 * Execution Quality Optimizer - Tracker
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tracks execution records and computes aggregated metrics.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
    ExecutionRecord,
    ExecutionMetrics,
    PoolExecutionQuality,
} from './types';
import { DEFAULT_CONFIG } from './config';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const executionRecords: ExecutionRecord[] = [];
const poolQualities: Map<string, PoolExecutionQuality> = new Map();
let lastCleanupTime = Date.now();

// ═══════════════════════════════════════════════════════════════════════════════
// RECORD MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a new execution event
 */
export function recordExecution(record: ExecutionRecord): void {
    executionRecords.push(record);
    
    // Update pool-specific quality
    updatePoolQuality(record);
    
    // Periodic cleanup
    const now = Date.now();
    if (now - lastCleanupTime > 5 * 60 * 1000) {
        cleanupOldRecords();
        lastCleanupTime = now;
    }
}

/**
 * Record a successful transaction
 */
export function recordSuccessfulTx(
    txId: string,
    poolAddress: string,
    type: 'entry' | 'exit',
    sizeUSD: number,
    expectedPrice: number,
    actualPrice: number,
    confirmationLatencyMs: number,
    retryCount: number = 0
): void {
    const slippageRealized = Math.abs(actualPrice - expectedPrice) / expectedPrice;
    
    recordExecution({
        txId,
        poolAddress,
        timestamp: Date.now(),
        success: true,
        confirmationLatencyMs,
        expectedPrice,
        actualPrice,
        slippageRealized,
        type,
        sizeUSD,
        retryCount,
    });
}

/**
 * Record a failed transaction
 */
export function recordFailedTx(
    txId: string,
    poolAddress: string,
    type: 'entry' | 'exit',
    sizeUSD: number,
    expectedPrice: number,
    failureReason: string,
    retryCount: number = 0
): void {
    recordExecution({
        txId,
        poolAddress,
        timestamp: Date.now(),
        success: false,
        confirmationLatencyMs: null,
        expectedPrice,
        actualPrice: null,
        slippageRealized: null,
        type,
        sizeUSD,
        retryCount,
        failureReason,
    });
}

/**
 * Update pool-specific execution quality
 */
function updatePoolQuality(record: ExecutionRecord): void {
    const existing = poolQualities.get(record.poolAddress);
    
    if (!existing) {
        poolQualities.set(record.poolAddress, {
            poolAddress: record.poolAddress,
            score: record.success ? 1 : 0,
            totalTransactions: 1,
            successRate: record.success ? 1 : 0,
            avgSlippage: record.slippageRealized ?? 0,
            lastUpdated: Date.now(),
        });
        return;
    }
    
    // Update with exponential moving average
    const alpha = 0.2; // Weight for new observations
    const newSuccessRate = alpha * (record.success ? 1 : 0) + (1 - alpha) * existing.successRate;
    const newSlippage = record.slippageRealized !== null
        ? alpha * record.slippageRealized + (1 - alpha) * existing.avgSlippage
        : existing.avgSlippage;
    
    poolQualities.set(record.poolAddress, {
        ...existing,
        totalTransactions: existing.totalTransactions + 1,
        successRate: newSuccessRate,
        avgSlippage: newSlippage,
        score: newSuccessRate * (1 - Math.min(1, newSlippage / 0.02)),
        lastUpdated: Date.now(),
    });
}

/**
 * Get records within a time window
 */
export function getRecordsInWindow(windowMs: number = DEFAULT_CONFIG.metricsWindowMs): ExecutionRecord[] {
    const cutoff = Date.now() - windowMs;
    return executionRecords.filter(r => r.timestamp >= cutoff);
}

/**
 * Compute aggregated execution metrics
 */
export function computeMetrics(windowMs: number = DEFAULT_CONFIG.metricsWindowMs): ExecutionMetrics {
    const records = getRecordsInWindow(windowMs);
    const now = Date.now();
    
    if (records.length === 0) {
        return createEmptyMetrics(now - windowMs, now);
    }
    
    const successfulRecords = records.filter(r => r.success);
    const failedRecords = records.filter(r => !r.success);
    const entryRecords = records.filter(r => r.type === 'entry');
    const exitRecords = records.filter(r => r.type === 'exit');
    
    // Latency calculations
    const latencies = successfulRecords
        .map(r => r.confirmationLatencyMs)
        .filter((l): l is number => l !== null)
        .sort((a, b) => a - b);
    
    const avgLatency = latencies.length > 0
        ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length
        : 0;
    
    const p95Index = Math.floor(latencies.length * 0.95);
    const p95Latency = latencies.length > 0 ? latencies[p95Index] || latencies[latencies.length - 1] : 0;
    
    // Slippage calculations
    const slippages = successfulRecords
        .map(r => r.slippageRealized)
        .filter((s): s is number => s !== null);
    
    const avgSlippage = slippages.length > 0
        ? slippages.reduce((sum, s) => sum + s, 0) / slippages.length
        : 0;
    
    const maxSlippage = slippages.length > 0
        ? Math.max(...slippages)
        : 0;
    
    // Retry calculations
    const avgRetryCount = records.reduce((sum, r) => sum + r.retryCount, 0) / records.length;
    
    // Entry/Exit specific success rates
    const entrySuccessRate = entryRecords.length > 0
        ? entryRecords.filter(r => r.success).length / entryRecords.length
        : 1;
    
    const exitSuccessRate = exitRecords.length > 0
        ? exitRecords.filter(r => r.success).length / exitRecords.length
        : 1;
    
    return {
        windowStart: records.length > 0 ? Math.min(...records.map(r => r.timestamp)) : now - windowMs,
        windowEnd: now,
        totalTx: records.length,
        successfulTx: successfulRecords.length,
        failedTx: failedRecords.length,
        txSuccessRate: records.length > 0 ? successfulRecords.length / records.length : 1,
        avgConfirmationLatencyMs: avgLatency,
        p95ConfirmationLatencyMs: p95Latency,
        avgSlippage,
        maxSlippage,
        failedTxRate: records.length > 0 ? failedRecords.length / records.length : 0,
        avgRetryCount,
        entrySuccessRate,
        exitSuccessRate,
    };
}

/**
 * Create empty metrics object
 */
function createEmptyMetrics(windowStart: number, windowEnd: number): ExecutionMetrics {
    return {
        windowStart,
        windowEnd,
        totalTx: 0,
        successfulTx: 0,
        failedTx: 0,
        txSuccessRate: 1,
        avgConfirmationLatencyMs: 0,
        p95ConfirmationLatencyMs: 0,
        avgSlippage: 0,
        maxSlippage: 0,
        failedTxRate: 0,
        avgRetryCount: 0,
        entrySuccessRate: 1,
        exitSuccessRate: 1,
    };
}

/**
 * Cleanup old records outside the maximum window
 */
function cleanupOldRecords(): void {
    const maxWindow = 2 * 60 * 60 * 1000; // 2 hours
    const cutoff = Date.now() - maxWindow;
    
    let removed = 0;
    while (executionRecords.length > 0 && executionRecords[0].timestamp < cutoff) {
        executionRecords.shift();
        removed++;
    }
    
    if (removed > 0) {
        // Also cleanup stale pool qualities
        const poolCutoff = Date.now() - maxWindow;
        for (const [poolAddress, quality] of poolQualities.entries()) {
            if (quality.lastUpdated < poolCutoff) {
                poolQualities.delete(poolAddress);
            }
        }
    }
}

/**
 * Get pool-specific execution quality
 */
export function getPoolExecutionQuality(poolAddress: string): PoolExecutionQuality | undefined {
    return poolQualities.get(poolAddress);
}

/**
 * Get all pool execution qualities
 */
export function getAllPoolQualities(): Map<string, PoolExecutionQuality> {
    return new Map(poolQualities);
}

/**
 * Get the count of records
 */
export function getRecordCount(): number {
    return executionRecords.length;
}

/**
 * Get recent failed transaction count
 */
export function getRecentFailedCount(windowMs: number = 5 * 60 * 1000): number {
    const records = getRecordsInWindow(windowMs);
    return records.filter(r => !r.success).length;
}

/**
 * Clear all execution records (for testing)
 */
export function clearAllRecords(): void {
    executionRecords.length = 0;
    poolQualities.clear();
}

