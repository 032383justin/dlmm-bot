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
 * REGIME-ADAPTIVE WEIGHTS:
 * - BULL: velocity-focused (binV=0.30, swapV=0.30, entropy=0.20, liqFlow=0.20)
 * - NEUTRAL: balanced (binV=0.25, swapV=0.25, entropy=0.25, liqFlow=0.25)
 * - BEAR: stability-focused (binV=0.15, swapV=0.15, entropy=0.35, liqFlow=0.35)
 * 
 * MHI controls position sizing dynamically (SIZING GOVERNOR, not hard gate):
 * - MHI >= 0.60 → 1.00x
 * - MHI 0.50-0.60 → 0.85x
 * - MHI 0.40-0.50 → 0.65x
 * - MHI 0.35-0.40 → 0.45x (SOFT_FLOOR)
 * - MHI 0.20-0.35 → 0.25x (micro-size)
 * - MHI < 0.20 → BLOCKED (HARD_FLOOR)
 * 
 * NOT score. NOT tier. NOT cap.
 * MHI is the SIZING GOVERNOR.
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
import { MarketRegime } from '../types';
import { 
    MHI_SOFT_FLOOR, 
    MHI_HARD_FLOOR, 
    isExplorationModeEnabled, 
    EXPLORATION_MAX_DEPLOYED_PCT 
} from '../config/constants';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MHI component weights
 */
export interface MHIWeights {
    binVelocity: number;
    swapVelocity: number;
    entropy: number;
    liquidityFlow: number;
}

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
    
    // Regime used for computation
    regime: MarketRegime;
    weights: MHIWeights;
    
    // Soft/hard floor status
    belowSoftFloor: boolean;
    belowHardFloor: boolean;
    
    // Validity
    valid: boolean;
    invalidReason?: string;
    
    timestamp: number;
}

/**
 * MHI-based sizing tiers
 */
export type MHISizingTier = 'MAX' | 'HIGH' | 'MEDIUM' | 'LOW' | 'MICRO' | 'BLOCKED';

/**
 * MHI thresholds configuration
 */
