/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BIN DOMINANCE STRATEGY — PREDATOR MODE v1
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * HARD RULE: DO NOT CREATE BIN ARRAYS. Only use existing bins.
 * 
 * PRIMARY MODE: Single-bin dominance (default)
 * - Identify modal price bin (highest recurring price density)
 * - Allocate >70% of position liquidity into that bin
 * - Optional 3-bin micro spread ONLY if oscillation amplitude demands it
 * 
 * KEY SHIFT: Bin width logic favors TIGHTNESS, not safety.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    PREDATOR_MODE_V1_ENABLED,
    BIN_DOMINANCE_CONFIG,
    REBALANCE_AGGRESSION_CONFIG,
    getRegimeMultipliers,
} from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BinDominanceResult {
    /** Strategy mode */
    mode: 'SINGLE_BIN' | 'MICRO_SPREAD' | 'DEFAULT';
    
    /** Primary (modal) bin to dominate */
    modalBinId: number;
    
    /** Bins to use (1 for single-bin, up to 3 for micro-spread) */
    binIds: number[];
    
    /** Allocation percentages per bin (sum = 1.0) */
    allocations: number[];
    
    /** Total bin count */
    binCount: number;
    
    /** Whether bin arrays can be created (always false in predator mode) */
    canCreateBinArrays: boolean;
    
    /** Strategy reasoning */
    reason: string;
}

export interface ModalBinAnalysis {
    /** Modal bin (most frequent price location) */
    modalBinId: number;
    
    /** Bin with highest volume */
    highVolumeBinId: number;
    
    /** Oscillation amplitude in bins */
    oscillationAmplitudeBins: number;
    
    /** Price visits per bin (for analysis) */
    binVisitCounts: Map<number, number>;
    
    /** Confidence in modal bin selection (0-1) */
    confidence: number;
}

export interface PriceHistory {
    timestamp: number;
    binId: number;
    price?: number;
}

