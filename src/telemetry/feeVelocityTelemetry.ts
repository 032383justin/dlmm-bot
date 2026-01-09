/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEE VELOCITY TELEMETRY — PREDATOR MODE v1 OPTIMIZATION METRICS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * STOP OPTIMIZING FOR:
 * - Pretty EV curves
 * - Short-term PnL cleanliness
 * - Early profitability
 * 
 * START OPTIMIZING FOR:
 * - Fee velocity (fee generation per unit time)
 * - Rebalance density (rebalances per hour)
 * - Time-in-bin dominance (time spent as bin leader)
 * - Capital reuse speed (how fast capital cycles)
 * 
 * SUCCESS CRITERIA:
 * - Winning days matter
 * - Individual trades do NOT matter
 * - Target: 90%+ green days at portfolio level
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    PREDATOR_MODE_V1_ENABLED,
    TELEMETRY_OPTIMIZATION_CONFIG,
    SUCCESS_CRITERIA,
} from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface FeeVelocityMetrics {
    /** Fees earned per hour (USD) */
    feesPerHour: number;
    
    /** Fees earned per deployed dollar per hour */
    feesPerDeployedPerHour: number;
    
    /** Rolling 24h fee total */
    fees24hUsd: number;
    
    /** Rebalances per hour */
    rebalancesPerHour: number;
    
    /** Minutes spent as bin leader */
    binDominanceMinutes: number;
    
    /** Average position hold time (minutes) */
    avgHoldTimeMinutes: number;
    
    /** Capital turnover (times capital has been cycled) */
    capitalTurnover: number;
}

export interface DailyPerformance {
    date: string;
    feesUsd: number;
    costsUsd: number;
    netPnlUsd: number;
    isGreenDay: boolean;
    rebalanceCount: number;
    avgDeployedUsd: number;
    feeYieldPct: number;
}

export interface PortfolioMetrics {
    /** Total days tracked */
    totalDays: number;
    
    /** Green days count */
    greenDays: number;
    
    /** Green day percentage */
    greenDayPct: number;
    
    /** Total fees earned */
    totalFeesUsd: number;
    
    /** Total costs incurred */
    totalCostsUsd: number;
    
    /** Net profit */
    netProfitUsd: number;
    
    /** Average daily fee velocity */
    avgDailyFeeVelocity: number;
    
    /** Average rebalances per day */
    avgDailyRebalances: number;
    
    /** Is meeting 90% green day target */
    meetsGreenDayTarget: boolean;
}

export interface PositionTelemetry {
    tradeId: string;
    poolName: string;
    entryTime: number;
    
    // Fee tracking
    feesAccruedUsd: number;
    feeVelocity: number;  // Fees per hour
    
    // Cost tracking
    entryCostUsd: number;
    rebalanceCostUsd: number;
    totalCostUsd: number;
    
    // Bin dominance
    binDominanceMinutes: number;
    lastBinDominanceUpdate: number;
    
    // Rebalance tracking
    rebalanceCount: number;
    rebalancesPerHour: number;
    
