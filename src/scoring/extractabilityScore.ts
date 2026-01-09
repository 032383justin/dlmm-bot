/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXTRACTABILITY SCORE (ES) — Pool Ranking for Fee Predation
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Replace TVL/Vol-first ranking with EXTRACTABILITY-FIRST selection.
 * 
 * Extractability Score (0–100) measures how "fee-harvestable" a pool is:
 * 
 * COMPONENTS:
 *   Fee Velocity (35%)           — Observed fees/min or fees/hr
 *   Churn/Oscillation (25%)      — binVel + swapVel + oscillation score
 *   Spread/Edge (15%)            — edgeScore, price reversion tendency
 *   Liquidity Quality (15%)      — Active liquidity depth near current bin (NOT total TVL)
 *   Stability Penalty (-0 to -25%) — Migration, telemetry invalid, stale, weird decimals
 * 
 * FINAL POOL RANK:
 *   finalScore = 0.65 * ES + 0.35 * existingScore
 * 
 * HARD FILTER:
 *   Do NOT deploy unless ES >= 55 (configurable)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const ES_CONFIG = {
    /** Enable Extractability Score */
    ENABLED: true,
    
    /** Minimum ES to allow deployment */
    MIN_ES_THRESHOLD: 55,
    
    /** Weight components */
    WEIGHTS: {
        FEE_VELOCITY: 0.35,           // Fees/hr normalized
        CHURN_OSCILLATION: 0.25,      // binVel + swapVel + oscillation
        SPREAD_EDGE: 0.15,            // Edge score + reversion tendency
        LIQUIDITY_QUALITY: 0.15,      // Active depth near current bin
        STABILITY_PENALTY: 0.10,      // Penalty bucket (applied as negative)
    },
    
    /** Blend ratio with existing score */
    BLEND: {
        ES_WEIGHT: 0.65,
        EXISTING_SCORE_WEIGHT: 0.35,
    },
    
    /** Normalization ranges for each component */
    NORMALIZATION: {
        /** Fee velocity: $0.50/hr = max score (100) */
        FEE_VELOCITY_MAX_HR: 0.50,
        
        /** Churn: Combined velocity score 200 = max (binVel 100 + swapVel 100) */
        CHURN_MAX: 200,
        
        /** Spread/edge: edgeScore 100 = max */
        EDGE_MAX: 100,
        
        /** Liquidity quality: % of TVL in active bins, 30% = max */
        LIQUIDITY_ACTIVE_PCT_MAX: 0.30,
    },
    
    /** Stability penalty deductions */
    PENALTIES: {
        /** Pool migrating/deprecated */
        MIGRATION: 25,
        
        /** Telemetry invalid/stale */
        TELEMETRY_INVALID: 15,
        
        /** Weird decimals detected */
        DECIMALS_ISSUE: 20,
        
        /** No recent activity (>1 hour) */
        STALE_ACTIVITY: 10,
        
        /** Low holder count (<1000) */
        LOW_HOLDERS: 5,
        
        /** Mintable/freezable token */
        TOKEN_RISK: 15,
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ESInput {
    // Fee velocity metrics
    fees24hUsd: number;
    feesPerHourEstimate?: number;     // Direct measurement if available
    feeIntensity?: number;            // Normalized 0-100
    
    // Churn/oscillation metrics
    binVelocity: number;              // 0-100
    swapVelocity: number;             // 0-100
    oscillationScore?: number;        // 0-100
    entropy?: number;                 // 0-1
    
    // Spread/edge metrics
    edgeScore?: number;               // 0-100
    priceReversionScore?: number;     // 0-100 (higher = more mean reversion)
    
    // Liquidity quality metrics
    tvlUsd: number;
    activeBinsTvlUsd?: number;        // TVL in active bins only
    activeBinsCount?: number;
    totalBinsCount?: number;
    
    // Stability/penalty metrics
    isMigrating?: boolean;
    isDeprecated?: boolean;
    telemetryValid?: boolean;
    lastActivityTimestamp?: number;
    decimalsIssue?: boolean;
    holderCount?: number;
    isMintable?: boolean;
    isFreezable?: boolean;
    
    // Existing score (for blending)
    existingScore?: number;           // MHI or tier4Score
}

export interface ESResult {
    /** Final Extractability Score (0-100) */
    score: number;
    
    /** Blended score with existing score */
    blendedScore: number;
    
    /** Individual component scores */
    components: {
        feeVelocity: number;          // 0-100
        churnOscillation: number;     // 0-100
        spreadEdge: number;           // 0-100
        liquidityQuality: number;     // 0-100
        stabilityPenalty: number;     // 0-25 (negative impact)
    };
    
    /** Penalties applied */
    penaltiesApplied: string[];
    
    /** Raw component values before normalization */
    rawValues: {
        feesPerHour: number;
        churnTotal: number;
        edgeTotal: number;
        activeLiquidityPct: number;
    };
    
    /** Pass/fail status */
    passesThreshold: boolean;
    
    /** Reason for pass/fail */
    reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Extractability Score for a pool.
 * 
 * ES = (feeVel * 0.35) + (churn * 0.25) + (edge * 0.15) + (liqQual * 0.15) - penalty
 */
export function calculateExtractabilityScore(input: ESInput): ESResult {
    const config = ES_CONFIG;
    const penalties: string[] = [];
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 1: Fee Velocity (35%)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Calculate fees per hour
    let feesPerHour = 0;
    if (input.feesPerHourEstimate !== undefined && input.feesPerHourEstimate > 0) {
        feesPerHour = input.feesPerHourEstimate;
    } else if (input.fees24hUsd > 0) {
        feesPerHour = input.fees24hUsd / 24;
    }
    
    // Normalize: 0-100 scale
    const feeVelocityNorm = Math.min(100, (feesPerHour / config.NORMALIZATION.FEE_VELOCITY_MAX_HR) * 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 2: Churn/Oscillation (25%)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const binVel = input.binVelocity || 0;
    const swapVel = input.swapVelocity || 0;
    const oscillation = input.oscillationScore || (input.entropy ? input.entropy * 100 : 0);
    
    // Combined churn = (binVel + swapVel + oscillation) / 3 (avg of available metrics)
    const churnCount = (binVel > 0 ? 1 : 0) + (swapVel > 0 ? 1 : 0) + (oscillation > 0 ? 1 : 0);
    const churnTotal = churnCount > 0 
        ? (binVel + swapVel + oscillation) / churnCount 
        : 0;
    
    // Normalize: Already 0-100 scale
    const churnNorm = Math.min(100, churnTotal);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 3: Spread/Edge (15%)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const edgeScore = input.edgeScore || 50;  // Default to neutral
    const reversionScore = input.priceReversionScore || 50;
    
    // Average of edge and reversion tendency
    const edgeTotal = (edgeScore + reversionScore) / 2;
    
    // Normalize: Already 0-100 scale
    const spreadEdgeNorm = Math.min(100, edgeTotal);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 4: Liquidity Quality (15%)
    // ═══════════════════════════════════════════════════════════════════════════
    
    let activeLiquidityPct = 0;
    
    if (input.activeBinsTvlUsd && input.tvlUsd > 0) {
        activeLiquidityPct = input.activeBinsTvlUsd / input.tvlUsd;
    } else if (input.activeBinsCount && input.totalBinsCount && input.totalBinsCount > 0) {
        // Estimate active liquidity from bin distribution
        activeLiquidityPct = input.activeBinsCount / input.totalBinsCount;
    } else {
        // Default assumption: 20% of TVL is in active bins
        activeLiquidityPct = 0.20;
    }
    
    // Normalize: 30% active = 100 score
    const liquidityQualityNorm = Math.min(100, (activeLiquidityPct / config.NORMALIZATION.LIQUIDITY_ACTIVE_PCT_MAX) * 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 5: Stability Penalty (-0 to -25%)
    // ═══════════════════════════════════════════════════════════════════════════
    
    let stabilityPenalty = 0;
    
    // Migration/deprecation
    if (input.isMigrating || input.isDeprecated) {
        stabilityPenalty += config.PENALTIES.MIGRATION;
        penalties.push('MIGRATION');
    }
    
    // Telemetry invalid
    if (input.telemetryValid === false) {
        stabilityPenalty += config.PENALTIES.TELEMETRY_INVALID;
        penalties.push('TELEMETRY_INVALID');
    }
    
    // Decimals issue
    if (input.decimalsIssue) {
        stabilityPenalty += config.PENALTIES.DECIMALS_ISSUE;
        penalties.push('DECIMALS_ISSUE');
    }
    
    // Stale activity (>1 hour since last activity)
    if (input.lastActivityTimestamp) {
        const hoursSinceActivity = (Date.now() - input.lastActivityTimestamp) / (60 * 60 * 1000);
        if (hoursSinceActivity > 1) {
            stabilityPenalty += config.PENALTIES.STALE_ACTIVITY;
            penalties.push('STALE_ACTIVITY');
        }
    }
    
    // Low holders
    if (input.holderCount !== undefined && input.holderCount < 1000) {
        stabilityPenalty += config.PENALTIES.LOW_HOLDERS;
        penalties.push('LOW_HOLDERS');
    }
    
    // Token risk
    if (input.isMintable || input.isFreezable) {
        stabilityPenalty += config.PENALTIES.TOKEN_RISK;
        penalties.push('TOKEN_RISK');
    }
    
    // Cap penalty at 25
    stabilityPenalty = Math.min(25, stabilityPenalty);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FINAL CALCULATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Weighted sum of positive components
    const positiveScore = (
        feeVelocityNorm * config.WEIGHTS.FEE_VELOCITY +
        churnNorm * config.WEIGHTS.CHURN_OSCILLATION +
        spreadEdgeNorm * config.WEIGHTS.SPREAD_EDGE +
        liquidityQualityNorm * config.WEIGHTS.LIQUIDITY_QUALITY
    );
    
    // Apply penalty (scaled by penalty weight)
    const penaltyImpact = (stabilityPenalty / 25) * 100 * config.WEIGHTS.STABILITY_PENALTY;
    
    // Final ES score (0-100)
    const esScore = Math.max(0, Math.min(100, positiveScore - penaltyImpact));
    
    // Blend with existing score
    const existingScore = input.existingScore ?? 50;
    const blendedScore = (
        esScore * config.BLEND.ES_WEIGHT +
        existingScore * config.BLEND.EXISTING_SCORE_WEIGHT
    );
    
    // Check threshold
    const passesThreshold = esScore >= config.MIN_ES_THRESHOLD;
    
    const result: ESResult = {
        score: Math.round(esScore * 10) / 10,
        blendedScore: Math.round(blendedScore * 10) / 10,
        components: {
            feeVelocity: Math.round(feeVelocityNorm * 10) / 10,
            churnOscillation: Math.round(churnNorm * 10) / 10,
            spreadEdge: Math.round(spreadEdgeNorm * 10) / 10,
            liquidityQuality: Math.round(liquidityQualityNorm * 10) / 10,
            stabilityPenalty: Math.round(stabilityPenalty * 10) / 10,
        },
        penaltiesApplied: penalties,
        rawValues: {
            feesPerHour,
            churnTotal,
            edgeTotal,
            activeLiquidityPct,
        },
        passesThreshold,
        reason: passesThreshold 
            ? `ES=${esScore.toFixed(1)} >= ${config.MIN_ES_THRESHOLD} threshold`
            : `ES=${esScore.toFixed(1)} < ${config.MIN_ES_THRESHOLD} threshold`,
    };
    
    return result;
}

/**
 * Calculate final pool rank using ES + existing score blend.
 */
export function calculateFinalPoolRank(esResult: ESResult): number {
    return esResult.blendedScore;
}

/**
 * Check if pool passes ES threshold for deployment.
 */
export function passesESThreshold(esScore: number): boolean {
    return esScore >= ES_CONFIG.MIN_ES_THRESHOLD;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log ES calculation details for a pool.
 */
export function logESCalculation(poolName: string, result: ESResult): void {
    const { components, rawValues, penaltiesApplied } = result;
    
    const status = result.passesThreshold ? '✅' : '❌';
    
    logger.info(
        `[ES-SCORE] ${status} ${poolName} | ` +
        `ES=${result.score.toFixed(1)} blended=${result.blendedScore.toFixed(1)} | ` +
        `feeVel=${components.feeVelocity.toFixed(0)} churn=${components.churnOscillation.toFixed(0)} ` +
        `edge=${components.spreadEdge.toFixed(0)} liq=${components.liquidityQuality.toFixed(0)} ` +
        `penalty=-${components.stabilityPenalty.toFixed(0)} | ` +
        `${result.reason}`
    );
    
    // Log raw values for debugging
    logger.debug(
        `[ES-RAW] ${poolName} | ` +
        `feesHr=$${rawValues.feesPerHour.toFixed(4)} ` +
        `churnTotal=${rawValues.churnTotal.toFixed(1)} ` +
        `edgeTotal=${rawValues.edgeTotal.toFixed(1)} ` +
        `activeLiq=${(rawValues.activeLiquidityPct * 100).toFixed(1)}% | ` +
        `penalties=[${penaltiesApplied.join(',')}]`
    );
}

/**
 * Log ES summary for multiple pools.
 */
export function logESSummary(results: Array<{ poolName: string; result: ESResult }>): void {
    // Sort by blended score descending
    const sorted = [...results].sort((a, b) => b.result.blendedScore - a.result.blendedScore);
    
    const passing = sorted.filter(r => r.result.passesThreshold);
    const failing = sorted.filter(r => !r.result.passesThreshold);
    
    logger.info(`[ES-SUMMARY] ═══════════════════════════════════════════════════════`);
    logger.info(`[ES-SUMMARY] Pools evaluated: ${results.length} | Passing: ${passing.length} | Failing: ${failing.length}`);
    
    if (passing.length > 0) {
        logger.info(`[ES-SUMMARY] TOP EXTRACTABLE POOLS:`);
        passing.slice(0, 5).forEach((p, i) => {
            logger.info(
                `[ES-SUMMARY]   ${i + 1}. ${p.poolName} ES=${p.result.score.toFixed(1)} blend=${p.result.blendedScore.toFixed(1)}`
            );
        });
    }
    
    if (failing.length > 0 && failing.length <= 5) {
        logger.info(`[ES-SUMMARY] BELOW THRESHOLD (ES < ${ES_CONFIG.MIN_ES_THRESHOLD}):`);
        failing.forEach(p => {
            logger.info(
                `[ES-SUMMARY]   ❌ ${p.poolName} ES=${p.result.score.toFixed(1)} | ${p.result.reason}`
            );
        });
    }
    
    logger.info(`[ES-SUMMARY] ═══════════════════════════════════════════════════════`);
}

export default {
    ES_CONFIG,
    calculateExtractabilityScore,
    calculateFinalPoolRank,
    passesESThreshold,
    logESCalculation,
    logESSummary,
};

