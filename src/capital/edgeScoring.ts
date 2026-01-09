/**
 * Edge Scoring — Dynamic Capital Prioritization for Oscillatory Pools
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Dynamically bias capital allocation toward pools demonstrating 
 * sustained oscillatory edge, while preserving all existing risk caps.
 * 
 * THIS IS NOT LEVERAGE OR AGGRESSION — IT IS CAPITAL PRIORITIZATION.
 * 
 * KEY INVARIANTS (NEVER VIOLATED):
 *   - Global risk limits unchanged
 *   - Max positions per tier unchanged
 *   - Entry/exit criteria unchanged
 *   - Bin width logic unchanged (Phase 1 is final)
 *   - No randomness introduced
 * 
 * EDGE SCORE FORMULA:
 *   edgeScore = 
 *     0.45 * oscScore +
 *     0.25 * clamp01(binVelRaw / 0.60) +
 *     0.20 * clamp01(swapVelRaw / 0.06) +
 *     0.10 * clamp01(1 - abs(migrationSlope) / 0.002)
 * 
 * EDGE STABILITY FILTER:
 *   Edge is only valid if:
 *     - edgeScore >= 0.55
 *     - Pool has remained eligible for >= 3 consecutive scan cycles
 * 
 * CAPITAL WEIGHT MULTIPLIER (SAFE CURVE):
 *   edgeCapitalMultiplier = clamp(1.0 + (edgeScore - 0.55) * 0.8, 1.0, 1.35)
 * 
 * PORTFOLIO-LEVEL SAFETY CAP:
 *   At any time: Σ(edgeBoostedCapital) ≤ 60% of total deployed capital
 * 
 * CHANGE RATE LIMITER:
 *   MAX_EDGE_DELTA_PER_CYCLE = 0.10 per pool
 * 
 * EXIT CONDITIONS (boost removal):
 *   - CHAOS regime
 *   - Forced exit
 *   - Migration slope breach
 *   - Volatility breach
 *   - Position close
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — EDGE SCORING CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Edge Score Component Weights (must sum to 1.0)
 */
const EDGE_WEIGHTS = {
    oscScore: 0.45,
    binVel: 0.25,
    swapVel: 0.20,
    migrationStability: 0.10,
} as const;

/**
 * Reference values for normalization
 */
const EDGE_REFERENCES = {
    binVelRef: 0.60,           // binVelocity reference (0-1 normalized)
    swapVelRef: 0.06,          // swapVelocity reference (0-1 normalized)
    migrationSlopeMax: 0.002,  // Maximum migration slope for full stability score
} as const;

/**
 * Edge Stability Filter Thresholds
 */
const EDGE_STABILITY = {
    minEdgeScore: 0.55,        // Minimum edge score for boost eligibility
    minConsecutiveCycles: 3,   // Minimum consecutive eligible cycles
} as const;

/**
 * Capital Multiplier Configuration
 */
const EDGE_CAPITAL = {
    multiplierBase: 1.0,       // Base multiplier (no boost)
    multiplierSlope: 0.8,      // Slope for boost curve: (edgeScore - 0.55) * slope
    multiplierMin: 1.0,        // Minimum multiplier
    multiplierMax: 1.35,       // Maximum multiplier (35% boost cap)
} as const;

/**
 * Portfolio-Level Safety Cap
 */
const EDGE_PORTFOLIO = {
    maxBoostedCapitalPct: 0.60, // Max 60% of deployed capital can be edge-boosted
} as const;

/**
 * Rate Limiter
 */
