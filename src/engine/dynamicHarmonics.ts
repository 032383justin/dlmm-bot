/**
 * Dynamic Stop Harmonics - Tier 4 Predator Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE SYSTEM MUST LEARN FROM VOLATILITY CLUSTERS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module computes rolling stddev of:
 * - entropy
 * - swapVelocity
 * - liquidityFlow
 * 
 * When stddev spikes → widen tolerance bands
 * When stddev collapses → tighten bands
 * 
 * This turns the bot into a VOLATILITY-SENSITIVE animal.
 * 
 * STRUCTURAL EXIT STRATEGY:
 * Never exit on price.
 * Exit only on structural decay.
 * 
 * For each position:
 * - Track decay rate of entropy and liquidity simultaneously
 * - When slopeE < 0 AND slopeL < 0 for ≥ 3 consecutive snapshots → FULL EXIT
 * 
 * No "profit target"
 * No "trailing stops"
 * You are trading MICROSTRUCTURE, not chart shapes.
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
import { RiskTier } from './riskBucketEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Volatility state for a pool
 */
export interface VolatilityState {
    poolId: string;
    
    // Rolling standard deviations
    entropyStdDev: number;
    swapVelocityStdDev: number;
    liquidityFlowStdDev: number;
    
    // Combined volatility score (0-1)
    combinedVolatility: number;
    volatilityLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL';
    
    // Band adjustments
    bandMultiplier: number;          // 0.5 - 2.0 (tighter to wider)
    
    // Historical data
    entropyHistory: number[];
    swapVelocityHistory: number[];
    liquidityFlowHistory: number[];
    
    timestamp: number;
}

/**
 * Structural decay tracking for a position
 */
export interface StructuralDecayState {
    tradeId: string;
    poolId: string;
    
    // Consecutive negative slope counts
    consecutiveNegativeEntropySlopes: number;
    consecutiveNegativeLiquiditySlopes: number;
    
    // Slope history
    entropySlopes: number[];
    liquiditySlopes: number[];
    
    // Current state
    isDecaying: boolean;
    decayStartTime: number | null;
    decaySeverity: 'NONE' | 'MILD' | 'MODERATE' | 'SEVERE';
    
    // Exit signal
    shouldExit: boolean;
    exitReason: string | null;
    
    timestamp: number;
}

/**
 * Dynamic harmonic thresholds (adjusted by volatility)
 */
export interface DynamicHarmonicThresholds {
    poolId: string;
    tier: RiskTier;
    
    // Base thresholds (from harmonics.ts)
    baseVelocityDropFactor: number;
    baseEntropyDropFactor: number;
    baseLiquidityOutflowPct: number;
    baseMinHealthScore: number;
    
    // Adjusted thresholds (by volatility)
    adjustedVelocityDropFactor: number;
    adjustedEntropyDropFactor: number;
    adjustedLiquidityOutflowPct: number;
    adjustedMinHealthScore: number;
    
    // Adjustment applied
    bandMultiplier: number;
    volatilityLevel: string;
    
    timestamp: number;
}

/**
 * Structural exit evaluation result
 */
export interface StructuralExitEvaluation {
    shouldExit: boolean;
    reason: string;
    
    // Current slopes
    entropySlope: number;
    liquiditySlope: number;
    
    // Consecutive negative counts
    consecutiveNegativeEntropy: number;
    consecutiveNegativeLiquidity: number;
    
    // Volatility state
    volatilityLevel: string;
    bandMultiplier: number;
    
