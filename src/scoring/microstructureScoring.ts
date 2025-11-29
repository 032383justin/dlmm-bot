/**
 * Microstructure-Based Pool Scoring - Tier 4 Institutional Architecture
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 SCORING MODEL (UPGRADED WITH TIME-WEIGHTING)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Five Scoring Pillars (0-100 each):
 * 1. Bin Velocity Score (30%) - binVelocity normalized 0→0, 0.05/sec→100
 * 2. Swap Velocity Score (25%) - swaps/sec normalized 0→0, 0.30/sec→100
 * 3. Liquidity Flow Score (20%) - inflow/outflow as % of TVL
 * 4. Fee Intensity Score (15%) - fees/sec normalized by TVL
 * 5. Entropy Score (10%) - Shannon entropy 0→0, 0.70+→100
 * 
 * Composite Score:
 * tier4Score = baseScore * migrationMultiplier * regimeMultiplier * slopeMultiplier * timeWeightMultiplier
 * 
 * Where baseScore = weighted sum of pillars
 * 
 * TIME-WEIGHTED SCORING (NEW):
 * - Prefer consistent bin shifts over time
 * - Prefer persistent liquidity flow
 * - Penalize single candle spikes
 * - Consistency score: higher = more stable activity
 * - Spike ratio: higher = more volatile (penalized)
 * 
 * REGIME CLASSIFICATION:
 * - BULL: binVelocity > 0.05 OR liquiditySlope > 0 → multiplier 1.20
 * - NEUTRAL: default → multiplier 1.00
 * - BEAR: binVelocity < 0 OR liquiditySlope < 0 → multiplier 0.80
 * 
 * MIGRATION SYSTEM:
 * - liquiditySlope > +40%/min → direction "in"
 * - liquiditySlope < -40%/min → direction "out"
 * - otherwise → "neutral"
 * 
 * SLOPE MULTIPLIER:
 * slopeMultiplier = 1.0 + clamp(velocity_slope/50, -0.10, +0.10)
 *                      + clamp(liquidity_slope/50, -0.10, +0.15)
 *                      + clamp(entropy_slope/50, -0.05, +0.10)
 * Capped to range [0.75, 1.35]
 * 
 * DYNAMIC THRESHOLDS:
 * - BULL: ENTRY=28, EXIT=18
 * - NEUTRAL: ENTRY=32, EXIT=22
 * - BEAR: ENTRY=36, EXIT=30
 * 
 * PRE-TIER FILTERING (UPSTREAM):
 * Pools NEVER reach Tier4 scoring if they fail pre-tier:
 * - swapVelocity < 0.12 → DISCARDED
 * - poolEntropy < 0.65 → DISCARDED
 * - liquidityFlow < 0.5% → DISCARDED
 * - 24h volume < $75,000 → DISCARDED
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Pool } from '../core/normalizePools';
import { 
    computeMicrostructureMetrics, 
    MicrostructureMetrics,
    getPoolHistory,
    DLMMTelemetry,
} from '../services/dlmmTelemetry';
import {
    getMomentumSlopes,
    MomentumSlopes,
    MIN_SNAPSHOTS,
} from './momentumEngine';
import {
    Tier4Score,
    MarketRegime,
    MigrationDirection,
    Tier4Thresholds,
    BinWidthConfig,
    Tier4EntryEvaluation,
    EntryGatingStatus,
} from '../types';
import logger from '../utils/logger';
import { computeMHI } from '../engine/microstructureHealthIndex';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tier 4 scoring weights
 */
export const TIER4_WEIGHTS = {
    binVelocity: 0.30,
    swapVelocity: 0.25,
    liquidityFlow: 0.20,
    feeIntensity: 0.15,
    entropy: 0.10,
};

/**
 * Normalization constants for pillar scores
 */
const NORMALIZATION = {
    binVelocity: { max: 0.05 },      // 0.05 bins/sec = 100
    swapVelocity: { max: 0.30 },     // 0.30 swaps/sec = 100
    liquidityFlow: { max: 0.10 },     // 10% of TVL = 100
    feeIntensity: { max: 0.001 },     // 0.1% fees/sec = 100
    entropy: { max: 0.70 },           // 0.70 entropy = 100
};

/**
 * Regime multipliers
 */
const REGIME_MULTIPLIERS: Record<MarketRegime, number> = {
    BULL: 1.20,
    NEUTRAL: 1.00,
    BEAR: 0.80,
};

/**
 * Dynamic thresholds per regime
 */
