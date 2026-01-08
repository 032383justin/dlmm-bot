/**
 * Fee Bully Gate — Deploy-by-Default Entry System
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Replace "veto on any weak signal" with "deploy-by-default with size penalties"
 * 
 * KEY PRINCIPLE:
 * - HARD_BLOCK only on true infrastructure red flags
 * - All other conditions apply PENALTY MULTIPLIERS to position size
 * - Positions with many soft penalties get smaller allocations, not zero
 * 
 * TWO-TIER GATE SYSTEM:
 * 
 * TIER 1 - HARD BLOCKS (Cannot trade, period):
 *   1. Extreme migration risk (>60%/min outflow with high confidence)
 *   2. Liquidity below absolute safety floor (<$1,000 TVL)
 *   3. Pool dead: near-zero swaps across multiple consecutive windows
 *   4. Execution telemetry degraded (RPC health < 0.30)
 *   5. Kill switch active
 * 
 * TIER 2 - PENALTIES (Apply multiplier 0.2-1.0 to position size):
 *   - Low velocity: multiply by 0.5-1.0
 *   - Low liquidity flow: multiply by 0.4-1.0
 *   - High entropy/instability: multiply by 0.3-1.0
 *   - Low telemetry freshness: multiply by 0.5-1.0
 *   - Low migration confidence: multiply by 0.6-1.0
 *   - Low consistency: multiply by 0.5-1.0
 *   - Negative slopes: multiply by 0.4-1.0
 * 
 * BOOTSTRAP DEPLOY MODE:
 *   For first 2-3 cycles, use conservative sizing (2-3% per pool) to seed
 *   telemetry/history, then revert to normal Fee Bully sizing.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { TradingState } from '../risk/adaptive_sizing/types';
import { FEE_BULLY_MODE_ENABLED, FEE_BULLY_CAPITAL } from '../config/feeBullyConfig';
import { getExecutionQuality } from '../execution/qualityOptimizer';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * HARD BLOCK thresholds — TRUE red flags only
 */
export const HARD_BLOCK_THRESHOLDS = {
    /** Minimum TVL in USD to trade (absolute floor) */
    minTvlUsd: 1000,
    
    /** Maximum migration outflow rate (%/min) that triggers hard block */
    maxMigrationOutflowRate: 0.60, // 60%/min = catastrophic drain
    
    /** Minimum migration confidence to trigger migration block */
    migrationBlockConfidence: 0.70, // Only block if we're 70%+ confident it's a drain
    
    /** Dead pool: swaps per second below this for N windows */
    deadPoolSwapVelocity: 0.001, // Near-zero
    
    /** Number of consecutive windows with dead velocity */
    deadPoolWindowCount: 3,
    
    /** RPC health below this = infrastructure failure */
    minRpcHealth: 0.30,
    
    /** Kill switch triggers immediate hard block */
    killSwitchActive: false, // Externally controlled
};

/**
 * PENALTY thresholds — soft signals that reduce position size
 */
export const PENALTY_THRESHOLDS = {
    // Velocity penalties
    velocity: {
        /** Above this = no penalty */
        healthy: 0.15,
        /** Below healthy, penalty scales linearly to this floor */
        floor: 0.02,
        /** Penalty multiplier at floor */
        maxPenalty: 0.50, // 50% of normal size
    },
    
    // Liquidity flow penalties
    liquidityFlow: {
        healthy: 0.30,
        floor: 0.05,
        maxPenalty: 0.40,
    },
    
    // Entropy penalties (higher entropy = more penalty)
    entropy: {
        /** Below this = no penalty */
        healthy: 0.60,
        /** Above healthy, penalty scales to ceiling */
        ceiling: 0.85,
        maxPenalty: 0.30,
    },
    
    // Consistency penalties
    consistency: {
        healthy: 0.40,
        floor: 0.15,
        maxPenalty: 0.50,
    },
    
    // Migration confidence penalties
    migrationConfidence: {
        healthy: 0.40,
        floor: 0.10,
        maxPenalty: 0.60,
    },
    
    // Slope penalties (negative slopes)
    slope: {
        /** Slope at or above this = no penalty */
        healthy: 0.00,
        /** Slope below this = max penalty */
        floor: -0.05,
        maxPenalty: 0.40,
    },
    
    // Telemetry freshness (samples in last window)
    telemetryFreshness: {
        healthy: 3, // 3+ samples = fresh
        floor: 0,
        maxPenalty: 0.50,
    },
};

/**
 * Bootstrap deploy mode configuration
 */
