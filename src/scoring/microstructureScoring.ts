/**
 * Microstructure-Based Pool Scoring
 * 
 * CRITICAL: This module replaces 24h/TVL-based scoring with real-time DLMM signals.
 * All scoring uses short-term bin-level microstructure data.
 * 
 * Scoring Weights:
 * - binVelocity: 30%
 * - liquidityFlow: 30%
 * - swapVelocity: 25%
 * - feeIntensity: 15%
 * 
 * RULE: No pool is ever scored using 24h or TVL-only metrics.
 * DLMM alpha exists inside short-term bin-level volatility.
 */

import { Pool } from '../core/normalizePools';
import { 
    computeMicrostructureMetrics, 
    MicrostructureMetrics,
    getPoolHistory,
    DLMMTelemetry,
    GATING_THRESHOLDS,
    SCORING_WEIGHTS,
} from '../services/dlmmTelemetry';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool with microstructure enrichment
 */
export interface MicrostructureEnrichedPool extends Pool {
    // Core metrics
    microMetrics: MicrostructureMetrics | null;
    
    // Validity flags
    hasValidTelemetry: boolean;
    isMarketAlive: boolean;
    
    // Raw values for logging
    rawBinVelocity: number;
    rawLiquidityFlow: number;
    rawSwapVelocity: number;
    rawFeeIntensity: number;
    
    // Final score (microstructure-based)
    microScore: number;
}

/**
 * Scoring diagnostics for verbose logging
 */
export interface MicrostructureScoringDiagnostics {
    poolAddress: string;
    poolName: string;
    
    // Input metrics
    metrics: {
        binVelocity: number;
        liquidityFlow: number;
        swapVelocity: number;
        feeIntensity: number;
        poolEntropy: number;
    };
    
    // Weighted components
    weightedScores: {
        binVelocity: number;
        liquidityFlow: number;
        swapVelocity: number;
        feeIntensity: number;
    };
    
    // Gating
    gating: {
        isMarketAlive: boolean;
        reasons: string[];
    };
    
    // Final
    rawScore: number;
    adjustedScore: number;
    finalScore: number;
    