export interface MHIThresholds {
    maxTier: { min: number; max: number; sizeMultiplier: number };
    highTier: { min: number; max: number; sizeMultiplier: number };
    mediumTier: { min: number; max: number; sizeMultiplier: number };
    lowTier: { min: number; max: number; sizeMultiplier: number };
    microTier: { min: number; max: number; sizeMultiplier: number };
    blockedBelow: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC MHI WEIGHTS — REGIME-INDEPENDENT (Fee Harvester Mode)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * NEUTRALIZED: MHI weights are now STATIC and regime-independent.
 * 
 * Rationale: This is a fee-extraction system, not a directional trader.
 * Market regime must not affect economic behavior.
 * 
 * Weights are fee-centric: balanced to capture fee opportunities regardless
 * of macro market conditions.
 */
const STATIC_MHI_WEIGHTS: MHIWeights = {
    binVelocity: 0.25,
    swapVelocity: 0.25,
    entropy: 0.25,
    liquidityFlow: 0.25,
};

// Legacy: kept for logging/telemetry only - NOT used for scoring
const REGIME_MHI_WEIGHTS: Record<MarketRegime, MHIWeights> = {
    BULL: STATIC_MHI_WEIGHTS,
    NEUTRAL: STATIC_MHI_WEIGHTS,
    BEAR: STATIC_MHI_WEIGHTS,
};

/**
 * Get MHI weights - ALWAYS returns static weights.
 * Regime parameter is IGNORED (kept for API compatibility).
 * 
 * @param _regime - IGNORED, kept for backward compatibility
 */
export function getMhiWeightsForRegime(_regime: MarketRegime): MHIWeights {
    // NEUTRALIZED: Always return static weights, ignore regime
    return STATIC_MHI_WEIGHTS;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

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
 * MHI sizing thresholds (smooth multipliers, not discrete cliffs)
 */
export const MHI_THRESHOLDS: MHIThresholds = {
    maxTier: { min: 0.60, max: 1.00, sizeMultiplier: 1.00 },
    highTier: { min: 0.50, max: 0.60, sizeMultiplier: 0.85 },
    mediumTier: { min: 0.40, max: 0.50, sizeMultiplier: 0.65 },
    lowTier: { min: 0.35, max: 0.40, sizeMultiplier: 0.45 },
    microTier: { min: 0.20, max: 0.35, sizeMultiplier: 0.25 },
    blockedBelow: MHI_HARD_FLOOR,  // 0.20 - true hard stop
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
// VELOCITY AUDIT STATE (rate-limited logging)
// ═══════════════════════════════════════════════════════════════════════════════

let lastVelocityAuditCycle = 0;
let velocityAuditCount = 0;
const MAX_VELOCITY_AUDIT_PER_CYCLE = 3;

/**
 * Reset velocity audit for new scan cycle
 */
export function resetVelocityAuditCycle(): void {
    lastVelocityAuditCycle = Date.now();
    velocityAuditCount = 0;
}

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
 * Determine sizing tier from MHI value (smooth tiers)
 */
function determineSizingTier(mhi: number): MHISizingTier {
    if (mhi >= MHI_THRESHOLDS.maxTier.min) return 'MAX';
    if (mhi >= MHI_THRESHOLDS.highTier.min) return 'HIGH';
    if (mhi >= MHI_THRESHOLDS.mediumTier.min) return 'MEDIUM';
    if (mhi >= MHI_THRESHOLDS.lowTier.min) return 'LOW';
    if (mhi >= MHI_THRESHOLDS.microTier.min) return 'MICRO';
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
        case 'MICRO': return MHI_THRESHOLDS.microTier.sizeMultiplier;
        case 'BLOCKED': return 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL REGIME STATE
// ═══════════════════════════════════════════════════════════════════════════════

let currentGlobalRegime: MarketRegime = 'NEUTRAL';

/**
 * Update the global regime for OBSERVATION ONLY.
 * 
 * NEUTRALIZED: Regime changes have NO economic impact.
 * - Does NOT change MHI weights (always static)
 * - Does NOT affect entries, sizes, or exits
 * - Kept only for telemetry/logging
 */
export function updateMHIRegime(regime: MarketRegime): void {
    if (regime !== currentGlobalRegime) {
        // Log regime change for observability only
        logger.info(
            `[REGIME] ${currentGlobalRegime}→${regime} (OBSERVATION_ONLY - no economic impact)`
        );
        currentGlobalRegime = regime;
    }
}

/**
 * Get current global regime
 */
export function getMHIRegime(): MarketRegime {
    return currentGlobalRegime;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute Microstructure Health Index for a pool.
 * 
 * MHI = Wv * binVelocity + Ws * swapVelocity + We * entropy + Wl * liquidityFlow
 *     - Wd * negativeSlopePenalty
 * 
 * NEUTRALIZED: Weights are STATIC (regime-independent).
 * Regime parameter is kept for API compatibility but IGNORED.
 */
export function computeMHI(poolId: string, _regime?: MarketRegime): MHIResult | null {
    const now = Date.now();
    // NEUTRALIZED: Use static weights regardless of regime
    const weights = getMhiWeightsForRegime('NEUTRAL');
    
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
            regime: currentGlobalRegime,  // OBSERVATION_ONLY
            weights,
            belowSoftFloor: true,
            belowHardFloor: true,
            valid: false,
            invalidReason: 'No microstructure metrics',
            timestamp: now,
        };
    }
    
    // Get slope data
    const slopes = getMomentumSlopes(poolId);
    
    // Get history for velocity audit
    const history = getPoolHistory(poolId);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // VELOCITY AUDIT INSTRUMENTATION (rate-limited)
    // ═══════════════════════════════════════════════════════════════════════════
    if (velocityAuditCount < MAX_VELOCITY_AUDIT_PER_CYCLE) {
        const windowMs = history.length >= 2 
            ? history[history.length - 1].fetchedAt - history[0].fetchedAt 
            : 0;
        const lastTsDelta = history.length >= 2
            ? history[history.length - 1].fetchedAt - history[history.length - 2].fetchedAt
            : 0;
        
        // Raw bin velocity before normalization (6 decimal precision)
        const rawBinVelUnscaled = metrics.binVelocity / 100;
        const rawSwapVelUnscaled = metrics.swapVelocity / 100;
        
        if (history.length === 0 || windowMs === 0) {
            logger.info(
                `[VELOCITY-AUDIT] pool=${poolId.slice(0, 8)} insufficient data (samples=${history.length}) using 0 velocity`
            );
        } else {
            logger.info(
                `[VELOCITY-AUDIT] pool=${poolId.slice(0, 8)} ` +
                `binVelRaw=${rawBinVelUnscaled.toFixed(6)} ` +
                `swapVelRaw=${rawSwapVelUnscaled.toFixed(6)} ` +
                `window=${windowMs}ms samples=${history.length} lastTsDelta=${lastTsDelta}ms`
            );
        }
        velocityAuditCount++;
    }
    
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
    // COMPUTE MHI (REGIME-ADAPTIVE WEIGHTS)
    // MHI = (Wv * binV + Ws * swapV + We * entropy + Wl * liqFlow) - (Wd * penalty)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const baseScore = 
        (weights.binVelocity * binVelocityComponent) +
        (weights.swapVelocity * swapVelocityComponent) +
        (weights.entropy * entropyComponent) +
        (weights.liquidityFlow * liquidityFlowComponent);
    
    const mhi = clamp01(baseScore - (SLOPE_PENALTY_WEIGHT * slopePenalty));
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DETERMINE SIZING TIER (SOFT/HARD FLOOR)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const belowHardFloor = mhi < MHI_HARD_FLOOR;
    const belowSoftFloor = mhi < MHI_SOFT_FLOOR;
    
    const sizingTier = determineSizingTier(mhi);
    const sizeMultiplier = getSizeMultiplier(sizingTier);
    
    // Permission flags - MHI is now a sizing governor, not a hard gate
    // Only block if below HARD_FLOOR (0.20)
    const canEnter = !belowHardFloor;
    const canScale = sizingTier === 'MAX' || sizingTier === 'HIGH';
    const canReinject = !belowHardFloor && mhi >= 0.40;
    
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
        regime: currentGlobalRegime,  // OBSERVATION_ONLY
        weights,
        belowSoftFloor,
        belowHardFloor,
        valid: true,
        timestamp: now,
    };
}

/**
 * Quick check if pool passes MHI gating for entry.
 * Now uses HARD_FLOOR (0.20) instead of 0.45.
 * MHI is a sizing governor, not a hard gate.
 */
export function passesMHIGating(poolId: string): boolean {
    const result = computeMHI(poolId);
    if (!result) return false;
    
    // Only block if below HARD_FLOOR
    return result.mhi >= MHI_HARD_FLOOR;
}

/**
 * Get MHI-adjusted position size.
 * Takes base size and adjusts it based on MHI.
 * Logs when MHI is below soft floor.
 */
export function getMHIAdjustedSize(
    poolId: string, 
    baseSize: number, 
    poolName?: string
): { size: number; multiplier: number; reason: string } {
    const result = computeMHI(poolId);
    
    if (!result || result.belowHardFloor) {
        return { 
            size: 0, 
            multiplier: 0, 
            reason: 'HARD_FLOOR' 
        };
    }
    
    const adjustedSize = baseSize * result.sizeMultiplier;
    let reason: string = result.sizingTier;
    
    // Log when below soft floor (rate-limited per pool per cycle)
    if (result.belowSoftFloor) {
        reason = 'SOFT_FLOOR';
        const name = poolName || poolId.slice(0, 8);
        logger.info(
            `[MHI-SIZE] ${name} mhi=${result.mhi.toFixed(2)} ` +
            `multiplier=${result.sizeMultiplier.toFixed(2)} ` +
            `regime=${result.regime} reason=${reason}`
        );
    }
    
    return {
        size: adjustedSize,
        multiplier: result.sizeMultiplier,
        reason,
    };
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
        MICRO: '🟤',
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
        `sizeX=${result.sizeMultiplier.toFixed(2)} | ` +
        `regime=${result.regime}`
    );
}

/**
 * Log MHI summary for multiple pools.
 */
export function logMHISummary(poolIds: string[]): void {
    const ranked = rankPoolsByMHI(poolIds);
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`MICROSTRUCTURE HEALTH INDEX SUMMARY (regime=${currentGlobalRegime})`);
    logger.info('───────────────────────────────────────────────────────────────');
    
