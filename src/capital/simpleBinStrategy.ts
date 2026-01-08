/**
 * Simple Bin Strategy — HARVEST vs STABILIZE Modes Only
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Replace adaptive bin math with two static modes.
 * No predictive logic. No entropy models. Just fee extraction.
 * 
 * MODES:
 * 
 * HARVEST MODE (default):
 *   - 5-10 bins
 *   - Used for normal operation
 *   - Tight range = more fee capture per unit of liquidity
 *   - Requires more frequent rebalancing
 * 
 * STABILIZE MODE:
 *   - 15-25 bins
 *   - Triggered ONLY on volatility spike
 *   - Wider range = less rebalancing during chaos
 *   - Returns to HARVEST when volatility subsides
 * 
 * VOLATILITY SPIKE DETECTION:
 *   - Price movement > 5% in last hour
 *   - OR bin crossings > 10 in last 10 minutes
 *   - OR volatility score > 0.8 (from pool metrics)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// BIN STRATEGY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const BIN_STRATEGY_CONFIG = {
    /** HARVEST mode bin range (tight for max fee capture) */
    HARVEST: {
        MIN_BINS: 5,
        MAX_BINS: 10,
        DEFAULT_BINS: 7,
    },
    
    /** STABILIZE mode bin range (wider for volatile markets) */
    STABILIZE: {
        MIN_BINS: 15,
        MAX_BINS: 25,
        DEFAULT_BINS: 20,
    },
    
    /** Volatility spike thresholds */
    VOLATILITY_THRESHOLDS: {
        /** Price movement % in last hour to trigger STABILIZE */
        PRICE_MOVEMENT_PCT: 0.05,  // 5%
        
        /** Bin crossings in last 10 minutes to trigger STABILIZE */
        BIN_CROSSINGS_10MIN: 10,
        
        /** Volatility score (0-1) threshold */
        VOLATILITY_SCORE: 0.8,
        
        /** Cooldown before returning to HARVEST (ms) */
        STABILIZE_COOLDOWN_MS: 30 * 60 * 1000,  // 30 minutes
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type BinMode = 'HARVEST' | 'STABILIZE';

export interface BinStrategyResult {
    mode: BinMode;
    binCount: number;
    reason: string;
    volatilityMetrics: {
        priceMovementPct: number;
        binCrossings: number;
        volatilityScore: number;
    };
    timestamp: number;
}

export interface VolatilityInput {
    /** Price movement % in last hour (0-1, e.g., 0.05 = 5%) */
    priceMovementPct: number;
    
    /** Number of bin crossings in last 10 minutes */
    binCrossings10Min: number;
    
    /** Volatility score from pool metrics (0-1) */
    volatilityScore: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE — PER-POOL MODE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

interface PoolBinState {
    mode: BinMode;
    enteredAt: number;
    stabilizeTriggeredAt: number | null;
}

const poolBinStates = new Map<string, PoolBinState>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine if volatility spike is detected
 */
function isVolatilitySpike(input: VolatilityInput): boolean {
    const thresholds = BIN_STRATEGY_CONFIG.VOLATILITY_THRESHOLDS;
    
    return (
        input.priceMovementPct >= thresholds.PRICE_MOVEMENT_PCT ||
        input.binCrossings10Min >= thresholds.BIN_CROSSINGS_10MIN ||
        input.volatilityScore >= thresholds.VOLATILITY_SCORE
    );
}

/**
 * Get the current bin mode for a pool
 */
export function getPoolBinMode(poolAddress: string): BinMode {
    const state = poolBinStates.get(poolAddress);
    return state?.mode ?? 'HARVEST';
}

/**
 * Determine bin strategy for a pool.
 * 
 * This is the main entry point for bin count determination.
 * Returns HARVEST (5-10 bins) by default, STABILIZE (15-25 bins) on volatility spike.
 */
export function determineBinStrategy(
    poolAddress: string,
    poolName: string,
    volatilityInput: VolatilityInput
): BinStrategyResult {
    const now = Date.now();
    const existingState = poolBinStates.get(poolAddress);
    const thresholds = BIN_STRATEGY_CONFIG.VOLATILITY_THRESHOLDS;
    
    // Check for volatility spike
    const isSpike = isVolatilitySpike(volatilityInput);
    
    // Determine mode
    let mode: BinMode;
    let reason: string;
    
    if (isSpike) {
        // Enter STABILIZE mode
        mode = 'STABILIZE';
        
        if (volatilityInput.priceMovementPct >= thresholds.PRICE_MOVEMENT_PCT) {
            reason = `Price movement ${(volatilityInput.priceMovementPct * 100).toFixed(1)}% >= ${(thresholds.PRICE_MOVEMENT_PCT * 100).toFixed(0)}%`;
        } else if (volatilityInput.binCrossings10Min >= thresholds.BIN_CROSSINGS_10MIN) {
            reason = `Bin crossings ${volatilityInput.binCrossings10Min} >= ${thresholds.BIN_CROSSINGS_10MIN} in 10min`;
        } else {
            reason = `Volatility score ${volatilityInput.volatilityScore.toFixed(2)} >= ${thresholds.VOLATILITY_SCORE}`;
        }
        
        // Update state
        poolBinStates.set(poolAddress, {
            mode: 'STABILIZE',
            enteredAt: existingState?.enteredAt ?? now,
            stabilizeTriggeredAt: existingState?.mode === 'STABILIZE' 
                ? existingState.stabilizeTriggeredAt 
                : now,
        });
        
    } else if (existingState?.mode === 'STABILIZE') {
        // Check if we can return to HARVEST (cooldown elapsed)
        const stabilizeTime = existingState.stabilizeTriggeredAt ?? now;
        const elapsed = now - stabilizeTime;
        
        if (elapsed >= thresholds.STABILIZE_COOLDOWN_MS) {
            // Return to HARVEST
            mode = 'HARVEST';
            reason = `Volatility subsided, cooldown elapsed (${(elapsed / 60000).toFixed(0)}min)`;
            
            poolBinStates.set(poolAddress, {
                mode: 'HARVEST',
                enteredAt: existingState.enteredAt,
                stabilizeTriggeredAt: null,
            });
        } else {
            // Stay in STABILIZE
            mode = 'STABILIZE';
            reason = `Stabilize cooldown active (${((thresholds.STABILIZE_COOLDOWN_MS - elapsed) / 60000).toFixed(0)}min remaining)`;
        }
    } else {
        // Normal operation - HARVEST mode
        mode = 'HARVEST';
        reason = 'Normal operation - maximum fee extraction';
        
        if (!existingState) {
            poolBinStates.set(poolAddress, {
                mode: 'HARVEST',
                enteredAt: now,
                stabilizeTriggeredAt: null,
            });
        }
    }
    
    // Determine bin count based on mode
    const config = mode === 'HARVEST' 
        ? BIN_STRATEGY_CONFIG.HARVEST 
        : BIN_STRATEGY_CONFIG.STABILIZE;
    
    // Use default bins for the mode (no adaptive calculation)
    const binCount = config.DEFAULT_BINS;
    
    const result: BinStrategyResult = {
        mode,
        binCount,
        reason,
        volatilityMetrics: {
            priceMovementPct: volatilityInput.priceMovementPct,
            binCrossings: volatilityInput.binCrossings10Min,
            volatilityScore: volatilityInput.volatilityScore,
        },
        timestamp: now,
    };
    
    // Log mode determination
    logger.info(
        `[BIN-STRATEGY] pool=${poolName} mode=${mode} bins=${binCount} reason="${reason}"`
    );
    
    return result;
}

/**
 * Force a specific mode for a pool (for testing or manual override)
 */
export function forcePoolBinMode(poolAddress: string, mode: BinMode): void {
    const now = Date.now();
    const existingState = poolBinStates.get(poolAddress);
    
    poolBinStates.set(poolAddress, {
        mode,
        enteredAt: existingState?.enteredAt ?? now,
        stabilizeTriggeredAt: mode === 'STABILIZE' ? now : null,
    });
    
    logger.info(`[BIN-STRATEGY] Force set ${poolAddress.slice(0, 8)} to ${mode}`);
}

/**
 * Get bin count for a specific mode
 */
export function getBinCountForMode(mode: BinMode): number {
    const config = mode === 'HARVEST' 
        ? BIN_STRATEGY_CONFIG.HARVEST 
        : BIN_STRATEGY_CONFIG.STABILIZE;
    return config.DEFAULT_BINS;
}

/**
 * Get bin range for a specific mode
 */
export function getBinRangeForMode(mode: BinMode): { min: number; max: number; default: number } {
    const config = mode === 'HARVEST' 
        ? BIN_STRATEGY_CONFIG.HARVEST 
        : BIN_STRATEGY_CONFIG.STABILIZE;
    return {
        min: config.MIN_BINS,
        max: config.MAX_BINS,
        default: config.DEFAULT_BINS,
    };
}

/**
 * Clear pool bin state (call on position close)
 */
export function clearPoolBinState(poolAddress: string): void {
    poolBinStates.delete(poolAddress);
}

/**
 * Clear all bin states (for testing/reset)
 */
export function clearAllBinStates(): void {
    poolBinStates.clear();
    logger.info('[BIN-STRATEGY] All states cleared');
}

/**
 * Get summary of all pool bin states
 */
export function getBinStrategySummary(): {
    totalPools: number;
    harvestPools: number;
    stabilizePools: number;
    states: Array<{ address: string; mode: BinMode; since: number }>;
} {
    const states: Array<{ address: string; mode: BinMode; since: number }> = [];
    let harvestCount = 0;
    let stabilizeCount = 0;
    
    for (const [address, state] of poolBinStates) {
        states.push({
            address,
            mode: state.mode,
            since: state.mode === 'STABILIZE' 
                ? state.stabilizeTriggeredAt ?? state.enteredAt
                : state.enteredAt,
        });
        
        if (state.mode === 'HARVEST') {
            harvestCount++;
        } else {
            stabilizeCount++;
        }
    }
    
    return {
        totalPools: poolBinStates.size,
        harvestPools: harvestCount,
        stabilizePools: stabilizeCount,
        states,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create volatility input from pool metrics
 */
export function createVolatilityInput(
    priceHistory: number[],
    binCrossings: number,
    volatilityScore: number
): VolatilityInput {
    // Calculate price movement from history
    let priceMovementPct = 0;
    if (priceHistory.length >= 2) {
        const start = priceHistory[0];
        const end = priceHistory[priceHistory.length - 1];
        priceMovementPct = Math.abs((end - start) / start);
    }
    
    return {
        priceMovementPct,
        binCrossings10Min: binCrossings,
        volatilityScore,
    };
}

/**
 * Determine bin strategy using pool telemetry
 */
export function determineBinStrategyFromTelemetry(
    poolAddress: string,
    poolName: string,
    microMetrics: {
        binVelocity?: number;
        poolEntropy?: number;
        priceMovementPct?: number;
    }
): BinStrategyResult {
    // Extract volatility signals from telemetry
    const binVelocity = microMetrics.binVelocity ?? 0;
    const entropy = microMetrics.poolEntropy ?? 0;
    const priceMovement = microMetrics.priceMovementPct ?? 0;
    
    // Convert bin velocity to bin crossings estimate
    // binVelocity is 0-100, assume 10 crossings at 100
    const binCrossings = Math.floor(binVelocity / 10);
    
    // Use entropy as volatility score proxy
    const volatilityScore = Math.min(1, entropy);
    
    const input: VolatilityInput = {
        priceMovementPct: priceMovement,
        binCrossings10Min: binCrossings,
        volatilityScore,
    };
    
    return determineBinStrategy(poolAddress, poolName, input);
}


