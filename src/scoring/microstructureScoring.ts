/**
 * Microstructure-Based Pool Scoring - Tier 3 Architecture
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: Scoring uses ONLY real on-chain DLMM state from Meteora SDK
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module implements Tier-3 scoring with:
 * - Microstructure base scoring (65% weight)
 * - Momentum slope scoring (35% weight)
 * - Sigmoid entropy weighting (+0-15 bonus)
 * 
 * Scoring Weights (Microstructure):
 * - binVelocity: 30%
 * - liquidityFlow: 30%
 * - swapVelocity: 25%
 * - feeIntensity: 15%
 * 
 * Momentum Weights:
 * - velocitySlope: 40%
 * - liquiditySlope: 35%
 * - entropySlope: 25%
 * 
 * GATING RULES (Tier 3):
 * - liquidityUSD <= 0 → disable
 * - no history ≥ 3 snapshots → disable
 * - NO entropy gating
 * - NO velocity gating
 * 
 * RULES:
 * - No pool is ever scored using 24h or TVL-only metrics.
 * - DLMM alpha exists inside short-term bin-level volatility.
 * - Use liquidityUSD everywhere. NEVER use totalLiquidity.
 */

import { Pool } from '../core/normalizePools';
import { 
    computeMicrostructureMetrics, 
    MicrostructureMetrics,
    getPoolHistory,
    DLMMTelemetry,
    SCORING_WEIGHTS,
} from '../services/dlmmTelemetry';
import {
    computeMomentumScore,
    getMomentumSlopes,
    MomentumSlopes,
    MIN_SNAPSHOTS,
} from './momentumEngine';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool with microstructure + momentum enrichment
 */
export interface MicrostructureEnrichedPool extends Pool {
    // Core metrics
    microMetrics: MicrostructureMetrics | null;
    momentumSlopes: MomentumSlopes | null;
    
    // Validity flags
    hasValidTelemetry: boolean;
    isMarketAlive: boolean;
    
    // Raw values for logging
    rawBinVelocity: number;
    rawLiquidityFlow: number;
    rawSwapVelocity: number;
    rawFeeIntensity: number;
    
    // Slope values
    velocitySlope: number;
    liquiditySlope: number;
    entropySlope: number;
    
    // Score components
    microstructureScore: number;
    momentumScore: number;
    sigmoidEntropyBonus: number;
    
    // Final score (microstructure + momentum + sigmoid)
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
    
    // Momentum slopes
    slopes: {
        velocitySlope: number;
        liquiditySlope: number;
        entropySlope: number;
        momentumScore: number;
    };
    
    // Gating
    gating: {
        isMarketAlive: boolean;
        reasons: string[];
    };
    
    // Score composition
    microstructureScore: number;
    momentumScore: number;
    sigmoidEntropyBonus: number;
    finalScore: number;
    
