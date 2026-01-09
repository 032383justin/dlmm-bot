/**
 * Fee Velocity Acceleration (FVA) — Core Compounding Engine
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * OBJECTIVE: Maximize daily compounded returns via fee velocity tracking.
 * 
 * DEFINITIONS:
 *   feeVelocity     = fees_per_hour (USD/hour)
 *   feeAcceleration = d(feeVelocity)/dt over rolling 2-5 minute windows
 * 
 * RULES:
 *   Positive acceleration → aggressive entry bias
 *   Negative acceleration → size suppression or exit bias
 *   Flat velocity        → neutral hold
 * 
 * FVA OVERRIDES:
 *   - Static thresholds
 *   - Historical averages
 *   - EV calculations (EV is TELEMETRY ONLY)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// FVA CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const FVA_CONFIG = {
    /** Rolling window for acceleration calculation (minutes) */
    ACCELERATION_WINDOW_MINUTES: 3,
    
    /** Minimum samples in window for valid acceleration */
    MIN_SAMPLES_FOR_ACCELERATION: 2,
    
    /** Acceleration thresholds */
    ACCELERATION: {
        /** Above this = aggressive entry bias (USD/hour per minute) */
        AGGRESSIVE_THRESHOLD: 0.05,
        
        /** Below this = exit/suppress bias (negative) */
        SUPPRESS_THRESHOLD: -0.03,
        
        /** Within these bounds = neutral hold */
        NEUTRAL_BAND: 0.02,
    },
    
    /** Velocity thresholds for sizing */
    VELOCITY: {
        /** Above this = max size allowed */
        HIGH_VELOCITY: 5.0,      // $5/hour
        
        /** Below this = reduce size */
        LOW_VELOCITY: 0.50,      // $0.50/hour
        
        /** Below this = minimum size only */
        MINIMUM_VELOCITY: 0.10,  // $0.10/hour
    },
    
    /** Size multipliers based on acceleration */
    SIZE_MULTIPLIERS: {
        ACCELERATING: 1.5,      // +50% size
        NEUTRAL: 1.0,           // Normal size
        DECELERATING: 0.6,      // -40% size
        COLLAPSING: 0.3,        // -70% size (exit candidate)
    },
    
    /** Compounding threshold - reinvest if velocity improves by this % */
    COMPOUND_VELOCITY_IMPROVEMENT_PCT: 0.10,  // 10%
    
    /** Capital concentration - % of capital in top pools */
    CONCENTRATION: {
        TARGET_TOP_POOL_PCT: 0.45,   // 45% in top pool
        TARGET_TOP2_PCT: 0.80,       // 80% in top 2 pools
        MAX_POOLS: 3,                 // Never more than 3 pools
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════

interface VelocitySample {
    timestamp: number;
    feeVelocity: number;  // USD/hour
    fees24h: number;      // Source data
    tvl: number;
}

interface FVAState {
    samples: VelocitySample[];
    currentVelocity: number;
    currentAcceleration: number;
    accelerationTrend: 'ACCELERATING' | 'DECELERATING' | 'FLAT' | 'COLLAPSING';
    lastUpdate: number;
}

interface FVAResult {
    poolAddress: string;
    feeVelocity: number;           // USD/hour
    feeAcceleration: number;       // USD/hour per minute
    trend: 'ACCELERATING' | 'DECELERATING' | 'FLAT' | 'COLLAPSING';
    sizeMultiplier: number;        // Applied to position sizing
    entryBias: 'AGGRESSIVE' | 'NEUTRAL' | 'SUPPRESS';  // No EXIT for entry bias
    shouldCompound: boolean;       // True if velocity improvement > threshold
    concentrationScore: number;    // 0-1, higher = prioritize for concentration
    isValid: boolean;
    reason?: string;
}

export type { FVAResult };

// Pool FVA state storage
const poolFVAState = new Map<string, FVAState>();

// ═══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE METRICS TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

interface PerformanceMetrics {
    dailyCompoundedReturn: number;      // % daily return
    feeVelocityPerDollar: number;       // fees/hour per $1 deployed
    reinvestmentEfficiency: number;     // ratio of reinvested vs withdrawn
    timeToCapitalPayback: number;       // minutes to recover entry cost
    totalFeesAccrued: number;           // USD
    totalCapitalDeployed: number;       // USD
    startTimestamp: number;
    lastUpdate: number;
}

let performanceMetrics: PerformanceMetrics = {
    dailyCompoundedReturn: 0,
    feeVelocityPerDollar: 0,
    reinvestmentEfficiency: 0,
    timeToCapitalPayback: 0,
    totalFeesAccrued: 0,
    totalCapitalDeployed: 0,
    startTimestamp: Date.now(),
    lastUpdate: Date.now(),
};

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FVA COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a fee velocity sample for a pool
 */
export function recordFeeVelocitySample(
    poolAddress: string,
    fees24h: number,
    tvl: number,
): void {
    const now = Date.now();
    
    // Compute current fee velocity (USD/hour)
    const feeVelocity = fees24h / 24;
    
    let state = poolFVAState.get(poolAddress);
    if (!state) {
        state = {
            samples: [],
            currentVelocity: feeVelocity,
            currentAcceleration: 0,
            accelerationTrend: 'FLAT',
            lastUpdate: now,
        };
        poolFVAState.set(poolAddress, state);
    }
    
    // Add sample
    state.samples.push({
        timestamp: now,
        feeVelocity,
        fees24h,
        tvl,
    });
    
    // Trim to window
    const windowMs = FVA_CONFIG.ACCELERATION_WINDOW_MINUTES * 60 * 1000;
    state.samples = state.samples.filter(s => now - s.timestamp <= windowMs);
    
    // Compute acceleration if enough samples
    if (state.samples.length >= FVA_CONFIG.MIN_SAMPLES_FOR_ACCELERATION) {
        const oldest = state.samples[0];
        const newest = state.samples[state.samples.length - 1];
        const dtMinutes = (newest.timestamp - oldest.timestamp) / 60000;
        
        if (dtMinutes > 0) {
            state.currentAcceleration = (newest.feeVelocity - oldest.feeVelocity) / dtMinutes;
        }
    }
    
    state.currentVelocity = feeVelocity;
    state.lastUpdate = now;
    
    // Classify trend
    const accel = state.currentAcceleration;
    if (accel >= FVA_CONFIG.ACCELERATION.AGGRESSIVE_THRESHOLD) {
        state.accelerationTrend = 'ACCELERATING';
    } else if (accel <= FVA_CONFIG.ACCELERATION.SUPPRESS_THRESHOLD * 2) {
        state.accelerationTrend = 'COLLAPSING';
    } else if (accel <= FVA_CONFIG.ACCELERATION.SUPPRESS_THRESHOLD) {
        state.accelerationTrend = 'DECELERATING';
    } else {
        state.accelerationTrend = 'FLAT';
    }
    
    poolFVAState.set(poolAddress, state);
}

/**
 * Evaluate FVA for a pool - returns entry bias, size multiplier, and concentration score
 */
export function evaluateFVA(poolAddress: string, fees24h: number, tvl: number): FVAResult {
    // Record sample first
    recordFeeVelocitySample(poolAddress, fees24h, tvl);
    
    const state = poolFVAState.get(poolAddress);
    if (!state || state.samples.length < FVA_CONFIG.MIN_SAMPLES_FOR_ACCELERATION) {
        // Not enough data - use velocity only
        const velocity = fees24h / 24;
        return {
            poolAddress,
            feeVelocity: velocity,
            feeAcceleration: 0,
            trend: 'FLAT',
            sizeMultiplier: velocity >= FVA_CONFIG.VELOCITY.LOW_VELOCITY ? 1.0 : 0.6,
            entryBias: velocity >= FVA_CONFIG.VELOCITY.MINIMUM_VELOCITY ? 'NEUTRAL' : 'SUPPRESS',
            shouldCompound: false,
            concentrationScore: velocity / FVA_CONFIG.VELOCITY.HIGH_VELOCITY,
            isValid: true,
            reason: 'Insufficient samples for acceleration',
        };
    }
    
    const { currentVelocity, currentAcceleration, accelerationTrend } = state;
    
    // Determine size multiplier
    let sizeMultiplier: number;
    switch (accelerationTrend) {
        case 'ACCELERATING':
            sizeMultiplier = FVA_CONFIG.SIZE_MULTIPLIERS.ACCELERATING;
            break;
        case 'DECELERATING':
            sizeMultiplier = FVA_CONFIG.SIZE_MULTIPLIERS.DECELERATING;
            break;
        case 'COLLAPSING':
            sizeMultiplier = FVA_CONFIG.SIZE_MULTIPLIERS.COLLAPSING;
            break;
        default:
            sizeMultiplier = FVA_CONFIG.SIZE_MULTIPLIERS.NEUTRAL;
    }
    
    // Velocity-based size adjustment
    if (currentVelocity < FVA_CONFIG.VELOCITY.MINIMUM_VELOCITY) {
        sizeMultiplier *= 0.5;  // Further reduce for very low velocity
    } else if (currentVelocity >= FVA_CONFIG.VELOCITY.HIGH_VELOCITY) {
        sizeMultiplier *= 1.2;  // Boost for high velocity
    }
    
    // Determine entry bias
    // Note: 'EXIT' is not used for entry bias - use 'SUPPRESS' for both DECELERATING and COLLAPSING
    let entryBias: 'AGGRESSIVE' | 'NEUTRAL' | 'SUPPRESS';
    if (accelerationTrend === 'ACCELERATING') {
        entryBias = 'AGGRESSIVE';
    } else if (accelerationTrend === 'COLLAPSING' || accelerationTrend === 'DECELERATING') {
        entryBias = 'SUPPRESS';
    } else {
        entryBias = 'NEUTRAL';
    }
    
    // Should compound check - velocity improved by threshold
    const previousVelocity = state.samples.length > 1 
        ? state.samples[state.samples.length - 2].feeVelocity 
        : currentVelocity;
    const velocityImprovement = previousVelocity > 0 
        ? (currentVelocity - previousVelocity) / previousVelocity 
        : 0;
    const shouldCompound = velocityImprovement >= FVA_CONFIG.COMPOUND_VELOCITY_IMPROVEMENT_PCT;
    
    // Concentration score (0-1) - higher means prioritize for capital
    const concentrationScore = Math.min(1.0, (
        (currentVelocity / FVA_CONFIG.VELOCITY.HIGH_VELOCITY) * 0.6 +
        (accelerationTrend === 'ACCELERATING' ? 0.4 : 
         accelerationTrend === 'FLAT' ? 0.2 : 0)
    ));
    
    logger.debug(
        `[FVA] pool=${poolAddress.slice(0, 8)} velocity=$${currentVelocity.toFixed(2)}/h ` +
        `accel=${currentAcceleration.toFixed(4)}/min trend=${accelerationTrend} ` +
        `sizeMult=${sizeMultiplier.toFixed(2)} bias=${entryBias} ` +
        `compound=${shouldCompound} concScore=${concentrationScore.toFixed(2)}`
    );
    
    return {
        poolAddress,
        feeVelocity: currentVelocity,
        feeAcceleration: currentAcceleration,
        trend: accelerationTrend,
        sizeMultiplier,
        entryBias,
        shouldCompound,
        concentrationScore,
        isValid: true,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL CONCENTRATION
// ═══════════════════════════════════════════════════════════════════════════════

interface PoolConcentration {
    poolAddress: string;
    feeVelocity: number;
    concentrationScore: number;
    recommendedAllocationPct: number;
}

/**
 * Compute optimal capital concentration across pools
 * Returns recommended allocation percentages (sum = 1.0)
 */
export function computeCapitalConcentration(
    pools: Array<{ address: string; fees24h: number; tvl: number }>
): PoolConcentration[] {
    if (pools.length === 0) return [];
    
    // Evaluate FVA for all pools
    const evaluations = pools.map(p => ({
        ...evaluateFVA(p.address, p.fees24h, p.tvl),
        tvl: p.tvl,
    }));
    
    // Sort by concentration score (descending)
    evaluations.sort((a, b) => b.concentrationScore - a.concentrationScore);
    
    // Take top N pools
    const topPools = evaluations.slice(0, FVA_CONFIG.CONCENTRATION.MAX_POOLS);
    
    // Compute allocations
    const result: PoolConcentration[] = [];
    let remainingAlloc = 1.0;
    
    for (let i = 0; i < topPools.length; i++) {
        const pool = topPools[i];
        let allocation: number;
        
        if (i === 0) {
            // Top pool gets target allocation
            allocation = FVA_CONFIG.CONCENTRATION.TARGET_TOP_POOL_PCT;
        } else if (i === 1) {
            // Second pool gets remainder to hit top-2 target
            allocation = FVA_CONFIG.CONCENTRATION.TARGET_TOP2_PCT - 
                        FVA_CONFIG.CONCENTRATION.TARGET_TOP_POOL_PCT;
        } else {
            // Remaining pools split the rest
            allocation = remainingAlloc / (topPools.length - i);
        }
        
        allocation = Math.min(allocation, remainingAlloc);
        remainingAlloc -= allocation;
        
        result.push({
            poolAddress: pool.poolAddress,
            feeVelocity: pool.feeVelocity,
            concentrationScore: pool.concentrationScore,
            recommendedAllocationPct: allocation,
        });
    }
    
    logger.info(
        `[FVA-CONCENTRATION] Top ${result.length} pools: ` +
        result.map(p => `${p.poolAddress.slice(0, 6)}:${(p.recommendedAllocationPct * 100).toFixed(0)}%`).join(' ')
    );
    
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOUNDING DECISION
// ═══════════════════════════════════════════════════════════════════════════════

interface CompoundDecision {
    shouldCompound: boolean;
    reason: string;
    velocityBefore: number;
    velocityAfterEstimate: number;
    improvementPct: number;
}

/**
 * Determine if fees should be compounded back into position
 * 
 * Rule: Compound if ΔfeeVelocity after reinvest >= COMPOUND_THRESHOLD
 */
export function evaluateCompoundDecision(
    poolAddress: string,
    currentFees24h: number,
    currentTvl: number,
    feesToCompound: number,
): CompoundDecision {
    const state = poolFVAState.get(poolAddress);
    const currentVelocity = currentFees24h / 24;
    
    // Estimate velocity after compounding
    // Assumption: Adding capital proportionally increases fee capture
    const positionShare = feesToCompound / currentTvl;
    const velocityIncrease = currentVelocity * positionShare;
    const velocityAfter = currentVelocity + velocityIncrease;
    
    const improvementPct = currentVelocity > 0 
        ? (velocityAfter - currentVelocity) / currentVelocity 
        : 0;
    
    const shouldCompound = improvementPct >= FVA_CONFIG.COMPOUND_VELOCITY_IMPROVEMENT_PCT;
    
    const decision: CompoundDecision = {
        shouldCompound,
        reason: shouldCompound 
            ? `Velocity improvement ${(improvementPct * 100).toFixed(1)}% >= ${(FVA_CONFIG.COMPOUND_VELOCITY_IMPROVEMENT_PCT * 100).toFixed(0)}% threshold`
            : `Velocity improvement ${(improvementPct * 100).toFixed(1)}% < ${(FVA_CONFIG.COMPOUND_VELOCITY_IMPROVEMENT_PCT * 100).toFixed(0)}% threshold`,
        velocityBefore: currentVelocity,
        velocityAfterEstimate: velocityAfter,
        improvementPct,
    };
    
    logger.info(
        `[FVA-COMPOUND] pool=${poolAddress.slice(0, 8)} ` +
        `velBefore=$${currentVelocity.toFixed(2)}/h velAfter=$${velocityAfter.toFixed(2)}/h ` +
        `improvement=${(improvementPct * 100).toFixed(1)}% compound=${shouldCompound}`
    );
    
    return decision;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE METRICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update performance metrics
 */
export function updatePerformanceMetrics(
    feesAccrued: number,
    capitalDeployed: number,
    entryTimestamp?: number,
    entryCost?: number,
): void {
    const now = Date.now();
    
    performanceMetrics.totalFeesAccrued += feesAccrued;
    performanceMetrics.totalCapitalDeployed = capitalDeployed;
    performanceMetrics.lastUpdate = now;
    
    // Compute daily compounded return
    const runtimeMs = now - performanceMetrics.startTimestamp;
    const runtimeDays = runtimeMs / (24 * 60 * 60 * 1000);
    
    if (runtimeDays > 0 && capitalDeployed > 0) {
        // Total return as %
        const totalReturn = performanceMetrics.totalFeesAccrued / capitalDeployed;
        // Annualized daily rate
        performanceMetrics.dailyCompoundedReturn = totalReturn / runtimeDays * 100;
    }
    
    // Fee velocity per dollar
    if (capitalDeployed > 0) {
        performanceMetrics.feeVelocityPerDollar = 
            (performanceMetrics.totalFeesAccrued / runtimeDays / 24) / capitalDeployed;
    }
    
    // Time to capital payback
    if (entryTimestamp && entryCost && feesAccrued >= entryCost) {
        performanceMetrics.timeToCapitalPayback = (now - entryTimestamp) / 60000;  // minutes
    }
}

/**
 * Get current performance metrics
 */
export function getPerformanceMetrics(): PerformanceMetrics {
    return { ...performanceMetrics };
}

/**
 * Reset performance metrics (for new session)
 */
export function resetPerformanceMetrics(): void {
    performanceMetrics = {
        dailyCompoundedReturn: 0,
        feeVelocityPerDollar: 0,
        reinvestmentEfficiency: 0,
        timeToCapitalPayback: 0,
        totalFeesAccrued: 0,
        totalCapitalDeployed: 0,
        startTimestamp: Date.now(),
        lastUpdate: Date.now(),
    };
    logger.info(`[FVA-PERF] Performance metrics reset`);
}

/**
 * Log performance summary
 */
export function logPerformanceSummary(): void {
    const m = performanceMetrics;
    const runtimeHours = (m.lastUpdate - m.startTimestamp) / 3600000;
    
    logger.info(
        `[FVA-PERF] DAILY_RETURN=${m.dailyCompoundedReturn.toFixed(2)}% | ` +
        `fees/$/h=${m.feeVelocityPerDollar.toFixed(4)} | ` +
        `totalFees=$${m.totalFeesAccrued.toFixed(2)} | ` +
        `deployed=$${m.totalCapitalDeployed.toFixed(0)} | ` +
        `runtime=${runtimeHours.toFixed(1)}h | ` +
        `payback=${m.timeToCapitalPayback.toFixed(0)}min`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export function clearFVAState(poolAddress: string): void {
    poolFVAState.delete(poolAddress);
}

export function getFVAState(poolAddress: string): FVAState | undefined {
    return poolFVAState.get(poolAddress);
}

export function getAllFVAStates(): Map<string, FVAState> {
    return new Map(poolFVAState);
}