export const BOOTSTRAP_DEPLOY_CONFIG = {
    /** Enable bootstrap deploy mode */
    enabled: true,
    
    /** Number of cycles to run in bootstrap mode */
    bootstrapCycles: 3,
    
    /** Position size as % of equity during bootstrap */
    bootstrapSizePct: 0.025, // 2.5% per pool
    
    /** Maximum positions during bootstrap */
    bootstrapMaxPositions: 4,
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Track cycle count for bootstrap mode */
let cycleCount = 0;

/** Dead pool velocity history (poolId -> last N velocities) */
const deadPoolHistory = new Map<string, number[]>();

/** Kill switch state */
let killSwitchActive = false;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface FeeBullyGateInputs {
    poolAddress: string;
    poolName: string;
    
    // Core metrics
    tvlUsd: number;
    swapVelocity: number;        // swaps per second
    liquidityFlowScore: number;  // 0-1
    entropyScore: number;        // 0-1
    consistencyScore: number;    // 0-1
    migrationConfidence: number; // 0-1
    migrationRate: number;       // %/min (negative = outflow)
    
    // Slopes
    velocitySlope: number;
    liquiditySlope: number;
    
    // Telemetry
    telemetrySamples: number;
    rpcHealthScore: number;
    
    // Position info
    basePositionSize: number;
    totalEquity: number;
    openPositionCount: number;
}

export interface FeeBullyGateResult {
    /** Entry allowed? */
    allowed: boolean;
    
    /** If blocked, the reason */
    hardBlockReason?: string;
    
    /** Final position size after penalties */
    finalPositionSize: number;
    
    /** Combined penalty multiplier (0.2-1.0) */
    penaltyMultiplier: number;
    
    /** Breakdown of individual penalties */
    penaltyBreakdown: {
        velocity: number;
        liquidityFlow: number;
        entropy: number;
        consistency: number;
        migrationConfidence: number;
        slopes: number;
        telemetry: number;
    };
    
    /** Which penalties were applied (for logging) */
    appliedPenalties: string[];
    
    /** Is bootstrap deploy mode active? */
    isBootstrapMode: boolean;
    
    /** Cycles remaining in bootstrap mode */
    bootstrapCyclesRemaining: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate entry using Fee Bully Gate system.
 * 
 * Returns allowed=true with penalty multiplier, or allowed=false for hard blocks.
 */
export function evaluateFeeBullyGate(inputs: FeeBullyGateInputs): FeeBullyGateResult {
    const appliedPenalties: string[] = [];
    
    // Initialize result
    const result: FeeBullyGateResult = {
        allowed: true,
        finalPositionSize: inputs.basePositionSize,
        penaltyMultiplier: 1.0,
        penaltyBreakdown: {
            velocity: 1.0,
            liquidityFlow: 1.0,
            entropy: 1.0,
            consistency: 1.0,
            migrationConfidence: 1.0,
            slopes: 1.0,
            telemetry: 1.0,
        },
        appliedPenalties,
        isBootstrapMode: isBootstrapMode(),
        bootstrapCyclesRemaining: getBootstrapCyclesRemaining(),
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 1: HARD BLOCKS — True red flags only
    // ═══════════════════════════════════════════════════════════════════════════
    
    const hardBlock = evaluateHardBlocks(inputs);
    if (hardBlock.blocked) {
        result.allowed = false;
        result.hardBlockReason = hardBlock.reason;
        result.finalPositionSize = 0;
        
        // Log hard block
        logger.info(
            `[GATE] HARD_BLOCK | pool=${inputs.poolName} | reason=${hardBlock.reason}`
        );
        
        return result;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 2: PENALTY MULTIPLIERS — Reduce size, don't block
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Velocity penalty
    const velocityPenalty = computePenalty(
        inputs.swapVelocity,
        PENALTY_THRESHOLDS.velocity.healthy,
        PENALTY_THRESHOLDS.velocity.floor,
        PENALTY_THRESHOLDS.velocity.maxPenalty,
        'below' // penalize if below healthy
    );
    result.penaltyBreakdown.velocity = velocityPenalty;
    if (velocityPenalty < 1.0) {
        appliedPenalties.push(`velocity:${(velocityPenalty * 100).toFixed(0)}%`);
    }
    
    // Liquidity flow penalty
    const liquidityFlowPenalty = computePenalty(
        inputs.liquidityFlowScore,
        PENALTY_THRESHOLDS.liquidityFlow.healthy,
        PENALTY_THRESHOLDS.liquidityFlow.floor,
        PENALTY_THRESHOLDS.liquidityFlow.maxPenalty,
        'below'
    );
    result.penaltyBreakdown.liquidityFlow = liquidityFlowPenalty;
    if (liquidityFlowPenalty < 1.0) {
        appliedPenalties.push(`liquidityFlow:${(liquidityFlowPenalty * 100).toFixed(0)}%`);
    }
    
    // Entropy penalty (penalize if ABOVE healthy, not below)
    const entropyPenalty = computePenalty(
        inputs.entropyScore,
        PENALTY_THRESHOLDS.entropy.healthy,
        PENALTY_THRESHOLDS.entropy.ceiling,
        PENALTY_THRESHOLDS.entropy.maxPenalty,
        'above' // penalize if above healthy
    );
    result.penaltyBreakdown.entropy = entropyPenalty;
    if (entropyPenalty < 1.0) {
        appliedPenalties.push(`entropy:${(entropyPenalty * 100).toFixed(0)}%`);
    }
    
    // Consistency penalty
    const consistencyPenalty = computePenalty(
        inputs.consistencyScore,
        PENALTY_THRESHOLDS.consistency.healthy,
        PENALTY_THRESHOLDS.consistency.floor,
        PENALTY_THRESHOLDS.consistency.maxPenalty,
        'below'
    );
    result.penaltyBreakdown.consistency = consistencyPenalty;
    if (consistencyPenalty < 1.0) {
        appliedPenalties.push(`consistency:${(consistencyPenalty * 100).toFixed(0)}%`);
    }
    
    // Migration confidence penalty
    const migrationPenalty = computePenalty(
        inputs.migrationConfidence,
        PENALTY_THRESHOLDS.migrationConfidence.healthy,
        PENALTY_THRESHOLDS.migrationConfidence.floor,
        PENALTY_THRESHOLDS.migrationConfidence.maxPenalty,
        'below'
    );
    result.penaltyBreakdown.migrationConfidence = migrationPenalty;
    if (migrationPenalty < 1.0) {
        appliedPenalties.push(`migration:${(migrationPenalty * 100).toFixed(0)}%`);
    }
    
    // Slope penalties (average of velocity and liquidity slopes)
    const minSlope = Math.min(inputs.velocitySlope, inputs.liquiditySlope);
    const slopePenalty = computePenalty(
        minSlope,
        PENALTY_THRESHOLDS.slope.healthy,
        PENALTY_THRESHOLDS.slope.floor,
        PENALTY_THRESHOLDS.slope.maxPenalty,
        'below'
    );
    result.penaltyBreakdown.slopes = slopePenalty;
    if (slopePenalty < 1.0) {
        appliedPenalties.push(`slopes:${(slopePenalty * 100).toFixed(0)}%`);
    }
    
    // Telemetry freshness penalty
    const telemetryPenalty = computePenalty(
        inputs.telemetrySamples,
        PENALTY_THRESHOLDS.telemetryFreshness.healthy,
        PENALTY_THRESHOLDS.telemetryFreshness.floor,
        PENALTY_THRESHOLDS.telemetryFreshness.maxPenalty,
        'below'
    );
    result.penaltyBreakdown.telemetry = telemetryPenalty;
    if (telemetryPenalty < 1.0) {
        appliedPenalties.push(`telemetry:${(telemetryPenalty * 100).toFixed(0)}%`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE COMBINED PENALTY
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Multiply all penalties together, but floor at 0.20 (20% of normal size)
    const combinedPenalty = Math.max(
        0.20,
        velocityPenalty *
        liquidityFlowPenalty *
        entropyPenalty *
        consistencyPenalty *
        migrationPenalty *
        slopePenalty *
        telemetryPenalty
    );
    
    result.penaltyMultiplier = combinedPenalty;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE FINAL POSITION SIZE
    // ═══════════════════════════════════════════════════════════════════════════
    
    let finalSize: number;
    
    if (result.isBootstrapMode) {
        // Bootstrap mode: use conservative fixed sizing
        finalSize = inputs.totalEquity * BOOTSTRAP_DEPLOY_CONFIG.bootstrapSizePct;
        
        logger.info(
            `[BOOTSTRAP-DEPLOY] active | cyclesRemaining=${result.bootstrapCyclesRemaining} | ` +
            `size=${BOOTSTRAP_DEPLOY_CONFIG.bootstrapSizePct * 100}% = $${finalSize.toFixed(0)}`
        );
    } else {
        // Normal mode: apply penalty multiplier
        finalSize = inputs.basePositionSize * combinedPenalty;
    }
    
    // Apply min/max bounds
    finalSize = Math.max(finalSize, FEE_BULLY_CAPITAL.MIN_POSITION_SIZE_USD);
    finalSize = Math.min(finalSize, FEE_BULLY_CAPITAL.MAX_POSITION_SIZE_USD);
    finalSize = Math.min(finalSize, inputs.totalEquity * FEE_BULLY_CAPITAL.MAX_PER_POOL_PCT);
    
    result.finalPositionSize = Math.floor(finalSize);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LOG DECISION
    // ═══════════════════════════════════════════════════════════════════════════
    
    const penaltyStr = appliedPenalties.length > 0 
        ? appliedPenalties.join(', ')
        : 'none';
    
    logger.info(
        `[GATE] ALLOW | pool=${inputs.poolName} | ` +
        `penalties=[${penaltyStr}]`
    );
    
    logger.info(
        `[SIZE] baseSize=$${inputs.basePositionSize.toFixed(0)} | ` +
        `penaltyMultiplier=${(combinedPenalty * 100).toFixed(0)}% | ` +
        `finalSize=$${result.finalPositionSize} | ` +
        `${result.isBootstrapMode ? '[BOOTSTRAP]' : '[NORMAL]'}`
    );
    
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HARD BLOCK EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

interface HardBlockResult {
    blocked: boolean;
    reason: string;
}

function evaluateHardBlocks(inputs: FeeBullyGateInputs): HardBlockResult {
    // ───────────────────────────────────────────────────────────────────────────
    // CHECK 1: Kill switch
    // ───────────────────────────────────────────────────────────────────────────
    if (killSwitchActive) {
        return { blocked: true, reason: 'KILL_SWITCH_ACTIVE' };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // CHECK 2: RPC health below critical threshold
    // ───────────────────────────────────────────────────────────────────────────
    if (inputs.rpcHealthScore < HARD_BLOCK_THRESHOLDS.minRpcHealth) {
        return { 
            blocked: true, 
            reason: `RPC_HEALTH_CRITICAL: ${(inputs.rpcHealthScore * 100).toFixed(0)}% < ${(HARD_BLOCK_THRESHOLDS.minRpcHealth * 100).toFixed(0)}%`
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // CHECK 3: TVL below absolute minimum
    // ───────────────────────────────────────────────────────────────────────────
    if (inputs.tvlUsd < HARD_BLOCK_THRESHOLDS.minTvlUsd) {
        return { 
            blocked: true, 
            reason: `TVL_FLOOR: $${inputs.tvlUsd.toFixed(0)} < $${HARD_BLOCK_THRESHOLDS.minTvlUsd}`
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // CHECK 4: Extreme migration outflow (catastrophic drain)
    // ───────────────────────────────────────────────────────────────────────────
    if (inputs.migrationRate < -HARD_BLOCK_THRESHOLDS.maxMigrationOutflowRate &&
        inputs.migrationConfidence >= HARD_BLOCK_THRESHOLDS.migrationBlockConfidence) {
        return { 
            blocked: true, 
            reason: `EXTREME_MIGRATION: ${(inputs.migrationRate * 100).toFixed(1)}%/min outflow (confidence=${(inputs.migrationConfidence * 100).toFixed(0)}%)`
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // CHECK 5: Dead pool (near-zero swaps across multiple windows)
    // ───────────────────────────────────────────────────────────────────────────
    const isDeadPool = checkDeadPool(inputs.poolAddress, inputs.swapVelocity);
    if (isDeadPool) {
        return { 
            blocked: true, 
            reason: `DEAD_POOL: swapVelocity < ${HARD_BLOCK_THRESHOLDS.deadPoolSwapVelocity} for ${HARD_BLOCK_THRESHOLDS.deadPoolWindowCount} consecutive windows`
        };
    }
    
    return { blocked: false, reason: '' };
}

/**
 * Track velocity history and check if pool is dead
 */
function checkDeadPool(poolAddress: string, currentVelocity: number): boolean {
    let history = deadPoolHistory.get(poolAddress) || [];
    
    // Add current velocity to history
    history.push(currentVelocity);
    
    // Keep only last N windows
    if (history.length > HARD_BLOCK_THRESHOLDS.deadPoolWindowCount) {
        history = history.slice(-HARD_BLOCK_THRESHOLDS.deadPoolWindowCount);
    }
    
    deadPoolHistory.set(poolAddress, history);
    
    // Check if all recent windows are below dead threshold
    if (history.length < HARD_BLOCK_THRESHOLDS.deadPoolWindowCount) {
        return false; // Not enough history yet
    }
    
    return history.every(v => v < HARD_BLOCK_THRESHOLDS.deadPoolSwapVelocity);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PENALTY COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute penalty multiplier based on value relative to thresholds.
 * 
 * @param value Current value
 * @param healthy Value at which no penalty applies (multiplier = 1.0)
 * @param extreme Value at which max penalty applies
 * @param maxPenalty The multiplier to apply at extreme (e.g., 0.5 = 50% of normal size)
 * @param direction 'below' = penalize if value < healthy, 'above' = penalize if value > healthy
 */
function computePenalty(
    value: number,
    healthy: number,
    extreme: number,
    maxPenalty: number,
    direction: 'below' | 'above'
): number {
    if (direction === 'below') {
        // Penalize if below healthy
        if (value >= healthy) return 1.0;
        if (value <= extreme) return maxPenalty;
        
        // Linear interpolation between healthy and extreme
        const ratio = (value - extreme) / (healthy - extreme);
        return maxPenalty + (1.0 - maxPenalty) * ratio;
    } else {
        // Penalize if above healthy
        if (value <= healthy) return 1.0;
        if (value >= extreme) return maxPenalty;
        
        // Linear interpolation between healthy and extreme
        const ratio = (value - healthy) / (extreme - healthy);
        return 1.0 - (1.0 - maxPenalty) * ratio;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP MODE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if we're in bootstrap deploy mode
 */
export function isBootstrapMode(): boolean {
    if (!FEE_BULLY_MODE_ENABLED) return false;
    if (!BOOTSTRAP_DEPLOY_CONFIG.enabled) return false;
    return cycleCount < BOOTSTRAP_DEPLOY_CONFIG.bootstrapCycles;
}

/**
 * Get remaining bootstrap cycles
 */
export function getBootstrapCyclesRemaining(): number {
    if (!isBootstrapMode()) return 0;
    return BOOTSTRAP_DEPLOY_CONFIG.bootstrapCycles - cycleCount;
}

/**
 * Increment cycle count (call at end of each scan cycle)
 */
export function incrementCycleCount(): void {
    cycleCount++;
    
    if (cycleCount === BOOTSTRAP_DEPLOY_CONFIG.bootstrapCycles) {
        logger.info(
            `[BOOTSTRAP-DEPLOY] COMPLETE | Transitioning to normal Fee Bully sizing`
        );
    }
}

/**
 * Get current cycle count
 */
export function getCycleCount(): number {
    return cycleCount;
}

/**
 * Reset cycle count (for testing or restart)
 */
export function resetCycleCount(): void {
    cycleCount = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// KILL SWITCH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Activate kill switch (blocks all entries)
 */
export function activateKillSwitch(reason: string): void {
    killSwitchActive = true;
    logger.warn(`[GATE] KILL_SWITCH ACTIVATED: ${reason}`);
}

/**
 * Deactivate kill switch
 */
export function deactivateKillSwitch(): void {
    killSwitchActive = false;
    logger.info(`[GATE] Kill switch deactivated`);
}

/**
 * Check if kill switch is active
 */
export function isKillSwitchActive(): boolean {
    return killSwitchActive;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Create inputs from trading state
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert trading state and pool data to FeeBullyGateInputs
 */
export function createFeeBullyGateInputs(
    poolAddress: string,
    poolName: string,
    tradingState: TradingState,
    poolData: {
        tvlUsd: number;
        swapVelocity: number;
        migrationRate: number;
        velocitySlope: number;
        liquiditySlope: number;
        telemetrySamples: number;
    },
    positionContext: {
        basePositionSize: number;
        totalEquity: number;
        openPositionCount: number;
    }
): FeeBullyGateInputs {
    // Get RPC health from execution quality
    const execQuality = getExecutionQuality();
    
    return {
        poolAddress,
        poolName,
        tvlUsd: poolData.tvlUsd,
        swapVelocity: poolData.swapVelocity,
        liquidityFlowScore: tradingState.liquidityFlow_score,
        entropyScore: tradingState.entropy_score,
        consistencyScore: tradingState.consistency_score,
        migrationConfidence: tradingState.migrationDirection_confidence,
        migrationRate: poolData.migrationRate,
        velocitySlope: poolData.velocitySlope,
        liquiditySlope: poolData.liquiditySlope,
        telemetrySamples: poolData.telemetrySamples,
        rpcHealthScore: execQuality.score,
        basePositionSize: positionContext.basePositionSize,
        totalEquity: positionContext.totalEquity,
        openPositionCount: positionContext.openPositionCount,
    };
}

