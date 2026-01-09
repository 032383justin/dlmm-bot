/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREDATOR OBSERVABILITY — Metrics & Summary
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Make the predator measurable with per-pool rolling metrics.
 * 
 * PER-POOL METRICS:
 *   - fees/hr (real)
 *   - rebalance count/day
 *   - avg hold time
 *   - cost amortization progress
 *   - net PnL attribution (fees vs slip vs entry/exit fees)
 *   - "extraction efficiency" = fees / total costs
 * 
 * PREDATOR SUMMARY:
 *   - Top 5 pools by fees/hr
 *   - Top 5 pools by extraction efficiency
 *   - Worst 5 pools by cost bleed
 *   - Capital ramp stage per pool (Probe/2.5/5/Cap)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const OBSERVABILITY_CONFIG = {
    /** Enable predator observability */
    ENABLED: true,
    
    /** Summary log interval (ms) */
    SUMMARY_INTERVAL_MS: 15 * 60 * 1000,  // 15 minutes
    
    /** Rolling window for metrics (ms) */
    ROLLING_WINDOW_MS: 24 * 60 * 60 * 1000,  // 24 hours
    
    /** Number of top/worst pools to show in summary */
    TOP_N: 5,
    
    /** Extraction efficiency warning threshold */
    LOW_EFFICIENCY_THRESHOLD: 1.0,  // < 1.0 = losing money to costs
    
    /** Cost bleed warning threshold ($/hr) */
    COST_BLEED_THRESHOLD: 0.05,  // $0.05/hr net loss
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PoolMetrics {
    poolAddress: string;
    poolName: string;
    
    // Fee metrics
    totalFeesUsd: number;
    feesPerHour: number;
    feesSamples: Array<{ timestamp: number; feesUsd: number }>;
    
    // Rebalance metrics
    rebalanceCount: number;
    rebalanceCountToday: number;
    lastRebalanceAt?: number;
    
    // Hold time metrics
    holdTimeMs: number;
    avgHoldTimeMs: number;
    holdTimeSamples: number[];
    
    // Cost metrics
    totalEntryCosts: number;
    totalExitCosts: number;
    totalSlippageCosts: number;
    totalRebalanceCosts: number;
    totalCosts: number;
    
    // Efficiency metrics
    extractionEfficiency: number;  // fees / total costs
    netPnl: number;                // fees - total costs
    netPnlPerHour: number;
    
    // Capital ramp stage
    trancheStage: string;
    
    // Timestamps
    entryTimestamp: number;
    lastUpdateAt: number;
}

export interface PredatorSummary {
    timestamp: number;
    
    // Aggregate metrics
    totalPoolsActive: number;
    totalDeployedUsd: number;
    totalFeesUsd: number;
    totalCostsUsd: number;
    netPnlUsd: number;
    aggregateEfficiency: number;
    feesPerHour: number;
    
    // Rankings
    topByFeesHr: Array<{ poolName: string; feesHr: number }>;
    topByEfficiency: Array<{ poolName: string; efficiency: number }>;
    worstByCostBleed: Array<{ poolName: string; bleedHr: number }>;
    
    // Stage breakdown
    byStage: {
        PROBE: number;
        TRANCHE_2: number;
        TRANCHE_3: number;
        CAP: number;
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

const poolMetrics = new Map<string, PoolMetrics>();
let lastSummaryAt = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize metrics for a new pool position.
 */
export function initializePoolMetrics(
    poolAddress: string,
    poolName: string,
    entryCostUsd: number,
    trancheStage: string = 'PROBE'
): void {
    const now = Date.now();
    
    const metrics: PoolMetrics = {
        poolAddress,
        poolName,
        totalFeesUsd: 0,
        feesPerHour: 0,
        feesSamples: [],
        rebalanceCount: 0,
        rebalanceCountToday: 0,
        holdTimeMs: 0,
        avgHoldTimeMs: 0,
        holdTimeSamples: [],
        totalEntryCosts: entryCostUsd,
        totalExitCosts: 0,
        totalSlippageCosts: 0,
        totalRebalanceCosts: 0,
        totalCosts: entryCostUsd,
        extractionEfficiency: 0,
        netPnl: -entryCostUsd,
        netPnlPerHour: 0,
        trancheStage,
        entryTimestamp: now,
        lastUpdateAt: now,
    };
    
    poolMetrics.set(poolAddress, metrics);
    
    logger.info(
        `[PREDATOR-OBS] INIT | pool=${poolName} stage=${trancheStage} | ` +
        `entryCost=$${entryCostUsd.toFixed(2)}`
    );
}

/**
 * Update pool metrics with new fee data.
 */
export function updatePoolFees(
    poolAddress: string,
    feesAccumulatedUsd: number,
    currentFeeVelocityHr: number
): void {
    const metrics = poolMetrics.get(poolAddress);
    if (!metrics) return;
    
    const now = Date.now();
    const holdTimeMs = now - metrics.entryTimestamp;
    
    // Update fees
    metrics.totalFeesUsd = feesAccumulatedUsd;
    metrics.feesPerHour = currentFeeVelocityHr;
    metrics.feesSamples.push({ timestamp: now, feesUsd: feesAccumulatedUsd });
    
    // Keep only samples within rolling window
    const windowStart = now - OBSERVABILITY_CONFIG.ROLLING_WINDOW_MS;
    metrics.feesSamples = metrics.feesSamples.filter(s => s.timestamp > windowStart);
    
    // Update hold time
    metrics.holdTimeMs = holdTimeMs;
    
    // Update efficiency
    metrics.totalCosts = metrics.totalEntryCosts + metrics.totalExitCosts + 
                          metrics.totalSlippageCosts + metrics.totalRebalanceCosts;
    metrics.extractionEfficiency = metrics.totalCosts > 0 
        ? metrics.totalFeesUsd / metrics.totalCosts 
        : 0;
    
    // Update PnL
    metrics.netPnl = metrics.totalFeesUsd - metrics.totalCosts;
    metrics.netPnlPerHour = holdTimeMs > 0 
        ? (metrics.netPnl / holdTimeMs) * (60 * 60 * 1000) 
        : 0;
    
    metrics.lastUpdateAt = now;
    poolMetrics.set(poolAddress, metrics);
}

/**
 * Record a rebalance for a pool.
 */
export function recordPoolRebalance(
    poolAddress: string,
    rebalanceCostUsd: number
): void {
    const metrics = poolMetrics.get(poolAddress);
    if (!metrics) return;
    
    const now = Date.now();
    
    metrics.rebalanceCount++;
    metrics.rebalanceCountToday++;
    metrics.lastRebalanceAt = now;
    metrics.totalRebalanceCosts += rebalanceCostUsd;
    metrics.totalCosts += rebalanceCostUsd;
    metrics.lastUpdateAt = now;
    
    poolMetrics.set(poolAddress, metrics);
}

/**
 * Update tranche stage for a pool.
 */
export function updatePoolStage(
    poolAddress: string,
    newStage: string
): void {
    const metrics = poolMetrics.get(poolAddress);
    if (!metrics) return;
    
    logger.info(
        `[PREDATOR-OBS] STAGE_UP | pool=${metrics.poolName} | ` +
        `${metrics.trancheStage} → ${newStage}`
    );
    
    metrics.trancheStage = newStage;
    metrics.lastUpdateAt = Date.now();
    poolMetrics.set(poolAddress, metrics);
}

/**
 * Finalize metrics on position close.
 */
export function finalizePoolMetrics(
    poolAddress: string,
    exitCostUsd: number,
    slippageUsd: number
): PoolMetrics | undefined {
    const metrics = poolMetrics.get(poolAddress);
    if (!metrics) return undefined;
    
    const now = Date.now();
    
    // Update final costs
    metrics.totalExitCosts = exitCostUsd;
    metrics.totalSlippageCosts = slippageUsd;
    metrics.totalCosts = metrics.totalEntryCosts + metrics.totalExitCosts + 
                          metrics.totalSlippageCosts + metrics.totalRebalanceCosts;
    
    // Final efficiency calculation
    metrics.extractionEfficiency = metrics.totalCosts > 0 
        ? metrics.totalFeesUsd / metrics.totalCosts 
        : 0;
    
    // Final PnL
    metrics.netPnl = metrics.totalFeesUsd - metrics.totalCosts;
    metrics.holdTimeMs = now - metrics.entryTimestamp;
    metrics.netPnlPerHour = metrics.holdTimeMs > 0 
        ? (metrics.netPnl / metrics.holdTimeMs) * (60 * 60 * 1000) 
        : 0;
    
    // Record hold time sample
    metrics.holdTimeSamples.push(metrics.holdTimeMs);
    metrics.avgHoldTimeMs = metrics.holdTimeSamples.reduce((a, b) => a + b, 0) / metrics.holdTimeSamples.length;
    
    logger.info(
        `[PREDATOR-OBS] FINALIZE | pool=${metrics.poolName} | ` +
        `fees=$${metrics.totalFeesUsd.toFixed(2)} costs=$${metrics.totalCosts.toFixed(2)} | ` +
        `netPnL=$${metrics.netPnl.toFixed(2)} | efficiency=${metrics.extractionEfficiency.toFixed(2)}x | ` +
        `holdTime=${(metrics.holdTimeMs / 60000).toFixed(0)}m | rebalances=${metrics.rebalanceCount}`
    );
    
    // Don't remove metrics - keep for summary
    return metrics;
}

/**
 * Get metrics for a pool.
 */
export function getPoolMetrics(poolAddress: string): PoolMetrics | undefined {
    return poolMetrics.get(poolAddress);
}

/**
 * Generate predator summary.
 */
export function generatePredatorSummary(): PredatorSummary {
    const now = Date.now();
    const allMetrics = Array.from(poolMetrics.values());
    
    // Filter to active pools (updated in last hour)
    const activeMetrics = allMetrics.filter(m => 
        now - m.lastUpdateAt < 60 * 60 * 1000
    );
    
    // Aggregate metrics
    const totalDeployedUsd = 0; // Would need position size tracking
    const totalFeesUsd = activeMetrics.reduce((sum, m) => sum + m.totalFeesUsd, 0);
    const totalCostsUsd = activeMetrics.reduce((sum, m) => sum + m.totalCosts, 0);
    const netPnlUsd = totalFeesUsd - totalCostsUsd;
    const aggregateEfficiency = totalCostsUsd > 0 ? totalFeesUsd / totalCostsUsd : 0;
    const feesPerHour = activeMetrics.reduce((sum, m) => sum + m.feesPerHour, 0);
    
    // Sort for rankings
    const byFeesHr = [...activeMetrics].sort((a, b) => b.feesPerHour - a.feesPerHour);
    const byEfficiency = [...activeMetrics].sort((a, b) => b.extractionEfficiency - a.extractionEfficiency);
    const byCostBleed = [...activeMetrics]
        .filter(m => m.netPnlPerHour < 0)
        .sort((a, b) => a.netPnlPerHour - b.netPnlPerHour);
    
    // Stage breakdown
    const byStage = {
        PROBE: activeMetrics.filter(m => m.trancheStage === 'PROBE').length,
        TRANCHE_2: activeMetrics.filter(m => m.trancheStage === 'TRANCHE_2').length,
        TRANCHE_3: activeMetrics.filter(m => m.trancheStage === 'TRANCHE_3').length,
        CAP: activeMetrics.filter(m => m.trancheStage === 'CAP').length,
    };
    
    return {
        timestamp: now,
        totalPoolsActive: activeMetrics.length,
        totalDeployedUsd,
        totalFeesUsd,
        totalCostsUsd,
        netPnlUsd,
        aggregateEfficiency,
        feesPerHour,
        topByFeesHr: byFeesHr.slice(0, OBSERVABILITY_CONFIG.TOP_N).map(m => ({
            poolName: m.poolName,
            feesHr: m.feesPerHour,
        })),
        topByEfficiency: byEfficiency.slice(0, OBSERVABILITY_CONFIG.TOP_N).map(m => ({
            poolName: m.poolName,
            efficiency: m.extractionEfficiency,
        })),
        worstByCostBleed: byCostBleed.slice(0, OBSERVABILITY_CONFIG.TOP_N).map(m => ({
            poolName: m.poolName,
            bleedHr: -m.netPnlPerHour,
        })),
        byStage,
    };
}

/**
 * Clean up old metrics (call periodically).
 */
export function cleanupOldMetrics(): void {
    const now = Date.now();
    const maxAge = OBSERVABILITY_CONFIG.ROLLING_WINDOW_MS;
    
    for (const [address, metrics] of poolMetrics) {
        if (now - metrics.lastUpdateAt > maxAge) {
            poolMetrics.delete(address);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log predator summary.
 */
export function logPredatorSummary(): void {
    if (!OBSERVABILITY_CONFIG.ENABLED) return;
    
    const now = Date.now();
    
    // Check interval
    if (now - lastSummaryAt < OBSERVABILITY_CONFIG.SUMMARY_INTERVAL_MS) {
        return;
    }
    lastSummaryAt = now;
    
    const summary = generatePredatorSummary();
    
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                        🦅 PREDATOR SUMMARY 🦅                                ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log(`║  Active Pools: ${summary.totalPoolsActive.toString().padEnd(4)} | Fees/hr: $${summary.feesPerHour.toFixed(4).padEnd(8)} | Net PnL: $${summary.netPnlUsd.toFixed(2).padStart(8)} ║`);
    console.log(`║  Total Fees: $${summary.totalFeesUsd.toFixed(2).padEnd(8)} | Total Costs: $${summary.totalCostsUsd.toFixed(2).padEnd(8)} | Efficiency: ${summary.aggregateEfficiency.toFixed(2)}x    ║`);
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║  CAPITAL RAMP STAGES:                                                        ║');
    console.log(`║    PROBE: ${summary.byStage.PROBE}  |  T2: ${summary.byStage.TRANCHE_2}  |  T3: ${summary.byStage.TRANCHE_3}  |  CAP: ${summary.byStage.CAP}                                      ║`);
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    
    if (summary.topByFeesHr.length > 0) {
        console.log('║  TOP BY FEES/HR:                                                             ║');
        summary.topByFeesHr.forEach((p, i) => {
            console.log(`║    ${i + 1}. ${p.poolName.padEnd(20).slice(0, 20)} $${p.feesHr.toFixed(4)}/hr                             ║`);
        });
    }
    
    if (summary.topByEfficiency.length > 0) {
        console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
        console.log('║  TOP BY EFFICIENCY:                                                          ║');
        summary.topByEfficiency.slice(0, 3).forEach((p, i) => {
            console.log(`║    ${i + 1}. ${p.poolName.padEnd(20).slice(0, 20)} ${p.efficiency.toFixed(2)}x                                  ║`);
        });
    }
    
    if (summary.worstByCostBleed.length > 0) {
        console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
        console.log('║  ⚠️  COST BLEED WARNING:                                                     ║');
        summary.worstByCostBleed.slice(0, 3).forEach((p, i) => {
            console.log(`║    ${i + 1}. ${p.poolName.padEnd(20).slice(0, 20)} -$${p.bleedHr.toFixed(4)}/hr                           ║`);
        });
    }
    
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log('');
    
    // Also log to standard logger
    logger.info(
        `[PREDATOR-SUMMARY] ` +
        `pools=${summary.totalPoolsActive} | fees/hr=$${summary.feesPerHour.toFixed(4)} | ` +
        `netPnL=$${summary.netPnlUsd.toFixed(2)} | efficiency=${summary.aggregateEfficiency.toFixed(2)}x | ` +
        `stages: P=${summary.byStage.PROBE} T2=${summary.byStage.TRANCHE_2} T3=${summary.byStage.TRANCHE_3} CAP=${summary.byStage.CAP}`
    );
}

/**
 * Log per-pool metrics.
 */
export function logPoolMetrics(poolAddress: string): void {
    const metrics = poolMetrics.get(poolAddress);
    if (!metrics) return;
    
    const holdMinutes = metrics.holdTimeMs / 60000;
    
    logger.info(
        `[POOL-METRICS] ${metrics.poolName} | ` +
        `fees=$${metrics.totalFeesUsd.toFixed(2)} fees/hr=$${metrics.feesPerHour.toFixed(4)} | ` +
        `costs=$${metrics.totalCosts.toFixed(2)} | netPnL=$${metrics.netPnl.toFixed(2)} | ` +
        `efficiency=${metrics.extractionEfficiency.toFixed(2)}x | ` +
        `hold=${holdMinutes.toFixed(0)}m rebal=${metrics.rebalanceCount} | ` +
        `stage=${metrics.trancheStage}`
    );
}

export default {
    OBSERVABILITY_CONFIG,
    initializePoolMetrics,
    updatePoolFees,
    recordPoolRebalance,
    updatePoolStage,
    finalizePoolMetrics,
    getPoolMetrics,
    generatePredatorSummary,
    cleanupOldMetrics,
    logPredatorSummary,
    logPoolMetrics,
};

