/**
 * Microstructure Health Index (MHI) - Tier 4 Predator Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * A CONTINUOUS SIGNAL THAT CONTROLS POSITION SIZING DYNAMICALLY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This is where 99.9% of bots die — they size BEFORE they see microstructure quality.
 * 
 * MHI = Wv * binVelocity
 *     + Ws * swapVelocity
 *     + We * entropy
 *     + Wl * liquidityFlowPct
 *     - Wd * negativeSlopePenalty
 * 
 * MHI controls position sizing dynamically:
 * - MHI .80–1.0 → max allowed
 * - MHI .60–.80 → 50–70%
 * - MHI < .45 → no entry, no scale, no reinjection
 * 
 * NOT score. NOT tier. NOT cap.
 * MHI is the FINAL gatekeeper.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { 
    computeMicrostructureMetrics, 
    getPoolHistory,
    MicrostructureMetrics,
    DLMMTelemetry,
} from '../services/dlmmTelemetry';
import { getMomentumSlopes, MomentumSlopes } from '../scoring/momentumEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MHI computation result
 */
export interface MHIResult {
    poolId: string;
    mhi: number;                    // Final MHI score (0-1)
    
    // Component scores (normalized 0-1)
    binVelocityComponent: number;
    swapVelocityComponent: number;
    entropyComponent: number;
    liquidityFlowComponent: number;
    slopePenalty: number;
    
    // Raw values
    rawBinVelocity: number;
    rawSwapVelocity: number;
    rawEntropy: number;
    rawLiquidityFlowPct: number;
    rawVelocitySlope: number;
    rawLiquiditySlope: number;
    rawEntropySlope: number;
    
    // Sizing decision
    sizingTier: MHISizingTier;
    sizeMultiplier: number;
    canEnter: boolean;
    canScale: boolean;
    canReinject: boolean;
    
    // Validity
    valid: boolean;
    invalidReason?: string;
    
    timestamp: number;
}

/**
 * MHI-based sizing tiers
 */
export type MHISizingTier = 'MAX' | 'HIGH' | 'MEDIUM' | 'LOW' | 'BLOCKED';

/**
 * MHI thresholds configuration
 */