    // Validation
    valid: boolean;
    invalidReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCORING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Score a pool using microstructure metrics ONLY.
 * 
 * CRITICAL: Returns 0 if telemetry is invalid or missing.
 * DO NOT use fallback/default values.
 * 
 * @param pool - Pool to score
 * @returns Microstructure score (0-100) or 0 if invalid
 */
export function scoreMicrostructure(pool: Pool): number {
    const poolAddress = pool.address;
    
    // Compute metrics from live telemetry
    const metrics = computeMicrostructureMetrics(poolAddress);
    
    // CRITICAL: No fallbacks. Invalid telemetry = zero score.
    if (!metrics) {
        logInvalidPool(poolAddress, pool.name, 'Insufficient snapshot history (need ≥3)');
        return 0;
    }
    
    // Validate core metrics exist
    if (
        metrics.binVelocity === undefined ||
        metrics.liquidityFlow === undefined ||
        metrics.swapVelocity === undefined ||
        metrics.feeIntensity === undefined
    ) {
        logInvalidPool(poolAddress, pool.name, 'Missing core metric values');
        return 0;
    }
    
    // Compute weighted score
    const rawScore = (
        metrics.binVelocity * SCORING_WEIGHTS.binVelocity +
        metrics.liquidityFlow * SCORING_WEIGHTS.liquidityFlow +
        metrics.swapVelocity * SCORING_WEIGHTS.swapVelocity +
        metrics.feeIntensity * SCORING_WEIGHTS.feeIntensity
    );
    
    // Apply entropy adjustment (high entropy = healthy market)
    let entropyMultiplier = 1.0;
    if (metrics.poolEntropy >= 0.65) {
        entropyMultiplier = 1.15; // 15% bonus for high entropy
    } else if (metrics.poolEntropy >= 0.45) {
        entropyMultiplier = 1.05; // 5% bonus for moderate entropy
    } else if (metrics.poolEntropy < 0.25) {
        entropyMultiplier = 0.80; // 20% penalty for low entropy
    }
    
    const adjustedScore = rawScore * entropyMultiplier;
    
    // Apply gating penalty (market must be alive for full score)
    let gatingMultiplier = 1.0;
    if (!metrics.isMarketAlive) {
        gatingMultiplier = 0.50; // 50% penalty if market is dormant
    }
    
    const finalScore = Math.min(adjustedScore * gatingMultiplier, 100);
    
    // Log diagnostics if verbose
    if (process.env.VERBOSE_SCORING === 'true') {
        logScoringDiagnostics({
            poolAddress,
            poolName: pool.name,
            metrics: {
                binVelocity: metrics.binVelocity,
                liquidityFlow: metrics.liquidityFlow,
                swapVelocity: metrics.swapVelocity,
                feeIntensity: metrics.feeIntensity,
                poolEntropy: metrics.poolEntropy,
            },
            weightedScores: {
                binVelocity: metrics.binVelocity * SCORING_WEIGHTS.binVelocity,
                liquidityFlow: metrics.liquidityFlow * SCORING_WEIGHTS.liquidityFlow,
                swapVelocity: metrics.swapVelocity * SCORING_WEIGHTS.swapVelocity,
                feeIntensity: metrics.feeIntensity * SCORING_WEIGHTS.feeIntensity,
            },
            gating: {
                isMarketAlive: metrics.isMarketAlive,
                reasons: metrics.gatingReasons,
            },
            rawScore,
            adjustedScore,
            finalScore,
            valid: true,
        });
    }
    
    return finalScore;
}

/**
 * Enrich pool with microstructure data
 */
export function enrichPoolWithMicrostructure(pool: Pool): MicrostructureEnrichedPool {
    const metrics = computeMicrostructureMetrics(pool.address);
    
    const enriched: MicrostructureEnrichedPool = {
        ...pool,
        microMetrics: metrics,
        hasValidTelemetry: metrics !== null,
        isMarketAlive: metrics?.isMarketAlive ?? false,
        rawBinVelocity: metrics?.rawBinDelta ?? 0,
        rawLiquidityFlow: metrics?.rawLiquidityDelta ?? 0,
        rawSwapVelocity: metrics?.rawSwapCount ?? 0,
        rawFeeIntensity: metrics?.rawFeesGenerated ?? 0,
        microScore: metrics ? scoreMicrostructure(pool) : 0,
    };
    
    // Update pool score with microstructure score
    enriched.score = enriched.microScore;
    
    return enriched;
}

/**
 * Batch score multiple pools
 */
export function batchScorePools(pools: Pool[]): MicrostructureEnrichedPool[] {
    const enriched: MicrostructureEnrichedPool[] = [];
    let validCount = 0;
    let invalidCount = 0;
    
    for (const pool of pools) {
        const enrichedPool = enrichPoolWithMicrostructure(pool);
        enriched.push(enrichedPool);
        
        if (enrichedPool.hasValidTelemetry) {
            validCount++;
        } else {
            invalidCount++;
        }
    }
    
    // Sort by microScore descending
    enriched.sort((a, b) => b.microScore - a.microScore);
    
    logger.info(`[MICRO-SCORING] Processed ${pools.length} pools: ${validCount} valid, ${invalidCount} invalid telemetry`);
    
    return enriched;
}

/**
 * Filter pools to only those with valid telemetry and alive markets
 */
export function filterValidPools(pools: MicrostructureEnrichedPool[]): MicrostructureEnrichedPool[] {
    return pools.filter(p => p.hasValidTelemetry && p.isMarketAlive);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATING CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a pool passes entry gating conditions
 */
export function passesEntryGating(pool: Pool): { passes: boolean; reasons: string[] } {
    const metrics = computeMicrostructureMetrics(pool.address);
    
    if (!metrics) {
        return {
            passes: false,
            reasons: ['No telemetry data available'],
        };
    }
    
    return {
        passes: metrics.isMarketAlive,
        reasons: metrics.gatingReasons,
    };
}

/**
 * Get minimum required conditions for entry
 */
export function getEntryGatingStatus(pool: Pool): {
    binVelocity: { value: number; required: number; passes: boolean };
    swapVelocity: { value: number; required: number; passes: boolean };
    poolEntropy: { value: number; required: number; passes: boolean };
    liquidityFlow: { value: number; required: number; passes: boolean };
    allPass: boolean;
} {
    const metrics = computeMicrostructureMetrics(pool.address);
    
    if (!metrics) {
        return {
            binVelocity: { value: 0, required: GATING_THRESHOLDS.minBinVelocity, passes: false },
            swapVelocity: { value: 0, required: GATING_THRESHOLDS.minSwapVelocity, passes: false },
            poolEntropy: { value: 0, required: GATING_THRESHOLDS.minPoolEntropy, passes: false },
            liquidityFlow: { value: 0, required: GATING_THRESHOLDS.minLiquidityFlow, passes: false },
            allPass: false,
        };
    }
    
    const history = getPoolHistory(pool.address);
    const latest = history[history.length - 1];
    const prev = history.length > 1 ? history[history.length - 2] : latest;
    
    const timeDelta = (latest?.timestamp ?? 0) - (prev?.timestamp ?? 0);
    const rawBinVelocity = timeDelta > 0 
        ? Math.abs((latest?.activeBin ?? 0) - (prev?.activeBin ?? 0)) / (timeDelta / 1000)
        : 0;
    
    const rawLiquidityFlow = (latest?.totalLiquidity ?? 0) > 0
        ? Math.abs((latest?.totalLiquidity ?? 0) - (prev?.totalLiquidity ?? 0)) / (latest?.totalLiquidity ?? 1)
        : 0;
    
    const rawSwapVelocity = metrics.rawSwapCount / 60;
    
    return {
        binVelocity: { 
            value: rawBinVelocity, 
            required: GATING_THRESHOLDS.minBinVelocity, 
            passes: rawBinVelocity >= GATING_THRESHOLDS.minBinVelocity 
        },
        swapVelocity: { 
            value: rawSwapVelocity, 
            required: GATING_THRESHOLDS.minSwapVelocity, 
            passes: rawSwapVelocity >= GATING_THRESHOLDS.minSwapVelocity 
        },
        poolEntropy: { 
            value: metrics.poolEntropy, 
            required: GATING_THRESHOLDS.minPoolEntropy, 
            passes: metrics.poolEntropy >= GATING_THRESHOLDS.minPoolEntropy 
        },
        liquidityFlow: { 
            value: rawLiquidityFlow, 
            required: GATING_THRESHOLDS.minLiquidityFlow, 
            passes: rawLiquidityFlow >= GATING_THRESHOLDS.minLiquidityFlow 
        },
        allPass: metrics.isMarketAlive,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

function logInvalidPool(address: string, name: string, reason: string): void {
    if (process.env.VERBOSE_SCORING === 'true') {
        logger.warn(`❌ [MICRO-SCORING] ${name} (${address.slice(0, 8)}...) - INVALID: ${reason}`);
    }
}

function logScoringDiagnostics(diag: MicrostructureScoringDiagnostics): void {
    const divider = '─'.repeat(60);
    
    logger.info(`\n${divider}`);
    logger.info(`📊 MICROSTRUCTURE SCORING: ${diag.poolName}`);
    logger.info(`   Address: ${diag.poolAddress.slice(0, 8)}...${diag.poolAddress.slice(-6)}`);
    logger.info(divider);
    
    // Input Metrics
    logger.info(`📥 INPUT METRICS (0-100 scale):`);
    logger.info(`   Bin Velocity:     ${diag.metrics.binVelocity.toFixed(1)} (weight: 30%)`);
    logger.info(`   Liquidity Flow:   ${diag.metrics.liquidityFlow.toFixed(1)} (weight: 30%)`);
    logger.info(`   Swap Velocity:    ${diag.metrics.swapVelocity.toFixed(1)} (weight: 25%)`);
    logger.info(`   Fee Intensity:    ${diag.metrics.feeIntensity.toFixed(1)} (weight: 15%)`);
    logger.info(`   Pool Entropy:     ${diag.metrics.poolEntropy.toFixed(4)}`);
    
    // Weighted Components
    logger.info(`\n✖️  WEIGHTED SCORES:`);
    logger.info(`   Bin Velocity:     ${diag.weightedScores.binVelocity.toFixed(2)}`);
    logger.info(`   Liquidity Flow:   ${diag.weightedScores.liquidityFlow.toFixed(2)}`);
    logger.info(`   Swap Velocity:    ${diag.weightedScores.swapVelocity.toFixed(2)}`);
    logger.info(`   Fee Intensity:    ${diag.weightedScores.feeIntensity.toFixed(2)}`);
    
    // Gating
    logger.info(`\n🚪 GATING STATUS:`);
    if (diag.gating.isMarketAlive) {
        logger.info(`   ✅ Market ALIVE - all conditions met`);
    } else {
        logger.info(`   ⚠️  Market DORMANT - conditions not met:`);
        for (const reason of diag.gating.reasons) {
            logger.info(`      → ${reason}`);
        }
    }
    
    // Score Composition
    logger.info(`\n🧮 SCORE COMPOSITION:`);
    logger.info(`   Raw Score:      ${diag.rawScore.toFixed(2)}`);
    logger.info(`   + Entropy Adj:  ${diag.adjustedScore.toFixed(2)}`);
    logger.info(`   + Gating Adj:   ${diag.finalScore.toFixed(2)}`);
    logger.info(`   ─────────────────────────────────`);
    logger.info(`   📌 FINAL SCORE: ${diag.finalScore.toFixed(2)}`);
    logger.info(divider + '\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    SCORING_WEIGHTS,
    GATING_THRESHOLDS,
};