export interface BinVolumeData {
    binId: number;
    volumeUsd: number;
    swapCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL BIN DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyze price history to find the modal (most frequent) bin
 */
export function analyzeModalBin(
    priceHistory: PriceHistory[],
    volumeData?: BinVolumeData[]
): ModalBinAnalysis {
    if (priceHistory.length === 0) {
        return {
            modalBinId: 0,
            highVolumeBinId: 0,
            oscillationAmplitudeBins: 0,
            binVisitCounts: new Map(),
            confidence: 0,
        };
    }
    
    // Count visits to each bin
    const binVisitCounts = new Map<number, number>();
    let minBin = Infinity;
    let maxBin = -Infinity;
    
    for (const entry of priceHistory) {
        const count = binVisitCounts.get(entry.binId) || 0;
        binVisitCounts.set(entry.binId, count + 1);
        minBin = Math.min(minBin, entry.binId);
        maxBin = Math.max(maxBin, entry.binId);
    }
    
    // Find modal bin (most visited)
    let modalBinId = priceHistory[priceHistory.length - 1].binId;  // Default to current
    let maxVisits = 0;
    
    for (const [binId, visits] of binVisitCounts) {
        if (visits > maxVisits) {
            maxVisits = visits;
            modalBinId = binId;
        }
    }
    
    // Find high-volume bin
    let highVolumeBinId = modalBinId;
    if (volumeData && volumeData.length > 0) {
        let maxVolume = 0;
        for (const vd of volumeData) {
            if (vd.volumeUsd > maxVolume) {
                maxVolume = vd.volumeUsd;
                highVolumeBinId = vd.binId;
            }
        }
    }
    
    // Calculate oscillation amplitude
    const oscillationAmplitudeBins = maxBin === -Infinity ? 0 : maxBin - minBin;
    
    // Calculate confidence (modal bin should have significantly more visits)
    const totalVisits = priceHistory.length;
    const modalRatio = maxVisits / totalVisits;
    const confidence = Math.min(1, modalRatio * 2);  // 50%+ visits = 100% confidence
    
    return {
        modalBinId,
        highVolumeBinId,
        oscillationAmplitudeBins,
        binVisitCounts,
        confidence,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BIN DOMINANCE STRATEGY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine bin dominance strategy for a position
 * 
 * RULES:
 * 1. DO NOT CREATE BIN ARRAYS - use existing bins only
 * 2. Primary mode is single-bin dominance
 * 3. Only use 3-bin micro-spread if oscillation amplitude demands it
 * 4. Modal bin gets >70% allocation
 */
export function determineBinDominanceStrategy(
    currentBinId: number,
    priceHistory: PriceHistory[],
    volumeData?: BinVolumeData[],
    regime?: string
): BinDominanceResult {
    // Default mode if predator not enabled
    if (!PREDATOR_MODE_V1_ENABLED) {
        return {
            mode: 'DEFAULT',
            modalBinId: currentBinId,
            binIds: [currentBinId],
            allocations: [1.0],
            binCount: 1,
            canCreateBinArrays: true,
            reason: 'PREDATOR_DISABLED',
        };
    }
    
    // Analyze modal bin
    const analysis = priceHistory.length > 0 
        ? analyzeModalBin(priceHistory, volumeData)
        : {
            modalBinId: currentBinId,
            highVolumeBinId: currentBinId,
            oscillationAmplitudeBins: 0,
            binVisitCounts: new Map<number, number>(),
            confidence: 0.5,
        };
    
    // Apply regime multipliers (minor adjustments only)
    const regimeMultipliers = getRegimeMultipliers(regime || 'NEUTRAL');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DECISION: Single-bin or micro-spread?
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Use micro-spread ONLY if oscillation amplitude is large (>3 bins)
    const useMicroSpread = analysis.oscillationAmplitudeBins >= 4;
    
    if (!useMicroSpread) {
        // ═══════════════════════════════════════════════════════════════════════
        // SINGLE-BIN DOMINANCE (preferred)
        // ═══════════════════════════════════════════════════════════════════════
        return {
            mode: 'SINGLE_BIN',
            modalBinId: analysis.modalBinId,
            binIds: [analysis.modalBinId],
            allocations: [1.0],
            binCount: 1,
            canCreateBinArrays: false,
            reason: `Single-bin dominance: modal=${analysis.modalBinId}, confidence=${(analysis.confidence * 100).toFixed(0)}%`,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MICRO-SPREAD (3 bins max) - only when oscillation is wide
    // ═══════════════════════════════════════════════════════════════════════════
    
    const modalBin = analysis.modalBinId;
    const adjacentLower = modalBin - 1;
    const adjacentUpper = modalBin + 1;
    
    // Modal bin gets 70%, adjacent bins split 30%
    const modalAllocation = BIN_DOMINANCE_CONFIG.MODAL_BIN_ALLOCATION_PCT;
    const adjacentAllocation = (1 - modalAllocation) / 2;
    
    return {
        mode: 'MICRO_SPREAD',
        modalBinId: modalBin,
        binIds: [adjacentLower, modalBin, adjacentUpper],
        allocations: [adjacentAllocation, modalAllocation, adjacentAllocation],
        binCount: 3,
        canCreateBinArrays: false,
        reason: `Micro-spread: modal=${modalBin} (${(modalAllocation * 100).toFixed(0)}%), oscillation=${analysis.oscillationAmplitudeBins} bins`,
    };
}

/**
 * Check if price has exited the dominant bin(s)
 * Used as rebalance trigger
 */
export function hasPriceExitedDominance(
    currentBinId: number,
    strategy: BinDominanceResult
): boolean {
    // For single-bin, exit if we've moved away from modal
    if (strategy.mode === 'SINGLE_BIN') {
        const drift = Math.abs(currentBinId - strategy.modalBinId);
        return drift >= REBALANCE_AGGRESSION_CONFIG.BIN_DRIFT_THRESHOLD;
    }
    
    // For micro-spread, exit if we're outside the spread
    if (strategy.mode === 'MICRO_SPREAD') {
        const minBin = Math.min(...strategy.binIds);
        const maxBin = Math.max(...strategy.binIds);
        return currentBinId < minBin || currentBinId > maxBin;
    }
    
    return false;
}

/**
 * Calculate new modal bin after rebalance
 */
export function calculateNewModalBin(
    currentBinId: number,
    oldStrategy: BinDominanceResult,
    priceHistory: PriceHistory[]
): number {
    // If we have recent history, use modal bin from that
    if (priceHistory.length >= 10) {
        const analysis = analyzeModalBin(priceHistory);
        if (analysis.confidence >= 0.5) {
            return analysis.modalBinId;
        }
    }
    
    // Otherwise, recenter on current bin
    return currentBinId;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BIN ALLOCATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate liquidity amounts for each bin based on allocation strategy
 */
export function calculateBinLiquidityAmounts(
    totalLiquidityUsd: number,
    strategy: BinDominanceResult
): { binId: number; amountUsd: number }[] {
    return strategy.binIds.map((binId, index) => ({
        binId,
        amountUsd: totalLiquidityUsd * strategy.allocations[index],
    }));
}

/**
 * Get the dominant bin for fee collection focus
 */
export function getDominantBin(strategy: BinDominanceResult): number {
    return strategy.modalBinId;
}

/**
 * Check if strategy recommends rebalance based on bin position
 */
export function recommendsRebalance(
    currentBinId: number,
    strategy: BinDominanceResult,
    lastRebalanceMs: number
): { recommend: boolean; urgency: 'HIGH' | 'MEDIUM' | 'LOW'; reason: string } {
    const elapsed = Date.now() - lastRebalanceMs;
    
    // Check minimum interval
    if (elapsed < REBALANCE_AGGRESSION_CONFIG.MIN_REBALANCE_INTERVAL_MS) {
        return {
            recommend: false,
            urgency: 'LOW',
            reason: `Too soon: ${(elapsed / 1000).toFixed(0)}s < ${REBALANCE_AGGRESSION_CONFIG.MIN_REBALANCE_INTERVAL_MS / 1000}s min`,
        };
    }
    
    // Check if price exited dominance
    if (hasPriceExitedDominance(currentBinId, strategy)) {
        return {
            recommend: true,
            urgency: 'HIGH',
            reason: `Price exited: current=${currentBinId}, modal=${strategy.modalBinId}`,
        };
    }
    
    // Time-based fallback
    if (elapsed >= REBALANCE_AGGRESSION_CONFIG.MAX_REBALANCE_INTERVAL_MS) {
        return {
            recommend: true,
            urgency: 'MEDIUM',
            reason: `Time fallback: ${(elapsed / 1000).toFixed(0)}s >= ${REBALANCE_AGGRESSION_CONFIG.MAX_REBALANCE_INTERVAL_MS / 1000}s max`,
        };
    }
    
    return {
        recommend: false,
        urgency: 'LOW',
        reason: 'Position stable',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logBinDominanceStrategy(
    poolName: string,
    strategy: BinDominanceResult
): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    const modeEmoji = strategy.mode === 'SINGLE_BIN' ? '🎯' : '📐';
    
    logger.info(
        `[BIN-DOMINANCE] ${modeEmoji} ${poolName} | ` +
        `mode=${strategy.mode} | ` +
        `modal=${strategy.modalBinId} | ` +
        `bins=[${strategy.binIds.join(',')}] | ` +
        `alloc=[${strategy.allocations.map(a => (a * 100).toFixed(0) + '%').join(',')}] | ` +
        `${strategy.reason}`
    );
}

export function logRebalanceRecommendation(
    poolName: string,
    currentBinId: number,
    recommendation: { recommend: boolean; urgency: string; reason: string }
): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    if (recommendation.recommend) {
        const urgencyEmoji = recommendation.urgency === 'HIGH' ? '🔴' : 
                            recommendation.urgency === 'MEDIUM' ? '🟡' : '🟢';
        logger.info(
            `[BIN-DOMINANCE] ${urgencyEmoji} REBALANCE ${poolName} | ` +
            `current=${currentBinId} | ` +
            `urgency=${recommendation.urgency} | ` +
            `${recommendation.reason}`
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

interface PositionBinState {
    strategy: BinDominanceResult;
    lastRebalanceMs: number;
    rebalanceCount: number;
    priceHistory: PriceHistory[];
}

const positionBinStates = new Map<string, PositionBinState>();

/**
 * Initialize bin tracking for a position
 */
export function initializeBinTracking(
    tradeId: string,
    currentBinId: number,
    priceHistory: PriceHistory[] = []
): BinDominanceResult {
    const strategy = determineBinDominanceStrategy(currentBinId, priceHistory);
    
    positionBinStates.set(tradeId, {
        strategy,
        lastRebalanceMs: Date.now(),
        rebalanceCount: 0,
        priceHistory: priceHistory.slice(-100),  // Keep last 100 entries
    });
    
    return strategy;
}

/**
 * Update bin tracking with new price data
 */
export function updateBinTracking(
    tradeId: string,
    currentBinId: number,
    timestamp: number = Date.now()
): void {
    const state = positionBinStates.get(tradeId);
    if (!state) return;
    
    // Add to price history
    state.priceHistory.push({ timestamp, binId: currentBinId });
    
    // Keep last 100 entries
    if (state.priceHistory.length > 100) {
        state.priceHistory = state.priceHistory.slice(-100);
    }
}

/**
 * Record that a rebalance was executed
 */
export function recordBinRebalance(
    tradeId: string,
    newStrategy: BinDominanceResult
): void {
    const state = positionBinStates.get(tradeId);
    if (!state) return;
    
    state.strategy = newStrategy;
    state.lastRebalanceMs = Date.now();
    state.rebalanceCount++;
}

/**
 * Get current bin strategy for a position
 */
export function getBinStrategy(tradeId: string): BinDominanceResult | undefined {
    return positionBinStates.get(tradeId)?.strategy;
}

/**
 * Get rebalance count for a position
 */
export function getRebalanceCount(tradeId: string): number {
    return positionBinStates.get(tradeId)?.rebalanceCount || 0;
}

/**
 * Cleanup bin tracking for a closed position
 */
export function cleanupBinTracking(tradeId: string): void {
    positionBinStates.delete(tradeId);
}

/**
 * Get all position bin states (for telemetry)
 */
export function getAllBinStates(): Map<string, PositionBinState> {
    return new Map(positionBinStates);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    analyzeModalBin,
    determineBinDominanceStrategy,
    hasPriceExitedDominance,
    calculateNewModalBin,
    calculateBinLiquidityAmounts,
    getDominantBin,
    recommendsRebalance,
    initializeBinTracking,
    updateBinTracking,
    recordBinRebalance,
    getBinStrategy,
    getRebalanceCount,
    cleanupBinTracking,
    getAllBinStates,
    logBinDominanceStrategy,
    logRebalanceRecommendation,
};