    const tierCounts = { MAX: 0, HIGH: 0, MEDIUM: 0, LOW: 0, MICRO: 0, BLOCKED: 0 };
    for (const r of ranked) {
        tierCounts[r.tier]++;
    }
    
    logger.info(
        `Tiers: MAX=${tierCounts.MAX} HIGH=${tierCounts.HIGH} ` +
        `MEDIUM=${tierCounts.MEDIUM} LOW=${tierCounts.LOW} ` +
        `MICRO=${tierCounts.MICRO} BLOCKED=${tierCounts.BLOCKED}`
    );
    
    logger.info('Top 5 by MHI:');
    for (const r of ranked.slice(0, 5)) {
        logger.info(`  ${r.poolId.slice(0, 8)}... | MHI=${r.mhi.toFixed(3)} | ${r.tier}`);
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

/**
 * Check if exploration mode allows entry for a weak-MHI pool.
 * Only for Tier A/B pools that pass all other gates.
 */
export function isExplorationEntryAllowed(
    mhi: number,
    riskTier: string,
    currentDeployedPct: number
): { allowed: boolean; reason: string } {
    if (!isExplorationModeEnabled()) {
        return { allowed: false, reason: 'EXPLORATION_MODE disabled' };
    }
    
    // Only allow if MHI is between hard and soft floor
    if (mhi < MHI_HARD_FLOOR) {
        return { allowed: false, reason: 'Below HARD_FLOOR' };
    }
    
    if (mhi >= MHI_SOFT_FLOOR) {
        return { allowed: true, reason: 'Above SOFT_FLOOR (normal entry)' };
    }
    
    // Exploration mode specific checks
    if (riskTier !== 'A' && riskTier !== 'B') {
        return { allowed: false, reason: `Exploration requires Tier A/B, got ${riskTier}` };
    }
    
    if (currentDeployedPct >= EXPLORATION_MAX_DEPLOYED_PCT) {
        return { 
            allowed: false, 
            reason: `Exploration cap reached (${(currentDeployedPct * 100).toFixed(1)}% >= ${(EXPLORATION_MAX_DEPLOYED_PCT * 100).toFixed(1)}%)` 
        };
    }
    
    logger.info(
        `[EXPLORATION] enabled maxDeployedPct=${(EXPLORATION_MAX_DEPLOYED_PCT * 100).toFixed(1)}% applied=true`
    );
    
    return { allowed: true, reason: 'EXPLORATION_MODE' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY EXPORTS (for backwards compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @deprecated Use getMhiWeightsForRegime() instead
 * Kept for backwards compatibility
 */
export const MHI_WEIGHTS = REGIME_MHI_WEIGHTS.NEUTRAL;