    // Performance
    netPnlUsd: number;
    feeYieldPct: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const positionTelemetry = new Map<string, PositionTelemetry>();
const dailyPerformance: DailyPerformance[] = [];

let totalFeesAllTime = 0;
let totalCostsAllTime = 0;
let totalRebalancesAllTime = 0;
let sessionStartTime = Date.now();

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize telemetry for a new position
 */
export function initializePositionTelemetry(
    tradeId: string,
    poolName: string,
    entryCostUsd: number
): void {
    positionTelemetry.set(tradeId, {
        tradeId,
        poolName,
        entryTime: Date.now(),
        feesAccruedUsd: 0,
        feeVelocity: 0,
        entryCostUsd,
        rebalanceCostUsd: 0,
        totalCostUsd: entryCostUsd,
        binDominanceMinutes: 0,
        lastBinDominanceUpdate: Date.now(),
        rebalanceCount: 0,
        rebalancesPerHour: 0,
        netPnlUsd: -entryCostUsd,
        feeYieldPct: 0,
    });
}

/**
 * Record fees earned
 */
export function recordFees(tradeId: string, feesUsd: number): void {
    const telemetry = positionTelemetry.get(tradeId);
    if (!telemetry) return;
    
    telemetry.feesAccruedUsd += feesUsd;
    totalFeesAllTime += feesUsd;
    
    // Update fee velocity
    const hoursHeld = (Date.now() - telemetry.entryTime) / (60 * 60 * 1000);
    telemetry.feeVelocity = hoursHeld > 0 ? telemetry.feesAccruedUsd / hoursHeld : 0;
    
    // Update net PnL
    telemetry.netPnlUsd = telemetry.feesAccruedUsd - telemetry.totalCostUsd;
    
    // Update fee yield
    if (telemetry.entryCostUsd > 0) {
        telemetry.feeYieldPct = (telemetry.feesAccruedUsd / telemetry.entryCostUsd) * 100;
    }
}

/**
 * Record rebalance cost
 */
export function recordRebalanceCost(tradeId: string, costUsd: number): void {
    const telemetry = positionTelemetry.get(tradeId);
    if (!telemetry) return;
    
    telemetry.rebalanceCostUsd += costUsd;
    telemetry.totalCostUsd = telemetry.entryCostUsd + telemetry.rebalanceCostUsd;
    telemetry.rebalanceCount++;
    totalCostsAllTime += costUsd;
    totalRebalancesAllTime++;
    
    // Update rebalances per hour
    const hoursHeld = (Date.now() - telemetry.entryTime) / (60 * 60 * 1000);
    telemetry.rebalancesPerHour = hoursHeld > 0 ? telemetry.rebalanceCount / hoursHeld : 0;
    
    // Update net PnL
    telemetry.netPnlUsd = telemetry.feesAccruedUsd - telemetry.totalCostUsd;
}

/**
 * Record bin dominance time
 */
export function recordBinDominance(tradeId: string, isDominant: boolean): void {
    const telemetry = positionTelemetry.get(tradeId);
    if (!telemetry) return;
    
    const now = Date.now();
    
    if (isDominant) {
        const minutesSinceLastUpdate = (now - telemetry.lastBinDominanceUpdate) / (60 * 1000);
        telemetry.binDominanceMinutes += minutesSinceLastUpdate;
    }
    
    telemetry.lastBinDominanceUpdate = now;
}

/**
 * Get position telemetry
 */
export function getPositionTelemetry(tradeId: string): PositionTelemetry | undefined {
    return positionTelemetry.get(tradeId);
}

/**
 * Cleanup telemetry for closed position
 */
export function cleanupPositionTelemetry(tradeId: string): PositionTelemetry | undefined {
    const telemetry = positionTelemetry.get(tradeId);
    if (telemetry) {
        positionTelemetry.delete(tradeId);
    }
    return telemetry;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY PERFORMANCE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record daily performance (call at end of day or on demand)
 */
export function recordDailyPerformance(
    feesUsd: number,
    costsUsd: number,
    rebalanceCount: number,
    avgDeployedUsd: number
): void {
    const date = new Date().toISOString().split('T')[0];
    const netPnl = feesUsd - costsUsd;
    const feeYield = avgDeployedUsd > 0 ? (feesUsd / avgDeployedUsd) * 100 : 0;
    
    // Check if we already have an entry for today
    const existingIndex = dailyPerformance.findIndex(d => d.date === date);
    
    const entry: DailyPerformance = {
        date,
        feesUsd,
        costsUsd,
        netPnlUsd: netPnl,
        isGreenDay: netPnl > 0,
        rebalanceCount,
        avgDeployedUsd,
        feeYieldPct: feeYield,
    };
    
    if (existingIndex >= 0) {
        dailyPerformance[existingIndex] = entry;
    } else {
        dailyPerformance.push(entry);
    }
    
    // Keep last 30 days
    while (dailyPerformance.length > 30) {
        dailyPerformance.shift();
    }
}

/**
 * Get portfolio metrics
 */
export function getPortfolioMetrics(): PortfolioMetrics {
    if (dailyPerformance.length === 0) {
        return {
            totalDays: 0,
            greenDays: 0,
            greenDayPct: 0,
            totalFeesUsd: totalFeesAllTime,
            totalCostsUsd: totalCostsAllTime,
            netProfitUsd: totalFeesAllTime - totalCostsAllTime,
            avgDailyFeeVelocity: 0,
            avgDailyRebalances: 0,
            meetsGreenDayTarget: false,
        };
    }
    
    const greenDays = dailyPerformance.filter(d => d.isGreenDay).length;
    const totalFees = dailyPerformance.reduce((sum, d) => sum + d.feesUsd, 0);
    const totalCosts = dailyPerformance.reduce((sum, d) => sum + d.costsUsd, 0);
    const totalRebalances = dailyPerformance.reduce((sum, d) => sum + d.rebalanceCount, 0);
    
    const greenDayPct = (greenDays / dailyPerformance.length) * 100;
    const target = SUCCESS_CRITERIA.WORKING_INDICATORS.includes('portfolio_90pct_green_days') ? 90 : 80;
    
    return {
        totalDays: dailyPerformance.length,
        greenDays,
        greenDayPct,
        totalFeesUsd: totalFees,
        totalCostsUsd: totalCosts,
        netProfitUsd: totalFees - totalCosts,
        avgDailyFeeVelocity: totalFees / dailyPerformance.length,
        avgDailyRebalances: totalRebalances / dailyPerformance.length,
        meetsGreenDayTarget: greenDayPct >= target,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGGREGATED METRICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate current fee velocity metrics
 */
export function calculateFeeVelocityMetrics(
    totalDeployedUsd: number
): FeeVelocityMetrics {
    const sessionHours = (Date.now() - sessionStartTime) / (60 * 60 * 1000);
    
    // Calculate aggregate position metrics
    let totalFees = 0;
    let totalBinDominance = 0;
    let totalHoldTime = 0;
    let positionCount = 0;
    
    for (const telemetry of positionTelemetry.values()) {
        totalFees += telemetry.feesAccruedUsd;
        totalBinDominance += telemetry.binDominanceMinutes;
        totalHoldTime += (Date.now() - telemetry.entryTime) / (60 * 1000);
        positionCount++;
    }
    
    const avgHoldTime = positionCount > 0 ? totalHoldTime / positionCount : 0;
    
    return {
        feesPerHour: sessionHours > 0 ? totalFeesAllTime / sessionHours : 0,
        feesPerDeployedPerHour: totalDeployedUsd > 0 && sessionHours > 0 
            ? (totalFeesAllTime / totalDeployedUsd) / sessionHours 
            : 0,
        fees24hUsd: totalFeesAllTime,  // Simplified - would need 24h window
        rebalancesPerHour: sessionHours > 0 ? totalRebalancesAllTime / sessionHours : 0,
        binDominanceMinutes: totalBinDominance,
        avgHoldTimeMinutes: avgHoldTime,
        capitalTurnover: totalDeployedUsd > 0 ? totalFeesAllTime / totalDeployedUsd : 0,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUCCESS CRITERIA EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate if system is meeting success criteria
 */
export function evaluateSuccessCriteria(): {
    isWorking: boolean;
    workingIndicators: string[];
    brokenIndicators: string[];
    score: number;
} {
    const portfolio = getPortfolioMetrics();
    const feeMetrics = calculateFeeVelocityMetrics(100000);  // Use placeholder
    
    const workingIndicators: string[] = [];
    const brokenIndicators: string[] = [];
    
    // Check: Positions held hours to days (not minutes)
    const avgHoldHours = feeMetrics.avgHoldTimeMinutes / 60;
    if (avgHoldHours >= 1) {
        workingIndicators.push('positions_held_hours_to_days');
    } else if (positionTelemetry.size > 0) {
        brokenIndicators.push('positions_exiting_within_minutes');
    }
    
    // Check: Frequent rebalances
    if (feeMetrics.rebalancesPerHour >= 2) {
        workingIndicators.push('frequent_rebalances');
    } else {
        brokenIndicators.push('low_rebalance_count');
    }
    
    // Check: Fees growing faster than costs
    if (totalFeesAllTime > totalCostsAllTime) {
        workingIndicators.push('fees_growing_faster_than_costs');
    } else if (totalCostsAllTime > 0) {
        brokenIndicators.push('fees_not_covering_costs');
    }
    
    // Check: 90%+ green days
    if (portfolio.meetsGreenDayTarget) {
        workingIndicators.push('portfolio_90pct_green_days');
    } else if (portfolio.totalDays >= 3) {
        brokenIndicators.push('portfolio_majority_red_days');
    }
    
    const score = workingIndicators.length / 
        (workingIndicators.length + brokenIndicators.length + 0.01) * 100;
    
    return {
        isWorking: brokenIndicators.length === 0 && workingIndicators.length >= 2,
        workingIndicators,
        brokenIndicators,
        score,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logFeeVelocityTelemetry(totalDeployedUsd: number): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    const metrics = calculateFeeVelocityMetrics(totalDeployedUsd);
    const portfolio = getPortfolioMetrics();
    const success = evaluateSuccessCriteria();
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('📊 FEE VELOCITY TELEMETRY');
    logger.info('═══════════════════════════════════════════════════════════════');
    
    // Fee Velocity
    logger.info('  Fee Velocity:');
    logger.info(`    Per Hour: $${metrics.feesPerHour.toFixed(4)}`);
    logger.info(`    Per Deployed $/hr: ${(metrics.feesPerDeployedPerHour * 100).toFixed(4)}%`);
    
    // Rebalance Density
    logger.info('  Rebalance Density:');
    logger.info(`    Per Hour: ${metrics.rebalancesPerHour.toFixed(2)}`);
    logger.info(`    Total: ${totalRebalancesAllTime}`);
    
    // Bin Dominance
    logger.info('  Bin Dominance:');
    logger.info(`    Total Minutes: ${metrics.binDominanceMinutes.toFixed(0)}`);
    
    // Capital Efficiency
    logger.info('  Capital Efficiency:');
    logger.info(`    Avg Hold Time: ${metrics.avgHoldTimeMinutes.toFixed(0)}m`);
    logger.info(`    Capital Turnover: ${metrics.capitalTurnover.toFixed(2)}×`);
    
    // Portfolio Performance
    if (portfolio.totalDays > 0) {
        logger.info('  Portfolio Performance:');
        logger.info(`    Days Tracked: ${portfolio.totalDays}`);
        logger.info(`    Green Days: ${portfolio.greenDays}/${portfolio.totalDays} (${portfolio.greenDayPct.toFixed(0)}%)`);
        logger.info(`    Net Profit: $${portfolio.netProfitUsd.toFixed(2)}`);
        
        const targetEmoji = portfolio.meetsGreenDayTarget ? '✅' : '⚠️';
        logger.info(`    90% Target: ${targetEmoji} ${portfolio.meetsGreenDayTarget ? 'MET' : 'NOT MET'}`);
    }
    
    // Success Criteria
    const successEmoji = success.isWorking ? '✅' : '⚠️';
    logger.info(`  Success Criteria: ${successEmoji} Score: ${success.score.toFixed(0)}%`);
    
    if (success.workingIndicators.length > 0) {
        logger.info(`    ✅ Working: ${success.workingIndicators.join(', ')}`);
    }
    if (success.brokenIndicators.length > 0) {
        logger.info(`    ❌ Broken: ${success.brokenIndicators.join(', ')}`);
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

export function logPositionTelemetrySummary(): void {
    if (!PREDATOR_MODE_V1_ENABLED || positionTelemetry.size === 0) return;
    
    logger.info('  Active Position Telemetry:');
    
    // Sort by fee velocity
    const sorted = [...positionTelemetry.values()].sort(
        (a, b) => b.feeVelocity - a.feeVelocity
    );
    
    for (const t of sorted) {
        const holdHours = ((Date.now() - t.entryTime) / (60 * 60 * 1000)).toFixed(1);
        const netEmoji = t.netPnlUsd >= 0 ? '🟢' : '🔴';
        
        logger.info(
            `    ${netEmoji} ${t.poolName} | ` +
            `vel=$${t.feeVelocity.toFixed(4)}/h | ` +
            `fees=$${t.feesAccruedUsd.toFixed(2)} | ` +
            `cost=$${t.totalCostUsd.toFixed(2)} | ` +
            `net=$${t.netPnlUsd.toFixed(2)} | ` +
            `rebal=${t.rebalanceCount} | ` +
            `hold=${holdHours}h`
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    initializePositionTelemetry,
    recordFees,
    recordRebalanceCost,
    recordBinDominance,
    getPositionTelemetry,
    cleanupPositionTelemetry,
    recordDailyPerformance,
    getPortfolioMetrics,
    calculateFeeVelocityMetrics,
    evaluateSuccessCriteria,
    logFeeVelocityTelemetry,
    logPositionTelemetrySummary,
};