export interface MHIThresholds {
    maxTier: { min: number; max: number; sizeMultiplier: number };
    highTier: { min: number; max: number; sizeMultiplier: number };
    mediumTier: { min: number; max: number; sizeMultiplier: number };
    lowTier: { min: number; max: number; sizeMultiplier: number };
    blockedBelow: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MHI component weights (must sum to 1.0 before penalty)
 */
export const MHI_WEIGHTS = {
    binVelocity: 0.25,       // Wv - bin movement activity
    swapVelocity: 0.25,      // Ws - trading activity
    entropy: 0.25,           // We - pool health/balance
    liquidityFlow: 0.25,     // Wl - liquidity stability
};

/**
 * Slope penalty weight
 */
export const SLOPE_PENALTY_WEIGHT = 0.20;  // Wd - maximum penalty from negative slopes

/**
 * Normalization constants for MHI components
 */
export const MHI_NORMALIZATION = {
    binVelocity: {
        min: 0,
        max: 0.10,              // 0.10 bins/sec = 100% score
    },
    swapVelocity: {
        min: 0,
        max: 0.50,              // 0.50 swaps/sec = 100% score
    },
    entropy: {
        min: 0.40,              // Below this = 0% score
        max: 0.85,              // Above this = 100% score
    },
    liquidityFlow: {
        min: -0.10,             // -10% flow = 0% score
        max: 0.05,              // +5% flow = 100% score
    },
};

/**
 * MHI sizing thresholds
 */
export const MHI_THRESHOLDS: MHIThresholds = {
    maxTier: { min: 0.80, max: 1.00, sizeMultiplier: 1.00 },
    highTier: { min: 0.70, max: 0.80, sizeMultiplier: 0.80 },
    mediumTier: { min: 0.60, max: 0.70, sizeMultiplier: 0.65 },
    lowTier: { min: 0.45, max: 0.60, sizeMultiplier: 0.50 },
    blockedBelow: 0.45,
};

/**
 * Slope penalty thresholds
 */
const SLOPE_PENALTY_THRESHOLDS = {
    velocitySlope: -0.05,     // Start penalizing below this
    liquiditySlope: -0.03,    // Start penalizing below this
    entropySlope: -0.02,      // Start penalizing below this
    maxPenaltySlope: -0.15,   // Maximum penalty at this slope
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp a value between 0 and 1
 */
function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/**
 * Normalize a value to 0-1 range
 */
function normalize(value: number, min: number, max: number): number {
    if (max <= min) return 0;
    return clamp01((value - min) / (max - min));
}

/**
 * Calculate slope penalty (0-1 scale, where 1 = no penalty)
 */
function calculateSlopePenalty(
    velocitySlope: number,
    liquiditySlope: number,
    entropySlope: number
): number {
    let penalty = 0;
    
    // Velocity slope penalty
    if (velocitySlope < SLOPE_PENALTY_THRESHOLDS.velocitySlope) {
        const slopeDelta = SLOPE_PENALTY_THRESHOLDS.velocitySlope - velocitySlope;
        const maxDelta = SLOPE_PENALTY_THRESHOLDS.velocitySlope - SLOPE_PENALTY_THRESHOLDS.maxPenaltySlope;
        penalty += clamp01(slopeDelta / maxDelta) * 0.33;
    }
    
    // Liquidity slope penalty
    if (liquiditySlope < SLOPE_PENALTY_THRESHOLDS.liquiditySlope) {
        const slopeDelta = SLOPE_PENALTY_THRESHOLDS.liquiditySlope - liquiditySlope;
        const maxDelta = SLOPE_PENALTY_THRESHOLDS.liquiditySlope - SLOPE_PENALTY_THRESHOLDS.maxPenaltySlope;
        penalty += clamp01(slopeDelta / maxDelta) * 0.34;
    }
    
    // Entropy slope penalty
    if (entropySlope < SLOPE_PENALTY_THRESHOLDS.entropySlope) {
        const slopeDelta = SLOPE_PENALTY_THRESHOLDS.entropySlope - entropySlope;
        const maxDelta = SLOPE_PENALTY_THRESHOLDS.entropySlope - SLOPE_PENALTY_THRESHOLDS.maxPenaltySlope;
        penalty += clamp01(slopeDelta / maxDelta) * 0.33;
    }
    
    return clamp01(penalty);
}

/**
 * Determine sizing tier from MHI value
 */
function determineSizingTier(mhi: number): MHISizingTier {
    if (mhi >= MHI_THRESHOLDS.maxTier.min) return 'MAX';
    if (mhi >= MHI_THRESHOLDS.highTier.min) return 'HIGH';
    if (mhi >= MHI_THRESHOLDS.mediumTier.min) return 'MEDIUM';
    if (mhi >= MHI_THRESHOLDS.lowTier.min) return 'LOW';
    return 'BLOCKED';
}

/**
 * Get size multiplier from MHI tier
 */
function getSizeMultiplier(tier: MHISizingTier): number {
    switch (tier) {
        case 'MAX': return MHI_THRESHOLDS.maxTier.sizeMultiplier;
        case 'HIGH': return MHI_THRESHOLDS.highTier.sizeMultiplier;
        case 'MEDIUM': return MHI_THRESHOLDS.mediumTier.sizeMultiplier;
        case 'LOW': return MHI_THRESHOLDS.lowTier.sizeMultiplier;
        case 'BLOCKED': return 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute Microstructure Health Index for a pool.
 * 
 * MHI = Wv * binVelocity + Ws * swapVelocity + We * entropy + Wl * liquidityFlow
 *     - Wd * negativeSlopePenalty
 */
export function computeMHI(poolId: string): MHIResult | null {
    const now = Date.now();
    
    // Get microstructure metrics
    const metrics = computeMicrostructureMetrics(poolId);
    if (!metrics) {
        return {
            poolId,
            mhi: 0,
            binVelocityComponent: 0,
            swapVelocityComponent: 0,
            entropyComponent: 0,
            liquidityFlowComponent: 0,
            slopePenalty: 0,
            rawBinVelocity: 0,
            rawSwapVelocity: 0,
            rawEntropy: 0,
            rawLiquidityFlowPct: 0,
            rawVelocitySlope: 0,
            rawLiquiditySlope: 0,
            rawEntropySlope: 0,
            sizingTier: 'BLOCKED',
            sizeMultiplier: 0,
            canEnter: false,
            canScale: false,
            canReinject: false,
            valid: false,
            invalidReason: 'No microstructure metrics',
            timestamp: now,
        };
    }
    
    // Get slope data
    const slopes = getMomentumSlopes(poolId);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXTRACT RAW VALUES (denormalize from 0-100 if needed)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // binVelocity is already raw in metrics
    const rawBinVelocity = metrics.binVelocity / 100;  // Convert from 0-100 to 0-1 range
    
    // swapVelocity - convert from 0-100 scale
    const rawSwapVelocity = metrics.swapVelocity / 100;
    
    // entropy is already 0-1
    const rawEntropy = metrics.poolEntropy;
    
    // Calculate liquidity flow percentage from history
    const history = getPoolHistory(poolId);
    let rawLiquidityFlowPct = 0;
    if (history.length >= 2) {
        const latest = history[history.length - 1];
        const previous = history[history.length - 2];
        rawLiquidityFlowPct = previous.liquidityUSD > 0
            ? (latest.liquidityUSD - previous.liquidityUSD) / previous.liquidityUSD
            : 0;
    }
    
    // Get slopes
    const rawVelocitySlope = slopes?.velocitySlope ?? 0;
    const rawLiquiditySlope = slopes?.liquiditySlope ?? 0;
    const rawEntropySlope = slopes?.entropySlope ?? 0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // NORMALIZE COMPONENTS TO 0-1
    // ═══════════════════════════════════════════════════════════════════════════
    
    const binVelocityComponent = normalize(
        rawBinVelocity,
        MHI_NORMALIZATION.binVelocity.min,
        MHI_NORMALIZATION.binVelocity.max
    );
    
    const swapVelocityComponent = normalize(
        rawSwapVelocity,
        MHI_NORMALIZATION.swapVelocity.min,
        MHI_NORMALIZATION.swapVelocity.max
    );
    
    const entropyComponent = normalize(
        rawEntropy,
        MHI_NORMALIZATION.entropy.min,
        MHI_NORMALIZATION.entropy.max
    );
    
    const liquidityFlowComponent = normalize(
        rawLiquidityFlowPct,
        MHI_NORMALIZATION.liquidityFlow.min,
        MHI_NORMALIZATION.liquidityFlow.max
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CALCULATE SLOPE PENALTY
    // ═══════════════════════════════════════════════════════════════════════════
    
    const slopePenalty = calculateSlopePenalty(
        rawVelocitySlope,
        rawLiquiditySlope,
        rawEntropySlope
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE MHI
    // MHI = (Wv * binV + Ws * swapV + We * entropy + Wl * liqFlow) - (Wd * penalty)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const baseScore = 
        (MHI_WEIGHTS.binVelocity * binVelocityComponent) +
        (MHI_WEIGHTS.swapVelocity * swapVelocityComponent) +
        (MHI_WEIGHTS.entropy * entropyComponent) +
        (MHI_WEIGHTS.liquidityFlow * liquidityFlowComponent);
    
    const mhi = clamp01(baseScore - (SLOPE_PENALTY_WEIGHT * slopePenalty));
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DETERMINE SIZING TIER
    // ═══════════════════════════════════════════════════════════════════════════
    
    const sizingTier = determineSizingTier(mhi);
    const sizeMultiplier = getSizeMultiplier(sizingTier);
    
    // Permission flags
    const canEnter = sizingTier !== 'BLOCKED';
    const canScale = sizingTier === 'MAX' || sizingTier === 'HIGH';
    const canReinject = sizingTier !== 'BLOCKED' && mhi >= 0.55;
    
    return {
        poolId,
        mhi,
        binVelocityComponent,
        swapVelocityComponent,
        entropyComponent,
        liquidityFlowComponent,
        slopePenalty,
        rawBinVelocity,
        rawSwapVelocity,
        rawEntropy,
        rawLiquidityFlowPct,
        rawVelocitySlope,
        rawLiquiditySlope,
        rawEntropySlope,
        sizingTier,
        sizeMultiplier,
        canEnter,
        canScale,
        canReinject,
        valid: true,
        timestamp: now,
    };
}

/**
 * Quick check if pool passes MHI gating for entry.
 */
export function passesMHIGating(poolId: string): boolean {
    const result = computeMHI(poolId);
    return result?.canEnter ?? false;
}

/**
 * Get MHI-adjusted position size.
 * Takes base size and adjusts it based on MHI.
 */
export function getMHIAdjustedSize(poolId: string, baseSize: number): number {
    const result = computeMHI(poolId);
    if (!result || !result.canEnter) {
        return 0;
    }
    return baseSize * result.sizeMultiplier;
}

/**
 * Check if scaling is allowed based on MHI.
 */
export function canScaleWithMHI(poolId: string): { 
    allowed: boolean; 
    reason?: string;
    maxScaleMultiplier: number;
} {
    const result = computeMHI(poolId);
    
    if (!result) {
        return { allowed: false, reason: 'No MHI data', maxScaleMultiplier: 0 };
    }
    
    if (!result.canScale) {
        return { 
            allowed: false, 
            reason: `MHI too low (${result.mhi.toFixed(2)} - ${result.sizingTier})`,
            maxScaleMultiplier: 0,
        };
    }
    
    // Scale allowed - determine max multiplier
    const maxScaleMultiplier = result.sizingTier === 'MAX' ? 1.0 : 0.5;
    
    return { 
        allowed: true, 
        maxScaleMultiplier,
    };
}

/**
 * Batch compute MHI for multiple pools.
 */
export function batchComputeMHI(poolIds: string[]): Map<string, MHIResult> {
    const results = new Map<string, MHIResult>();
    
    for (const poolId of poolIds) {
        const mhi = computeMHI(poolId);
        if (mhi) {
            results.set(poolId, mhi);
        }
    }
    
    return results;
}

/**
 * Get pools sorted by MHI descending.
 */
export function rankPoolsByMHI(poolIds: string[]): Array<{ poolId: string; mhi: number; tier: MHISizingTier }> {
    const results: Array<{ poolId: string; mhi: number; tier: MHISizingTier }> = [];
    
    for (const poolId of poolIds) {
        const mhiResult = computeMHI(poolId);
        if (mhiResult && mhiResult.valid) {
            results.push({
                poolId,
                mhi: mhiResult.mhi,
                tier: mhiResult.sizingTier,
            });
        }
    }
    
    results.sort((a, b) => b.mhi - a.mhi);
    
    return results;
}

/**
 * Log MHI details for a pool.
 */
export function logMHI(poolId: string, poolName?: string): void {
    const result = computeMHI(poolId);
    const name = poolName || poolId.slice(0, 8);
    
    if (!result || !result.valid) {
        logger.warn(`[MHI] ${name}: INVALID - ${result?.invalidReason || 'unknown'}`);
        return;
    }
    
    const tierEmoji = {
        MAX: '🟢',
        HIGH: '🔵',
        MEDIUM: '🟡',
        LOW: '🟠',
        BLOCKED: '🔴',
    }[result.sizingTier];
    
    logger.info(
        `[MHI] ${name} | ` +
        `${tierEmoji} ${result.sizingTier} | ` +
        `MHI=${result.mhi.toFixed(3)} | ` +
        `binV=${result.binVelocityComponent.toFixed(2)} ` +
        `swapV=${result.swapVelocityComponent.toFixed(2)} ` +
        `entropy=${result.entropyComponent.toFixed(2)} ` +
        `liqFlow=${result.liquidityFlowComponent.toFixed(2)} | ` +
        `penalty=${result.slopePenalty.toFixed(2)} | ` +
        `sizeX=${result.sizeMultiplier.toFixed(2)}`
    );
}

/**
 * Log MHI summary for multiple pools.
 */
export function logMHISummary(poolIds: string[]): void {
    const ranked = rankPoolsByMHI(poolIds);
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('MICROSTRUCTURE HEALTH INDEX SUMMARY');
    logger.info('───────────────────────────────────────────────────────────────');
    
    const tierCounts = { MAX: 0, HIGH: 0, MEDIUM: 0, LOW: 0, BLOCKED: 0 };
    for (const r of ranked) {
        tierCounts[r.tier]++;
    }
    
    logger.info(
        `Tiers: MAX=${tierCounts.MAX} HIGH=${tierCounts.HIGH} ` +
        `MEDIUM=${tierCounts.MEDIUM} LOW=${tierCounts.LOW} BLOCKED=${tierCounts.BLOCKED}`
    );
    
    logger.info('Top 5 by MHI:');
    for (const r of ranked.slice(0, 5)) {
        logger.info(`  ${r.poolId.slice(0, 8)}... | MHI=${r.mhi.toFixed(3)} | ${r.tier}`);
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    MHI_WEIGHTS,
    SLOPE_PENALTY_WEIGHT,
    MHI_NORMALIZATION,
    MHI_THRESHOLDS,
};