    // Validation
    valid: boolean;
    invalidReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3 GATING (SIMPLIFIED)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tier 3 gating rules (simplified):
 * - liquidityUSD <= 0 → disable
 * - no history ≥ 3 snapshots → disable
 * 
 * NO entropy gating.
 * NO velocity gating.
 */
export const TIER3_GATING = {
    minSnapshots: MIN_SNAPSHOTS,
    minLiquidityUSD: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// SIGMOID ENTROPY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sigmoid function for entropy weighting.
 * 
 * Returns value between 0 and 1.
 * At entropy = midpoint, returns 0.5.
 * Higher entropy → closer to 1.
 * Lower entropy → closer to 0.
 * 
 * @param e - Pool entropy (0-1)
 * @param midpoint - Entropy value where sigmoid = 0.5 (default 0.45)
 * @param slope - Steepness of sigmoid curve (default 8)
 */
export function sigmoidEntropy(e: number, midpoint: number = 0.45, slope: number = 8): number {
    return 1 / (1 + Math.exp(-slope * (e - midpoint)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCORING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Score a pool using Tier-3 architecture.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FORMULA:
 * 
 * microstructureScore = binVelocity*0.30 + liquidityFlow*0.30 + swapVelocity*0.25 + feeIntensity*0.15
 * 
 * momentumScore = velocitySlope*0.40 + liquiditySlope*0.35 + entropySlope*0.25
 * 
 * finalScore = (microstructureScore * 0.65) + (momentumScore * 0.35) + sigmoidEntropy(poolEntropy) * 15
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * GATING (Tier 3):
 * - liquidityUSD <= 0 → return 0
 * - snapshots < 3 → return 0
 * - NO entropy or velocity gates
 * 
 * @param pool - Pool to score
 * @returns Tier-3 score or 0 if gated
 */
export function scoreMicrostructure(pool: Pool): number {
    const poolAddress = pool.address;
    
    // Get pool history for gating check
    const history = getPoolHistory(poolAddress);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 3 GATING: Only check liquidity and snapshot count
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Gate: Minimum snapshots
    if (history.length < MIN_SNAPSHOTS) {
        logInvalidPool(poolAddress, pool.name, `Insufficient snapshots: ${history.length} < ${MIN_SNAPSHOTS}`);
        return 0;
    }
    
    // Gate: Liquidity must be positive
    const latestSnapshot = history[history.length - 1];
    if (latestSnapshot.liquidityUSD <= 0) {
        logInvalidPool(poolAddress, pool.name, 'liquidityUSD <= 0');
        return 0;
    }
    
    // Compute microstructure metrics
    const metrics = computeMicrostructureMetrics(poolAddress);
    
    if (!metrics) {
        logInvalidPool(poolAddress, pool.name, 'Failed to compute microstructure metrics');
        return 0;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MICROSTRUCTURE SCORE (65% of final)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const microstructureScore = (
        metrics.binVelocity * SCORING_WEIGHTS.binVelocity +
        metrics.liquidityFlow * SCORING_WEIGHTS.liquidityFlow +
        metrics.swapVelocity * SCORING_WEIGHTS.swapVelocity +
        metrics.feeIntensity * SCORING_WEIGHTS.feeIntensity
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MOMENTUM SCORE (35% of final)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const momentumData = computeMomentumScore(poolAddress);
    const momentumScore = momentumData.valid ? momentumData.momentumScore : 0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMBINED SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    
    const combinedScore = (microstructureScore * 0.65) + (momentumScore * 0.35);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SIGMOID ENTROPY BONUS (+0 to +15)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const sigmoidBonus = sigmoidEntropy(metrics.poolEntropy) * 15;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FINAL SCORE (no cap, no clamp)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const finalScore = combinedScore + sigmoidBonus;
    
    // Log diagnostics if verbose mode
    if (process.env.VERBOSE_SCORING === 'true') {
        const slopes = getMomentumSlopes(poolAddress);
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
            slopes: {
                velocitySlope: slopes?.velocitySlope ?? 0,
                liquiditySlope: slopes?.liquiditySlope ?? 0,
                entropySlope: slopes?.entropySlope ?? 0,
                momentumScore,
            },
            gating: {
                isMarketAlive: true, // Tier 3: No gating by velocity/entropy
                reasons: [],
            },
            microstructureScore,
            momentumScore,
            sigmoidEntropyBonus: sigmoidBonus,
            finalScore,
            valid: true,
        });
    }
    
    return finalScore;
}

/**
 * Enrich pool with microstructure + momentum data.
 * 
 * Sets hasValidTelemetry=false and microScore=0 for pools that fail gating.
 */
export function enrichPoolWithMicrostructure(pool: Pool): MicrostructureEnrichedPool {
    const history = getPoolHistory(pool.address);
    const metrics = computeMicrostructureMetrics(pool.address);
    const slopes = getMomentumSlopes(pool.address);
    const momentumData = computeMomentumScore(pool.address);
    
    // Tier 3 gating: only check snapshots and liquidity
    const hasMinSnapshots = history.length >= MIN_SNAPSHOTS;
    const hasPositiveLiquidity = history.length > 0 && history[history.length - 1].liquidityUSD > 0;
    const hasValidTelemetry = hasMinSnapshots && hasPositiveLiquidity && metrics !== null;
    
    // Market is "alive" if it passes Tier 3 gating (simplified)
    const isMarketAlive = hasValidTelemetry;
    
    // Calculate score components
    let microstructureScore = 0;
    let momentumScore = 0;
    let sigmoidEntropyBonus = 0;
    
    if (metrics) {
        microstructureScore = (
            metrics.binVelocity * SCORING_WEIGHTS.binVelocity +
            metrics.liquidityFlow * SCORING_WEIGHTS.liquidityFlow +
            metrics.swapVelocity * SCORING_WEIGHTS.swapVelocity +
            metrics.feeIntensity * SCORING_WEIGHTS.feeIntensity
        );
        sigmoidEntropyBonus = sigmoidEntropy(metrics.poolEntropy) * 15;
    }
    
    if (momentumData.valid) {
        momentumScore = momentumData.momentumScore;
    }
    
    const enriched: MicrostructureEnrichedPool = {
        ...pool,
        microMetrics: metrics,
        momentumSlopes: slopes,
        hasValidTelemetry,
        isMarketAlive,
        rawBinVelocity: metrics?.rawBinDelta ?? 0,
        rawLiquidityFlow: metrics?.rawLiquidityDelta ?? 0,
        rawSwapVelocity: metrics?.rawSwapCount ?? 0,
        rawFeeIntensity: metrics?.rawFeesGenerated ?? 0,
        velocitySlope: slopes?.velocitySlope ?? 0,
        liquiditySlope: slopes?.liquiditySlope ?? 0,
        entropySlope: slopes?.entropySlope ?? 0,
        microstructureScore,
        momentumScore,
        sigmoidEntropyBonus,
        microScore: hasValidTelemetry ? scoreMicrostructure(pool) : 0,
    };
    
    // Update pool score with microstructure score
    enriched.score = enriched.microScore;
    
    return enriched;
}

/**
 * Batch score multiple pools.
 * 
 * Pools that fail Tier 3 gating are marked with:
 * - hasValidTelemetry = false
 * - microScore = 0
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
    
    logger.info(`[MICRO-SCORING] Processed ${pools.length} pools: ${validCount} valid, ${invalidCount} disabled (gated)`);
    
    return enriched;
}

/**
 * Filter pools to only those with valid telemetry.
 */
export function filterValidPools(pools: MicrostructureEnrichedPool[]): MicrostructureEnrichedPool[] {
    return pools.filter(p => p.hasValidTelemetry);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATING CHECKS (TIER 3 SIMPLIFIED)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a pool passes Tier 3 entry gating.
 * 
 * Tier 3 rules:
 * - liquidityUSD > 0
 * - snapshots >= 3
 * - NO entropy check
 * - NO velocity check
 */
export function passesEntryGating(pool: Pool): { passes: boolean; reasons: string[] } {
    const history = getPoolHistory(pool.address);
    const reasons: string[] = [];
    
    if (history.length < MIN_SNAPSHOTS) {
        reasons.push(`Insufficient snapshots: ${history.length} < ${MIN_SNAPSHOTS}`);
    }
    
    if (history.length > 0 && history[history.length - 1].liquidityUSD <= 0) {
        reasons.push('liquidityUSD <= 0');
    }
    
    return {
        passes: reasons.length === 0,
        reasons,
    };
}

/**
 * Get Tier 3 gating status for a pool.
 */
export function getEntryGatingStatus(pool: Pool): {
    snapshotCount: { value: number; required: number; passes: boolean };
    liquidityUSD: { value: number; required: number; passes: boolean };
    allPass: boolean;
} {
    const history = getPoolHistory(pool.address);
    const latestLiquidity = history.length > 0 ? history[history.length - 1].liquidityUSD : 0;
    
    const snapshotPasses = history.length >= MIN_SNAPSHOTS;
    const liquidityPasses = latestLiquidity > 0;
    
    return {
        snapshotCount: { 
            value: history.length, 
            required: MIN_SNAPSHOTS, 
            passes: snapshotPasses 
        },
        liquidityUSD: { 
            value: latestLiquidity, 
            required: 0, 
            passes: liquidityPasses 
        },
        allPass: snapshotPasses && liquidityPasses,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

function logInvalidPool(address: string, name: string, reason: string): void {
    if (process.env.VERBOSE_SCORING === 'true') {
        logger.warn(`❌ [MICRO-SCORING] ${name} (${address.slice(0, 8)}...) - DISABLED: ${reason}`);
    }
}

function logScoringDiagnostics(diag: MicrostructureScoringDiagnostics): void {
    const divider = '─'.repeat(70);
    
    logger.info(`\n${divider}`);
    logger.info(`📊 TIER-3 MICROSTRUCTURE SCORING: ${diag.poolName}`);
    logger.info(`   Address: ${diag.poolAddress.slice(0, 8)}...${diag.poolAddress.slice(-6)}`);
    logger.info(divider);
    
    // Input Metrics
    logger.info(`📥 MICROSTRUCTURE METRICS (0-100 scale):`);
    logger.info(`   Bin Velocity:     ${diag.metrics.binVelocity.toFixed(1)} (weight: 30%)`);
    logger.info(`   Liquidity Flow:   ${diag.metrics.liquidityFlow.toFixed(1)} (weight: 30%)`);
    logger.info(`   Swap Velocity:    ${diag.metrics.swapVelocity.toFixed(1)} (weight: 25%)`);
    logger.info(`   Fee Intensity:    ${diag.metrics.feeIntensity.toFixed(1)} (weight: 15%)`);
    logger.info(`   Pool Entropy:     ${diag.metrics.poolEntropy.toFixed(4)}`);
    
    // Momentum Slopes
    logger.info(`\n📈 MOMENTUM SLOPES:`);
    logger.info(`   Velocity Slope:   ${diag.slopes.velocitySlope.toFixed(6)} (weight: 40%)`);
    logger.info(`   Liquidity Slope:  ${diag.slopes.liquiditySlope.toFixed(6)} (weight: 35%)`);
    logger.info(`   Entropy Slope:    ${diag.slopes.entropySlope.toFixed(6)} (weight: 25%)`);
    logger.info(`   Momentum Score:   ${diag.slopes.momentumScore.toFixed(2)}`);
    
    // Score Composition
    logger.info(`\n🧮 SCORE COMPOSITION (TIER-3):`);
    logger.info(`   Microstructure:   ${diag.microstructureScore.toFixed(2)} × 0.65 = ${(diag.microstructureScore * 0.65).toFixed(2)}`);
    logger.info(`   Momentum:         ${diag.momentumScore.toFixed(2)} × 0.35 = ${(diag.momentumScore * 0.35).toFixed(2)}`);
    logger.info(`   Sigmoid Entropy:  +${diag.sigmoidEntropyBonus.toFixed(2)}`);
    logger.info(`   ─────────────────────────────────`);
    logger.info(`   📌 FINAL SCORE:   ${diag.finalScore.toFixed(2)}`);
    logger.info(divider + '\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    SCORING_WEIGHTS,
};

// Re-export for backwards compatibility
export { TIER3_GATING as GATING_THRESHOLDS };