const EDGE_RATE_LIMIT = {
    maxEdgeDeltaPerCycle: 0.10, // Maximum edge score change per cycle
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inputs for edge score computation
 */
export interface EdgeScoreInputs {
    poolAddress: string;
    poolName: string;
    
    // Core signals (already available in Tier4EnrichedPool)
    oscScore: number;          // Oscillation score from adaptiveBinWidth (0-1)
    binVelRaw: number;         // Bin velocity (0-100 from microMetrics)
    swapVelRaw: number;        // Swap velocity (0-100 from microMetrics)
    migrationSlope: number;    // Liquidity slope (can be negative)
    
    // Context for boost removal
    regime: string;            // Current market regime
    isForceExit?: boolean;     // Whether position is being force-exited
    isVolatilityBreach?: boolean; // Whether volatility limits breached
}

/**
 * Result of edge score computation
 */
export interface EdgeScoreResult {
    poolAddress: string;
    poolName: string;
    
    // Core output
    edgeScore: number;         // 0-1 edge score
    edgeCapitalMultiplier: number; // 1.0-1.35 capital multiplier
    
    // Input components (for logging)
    components: {
        oscScore: number;
        binVel: number;        // Normalized 0-1
        swapVel: number;       // Normalized 0-1
        migrationStability: number; // 0-1
    };
    
    // Stability tracking
    consecutiveEligibleCycles: number;
    isStable: boolean;         // Meets stability filter
    isBoosted: boolean;        // Edge boost is active
    
    // Rate limiting
    previousEdgeScore: number | null;
    rateLimited: boolean;
    
    // Metadata
    timestamp: number;
}

/**
 * Per-pool edge tracking state
 */
interface PoolEdgeState {
    lastEdgeScore: number;
    consecutiveEligibleCycles: number;
    lastUpdateTs: number;
    lastEligible: boolean;
    boostedCapitalUsd: number; // Track boosted capital for portfolio cap
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE — PER-POOL EDGE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-pool edge state tracking
 */
const poolEdgeState = new Map<string, PoolEdgeState>();

/**
 * Total edge-boosted capital across portfolio (USD)
 */
let totalBoostedCapitalUsd = 0;

/**
 * Total deployed capital (USD) — updated externally
 */
let totalDeployedCapitalUsd = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp value to 0-1 range
 */
function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/**
 * Clamp value to arbitrary range
 */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE EDGE SCORE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute raw edge score from input signals
 * 
 * edgeScore = 
 *   0.45 * oscScore +
 *   0.25 * clamp01(binVelRaw / 0.60) +
 *   0.20 * clamp01(swapVelRaw / 0.06) +
 *   0.10 * clamp01(1 - abs(migrationSlope) / 0.002)
 */
function computeRawEdgeScore(inputs: EdgeScoreInputs): {
    edgeScore: number;
    components: {
        oscScore: number;
        binVel: number;
        swapVel: number;
        migrationStability: number;
    };
} {
    // Normalize binVelRaw and swapVelRaw from 0-100 to 0-1
    const binVelNorm = inputs.binVelRaw / 100;
    const swapVelNorm = inputs.swapVelRaw / 100;
    
    // Compute individual components
    const oscComponent = inputs.oscScore; // Already 0-1
    const binVelComponent = clamp01(binVelNorm / EDGE_REFERENCES.binVelRef);
    const swapVelComponent = clamp01(swapVelNorm / EDGE_REFERENCES.swapVelRef);
    const migrationStabilityComponent = clamp01(
        1 - Math.abs(inputs.migrationSlope) / EDGE_REFERENCES.migrationSlopeMax
    );
    
    // Compute weighted edge score
    const rawScore = 
        EDGE_WEIGHTS.oscScore * oscComponent +
        EDGE_WEIGHTS.binVel * binVelComponent +
        EDGE_WEIGHTS.swapVel * swapVelComponent +
        EDGE_WEIGHTS.migrationStability * migrationStabilityComponent;
    
    // Apply hard floor
    const edgeScore = Math.max(rawScore, 0);
    
    return {
        edgeScore,
        components: {
            oscScore: oscComponent,
            binVel: binVelComponent,
            swapVel: swapVelComponent,
            migrationStability: migrationStabilityComponent,
        },
    };
}

/**
 * Compute edge capital multiplier from edge score
 * 
 * edgeCapitalMultiplier = clamp(1.0 + (edgeScore - 0.55) * 0.8, 1.0, 1.35)
 */
function computeEdgeCapitalMultiplier(edgeScore: number, isStable: boolean): number {
    if (!isStable) {
        return EDGE_CAPITAL.multiplierBase;
    }
    
    const rawMultiplier = 
        EDGE_CAPITAL.multiplierBase + 
        (edgeScore - EDGE_STABILITY.minEdgeScore) * EDGE_CAPITAL.multiplierSlope;
    
    return clamp(
        rawMultiplier,
        EDGE_CAPITAL.multiplierMin,
        EDGE_CAPITAL.multiplierMax
    );
}

/**
 * Apply rate limiter to edge score change
 */
function applyEdgeRateLimiter(
    poolAddress: string,
    proposedScore: number
): { finalScore: number; previousScore: number | null; rateLimited: boolean } {
    const state = poolEdgeState.get(poolAddress);
    
    if (!state) {
        return { finalScore: proposedScore, previousScore: null, rateLimited: false };
    }
    
    const delta = proposedScore - state.lastEdgeScore;
    const maxDelta = EDGE_RATE_LIMIT.maxEdgeDeltaPerCycle;
    
    if (Math.abs(delta) > maxDelta) {
        // Rate limit the change
        const clampedScore = state.lastEdgeScore + Math.sign(delta) * maxDelta;
        return { 
            finalScore: clamp01(clampedScore), 
            previousScore: state.lastEdgeScore, 
            rateLimited: true 
        };
    }
    
    return { finalScore: proposedScore, previousScore: state.lastEdgeScore, rateLimited: false };
}

/**
 * Check if boost removal conditions are met
 * 
 * REGIME_ECONOMIC_IMPACT=DISABLED: CHAOS regime check removed.
 */
function shouldRemoveBoost(inputs: EdgeScoreInputs): { remove: boolean; reason: string | null } {
    // NEUTRALIZED: CHAOS regime no longer removes boost
    // Regime is observation only in fee harvester mode
    // if (inputs.regime === 'CHAOS') { ... }
    
    // Forced exit → remove boost
    if (inputs.isForceExit) {
        return { remove: true, reason: 'FORCED_EXIT' };
    }
    
    // Migration slope breach → remove boost
    if (Math.abs(inputs.migrationSlope) > EDGE_REFERENCES.migrationSlopeMax) {
        return { remove: true, reason: 'MIGRATION_BREACH' };
    }
    
    // Volatility breach → remove boost
    if (inputs.isVolatilityBreach) {
        return { remove: true, reason: 'VOLATILITY_BREACH' };
    }
    
    return { remove: false, reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API — EDGE SCORE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute edge score and capital multiplier for a pool
 * 
 * This is the main entry point, called once per eligible pool per scan cycle.
 */
export function computeEdgeScore(inputs: EdgeScoreInputs): EdgeScoreResult {
    const now = Date.now();
    
    // Get or create pool state
    let state = poolEdgeState.get(inputs.poolAddress);
    if (!state) {
        state = {
            lastEdgeScore: 0,
            consecutiveEligibleCycles: 0,
            lastUpdateTs: 0,
            lastEligible: false,
            boostedCapitalUsd: 0,
        };
        poolEdgeState.set(inputs.poolAddress, state);
    }
    
    // Check boost removal conditions
    const boostRemoval = shouldRemoveBoost(inputs);
    if (boostRemoval.remove) {
        // Reset eligibility and boost
        state.consecutiveEligibleCycles = 0;
        state.lastEligible = false;
        state.boostedCapitalUsd = 0;
        
        return {
            poolAddress: inputs.poolAddress,
            poolName: inputs.poolName,
            edgeScore: 0,
            edgeCapitalMultiplier: 1.0,
            components: { oscScore: 0, binVel: 0, swapVel: 0, migrationStability: 0 },
            consecutiveEligibleCycles: 0,
            isStable: false,
            isBoosted: false,
            previousEdgeScore: state.lastEdgeScore,
            rateLimited: false,
            timestamp: now,
        };
    }
    
    // Compute raw edge score
    const { edgeScore: rawScore, components } = computeRawEdgeScore(inputs);
    
    // Apply rate limiter
    const { finalScore, previousScore, rateLimited } = applyEdgeRateLimiter(
        inputs.poolAddress,
        rawScore
    );
    
    // Check eligibility (edgeScore >= 0.55)
    const isEligible = finalScore >= EDGE_STABILITY.minEdgeScore;
    
    // Update consecutive cycles
    if (isEligible) {
        if (state.lastEligible) {
            state.consecutiveEligibleCycles++;
        } else {
            state.consecutiveEligibleCycles = 1;
        }
    } else {
        state.consecutiveEligibleCycles = 0;
    }
    state.lastEligible = isEligible;
    
    // Check stability filter
    const isStable = isEligible && 
        state.consecutiveEligibleCycles >= EDGE_STABILITY.minConsecutiveCycles;
    
    // Compute capital multiplier
    const edgeCapitalMultiplier = computeEdgeCapitalMultiplier(finalScore, isStable);
    const isBoosted = edgeCapitalMultiplier > 1.0;
    
    // Update state
    state.lastEdgeScore = finalScore;
    state.lastUpdateTs = now;
    
    // Build result
    const result: EdgeScoreResult = {
        poolAddress: inputs.poolAddress,
        poolName: inputs.poolName,
        edgeScore: Math.round(finalScore * 1000) / 1000, // 3 decimal places
        edgeCapitalMultiplier: Math.round(edgeCapitalMultiplier * 1000) / 1000,
        components,
        consecutiveEligibleCycles: state.consecutiveEligibleCycles,
        isStable,
        isBoosted,
        previousEdgeScore: previousScore,
        rateLimited,
        timestamp: now,
    };
    
    // Log result (exactly one INFO log per eligible pool per cycle)
    logEdgeWeight(result, inputs);
    
    return result;
}

/**
 * Apply portfolio-level safety cap to edge multiplier
 * 
 * Σ(edgeBoostedCapital) ≤ 60% of total deployed capital
 * 
 * @param poolAddress - Pool address
 * @param baseSize - Base position size before edge boost
 * @param edgeMultiplier - Raw edge capital multiplier
 * @returns Adjusted multiplier after portfolio cap
 */
export function applyPortfolioEdgeCap(
    poolAddress: string,
    baseSize: number,
    edgeMultiplier: number
): { adjustedMultiplier: number; cappedByPortfolio: boolean } {
    if (edgeMultiplier <= 1.0 || totalDeployedCapitalUsd <= 0) {
        return { adjustedMultiplier: edgeMultiplier, cappedByPortfolio: false };
    }
    
    // Calculate proposed boost amount
    const proposedBoostedSize = baseSize * edgeMultiplier;
    const boostAmount = proposedBoostedSize - baseSize;
    
    // Get current pool's existing boost
    const state = poolEdgeState.get(poolAddress);
    const existingPoolBoost = state?.boostedCapitalUsd ?? 0;
    
    // Calculate total boosted after this addition
    const newTotalBoosted = totalBoostedCapitalUsd - existingPoolBoost + boostAmount;
    
    // Check against cap
    const maxBoosted = totalDeployedCapitalUsd * EDGE_PORTFOLIO.maxBoostedCapitalPct;
    
    if (newTotalBoosted <= maxBoosted) {
        // Within cap — allow full boost
        return { adjustedMultiplier: edgeMultiplier, cappedByPortfolio: false };
    }
    
    // Exceeds cap — scale down proportionally
    const availableBoostedRoom = maxBoosted - (totalBoostedCapitalUsd - existingPoolBoost);
    
    if (availableBoostedRoom <= 0) {
        // No room for boost
        return { adjustedMultiplier: 1.0, cappedByPortfolio: true };
    }
    
    // Compute scaled multiplier
    const scaledBoost = availableBoostedRoom;
    const scaledMultiplier = 1.0 + scaledBoost / baseSize;
    
    return { 
        adjustedMultiplier: clamp(scaledMultiplier, 1.0, edgeMultiplier), 
        cappedByPortfolio: true 
    };
}

/**
 * Record deployed capital for a position (for portfolio cap tracking)
 * Call after position entry
 */
export function recordEdgeDeployment(
    poolAddress: string,
    baseSize: number,
    appliedMultiplier: number
): void {
    const state = poolEdgeState.get(poolAddress);
    if (!state) return;
    
    const boostedAmount = baseSize * (appliedMultiplier - 1.0);
    
    // Update pool state
    state.boostedCapitalUsd = boostedAmount;
    
    // Update portfolio total
    totalBoostedCapitalUsd += boostedAmount;
}

/**
 * Record position close (for portfolio cap tracking)
 * Call on position exit
 */
export function recordEdgeExit(poolAddress: string): void {
    const state = poolEdgeState.get(poolAddress);
    if (!state) return;
    
    // Remove from portfolio total
    totalBoostedCapitalUsd = Math.max(0, totalBoostedCapitalUsd - state.boostedCapitalUsd);
    
    // Clear pool boost tracking
    state.boostedCapitalUsd = 0;
    state.consecutiveEligibleCycles = 0;
    state.lastEligible = false;
}

/**
 * Update total deployed capital (call from capital manager)
 */
export function updateTotalDeployedCapital(deployedUsd: number): void {
    totalDeployedCapitalUsd = deployedUsd;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log edge weight result (exactly one INFO log per eligible pool per cycle)
 */
function logEdgeWeight(result: EdgeScoreResult, inputs: EdgeScoreInputs): void {
    logger.info(
        `[EDGE-WEIGHT] ` +
        `pool=${inputs.poolAddress.slice(0, 8)}... ` +
        `edgeScore=${result.edgeScore.toFixed(3)} ` +
        `oscScore=${result.components.oscScore.toFixed(3)} ` +
        `binVel=${result.components.binVel.toFixed(3)} ` +
        `swapVel=${result.components.swapVel.toFixed(3)} ` +
        `slope=${inputs.migrationSlope.toFixed(6)} ` +
        `multiplier=${result.edgeCapitalMultiplier.toFixed(3)} ` +
        `prev=${result.previousEdgeScore?.toFixed(3) ?? 'null'} ` +
        `boosted=${result.isBoosted}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE ACCESSORS — FOR DIAGNOSTICS AND INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current edge state for a pool
 */
export function getPoolEdgeState(poolAddress: string): PoolEdgeState | undefined {
    return poolEdgeState.get(poolAddress);
}

/**
 * Get edge capital multiplier for a pool (for sizing integration)
 * Returns 1.0 if pool has no edge state or is not boosted
 */
export function getEdgeCapitalMultiplier(poolAddress: string): number {
    const state = poolEdgeState.get(poolAddress);
    if (!state) return 1.0;
    
    // Check if still stable
    const isStable = state.lastEligible && 
        state.consecutiveEligibleCycles >= EDGE_STABILITY.minConsecutiveCycles;
    
    if (!isStable) return 1.0;
    
    return computeEdgeCapitalMultiplier(state.lastEdgeScore, isStable);
}

/**
 * Check if a pool is currently edge-boosted
 */
export function isPoolEdgeBoosted(poolAddress: string): boolean {
    return getEdgeCapitalMultiplier(poolAddress) > 1.0;
}

/**
 * Get summary of all edge-boosted pools
 */
export function getEdgeScoreSummary(): {
    totalTrackedPools: number;
    boostedPools: number;
    totalBoostedCapitalUsd: number;
    totalDeployedCapitalUsd: number;
    boostedCapitalPct: number;
    pools: Array<{ address: string; edgeScore: number; multiplier: number; cycles: number }>;
} {
    const pools: Array<{ address: string; edgeScore: number; multiplier: number; cycles: number }> = [];
    let boostedCount = 0;
    
    for (const [address, state] of poolEdgeState) {
        const multiplier = getEdgeCapitalMultiplier(address);
        if (multiplier > 1.0) {
            boostedCount++;
        }
        pools.push({
            address,
            edgeScore: state.lastEdgeScore,
            multiplier,
            cycles: state.consecutiveEligibleCycles,
        });
    }
    
    const boostedCapitalPct = totalDeployedCapitalUsd > 0
        ? totalBoostedCapitalUsd / totalDeployedCapitalUsd
        : 0;
    
    return {
        totalTrackedPools: poolEdgeState.size,
        boostedPools: boostedCount,
        totalBoostedCapitalUsd,
        totalDeployedCapitalUsd,
        boostedCapitalPct,
        pools,
    };
}

/**
 * Clear all edge state (for testing/reset)
 */
export function clearEdgeState(): void {
    poolEdgeState.clear();
    totalBoostedCapitalUsd = 0;
    totalDeployedCapitalUsd = 0;
    logger.info('[EDGE-WEIGHT] State cleared');
}

/**
 * Clear edge state for a specific pool (on position close)
 */
export function clearPoolEdgeState(poolAddress: string): void {
    recordEdgeExit(poolAddress);
    poolEdgeState.delete(poolAddress);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS — CONFIGURATION CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const EDGE_SCORING_CONFIG = {
    EDGE_WEIGHTS,
    EDGE_REFERENCES,
    EDGE_STABILITY,
    EDGE_CAPITAL,
    EDGE_PORTFOLIO,
    EDGE_RATE_LIMIT,
};