    // Decay state
    decaySeverity: string;
    decayDurationMs: number;
    
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dynamic harmonics configuration
 */
export const DYNAMIC_HARMONICS_CONFIG = {
    // History length for volatility calculation
    volatilityWindow: 15,           // Last 15 snapshots
    minHistoryForVolatility: 5,     // Need at least 5 snapshots
    
    // Volatility level thresholds (stddev)
    volatilityLevels: {
        high: 0.15,                  // > 15% stddev
        medium: 0.08,                // > 8% stddev
        low: 0.03,                   // > 3% stddev
        minimal: 0,                  // < 3% stddev
    },
    
    // Band multipliers by volatility
    bandMultipliers: {
        HIGH: 1.5,                   // Widen bands by 50%
        MEDIUM: 1.2,                 // Widen bands by 20%
        LOW: 1.0,                    // Normal bands
        MINIMAL: 0.8,                // Tighten bands by 20%
    },
    
    // Structural decay exit thresholds
    structuralDecay: {
        consecutiveSlopesForExit: 3,  // Exit after 3 consecutive negative slopes
        mildDecayThreshold: 1,        // 1 consecutive
        moderateDecayThreshold: 2,    // 2 consecutive
        severeDecayThreshold: 3,      // 3 consecutive (exit)
    },
    
    // Weight for combined volatility score
    volatilityWeights: {
        entropy: 0.40,
        swapVelocity: 0.35,
        liquidityFlow: 0.25,
    },
    
    // Minimum band multiplier (can't tighten more than this)
    minBandMultiplier: 0.5,
    
    // Maximum band multiplier (can't widen more than this)
    maxBandMultiplier: 2.0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Volatility states per pool
const volatilityStates: Map<string, VolatilityState> = new Map();

// Structural decay states per trade
const decayStates: Map<string, StructuralDecayState> = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate standard deviation of an array
 */
function calculateStdDev(values: number[]): number {
    if (values.length < 2) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    
    return Math.sqrt(variance);
}

/**
 * Classify volatility level from stddev
 */
function classifyVolatilityLevel(stddev: number): 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL' {
    const levels = DYNAMIC_HARMONICS_CONFIG.volatilityLevels;
    
    if (stddev >= levels.high) return 'HIGH';
    if (stddev >= levels.medium) return 'MEDIUM';
    if (stddev >= levels.low) return 'LOW';
    return 'MINIMAL';
}

/**
 * Get band multiplier from volatility level
 */
function getBandMultiplier(level: 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL'): number {
    return DYNAMIC_HARMONICS_CONFIG.bandMultipliers[level];
}

/**
 * Clamp band multiplier to valid range
 */
function clampBandMultiplier(multiplier: number): number {
    return Math.max(
        DYNAMIC_HARMONICS_CONFIG.minBandMultiplier,
        Math.min(DYNAMIC_HARMONICS_CONFIG.maxBandMultiplier, multiplier)
    );
}

/**
 * Classify decay severity
 */
function classifyDecaySeverity(consecutiveCount: number): 'NONE' | 'MILD' | 'MODERATE' | 'SEVERE' {
    const thresholds = DYNAMIC_HARMONICS_CONFIG.structuralDecay;
    
    if (consecutiveCount >= thresholds.severeDecayThreshold) return 'SEVERE';
    if (consecutiveCount >= thresholds.moderateDecayThreshold) return 'MODERATE';
    if (consecutiveCount >= thresholds.mildDecayThreshold) return 'MILD';
    return 'NONE';
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOLATILITY TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update volatility state for a pool.
 * Call this on each telemetry refresh.
 */
export function updateVolatilityState(poolId: string): VolatilityState | null {
    const metrics = computeMicrostructureMetrics(poolId);
    const history = getPoolHistory(poolId);
    
    if (!metrics || history.length < DYNAMIC_HARMONICS_CONFIG.minHistoryForVolatility) {
        return null;
    }
    
    // Get or create state
    let state = volatilityStates.get(poolId);
    if (!state) {
        state = {
            poolId,
            entropyStdDev: 0,
            swapVelocityStdDev: 0,
            liquidityFlowStdDev: 0,
            combinedVolatility: 0,
            volatilityLevel: 'LOW',
            bandMultiplier: 1.0,
            entropyHistory: [],
            swapVelocityHistory: [],
            liquidityFlowHistory: [],
            timestamp: Date.now(),
        };
        volatilityStates.set(poolId, state);
    }
    
    // Extract current values
    const currentEntropy = metrics.poolEntropy;
    const currentSwapVelocity = metrics.swapVelocity / 100;
    
    // Calculate liquidity flow
    let currentLiquidityFlow = 0;
    if (history.length >= 2) {
        const latest = history[history.length - 1];
        const previous = history[history.length - 2];
        currentLiquidityFlow = previous.liquidityUSD > 0
            ? (latest.liquidityUSD - previous.liquidityUSD) / previous.liquidityUSD
            : 0;
    }
    
    // Update histories
    state.entropyHistory.push(currentEntropy);
    state.swapVelocityHistory.push(currentSwapVelocity);
    state.liquidityFlowHistory.push(currentLiquidityFlow);
    
    // Trim to window size
    const windowSize = DYNAMIC_HARMONICS_CONFIG.volatilityWindow;
    while (state.entropyHistory.length > windowSize) state.entropyHistory.shift();
    while (state.swapVelocityHistory.length > windowSize) state.swapVelocityHistory.shift();
    while (state.liquidityFlowHistory.length > windowSize) state.liquidityFlowHistory.shift();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CALCULATE ROLLING STDDEV
    // ═══════════════════════════════════════════════════════════════════════════
    
    state.entropyStdDev = calculateStdDev(state.entropyHistory);
    state.swapVelocityStdDev = calculateStdDev(state.swapVelocityHistory);
    state.liquidityFlowStdDev = calculateStdDev(state.liquidityFlowHistory);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CALCULATE COMBINED VOLATILITY SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    
    const weights = DYNAMIC_HARMONICS_CONFIG.volatilityWeights;
    state.combinedVolatility = 
        (state.entropyStdDev * weights.entropy) +
        (state.swapVelocityStdDev * weights.swapVelocity) +
        (state.liquidityFlowStdDev * weights.liquidityFlow);
    
    // Classify volatility level
    state.volatilityLevel = classifyVolatilityLevel(state.combinedVolatility);
    
    // Get band multiplier
    state.bandMultiplier = clampBandMultiplier(getBandMultiplier(state.volatilityLevel));
    
    state.timestamp = Date.now();
    
    return state;
}

/**
 * Get volatility-adjusted band multiplier for a pool.
 */
export function getVolatilityBandMultiplier(poolId: string): number {
    const state = volatilityStates.get(poolId);
    return state?.bandMultiplier ?? 1.0;
}

/**
 * Get current volatility level for a pool.
 */
export function getVolatilityLevel(poolId: string): 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL' {
    const state = volatilityStates.get(poolId);
    return state?.volatilityLevel ?? 'LOW';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMIC THRESHOLD ADJUSTMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get dynamically adjusted harmonic thresholds for a pool.
 * Widens or tightens based on current volatility.
 */
export function getDynamicHarmonicThresholds(
    poolId: string,
    tier: RiskTier,
    baseThresholds: {
        velocityDropFactor: number;
        entropyDropFactor: number;
        liquidityOutflowPct: number;
        minHealthScore: number;
    }
): DynamicHarmonicThresholds {
    const volatilityState = updateVolatilityState(poolId);
    const bandMultiplier = volatilityState?.bandMultiplier ?? 1.0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ADJUST THRESHOLDS BY VOLATILITY
    // Higher volatility = wider bands (more tolerant)
    // Lower volatility = tighter bands (less tolerant)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // For drop factors, lower value = more tolerant
    // So we DIVIDE by band multiplier (higher vol = lower threshold = more tolerant)
    const adjustedVelocityDropFactor = baseThresholds.velocityDropFactor / bandMultiplier;
    const adjustedEntropyDropFactor = baseThresholds.entropyDropFactor / bandMultiplier;
    
    // For outflow, more negative = more tolerant
    // So we MULTIPLY by band multiplier
    const adjustedLiquidityOutflowPct = baseThresholds.liquidityOutflowPct * bandMultiplier;
    
    // For min health score, lower = more tolerant
    // So we DIVIDE by band multiplier
    const adjustedMinHealthScore = baseThresholds.minHealthScore / bandMultiplier;
    
    return {
        poolId,
        tier,
        baseVelocityDropFactor: baseThresholds.velocityDropFactor,
        baseEntropyDropFactor: baseThresholds.entropyDropFactor,
        baseLiquidityOutflowPct: baseThresholds.liquidityOutflowPct,
        baseMinHealthScore: baseThresholds.minHealthScore,
        adjustedVelocityDropFactor,
        adjustedEntropyDropFactor,
        adjustedLiquidityOutflowPct,
        adjustedMinHealthScore,
        bandMultiplier,
        volatilityLevel: volatilityState?.volatilityLevel ?? 'LOW',
        timestamp: Date.now(),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRUCTURAL DECAY TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register a trade for structural decay tracking.
 * Call when a position is opened.
 */
export function registerDecayTracking(tradeId: string, poolId: string): void {
    decayStates.set(tradeId, {
        tradeId,
        poolId,
        consecutiveNegativeEntropySlopes: 0,
        consecutiveNegativeLiquiditySlopes: 0,
        entropySlopes: [],
        liquiditySlopes: [],
        isDecaying: false,
        decayStartTime: null,
        decaySeverity: 'NONE',
        shouldExit: false,
        exitReason: null,
        timestamp: Date.now(),
    });
    
    logger.debug(`[DECAY] Registered decay tracking for trade ${tradeId.slice(0, 8)}...`);
}

/**
 * Unregister a trade from structural decay tracking.
 * Call when a position is closed.
 */
export function unregisterDecayTracking(tradeId: string): void {
    decayStates.delete(tradeId);
}

/**
 * Update structural decay state for a trade.
 * Call on each telemetry refresh.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * STRUCTURAL EXIT RULE:
 * When slopeE < 0 AND slopeL < 0 for ≥ 3 consecutive snapshots → FULL EXIT
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function updateDecayState(tradeId: string): StructuralDecayState | null {
    const state = decayStates.get(tradeId);
    if (!state) return null;
    
    const slopes = getMomentumSlopes(state.poolId);
    if (!slopes || !slopes.valid) return state;
    
    const now = Date.now();
    const entropySlope = slopes.entropySlope;
    const liquiditySlope = slopes.liquiditySlope;
    
    // Add to history
    state.entropySlopes.push(entropySlope);
    state.liquiditySlopes.push(liquiditySlope);
    
    // Trim history
    const maxHistory = 20;
    while (state.entropySlopes.length > maxHistory) state.entropySlopes.shift();
    while (state.liquiditySlopes.length > maxHistory) state.liquiditySlopes.shift();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK FOR STRUCTURAL DECAY (both slopes negative)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const bothSlopesNegative = entropySlope < 0 && liquiditySlope < 0;
    
    if (bothSlopesNegative) {
        // Increment consecutive counters
        state.consecutiveNegativeEntropySlopes++;
        state.consecutiveNegativeLiquiditySlopes++;
        
        // Mark decay start time
        if (!state.isDecaying) {
            state.isDecaying = true;
            state.decayStartTime = now;
        }
    } else {
        // Reset consecutive counters
        if (entropySlope >= 0) {
            state.consecutiveNegativeEntropySlopes = 0;
        } else {
            state.consecutiveNegativeEntropySlopes++;
        }
        
        if (liquiditySlope >= 0) {
            state.consecutiveNegativeLiquiditySlopes = 0;
        } else {
            state.consecutiveNegativeLiquiditySlopes++;
        }
        
        // If neither is consecutive, reset decay
        if (entropySlope >= 0 && liquiditySlope >= 0) {
            state.isDecaying = false;
            state.decayStartTime = null;
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DETERMINE DECAY SEVERITY AND EXIT SIGNAL
    // ═══════════════════════════════════════════════════════════════════════════
    
    const minConsecutive = Math.min(
        state.consecutiveNegativeEntropySlopes,
        state.consecutiveNegativeLiquiditySlopes
    );
    
    state.decaySeverity = classifyDecaySeverity(minConsecutive);
    
    // Check for exit condition: both slopes negative for 3+ consecutive
    if (state.consecutiveNegativeEntropySlopes >= DYNAMIC_HARMONICS_CONFIG.structuralDecay.consecutiveSlopesForExit &&
        state.consecutiveNegativeLiquiditySlopes >= DYNAMIC_HARMONICS_CONFIG.structuralDecay.consecutiveSlopesForExit) {
        state.shouldExit = true;
        state.exitReason = `Structural decay: entropy slope (${entropySlope.toFixed(6)}) AND ` +
                          `liquidity slope (${liquiditySlope.toFixed(6)}) negative for ` +
                          `${minConsecutive} consecutive snapshots`;
    } else {
        state.shouldExit = false;
        state.exitReason = null;
    }
    
    state.timestamp = now;
    
    return state;
}

/**
 * Evaluate structural exit conditions for a trade.
 * Returns whether to exit based on structural decay.
 */
export function evaluateStructuralExit(tradeId: string): StructuralExitEvaluation {
    const state = decayStates.get(tradeId);
    const now = Date.now();
    
    if (!state) {
        return {
            shouldExit: false,
            reason: 'Trade not tracked',
            entropySlope: 0,
            liquiditySlope: 0,
            consecutiveNegativeEntropy: 0,
            consecutiveNegativeLiquidity: 0,
            volatilityLevel: 'LOW',
            bandMultiplier: 1.0,
            decaySeverity: 'NONE',
            decayDurationMs: 0,
            timestamp: now,
        };
    }
    
    // Update state
    updateDecayState(tradeId);
    
    // Get volatility state
    const volatilityState = volatilityStates.get(state.poolId);
    
    // Get current slopes
    const slopes = getMomentumSlopes(state.poolId);
    
    // Calculate decay duration
    const decayDurationMs = state.decayStartTime ? now - state.decayStartTime : 0;
    
    return {
        shouldExit: state.shouldExit,
        reason: state.exitReason || '',
        entropySlope: slopes?.entropySlope ?? 0,
        liquiditySlope: slopes?.liquiditySlope ?? 0,
        consecutiveNegativeEntropy: state.consecutiveNegativeEntropySlopes,
        consecutiveNegativeLiquidity: state.consecutiveNegativeLiquiditySlopes,
        volatilityLevel: volatilityState?.volatilityLevel ?? 'LOW',
        bandMultiplier: volatilityState?.bandMultiplier ?? 1.0,
        decaySeverity: state.decaySeverity,
        decayDurationMs,
        timestamp: now,
    };
}

/**
 * Get all trades that should exit due to structural decay.
 */
export function getStructuralExitSignals(): Array<{ tradeId: string; poolId: string; reason: string }> {
    const exitSignals: Array<{ tradeId: string; poolId: string; reason: string }> = [];
    
    for (const [tradeId, state] of decayStates) {
        updateDecayState(tradeId);
        
        if (state.shouldExit && state.exitReason) {
            exitSignals.push({
                tradeId,
                poolId: state.poolId,
                reason: state.exitReason,
            });
        }
    }
    
    return exitSignals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log volatility state for a pool
 */
export function logVolatilityState(poolId: string): void {
    const state = volatilityStates.get(poolId);
    if (!state) {
        logger.debug(`[VOLATILITY] Pool ${poolId.slice(0, 8)}... not tracked`);
        return;
    }
    
    const levelEmoji = {
        HIGH: '🌋',
        MEDIUM: '⚡',
        LOW: '🌊',
        MINIMAL: '🧊',
    }[state.volatilityLevel];
    
    logger.info(
        `[VOLATILITY] ${poolId.slice(0, 8)}... | ` +
        `${levelEmoji} ${state.volatilityLevel} | ` +
        `combined=${(state.combinedVolatility * 100).toFixed(2)}% | ` +
        `entropy=${(state.entropyStdDev * 100).toFixed(2)}% ` +
        `swap=${(state.swapVelocityStdDev * 100).toFixed(2)}% ` +
        `liq=${(state.liquidityFlowStdDev * 100).toFixed(2)}% | ` +
        `band=${state.bandMultiplier.toFixed(2)}x`
    );
}

/**
 * Log structural decay state for a trade
 */
export function logDecayState(tradeId: string): void {
    const state = decayStates.get(tradeId);
    if (!state) return;
    
    const severityEmoji = {
        NONE: '✅',
        MILD: '🟡',
        MODERATE: '🟠',
        SEVERE: '🔴',
    }[state.decaySeverity];
    
    logger.info(
        `[DECAY] trade ${tradeId.slice(0, 8)}... | ` +
        `${severityEmoji} ${state.decaySeverity} | ` +
        `entropy=${state.consecutiveNegativeEntropySlopes} ` +
        `liquidity=${state.consecutiveNegativeLiquiditySlopes} | ` +
        `exit=${state.shouldExit}`
    );
}

/**
 * Log dynamic harmonics summary
 */
export function logDynamicHarmonicsSummary(): void {
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info('DYNAMIC HARMONICS STATE');
    
    // Count volatility levels
    const volCounts = { HIGH: 0, MEDIUM: 0, LOW: 0, MINIMAL: 0 };
    for (const state of volatilityStates.values()) {
        volCounts[state.volatilityLevel]++;
    }
    
    logger.info(
        `  Volatility: 🌋${volCounts.HIGH} ⚡${volCounts.MEDIUM} ` +
        `🌊${volCounts.LOW} 🧊${volCounts.MINIMAL}`
    );
    
    // Count decay severity
    const decayCounts = { NONE: 0, MILD: 0, MODERATE: 0, SEVERE: 0 };
    let exitCount = 0;
    for (const state of decayStates.values()) {
        decayCounts[state.decaySeverity]++;
        if (state.shouldExit) exitCount++;
    }
    
    logger.info(
        `  Decay: ✅${decayCounts.NONE} 🟡${decayCounts.MILD} ` +
        `🟠${decayCounts.MODERATE} 🔴${decayCounts.SEVERE} | ` +
        `Exit Signals: ${exitCount}`
    );
    
    logger.info('───────────────────────────────────────────────────────────────');
}

/**
 * Clear all dynamic harmonics state
 */
export function clearDynamicHarmonicsState(): void {
    volatilityStates.clear();
    decayStates.clear();
    logger.info('[HARMONICS] Cleared dynamic harmonics state');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    DYNAMIC_HARMONICS_CONFIG,
};