const REGIME_THRESHOLDS: Record<MarketRegime, Tier4Thresholds> = {
    BULL: { entryThreshold: 28, exitThreshold: 18 },
    NEUTRAL: { entryThreshold: 32, exitThreshold: 22 },
    BEAR: { entryThreshold: 36, exitThreshold: 30 },
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER-BASED ENTRY THRESHOLDS
 * ═══════════════════════════════════════════════════════════════════════════════
 * Score must meet tier threshold based on market regime classification
 * 
 * RELAXED: These have been lowered to avoid over-filtering
 * The old thresholds (48/50/42/35) were causing "no candidates" issues
 */
export const ENTRY_TIER_THRESHOLDS = {
    TIER1: 32,   // Tier B momentum entries (was 48)
    TIER2: 35,   // Medium quality (was 50)
    TIER3: 38,   // More conservative (was 42)
    TIER4: 28,   // Minimum acceptable (was 35)
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENTRY BLOCKING THRESHOLDS
 * These are SOFT gates - not all must be met to block
 * The exception override can bypass blocks for high-quality pools
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * RELAXED: Lowered thresholds to avoid over-filtering when microstructure is
 * healthy but some metrics are borderline
 */
export const ENTRY_BLOCKING_THRESHOLDS = {
    minMHI: 0.45,              // MHI must be >= 0.45 (was 0.55)
    minSwapVelocity: 0.05,     // swapVelocity (swaps/sec) must be >= 0.05 (was 0.15)
    minPoolEntropy: 0.35,      // poolEntropy must be >= 0.35 (was 0.45)
    minVelocitySlope: -0.01,   // velocitySlope must be > -0.01 (was 0, allow slight negative)
    minLiquiditySlope: -0.01,  // liquiditySlope must be > -0.01 (was 0, allow slight negative)
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENTRY EXCEPTION OVERRIDE
 * If ALL conditions are met, allow entry even if blocked
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * RELAXED: Lowered to allow more pools through when they have strong signals
 */
export const ENTRY_EXCEPTION_THRESHOLDS = {
    minScore: 50,              // score > 50 (was 62)
    minFeeIntensity: 0.8,      // feeIntensity > 0.8 (was 1.5)
    minEntropySlope: 0.0001,   // entropySlope > 0.0001 (was 0.00015)
};

/**
 * Entry block reasons for logging
 */
export type EntryBlockReason = 
    | 'MHI_LOW' 
    | 'SWAP_VELOCITY_LOW' 
    | 'ENTROPY_LOW' 
    | 'VELOCITY_NEG' 
    | 'LIQUIDITY_NEG'
    | 'SCORE_LOW'
    | 'MIGRATION_BLOCK'
    | 'NO_DATA';

/**
 * Migration thresholds (percentage per minute)
 */
const MIGRATION_THRESHOLDS = {
    inflow: 0.40,   // +40%/min → "in"
    outflow: -0.40, // -40%/min → "out"
};

/**
 * Slope multiplier clamps
 */
const SLOPE_CLAMPS = {
    velocity: { min: -0.10, max: 0.10 },
    liquidity: { min: -0.10, max: 0.15 },
    entropy: { min: -0.05, max: 0.10 },
};

/**
 * Total slope multiplier range
 */
const SLOPE_MULTIPLIER_RANGE = { min: 0.75, max: 1.35 };

/**
 * Tier 4 bin width configurations
 */
const BIN_WIDTH_CONFIG: Record<string, BinWidthConfig> = {
    narrow: { min: 5, max: 12, label: 'NARROW (high score)' },
    medium: { min: 8, max: 18, label: 'MEDIUM (moderate score)' },
    wide: { min: 12, max: 26, label: 'WIDE (low score)' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool with Tier 4 enrichment
 */
export interface Tier4EnrichedPool extends Pool {
    // Tier 4 score data
    tier4: Tier4Score | null;
    
    // Legacy microMetrics for backwards compatibility
    microMetrics: MicrostructureMetrics | null;
    
    // Validity flags
    hasValidTelemetry: boolean;
    isMarketAlive: boolean;
    
    // Quick access fields
    tier4Score: number;
    microScore: number;     // Alias for backwards compatibility
    regime: MarketRegime;
    migrationDirection: MigrationDirection;
    entryThreshold: number;
    exitThreshold: number;
    binWidth: BinWidthConfig;
    
    // Slopes
    velocitySlope: number;
    liquiditySlope: number;
    entropySlope: number;
    
    // Time-weighted scoring (NEW)
    consistencyScore: number;     // 0-100, higher = more consistent activity
    spikeRatio: number;           // higher = more volatile/spiky (penalized)
    timeWeightMultiplier: number; // applied to final score
    isTimeWeightHealthy: boolean; // passes time-weight requirements
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Normalize a value to 0-100 scale
 */
function normalize(value: number, max: number): number {
    return clamp((value / max) * 100, 0, 100);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 PILLAR SCORE CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Bin Velocity Score (30%)
 * 
 * binVelocity = Δ(activeBin) / Δt
 * Normalize: 0 → 0, 0.05/sec → 100
 */
function calcBinVelocityScore(rawBinVelocity: number): number {
    return normalize(Math.abs(rawBinVelocity), NORMALIZATION.binVelocity.max);
}

/**
 * Calculate Swap Velocity Score (25%)
 * 
 * swaps / second
 * Normalize: 0 → 0, 0.30/sec → 100
 */
function calcSwapVelocityScore(rawSwapVelocity: number): number {
    return normalize(rawSwapVelocity, NORMALIZATION.swapVelocity.max);
}

/**
 * Calculate Liquidity Flow Score (20%)
 * 
 * inflow/outflow in USD Δ
 * Normalize: per percentage-of-TVL
 */
function calcLiquidityFlowScore(rawLiquidityDelta: number, tvl: number): number {
    if (tvl <= 0) return 0;
    const flowPercent = Math.abs(rawLiquidityDelta) / tvl;
    return normalize(flowPercent, NORMALIZATION.liquidityFlow.max);
}

/**
 * Calculate Fee Intensity Score (15%)
 * 
 * fees per second normalized by pool TVL
 */
function calcFeeIntensityScore(rawFeeIntensity: number): number {
    return normalize(rawFeeIntensity, NORMALIZATION.feeIntensity.max);
}

/**
 * Calculate Entropy Score (10%)
 * 
 * Shannon entropy of liquidity distribution
 * Normalize: 0 → 0, 0.70+ → 100
 */
function calcEntropyScore(rawEntropy: number): number {
    return normalize(rawEntropy, NORMALIZATION.entropy.max);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGIME CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify market regime based on bin velocity and liquidity slope
 * 
 * BULL: binVelocity > 0.05 OR liquiditySlope > 0 → 1.20
 * BEAR: binVelocity < 0 OR liquiditySlope < 0 → 0.80
 * NEUTRAL: everything else → 1.00
 */
export function classifyRegime(rawBinVelocity: number, liquiditySlope: number): MarketRegime {
    // BULL conditions
    if (rawBinVelocity > 0.05 || liquiditySlope > 0) {
        return 'BULL';
    }
    
    // BEAR conditions
    if (rawBinVelocity < 0 || liquiditySlope < 0) {
        return 'BEAR';
    }
    
    // Default NEUTRAL
    return 'NEUTRAL';
}

/**
 * Get regime multiplier
 */
export function getRegimeMultiplier(regime: MarketRegime): number {
    return REGIME_MULTIPLIERS[regime];
}

/**
 * Get dynamic thresholds for regime
 */
export function getRegimeThresholds(regime: MarketRegime): Tier4Thresholds {
    return REGIME_THRESHOLDS[regime];
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRATION SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify migration direction based on liquidity slope
 * 
 * liquiditySlope > +40%/min → "in"
 * liquiditySlope < -40%/min → "out"
 * otherwise → "neutral"
 */
export function classifyMigration(liquiditySlopePerMin: number): MigrationDirection {
    if (liquiditySlopePerMin > MIGRATION_THRESHOLDS.inflow) {
        return 'in';
    }
    if (liquiditySlopePerMin < MIGRATION_THRESHOLDS.outflow) {
        return 'out';
    }
    return 'neutral';
}

/**
 * Check if migration blocks entry
 * 
 * BLOCK if:
 * - migrationDirection="in" AND liquiditySlope < -40%
 * - migrationDirection="out" AND liquiditySlope > +40%
 */
export function checkMigrationBlock(
    migrationDirection: MigrationDirection,
    liquiditySlopePerMin: number
): { blocked: boolean; reason?: string } {
    if (migrationDirection === 'in' && liquiditySlopePerMin < MIGRATION_THRESHOLDS.outflow) {
        return {
            blocked: true,
            reason: `Migration reversal: was "in" but slope ${(liquiditySlopePerMin * 100).toFixed(1)}%/min < -40%`,
        };
    }
    
    if (migrationDirection === 'out' && liquiditySlopePerMin > MIGRATION_THRESHOLDS.inflow) {
        return {
            blocked: true,
            reason: `Migration reversal: was "out" but slope ${(liquiditySlopePerMin * 100).toFixed(1)}%/min > +40%`,
        };
    }
    
    return { blocked: false };
}

/**
 * Get migration multiplier (for score dampening)
 * 
 * Returns 1.0 for normal conditions, 0.0 if migration blocks entry
 */
export function getMigrationMultiplier(
    migrationDirection: MigrationDirection,
    liquiditySlopePerMin: number
): number {
    const block = checkMigrationBlock(migrationDirection, liquiditySlopePerMin);
    return block.blocked ? 0.0 : 1.0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLOPE MULTIPLIER (Anticipatory Logic)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate slope multiplier from first derivatives
 * 
 * slopeMultiplier = 1.0
 *   + clamp(velocity_slope / 50, -0.10, +0.10)
 *   + clamp(liquidity_slope / 50, -0.10, +0.15)
 *   + clamp(entropy_slope / 50, -0.05, +0.10)
 * 
 * Capped to range [0.75, 1.35]
 */
export function calcSlopeMultiplier(
    velocitySlope: number,
    liquiditySlope: number,
    entropySlope: number
): number {
    const velocityComponent = clamp(
        velocitySlope / 50,
        SLOPE_CLAMPS.velocity.min,
        SLOPE_CLAMPS.velocity.max
    );
    
    const liquidityComponent = clamp(
        liquiditySlope / 50,
        SLOPE_CLAMPS.liquidity.min,
        SLOPE_CLAMPS.liquidity.max
    );
    
    const entropyComponent = clamp(
        entropySlope / 50,
        SLOPE_CLAMPS.entropy.min,
        SLOPE_CLAMPS.entropy.max
    );
    
    const rawMultiplier = 1.0 + velocityComponent + liquidityComponent + entropyComponent;
    
    return clamp(rawMultiplier, SLOPE_MULTIPLIER_RANGE.min, SLOPE_MULTIPLIER_RANGE.max);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BIN WIDTH LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get bin width configuration based on Tier 4 score
 * 
 * score > 45 → narrow bins (5-12)
 * score > 35 → medium bins (8-18)
 * else → wide bins (12-26)
 */
export function getBinWidthConfig(tier4Score: number): BinWidthConfig {
    if (tier4Score > 45) {
        return BIN_WIDTH_CONFIG.narrow;
    }
    if (tier4Score > 35) {
        return BIN_WIDTH_CONFIG.medium;
    }
    return BIN_WIDTH_CONFIG.wide;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-WEIGHTED SCORING (NEW)
// Prefer consistent bin shifts, persistent flow, NOT single candle spikes
// ═══════════════════════════════════════════════════════════════════════════════

interface TimeWeightSnapshot {
    timestamp: number;
    binVelocity: number;
    swapVelocity: number;
    liquidityFlow: number;
    entropy: number;
}

const timeWeightHistory: Map<string, TimeWeightSnapshot[]> = new Map();

const TIME_WEIGHT_CONFIG = {
    historyWindowMs: 30 * 60 * 1000,  // 30 minutes of history
    minSnapshots: 3,                   // Minimum snapshots for time-weight calc
    consistencyWeight: 0.15,           // 15% boost for high consistency
    spikePenalty: 0.20,                // 20% penalty for high spike ratio
    minConsistencyScore: 40,           // Minimum consistency to be "healthy"
    maxSpikeRatio: 2.0,                // Max acceptable spike ratio
};

/**
 * Calculate time-weighted metrics for a pool
 * Returns consistency score (0-100) and spike ratio
 */
function calculateTimeWeightMetrics(poolId: string, currentMetrics: {
    binVelocity: number;
    swapVelocity: number;
    liquidityFlow: number;
    entropy: number;
}): {
    consistencyScore: number;
    spikeRatio: number;
    timeWeightMultiplier: number;
    isHealthy: boolean;
} {
    const now = Date.now();
    
    // Get or initialize history
    let history = timeWeightHistory.get(poolId);
    if (!history) {
        history = [];
        timeWeightHistory.set(poolId, history);
    }
    
    // Add current snapshot
    history.push({
        timestamp: now,
        binVelocity: currentMetrics.binVelocity,
        swapVelocity: currentMetrics.swapVelocity,
        liquidityFlow: currentMetrics.liquidityFlow,
        entropy: currentMetrics.entropy,
    });
    
    // Prune old snapshots
    const cutoff = now - TIME_WEIGHT_CONFIG.historyWindowMs;
    history = history.filter(s => s.timestamp > cutoff);
    timeWeightHistory.set(poolId, history);
    
    // Need minimum snapshots for meaningful calculation
    if (history.length < TIME_WEIGHT_CONFIG.minSnapshots) {
        return {
            consistencyScore: 50, // Neutral
            spikeRatio: 0,
            timeWeightMultiplier: 1.0,
            isHealthy: true, // Give benefit of doubt
        };
    }
    
    // Calculate averages
    const avgBinVelocity = history.reduce((s, h) => s + h.binVelocity, 0) / history.length;
    const avgSwapVelocity = history.reduce((s, h) => s + h.swapVelocity, 0) / history.length;
    const avgLiquidityFlow = history.reduce((s, h) => s + Math.abs(h.liquidityFlow), 0) / history.length;
    
    // Calculate variance (coefficient of variation)
    const binVelocityVariance = history.reduce((s, h) => s + Math.pow(h.binVelocity - avgBinVelocity, 2), 0) / history.length;
    const swapVelocityVariance = history.reduce((s, h) => s + Math.pow(h.swapVelocity - avgSwapVelocity, 2), 0) / history.length;
    
    const binVelocityCoV = avgBinVelocity > 0 ? Math.sqrt(binVelocityVariance) / avgBinVelocity : 0;
    const swapVelocityCoV = avgSwapVelocity > 0 ? Math.sqrt(swapVelocityVariance) / avgSwapVelocity : 0;
    
    // Consistency score: 100 = perfectly consistent, 0 = highly variable
    // Lower CoV = higher consistency
    const rawConsistency = 100 - (binVelocityCoV * 30 + swapVelocityCoV * 70);
    const consistencyScore = Math.max(0, Math.min(100, rawConsistency));
    
    // Calculate spike ratio (max / average - 1)
    const maxBinVelocity = Math.max(...history.map(h => h.binVelocity));
    const maxSwapVelocity = Math.max(...history.map(h => h.swapVelocity));
    
    const binSpikeRatio = avgBinVelocity > 0 ? (maxBinVelocity / avgBinVelocity) - 1 : 0;
    const swapSpikeRatio = avgSwapVelocity > 0 ? (maxSwapVelocity / avgSwapVelocity) - 1 : 0;
    
    const spikeRatio = (binSpikeRatio * 0.3 + swapSpikeRatio * 0.7);
    
    // Calculate time-weight multiplier
    // Consistency bonus: up to +15% for high consistency
    const consistencyBonus = (consistencyScore / 100) * TIME_WEIGHT_CONFIG.consistencyWeight;
    
    // Spike penalty: up to -20% for high spike ratio
    const spikePenalty = Math.min(spikeRatio / TIME_WEIGHT_CONFIG.maxSpikeRatio, 1.0) * TIME_WEIGHT_CONFIG.spikePenalty;
    
    const timeWeightMultiplier = clamp(1.0 + consistencyBonus - spikePenalty, 0.75, 1.20);
    
    // Health check
    const isHealthy = consistencyScore >= TIME_WEIGHT_CONFIG.minConsistencyScore && spikeRatio <= TIME_WEIGHT_CONFIG.maxSpikeRatio;
    
    return {
        consistencyScore,
        spikeRatio,
        timeWeightMultiplier,
        isHealthy,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TIER 4 SCORING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute complete Tier 4 score for a pool
 */
export function computeTier4Score(poolId: string): Tier4Score | null {
    const history = getPoolHistory(poolId);
    
    // Validate minimum snapshots
    if (history.length < MIN_SNAPSHOTS) {
        return {
            binVelocityScore: 0,
            swapVelocityScore: 0,
            liquidityFlowScore: 0,
            feeIntensityScore: 0,
            entropyScore: 0,
            rawBinVelocity: 0,
            rawSwapVelocity: 0,
            rawLiquidityFlow: 0,
            rawFeeIntensity: 0,
            rawEntropy: 0,
            velocitySlope: 0,
            liquiditySlope: 0,
            entropySlope: 0,
            regimeMultiplier: 1.0,
            migrationMultiplier: 1.0,
            slopeMultiplier: 1.0,
            regime: 'NEUTRAL',
            migrationDirection: 'neutral',
            baseScore: 0,
            tier4Score: 0,
            entryThreshold: REGIME_THRESHOLDS.NEUTRAL.entryThreshold,
            exitThreshold: REGIME_THRESHOLDS.NEUTRAL.exitThreshold,
            binWidth: BIN_WIDTH_CONFIG.wide,
            valid: false,
            invalidReason: `Insufficient snapshots: ${history.length} < ${MIN_SNAPSHOTS}`,
            poolId,
            timestamp: Date.now(),
        };
    }
    
    // Get latest snapshot
    const latest = history[history.length - 1];
    const previous = history[history.length - 2];
    
    // Validate liquidity
    if (latest.liquidityUSD <= 0) {
        return {
            binVelocityScore: 0,
            swapVelocityScore: 0,
            liquidityFlowScore: 0,
            feeIntensityScore: 0,
            entropyScore: 0,
            rawBinVelocity: 0,
            rawSwapVelocity: 0,
            rawLiquidityFlow: 0,
            rawFeeIntensity: 0,
            rawEntropy: 0,
            velocitySlope: 0,
            liquiditySlope: 0,
            entropySlope: 0,
            regimeMultiplier: 1.0,
            migrationMultiplier: 1.0,
            slopeMultiplier: 1.0,
            regime: 'NEUTRAL',
            migrationDirection: 'neutral',
            baseScore: 0,
            tier4Score: 0,
            entryThreshold: REGIME_THRESHOLDS.NEUTRAL.entryThreshold,
            exitThreshold: REGIME_THRESHOLDS.NEUTRAL.exitThreshold,
            binWidth: BIN_WIDTH_CONFIG.wide,
            valid: false,
            invalidReason: 'liquidityUSD <= 0',
            poolId,
            timestamp: Date.now(),
        };
    }
    
    // Get microstructure metrics
    const metrics = computeMicrostructureMetrics(poolId);
    if (!metrics) {
        return null;
    }
    
    // Get momentum slopes
    const slopes = getMomentumSlopes(poolId);
    const velocitySlope = slopes?.velocitySlope ?? 0;
    const liquiditySlope = slopes?.liquiditySlope ?? 0;
    const entropySlope = slopes?.entropySlope ?? 0;
    
    // Calculate time delta in seconds
    const timeDeltaSec = (latest.fetchedAt - previous.fetchedAt) / 1000;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CALCULATE RAW VALUES
    // ═══════════════════════════════════════════════════════════════════════════
    
    const rawBinVelocity = timeDeltaSec > 0 
        ? Math.abs(latest.activeBin - previous.activeBin) / timeDeltaSec 
        : 0;
    
    const rawSwapVelocity = latest.velocity; // Already swaps/sec from telemetry
    
    const rawLiquidityFlow = latest.liquidityUSD - previous.liquidityUSD;
    
    const rawFeeIntensity = metrics.feeIntensity / 100; // Convert from 0-100 to raw
    
    const rawEntropy = metrics.poolEntropy;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CALCULATE PILLAR SCORES (0-100)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const binVelocityScore = calcBinVelocityScore(rawBinVelocity);
    const swapVelocityScore = calcSwapVelocityScore(rawSwapVelocity);
    const liquidityFlowScore = calcLiquidityFlowScore(rawLiquidityFlow, latest.liquidityUSD);
    const feeIntensityScore = calcFeeIntensityScore(rawFeeIntensity);
    const entropyScore = calcEntropyScore(rawEntropy);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CALCULATE BASE SCORE (weighted sum)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const baseScore = (
        binVelocityScore * TIER4_WEIGHTS.binVelocity +
        swapVelocityScore * TIER4_WEIGHTS.swapVelocity +
        liquidityFlowScore * TIER4_WEIGHTS.liquidityFlow +
        feeIntensityScore * TIER4_WEIGHTS.feeIntensity +
        entropyScore * TIER4_WEIGHTS.entropy
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CLASSIFY REGIME
    // ═══════════════════════════════════════════════════════════════════════════
    
    const regime = classifyRegime(rawBinVelocity, liquiditySlope);
    const regimeMultiplier = getRegimeMultiplier(regime);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CLASSIFY MIGRATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Convert liquiditySlope to per-minute for migration classification
    const liquiditySlopePerMin = timeDeltaSec > 0 
        ? (rawLiquidityFlow / latest.liquidityUSD) * (60 / timeDeltaSec)
        : 0;
    
    const migrationDirection = classifyMigration(liquiditySlopePerMin);
    const migrationMultiplier = getMigrationMultiplier(migrationDirection, liquiditySlopePerMin);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CALCULATE SLOPE MULTIPLIER
    // ═══════════════════════════════════════════════════════════════════════════
    
    const slopeMultiplier = calcSlopeMultiplier(velocitySlope, liquiditySlope, entropySlope);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CALCULATE FINAL TIER 4 SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    
    const tier4Score = baseScore * migrationMultiplier * regimeMultiplier * slopeMultiplier;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GET DYNAMIC THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    const thresholds = getRegimeThresholds(regime);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GET BIN WIDTH
    // ═══════════════════════════════════════════════════════════════════════════
    
    const binWidth = getBinWidthConfig(tier4Score);
    
    return {
        binVelocityScore,
        swapVelocityScore,
        liquidityFlowScore,
        feeIntensityScore,
        entropyScore,
        rawBinVelocity,
        rawSwapVelocity,
        rawLiquidityFlow,
        rawFeeIntensity,
        rawEntropy,
        velocitySlope,
        liquiditySlope,
        entropySlope,
        regimeMultiplier,
        migrationMultiplier,
        slopeMultiplier,
        regime,
        migrationDirection,
        baseScore,
        tier4Score,
        entryThreshold: thresholds.entryThreshold,
        exitThreshold: thresholds.exitThreshold,
        binWidth,
        valid: true,
        poolId,
        timestamp: Date.now(),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POOL ENRICHMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Enrich pool with Tier 4 scoring data
 */
export function enrichPoolWithTier4(pool: Pool): Tier4EnrichedPool {
    const tier4 = computeTier4Score(pool.address);
    const microMetrics = computeMicrostructureMetrics(pool.address);
    
    const hasValidTelemetry = tier4?.valid ?? false;
    
    // Calculate time-weight metrics
    const timeWeightMetrics = calculateTimeWeightMetrics(pool.address, {
        binVelocity: tier4?.rawBinVelocity ?? 0,
        swapVelocity: tier4?.rawSwapVelocity ?? 0,
        liquidityFlow: tier4?.rawLiquidityFlow ?? 0,
        entropy: tier4?.rawEntropy ?? 0,
    });
    
    // Apply time-weight multiplier to tier4 score
    const baseScore = tier4?.tier4Score ?? 0;
    const timeWeightedScore = baseScore * timeWeightMetrics.timeWeightMultiplier;
    
    const isMarketAlive = hasValidTelemetry && 
        timeWeightedScore >= (tier4?.entryThreshold ?? 32) && 
        timeWeightMetrics.isHealthy;
    
    const enriched: Tier4EnrichedPool = {
        ...pool,
        tier4,
        microMetrics,  // For backwards compatibility
        hasValidTelemetry,
        isMarketAlive,
        tier4Score: timeWeightedScore,  // Now time-weighted
        microScore: timeWeightedScore,  // Alias for backwards compatibility
        regime: tier4?.regime ?? 'NEUTRAL',
        migrationDirection: tier4?.migrationDirection ?? 'neutral',
        entryThreshold: tier4?.entryThreshold ?? 32,
        exitThreshold: tier4?.exitThreshold ?? 22,
        binWidth: tier4?.binWidth ?? BIN_WIDTH_CONFIG.wide,
        velocitySlope: tier4?.velocitySlope ?? 0,
        liquiditySlope: tier4?.liquiditySlope ?? 0,
        entropySlope: tier4?.entropySlope ?? 0,
        
        // Time-weighted scoring
        consistencyScore: timeWeightMetrics.consistencyScore,
        spikeRatio: timeWeightMetrics.spikeRatio,
        timeWeightMultiplier: timeWeightMetrics.timeWeightMultiplier,
        isTimeWeightHealthy: timeWeightMetrics.isHealthy,
    };
    
    // Update pool score with time-weighted Tier 4 score
    enriched.score = enriched.tier4Score;
    
    return enriched;
}

/**
 * Batch score multiple pools with Tier 4
 */
export function batchScorePools(pools: Pool[]): Tier4EnrichedPool[] {
    const enriched: Tier4EnrichedPool[] = [];
    let validCount = 0;
    let invalidCount = 0;
    
    for (const pool of pools) {
        const enrichedPool = enrichPoolWithTier4(pool);
        enriched.push(enrichedPool);
        
        if (enrichedPool.hasValidTelemetry) {
            validCount++;
        } else {
            invalidCount++;
        }
    }
    
    // Sort by tier4Score descending
    enriched.sort((a, b) => b.tier4Score - a.tier4Score);
    
    logger.info(`[TIER4-SCORING] Processed ${pools.length} pools: ${validCount} valid, ${invalidCount} gated`);
    
    return enriched;
}

/**
 * Filter pools to only those with valid telemetry
 */
export function filterValidPools(pools: Tier4EnrichedPool[]): Tier4EnrichedPool[] {
    return pools.filter(p => p.hasValidTelemetry);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate if a pool can be entered based on Tier 4 rules
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * BLOCKING CONDITIONS (ALL must pass):
 * - MHI >= 0.55
 * - swapVelocity >= 0.15
 * - poolEntropy >= 0.45
 * - velocitySlope > 0
 * - liquiditySlope > 0
 * 
 * EXCEPTION OVERRIDE (bypasses blocks if ALL are true):
 * - score > 62
 * - feeIntensity > 1.5
 * - entropySlope > 0.00015
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function evaluateTier4Entry(pool: Pool): Tier4EntryEvaluation {
    const tier4 = computeTier4Score(pool.address);
    
    if (!tier4 || !tier4.valid) {
        logger.info(`[ENTRY-BLOCK] reason: NO_DATA pool=${pool.address.slice(0, 8)}...`);
        return {
            canEnter: false,
            blocked: true,
            blockReason: tier4?.invalidReason ?? 'No valid Tier 4 data',
            score: 0,
            regime: 'NEUTRAL',
            migrationDirection: 'neutral',
            entryThreshold: ENTRY_TIER_THRESHOLDS.TIER4,
            meetsThreshold: false,
        };
    }
    
    // Get microstructure metrics for blocking checks
    const metrics = computeMicrostructureMetrics(pool.address);
    const mhiResult = computeMHI(pool.address);
    const slopes = getMomentumSlopes(pool.address);
    
    const score = tier4.tier4Score;
    const mhi = mhiResult?.mhi ?? 0;
    const swapVelocity = metrics?.swapVelocity ? metrics.swapVelocity / 100 : 0; // Normalize from 0-100 to 0-1
    const poolEntropy = metrics?.poolEntropy ?? 0;
    const velocitySlope = slopes?.velocitySlope ?? 0;
    const liquiditySlope = slopes?.liquiditySlope ?? 0;
    const entropySlope = slopes?.entropySlope ?? 0;
    const feeIntensity = metrics?.feeIntensity ? metrics.feeIntensity / 100 : 0; // Normalize from 0-100 to 0-1
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK EXCEPTION OVERRIDE FIRST
    // If score > 62 AND feeIntensity > 1.5 AND entropySlope > 0.00015 → ALLOW
    // ═══════════════════════════════════════════════════════════════════════════
    const exceptionOverride = 
        score > ENTRY_EXCEPTION_THRESHOLDS.minScore &&
        feeIntensity > ENTRY_EXCEPTION_THRESHOLDS.minFeeIntensity &&
        entropySlope > ENTRY_EXCEPTION_THRESHOLDS.minEntropySlope;
    
    if (exceptionOverride) {
        logger.info(`[ENTRY-EXCEPTION] OVERRIDE ALLOWED pool=${pool.address.slice(0, 8)}... ` +
            `score=${score.toFixed(1)} feeIntensity=${feeIntensity.toFixed(2)} entropySlope=${entropySlope.toFixed(6)}`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCKING CONDITIONS (skip if exception override is active)
    // ═══════════════════════════════════════════════════════════════════════════
    if (!exceptionOverride) {
        // Check MHI
        if (mhi < ENTRY_BLOCKING_THRESHOLDS.minMHI) {
            logger.info(`[ENTRY-BLOCK] reason: MHI_LOW pool=${pool.address.slice(0, 8)}... ` +
                `mhi=${mhi.toFixed(3)} < ${ENTRY_BLOCKING_THRESHOLDS.minMHI}`);
            return {
                canEnter: false,
                blocked: true,
                blockReason: `MHI_LOW: ${mhi.toFixed(3)} < ${ENTRY_BLOCKING_THRESHOLDS.minMHI}`,
                score,
                regime: tier4.regime,
                migrationDirection: tier4.migrationDirection,
                entryThreshold: tier4.entryThreshold,
                meetsThreshold: false,
            };
        }
        
        // Check swap velocity
        if (swapVelocity < ENTRY_BLOCKING_THRESHOLDS.minSwapVelocity) {
            logger.info(`[ENTRY-BLOCK] reason: SWAP_VELOCITY_LOW pool=${pool.address.slice(0, 8)}... ` +
                `swapVelocity=${swapVelocity.toFixed(4)} < ${ENTRY_BLOCKING_THRESHOLDS.minSwapVelocity}`);
            return {
                canEnter: false,
                blocked: true,
                blockReason: `SWAP_VELOCITY_LOW: ${swapVelocity.toFixed(4)} < ${ENTRY_BLOCKING_THRESHOLDS.minSwapVelocity}`,
                score,
                regime: tier4.regime,
                migrationDirection: tier4.migrationDirection,
                entryThreshold: tier4.entryThreshold,
                meetsThreshold: false,
            };
        }
        
        // Check pool entropy
        if (poolEntropy < ENTRY_BLOCKING_THRESHOLDS.minPoolEntropy) {
            logger.info(`[ENTRY-BLOCK] reason: ENTROPY_LOW pool=${pool.address.slice(0, 8)}... ` +
                `poolEntropy=${poolEntropy.toFixed(4)} < ${ENTRY_BLOCKING_THRESHOLDS.minPoolEntropy}`);
            return {
                canEnter: false,
                blocked: true,
                blockReason: `ENTROPY_LOW: ${poolEntropy.toFixed(4)} < ${ENTRY_BLOCKING_THRESHOLDS.minPoolEntropy}`,
                score,
                regime: tier4.regime,
                migrationDirection: tier4.migrationDirection,
                entryThreshold: tier4.entryThreshold,
                meetsThreshold: false,
            };
        }
        
        // Check velocity slope (must be > 0)
        if (velocitySlope <= ENTRY_BLOCKING_THRESHOLDS.minVelocitySlope) {
            logger.info(`[ENTRY-BLOCK] reason: VELOCITY_NEG pool=${pool.address.slice(0, 8)}... ` +
                `velocitySlope=${velocitySlope.toFixed(6)} <= 0`);
            return {
                canEnter: false,
                blocked: true,
                blockReason: `VELOCITY_NEG: velocitySlope=${velocitySlope.toFixed(6)} <= 0`,
                score,
                regime: tier4.regime,
                migrationDirection: tier4.migrationDirection,
                entryThreshold: tier4.entryThreshold,
                meetsThreshold: false,
            };
        }
        
        // Check liquidity slope (must be > 0)
        if (liquiditySlope <= ENTRY_BLOCKING_THRESHOLDS.minLiquiditySlope) {
            logger.info(`[ENTRY-BLOCK] reason: LIQUIDITY_NEG pool=${pool.address.slice(0, 8)}... ` +
                `liquiditySlope=${liquiditySlope.toFixed(6)} <= 0`);
            return {
                canEnter: false,
                blocked: true,
                blockReason: `LIQUIDITY_NEG: liquiditySlope=${liquiditySlope.toFixed(6)} <= 0`,
                score,
                regime: tier4.regime,
                migrationDirection: tier4.migrationDirection,
                entryThreshold: tier4.entryThreshold,
                meetsThreshold: false,
            };
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MIGRATION BLOCK CHECK
    // ═══════════════════════════════════════════════════════════════════════════
    const history = getPoolHistory(pool.address);
    if (history.length >= 2) {
        const latest = history[history.length - 1];
        const previous = history[history.length - 2];
        const timeDeltaSec = (latest.fetchedAt - previous.fetchedAt) / 1000;
        const liquiditySlopePerMin = timeDeltaSec > 0 
            ? ((latest.liquidityUSD - previous.liquidityUSD) / latest.liquidityUSD) * (60 / timeDeltaSec)
            : 0;
        
        const migrationBlock = checkMigrationBlock(tier4.migrationDirection, liquiditySlopePerMin);
        
        if (migrationBlock.blocked && !exceptionOverride) {
            logger.info(`[ENTRY-BLOCK] reason: MIGRATION_BLOCK pool=${pool.address.slice(0, 8)}... ` +
                `${migrationBlock.reason}`);
            return {
                canEnter: false,
                blocked: true,
                blockReason: migrationBlock.reason,
                score,
                regime: tier4.regime,
                migrationDirection: tier4.migrationDirection,
                entryThreshold: tier4.entryThreshold,
                meetsThreshold: score >= tier4.entryThreshold,
            };
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER-BASED SCORE THRESHOLD CHECK
    // Use the appropriate tier threshold based on regime
    // RELAXED: Using lower thresholds to avoid "no candidates" issues
    // ═══════════════════════════════════════════════════════════════════════════
    let entryThreshold: number;
    switch (tier4.regime) {
        case 'BULL':
            entryThreshold = ENTRY_TIER_THRESHOLDS.TIER4; // 28 - most aggressive in bull
            break;
        case 'BEAR':
            entryThreshold = ENTRY_TIER_THRESHOLDS.TIER3; // 38 - more conservative in bear
            break;
        case 'NEUTRAL':
        default:
            entryThreshold = ENTRY_TIER_THRESHOLDS.TIER1; // 32 - default balanced entry
            break;
    }
    
    const meetsThreshold = score >= entryThreshold || exceptionOverride;
    
    if (!meetsThreshold) {
        logger.info(`[ENTRY-BLOCK] reason: SCORE_LOW pool=${pool.address.slice(0, 8)}... ` +
            `score=${score.toFixed(1)} < threshold=${entryThreshold} (${tier4.regime})`);
    }
    
    return {
        canEnter: meetsThreshold,
        blocked: !meetsThreshold,
        blockReason: meetsThreshold ? undefined : `SCORE_LOW: ${score.toFixed(1)} < ${entryThreshold}`,
        score,
        regime: tier4.regime,
        migrationDirection: tier4.migrationDirection,
        entryThreshold,
        meetsThreshold,
    };
}

/**
 * Get Tier 4 gating status for a pool
 */
export function getEntryGatingStatus(pool: Pool): EntryGatingStatus {
    const history = getPoolHistory(pool.address);
    const tier4 = computeTier4Score(pool.address);
    const latestLiquidity = history.length > 0 ? history[history.length - 1].liquidityUSD : 0;
    
    const snapshotPasses = history.length >= MIN_SNAPSHOTS;
    const liquidityPasses = latestLiquidity > 0;
    const tier4Passes = tier4?.valid && tier4.tier4Score >= tier4.entryThreshold;
    
    // Check migration
    let migrationBlocked = false;
    let migrationBlockReason: string | undefined;
    
    if (tier4?.valid && history.length >= 2) {
        const latest = history[history.length - 1];
        const previous = history[history.length - 2];
        const timeDeltaSec = (latest.fetchedAt - previous.fetchedAt) / 1000;
        const liquiditySlopePerMin = timeDeltaSec > 0 
            ? ((latest.liquidityUSD - previous.liquidityUSD) / latest.liquidityUSD) * (60 / timeDeltaSec)
            : 0;
        
        const block = checkMigrationBlock(tier4.migrationDirection, liquiditySlopePerMin);
        migrationBlocked = block.blocked;
        migrationBlockReason = block.reason;
    }
    
    return {
        tier4Score: { 
            value: tier4?.tier4Score ?? 0, 
            required: tier4?.entryThreshold ?? 32, 
            passes: tier4Passes ?? false
        },
        regime: { 
            value: tier4?.regime ?? 'NEUTRAL', 
            multiplier: tier4?.regimeMultiplier ?? 1.0 
        },
        migration: { 
            direction: tier4?.migrationDirection ?? 'neutral', 
            blocked: migrationBlocked,
            reason: migrationBlockReason
        },
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
        allPass: snapshotPasses && liquidityPasses && (tier4Passes ?? false) && !migrationBlocked,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log Tier 4 cycle metrics
 */
export function logTier4Cycle(poolId: string): void {
    const tier4 = computeTier4Score(poolId);
    
    if (!tier4 || !tier4.valid) {
        logger.warn(`[TIER4] pool=${poolId.slice(0, 8)}... INVALID: ${tier4?.invalidReason ?? 'No data'}`);
        return;
    }
    
    logger.info(`[REGIME] ${tier4.regime} (multiplier=${tier4.regimeMultiplier.toFixed(2)})`);
    logger.info(`[MIGRATION] direction=${tier4.migrationDirection} slopeL=${tier4.liquiditySlope.toFixed(6)}`);
    logger.info(`[TIER4 SCORE] ${tier4.tier4Score.toFixed(2)} (base=${tier4.baseScore.toFixed(2)} × regime=${tier4.regimeMultiplier.toFixed(2)} × migration=${tier4.migrationMultiplier.toFixed(2)} × slope=${tier4.slopeMultiplier.toFixed(2)})`);
    logger.info(`[THRESHOLDS] entry=${tier4.entryThreshold} exit=${tier4.exitThreshold}`);
    logger.info(`[BIN WIDTH] ${tier4.binWidth.label} (${tier4.binWidth.min}-${tier4.binWidth.max})`);
}

/**
 * Log entry block reason
 */
export function logEntryBlock(poolId: string, reason: string): void {
    logger.info(`[ENTRY BLOCK] pool=${poolId.slice(0, 8)}... reason="${reason}"`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Legacy scoring function (returns Tier 4 score)
 */
export function scoreMicrostructure(pool: Pool): number {
    const tier4 = computeTier4Score(pool.address);
    return tier4?.tier4Score ?? 0;
}

/**
 * Legacy passesEntryGating
 */
export function passesEntryGating(pool: Pool): { passes: boolean; reasons: string[] } {
    const status = getEntryGatingStatus(pool);
    const reasons: string[] = [];
    
    if (!status.snapshotCount.passes) {
        reasons.push(`Insufficient snapshots: ${status.snapshotCount.value} < ${status.snapshotCount.required}`);
    }
    if (!status.liquidityUSD.passes) {
        reasons.push('liquidityUSD <= 0');
    }
    if (!status.tier4Score.passes) {
        reasons.push(`Tier4 score ${status.tier4Score.value.toFixed(1)} < threshold ${status.tier4Score.required}`);
    }
    if (status.migration.blocked) {
        reasons.push(`Migration blocked: ${status.migration.reason}`);
    }
    
    return {
        passes: status.allPass,
        reasons,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    REGIME_MULTIPLIERS,
    REGIME_THRESHOLDS,
    MIGRATION_THRESHOLDS,
    BIN_WIDTH_CONFIG,
    MIN_SNAPSHOTS,
};

// Legacy export aliases
export { TIER4_WEIGHTS as SCORING_WEIGHTS };
export { REGIME_THRESHOLDS as GATING_THRESHOLDS };
