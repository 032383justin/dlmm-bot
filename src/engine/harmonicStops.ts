/**
 * Harmonic Stops Module - Tier 4 Microstructure-Driven Exit Controller
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PER-POSITION MICROSTRUCTURE HEALTH MONITORING
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Stops are STATE-BASED, not PRICE-DISTANCE-BASED.
 * 
 * Monitors live microstructure "health" per open trade:
 * - vSlope, lSlope, eSlope (velocity/liquidity/entropy slopes)
 * - binVelocity, swapVelocity, poolEntropy, liquidityFlowPct, feeIntensity
 * 
 * Compares current metrics vs a baseline snapshot at entry.
 * Decides HOLD vs FULL_EXIT based on harmonic "health bands".
 * 
 * Tier-dependent tolerance:
 * - Tier A (CORE): wide bands, tolerant, exits only on severe collapse
 * - Tier B (MOMENTUM): medium tolerance
 * - Tier C (SPECULATIVE): tight bands, quick exits
 * 
 * This is a PURE microstructure health controller, not TP/SL logic.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { RiskTier } from './riskBucketEngine';
import {
    harmonicConfig,
    getMinBadSamples,
    getVelocityDropFactor,
    getEntropyDropFactor,
    getLiquidityOutflowPct,
    getMinHealthScore,
} from '../config/harmonics';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Harmonic decision types
 */
export type HarmonicDecisionType = 'HOLD' | 'FULL_EXIT';

/**
 * Snapshot of microstructure metrics at a point in time.
 * Used for both baseline (entry) and current state comparisons.
 */
export interface MicroMetricsSnapshot {
    timestamp: number;
    binVelocity: number;        // Bin movement rate (bins/sec)
    swapVelocity: number;       // Swap rate (swaps/sec)
    liquidityFlowPct: number;   // Liquidity change as % of total
    poolEntropy: number;        // Pool health/balance indicator
    feeIntensity: number;       // Fee generation intensity
    vSlope: number;             // Velocity slope (acceleration)
    lSlope: number;             // Liquidity slope (flow trend)
    eSlope: number;             // Entropy slope (health trend)
}

/**
 * Context for a trade being evaluated by harmonic stops.
 * Contains all information needed to make a HOLD/EXIT decision.
 */
export interface HarmonicContext {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    tier: RiskTier;
    entryTimestamp: number;
    entryPrice: number;
    sizeUsd: number;
    baseline: MicroMetricsSnapshot;  // Snapshot at entry
}

/**
 * Result of harmonic stop evaluation.
 */
export interface HarmonicDecision {
    type: HarmonicDecisionType;
    healthScore: number;         // Combined health score (0-1)
    reason?: string;
    debug: HarmonicDebugInfo;
}

/**
 * Debug info for logging and tuning.
 */
export interface HarmonicDebugInfo {
    velocityRatio: number;       // current / baseline
    entropyRatio: number;        // current / baseline
    liquidityFlowPct: number;    // current flow %
    vSlope: number;
    lSlope: number;
    eSlope: number;
    badFactorCount: number;      // Number of factors in violation
    badFactors: string[];        // Names of violated factors
    floorViolations: string[];   // Absolute floor violations
    tier: RiskTier;
    holdTimeMs: number;
    consecutiveBadSamples: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Harmonic state per trade.
 * Tracks baseline, consecutive bad samples, and last check time.
 */
interface HarmonicTradeState {
    tradeId: string;
    poolAddress: string;
    tier: RiskTier;
    baseline: MicroMetricsSnapshot;
    consecutiveBadSamples: number;
    lastCheckTime: number;
    lastHealthScore: number;
}

// In-memory state storage - keyed by tradeId
const harmonicState: Map<string, HarmonicTradeState> = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register a new trade for harmonic monitoring.
 * Called when a position is opened.
 */
export function registerHarmonicTrade(
    tradeId: string,
    poolAddress: string,
    poolName: string,
    tier: RiskTier,
    baseline: MicroMetricsSnapshot
): void {
    harmonicState.set(tradeId, {
        tradeId,
        poolAddress,
        tier,
        baseline,
        consecutiveBadSamples: 0,
        lastCheckTime: Date.now(),
        lastHealthScore: 1.0,
    });
    
    logger.info(
        `[HARMONIC] Baseline for ${poolName} trade ${tradeId.slice(0, 8)}... | ` +
        `binV=${baseline.binVelocity.toFixed(4)} ` +
        `swapV=${baseline.swapVelocity.toFixed(4)} ` +
        `entropy=${baseline.poolEntropy.toFixed(4)} ` +
        `liqFlow=${(baseline.liquidityFlowPct * 100).toFixed(2)}% ` +
        `feeInt=${baseline.feeIntensity.toFixed(4)} ` +
        `tier=${tier}`
    );
}

/**
 * Unregister a trade from harmonic monitoring.
 * Called when a position is closed.
 */
export function unregisterHarmonicTrade(tradeId: string): void {
    if (harmonicState.has(tradeId)) {
        harmonicState.delete(tradeId);
        logger.debug(`[HARMONIC] Unregistered trade ${tradeId.slice(0, 8)}...`);
    }
}

/**
 * Get the harmonic state for a trade.
 */
export function getHarmonicState(tradeId: string): HarmonicTradeState | undefined {
    return harmonicState.get(tradeId);
}

/**
 * Check if a trade is registered for harmonic monitoring.
 */
export function isHarmonicRegistered(tradeId: string): boolean {
    return harmonicState.has(tradeId);
}

/**
 * Get all registered trade IDs.
 */
export function getAllHarmonicTradeIds(): string[] {
    return Array.from(harmonicState.keys());
}

/**
 * Clear all harmonic state (for reset/cleanup).
 */
export function clearAllHarmonicState(): void {
    harmonicState.clear();
    logger.info('[HARMONIC] Cleared all harmonic state');
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH SCORE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute individual factor health (0-1 scale).
 * Returns 1.0 if healthy, 0.0 if severely degraded.
 */
function computeRatioHealth(current: number, baseline: number, minFactor: number): number {
    if (baseline <= 0) return 1.0; // Avoid division by zero, assume healthy
    
    const ratio = current / baseline;
    
    if (ratio >= 1.0) {
        // Better than baseline → perfect health
        return 1.0;
    }
    
    if (ratio <= minFactor) {
        // Below minimum threshold → zero health
        return 0.0;
    }
    
    // Interpolate between minFactor and 1.0
    return (ratio - minFactor) / (1.0 - minFactor);
}

/**
 * Compute slope health (0-1 scale).
 * Negative slopes reduce health, positive slopes are healthy.
 */
function computeSlopeHealth(slope: number, maxNegative: number): number {
    if (slope >= 0) {
        // Positive or zero slope → healthy
        return 1.0;
    }
    
    if (slope <= maxNegative) {
        // Below maximum negative threshold → zero health
        return 0.0;
    }
    
    // Interpolate between maxNegative and 0
    return (slope - maxNegative) / (0 - maxNegative);
}

/**
 * Compute liquidity flow health (0-1 scale).
 * Outflow (negative) reduces health.
 */
function computeLiquidityFlowHealth(flowPct: number, minFlowPct: number): number {
    if (flowPct >= 0) {
        // Positive or zero flow → healthy (inflow or stable)
        return 1.0;
    }
    
    if (flowPct <= minFlowPct) {
        // Below minimum flow threshold → zero health
        return 0.0;
    }
    
    // Interpolate between minFlowPct and 0
    return (flowPct - minFlowPct) / (0 - minFlowPct);
}

/**
 * Check absolute floor violations.
 * Returns list of violated floors.
 */
function checkAbsoluteFloors(current: MicroMetricsSnapshot): string[] {
    const violations: string[] = [];
    
    if (current.binVelocity < harmonicConfig.minBinVelocity) {
        violations.push(`binVelocity ${current.binVelocity.toFixed(4)} < ${harmonicConfig.minBinVelocity}`);
    }
    
    if (current.swapVelocity < harmonicConfig.minSwapVelocity) {
        violations.push(`swapVelocity ${current.swapVelocity.toFixed(4)} < ${harmonicConfig.minSwapVelocity}`);
    }
    
    if (current.poolEntropy < harmonicConfig.minPoolEntropy) {
        violations.push(`poolEntropy ${current.poolEntropy.toFixed(4)} < ${harmonicConfig.minPoolEntropy}`);
    }
    
    if (current.feeIntensity < harmonicConfig.minFeeIntensity) {
        violations.push(`feeIntensity ${current.feeIntensity.toFixed(4)} < ${harmonicConfig.minFeeIntensity}`);
    }
    
    return violations;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EVALUATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate harmonic stop conditions for a trade.
 * 
 * This is the core function that decides HOLD vs FULL_EXIT.
 * 
 * @param ctx - Harmonic context (trade info + baseline)
 * @param current - Current microstructure metrics snapshot
 * @returns HarmonicDecision (HOLD or FULL_EXIT with reason and debug info)
 */
export function evaluateHarmonicStop(
    ctx: HarmonicContext,
    current: MicroMetricsSnapshot
): HarmonicDecision {
    const now = Date.now();
    const holdTimeMs = now - ctx.entryTimestamp;
    const tier = ctx.tier;
    
    // Get or create state for this trade
    let state = harmonicState.get(ctx.tradeId);
    if (!state) {
        // Auto-register if not found
        state = {
            tradeId: ctx.tradeId,
            poolAddress: ctx.poolAddress,
            tier: ctx.tier,
            baseline: ctx.baseline,
            consecutiveBadSamples: 0,
            lastCheckTime: now,
            lastHealthScore: 1.0,
        };
        harmonicState.set(ctx.tradeId, state);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GRACE PERIOD CHECK
    // ═══════════════════════════════════════════════════════════════════════════
    if (holdTimeMs < harmonicConfig.minHoldTimeMs) {
        // Still in grace period - always HOLD
        return {
            type: 'HOLD',
            healthScore: 1.0,
            reason: 'Grace period active',
            debug: {
                velocityRatio: 1.0,
                entropyRatio: 1.0,
                liquidityFlowPct: current.liquidityFlowPct,
                vSlope: current.vSlope,
                lSlope: current.lSlope,
                eSlope: current.eSlope,
                badFactorCount: 0,
                badFactors: [],
                floorViolations: [],
                tier,
                holdTimeMs,
                consecutiveBadSamples: state.consecutiveBadSamples,
            },
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE HEALTH COMPONENTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    const baseline = ctx.baseline;
    
    // Velocity ratio health (comparing to baseline)
    const velocityRatio = baseline.binVelocity > 0 
        ? current.binVelocity / baseline.binVelocity 
        : 1.0;
    const velocityHealth = computeRatioHealth(
        current.binVelocity + current.swapVelocity,
        baseline.binVelocity + baseline.swapVelocity,
        getVelocityDropFactor(tier)
    );
    
    // Entropy ratio health
    const entropyRatio = baseline.poolEntropy > 0 
        ? current.poolEntropy / baseline.poolEntropy 
        : 1.0;
    const entropyHealth = computeRatioHealth(
        current.poolEntropy,
        baseline.poolEntropy,
        getEntropyDropFactor(tier)
    );
    
    // Liquidity flow health
    const liquidityFlowHealth = computeLiquidityFlowHealth(
        current.liquidityFlowPct,
        getLiquidityOutflowPct(tier)
    );
    
    // Slope health (combined)
    const vSlopeHealth = computeSlopeHealth(current.vSlope, harmonicConfig.maxNegativeSlopeV);
    const lSlopeHealth = computeSlopeHealth(current.lSlope, harmonicConfig.maxNegativeSlopeL);
    const eSlopeHealth = computeSlopeHealth(current.eSlope, harmonicConfig.maxNegativeSlopeE);
    const combinedSlopeHealth = (vSlopeHealth + lSlopeHealth + eSlopeHealth) / 3;
    
    // Absolute floor violations
    const floorViolations = checkAbsoluteFloors(current);
    const floorHealth = floorViolations.length === 0 ? 1.0 : 
        Math.max(0, 1.0 - (floorViolations.length * 0.3)); // -30% per violation
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE COMBINED HEALTH SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    
    const weights = harmonicConfig.healthWeights;
    const healthScore = 
        (velocityHealth * weights.velocityRatio) +
        (entropyHealth * weights.entropyRatio) +
        (liquidityFlowHealth * weights.liquidityFlow) +
        (combinedSlopeHealth * weights.slopeHealth) +
        (floorHealth * weights.absoluteFloors);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // IDENTIFY BAD FACTORS
    // ═══════════════════════════════════════════════════════════════════════════
    
    const badFactors: string[] = [];
    
    if (velocityHealth < 0.5) {
        badFactors.push(`velocity collapsed (ratio=${velocityRatio.toFixed(2)})`);
    }
    
    if (entropyHealth < 0.5) {
        badFactors.push(`entropy dropped (ratio=${entropyRatio.toFixed(2)})`);
    }
    
    if (liquidityFlowHealth < 0.5) {
        badFactors.push(`liquidity draining (flow=${(current.liquidityFlowPct * 100).toFixed(2)}%)`);
    }
    
    if (combinedSlopeHealth < 0.5) {
        const slopeDetails = [];
        if (vSlopeHealth < 0.5) slopeDetails.push(`vSlope=${current.vSlope.toFixed(4)}`);
        if (lSlopeHealth < 0.5) slopeDetails.push(`lSlope=${current.lSlope.toFixed(4)}`);
        if (eSlopeHealth < 0.5) slopeDetails.push(`eSlope=${current.eSlope.toFixed(4)}`);
        badFactors.push(`slopes deteriorating (${slopeDetails.join(', ')})`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DETERMINE IF THIS IS A BAD SAMPLE
    // ═══════════════════════════════════════════════════════════════════════════
    
    const minHealthForTier = getMinHealthScore(tier);
    const isBadSample = healthScore < minHealthForTier || floorViolations.length >= 2;
    
    // Update consecutive bad sample count
    if (isBadSample) {
        state.consecutiveBadSamples++;
    } else {
        state.consecutiveBadSamples = 0; // Reset on healthy sample
    }
    
    state.lastCheckTime = now;
    state.lastHealthScore = healthScore;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BUILD DEBUG INFO
    // ═══════════════════════════════════════════════════════════════════════════
    
    const debugInfo: HarmonicDebugInfo = {
        velocityRatio,
        entropyRatio,
        liquidityFlowPct: current.liquidityFlowPct,
        vSlope: current.vSlope,
        lSlope: current.lSlope,
        eSlope: current.eSlope,
        badFactorCount: badFactors.length,
        badFactors,
        floorViolations,
        tier,
        holdTimeMs,
        consecutiveBadSamples: state.consecutiveBadSamples,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DECISION: HOLD OR FULL_EXIT
    // ═══════════════════════════════════════════════════════════════════════════
    
    const minBadSamples = getMinBadSamples(tier);
    
    // Exit if consecutive bad samples exceed threshold
    if (state.consecutiveBadSamples >= minBadSamples && minBadSamples > 0) {
        const reason = buildExitReason(badFactors, floorViolations, healthScore, state.consecutiveBadSamples);
        
        logger.warn(
            `[HARMONIC] CHECK trade ${ctx.tradeId.slice(0, 8)}... | ` +
            `healthScore=${healthScore.toFixed(2)} | ` +
            `status=EXIT_TRIGGERED | ` +
            `badSamples=${state.consecutiveBadSamples}/${minBadSamples} | ` +
            `tier=${tier}`
        );
        
        return {
            type: 'FULL_EXIT',
            healthScore,
            reason,
            debug: debugInfo,
        };
    }
    
    // Otherwise HOLD
    logger.info(
        `[HARMONIC] CHECK trade ${ctx.tradeId.slice(0, 8)}... | ` +
        `healthScore=${healthScore.toFixed(2)} | ` +
        `status=HOLD | ` +
        `badSamples=${state.consecutiveBadSamples}/${minBadSamples} | ` +
        `tier=${tier}`
    );
    
    return {
        type: 'HOLD',
        healthScore,
        debug: debugInfo,
    };
}

/**
 * Build a human-readable exit reason string.
 */
function buildExitReason(
    badFactors: string[], 
    floorViolations: string[], 
    healthScore: number,
    consecutiveBadSamples: number
): string {
    const parts: string[] = [];
    
    if (badFactors.length > 0) {
        parts.push(badFactors.slice(0, 2).join(' + '));
    }
    
    if (floorViolations.length > 0) {
        parts.push(`floor violations: ${floorViolations.length}`);
    }
    
    if (parts.length === 0) {
        parts.push('health score below threshold');
    }
    
    return `${parts.join('; ')} (health=${healthScore.toFixed(2)}, badSamples=${consecutiveBadSamples})`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a MicroMetricsSnapshot from telemetry data.
 * Helper to build snapshots from existing telemetry structures.
 */
export function createMicroMetricsSnapshot(
    timestamp: number,
    binVelocity: number,
    swapVelocity: number,
    liquidityFlowPct: number,
    poolEntropy: number,
    feeIntensity: number,
    vSlope: number,
    lSlope: number,
    eSlope: number
): MicroMetricsSnapshot {
    return {
        timestamp,
        binVelocity,
        swapVelocity,
        liquidityFlowPct,
        poolEntropy,
        feeIntensity,
        vSlope,
        lSlope,
        eSlope,
    };
}

/**
 * Create a HarmonicContext from trade and baseline data.
 */
export function createHarmonicContext(
    tradeId: string,
    poolAddress: string,
    poolName: string,
    tier: RiskTier,
    entryTimestamp: number,
    entryPrice: number,
    sizeUsd: number,
    baseline: MicroMetricsSnapshot
): HarmonicContext {
    return {
        tradeId,
        poolAddress,
        poolName,
        tier,
        entryTimestamp,
        entryPrice,
        sizeUsd,
        baseline,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    harmonicConfig,
};

