/**
 * Predator Controller - Tier 4 Unified Microstructure Engine
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE UNIFIED CONTROL CENTER FOR ALL PREDATOR MODULES
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This controller orchestrates:
 * - Microstructure Health Index (MHI) for position sizing
 * - Non-Equilibrium Reinjection Engine for structural re-entries
 * - Cross-Pool Reflexivity Scoring for ecosystem opportunities
 * - Adaptive Snapshot Frequency for efficient telemetry
 * - Dynamic Stop Harmonics for volatility-sensitive exits
 * - Pool Personality Profiling for specialist focus
 * 
 * BEHAVIORAL PRINCIPLES:
 * 1. Become a SPECIALIST, not a generalist
 *    - Bots that trade 500 pools LOSE
 *    - Bots that trade 5 pools like predators WIN
 * 
 * 2. Never exit on PRICE - exit on STRUCTURE
 *    - No profit targets
 *    - No trailing stops
 *    - You trade MICROSTRUCTURE, not chart shapes
 * 
 * 3. MHI controls ALL sizing decisions
 *    - Not score, not tier, not cap
 *    - MHI is the final gatekeeper
 * 
 * 4. Reinjection is STRUCTURAL
 *    - Wait for prey to stumble
 *    - Only re-enter when structure heals
 *    - You are not a DCA bot
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// Import all predator modules
import {
    computeMHI,
    passesMHIGating,
    getMHIAdjustedSize,
    canScaleWithMHI,
    rankPoolsByMHI,
    logMHI,
    logMHISummary,
    MHIResult,
    MHISizingTier,
    MHI_THRESHOLDS,
} from './microstructureHealthIndex';

import {
    registerExit,
    updateReinjectionTracking,
    evaluateReinjection,
    getReinjectionOpportunities,
    consumeReinjection,
    isTrackingReinjection,
    isBlacklisted,
    getReinjectionStats,
    logReinjectionOpportunities,
    clearReinjectionState,
    ReinjectionOpportunity,
    ReinjectionEvaluation,
} from './reinjectionEngine';

import {
    registerPoolTokens,
    updateEcosystemState,
    buildTokenCorrelations,
    computeReflexivity,
    getPredatorOpportunities,
    getMigrationTargets,
    updatePoolPersonality,
    getPoolPersonality,
    getTopTrustedPools,
    isSpecialistPool,
    updateAllEcosystemStates,
    getAllReflexivityScores,
    logReflexivitySummary,
    logSpecialistPools,
    clearReflexivityState,
    ReflexivityResult,
    PoolPersonality,
} from './reflexivityEngine';

import {
    computePoolSnapshotInterval,
    updatePoolFrequencyState,
    markSnapshotTaken,
    isSnapshotDue,
    getSnapshotSchedule,
    updateGlobalFrequencyState,
    getGlobalSnapshotInterval,
    getPoolsDueForSnapshot,
    getPrioritizedSchedule,
    logAdaptiveSnapshotSummary,
    clearFrequencyState,
    SnapshotSchedule,
    GlobalFrequencyState,
} from './adaptiveSnapshot';

import {
    updateVolatilityState,
    getVolatilityBandMultiplier,
    getVolatilityLevel,
    getDynamicHarmonicThresholds,
    registerDecayTracking,
    unregisterDecayTracking,
    updateDecayState,
    evaluateStructuralExit,
    getStructuralExitSignals,
    logVolatilityState,
    logDecayState,
    logDynamicHarmonicsSummary,
    clearDynamicHarmonicsState,
    VolatilityState,
    StructuralDecayState,
    StructuralExitEvaluation,
    DynamicHarmonicThresholds,
} from './dynamicHarmonics';

import { RiskTier } from './riskBucketEngine';
import { 
    getVelocityDropFactor,
    getEntropyDropFactor,
    getLiquidityOutflowPct,
    getMinHealthScore,
} from '../config/harmonics';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Unified entry evaluation result
 */
export interface PredatorEntryEvaluation {
    poolId: string;
    poolName: string;
    
    // Entry decision
    canEnter: boolean;
    blockedReasons: string[];
    
    // MHI-based sizing
    mhi: number;
    mhiTier: MHISizingTier;
    sizeMultiplier: number;
    
    // Reflexivity bonus
    reflexivityScore: number;
    reflexivityMultiplier: number;
    isPredatorOpportunity: boolean;
    
    // Final adjusted size
    finalSizeMultiplier: number;
    
    // Priority
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    
    // Specialist status
    isSpecialistPool: boolean;
    trustScore: number;
    
    timestamp: number;
}

/**
 * Unified exit evaluation result
 */
export interface PredatorExitEvaluation {
    tradeId: string;
    poolId: string;
    
    // Exit decision
    shouldExit: boolean;
    exitReason: string;
    
    // Structural decay
    structuralDecay: StructuralExitEvaluation;
    
    // Volatility adjustment
    volatilityLevel: string;
    bandMultiplier: number;
    
    // Adjusted thresholds
    dynamicThresholds: DynamicHarmonicThresholds;
    
    // Reinjection potential
    willTrackForReinjection: boolean;
    
    timestamp: number;
}

/**
 * Predator cycle summary
 */
export interface PredatorCycleSummary {
    // Pool stats
    totalPools: number;
    poolsWithMHI: number;
    entryEligible: number;
    
    // MHI distribution
    mhiTierCounts: Record<MHISizingTier, number>;
    
    // Reflexivity
    predatorOpportunities: number;
    migrationTargets: number;
    
    // Reinjection
    trackedForReinjection: number;
    readyForReinjection: number;
    blacklistedPools: number;
    
    // Specialist focus
    specialistPoolCount: number;
    topSpecialists: string[];
    
    // Adaptive telemetry
    marketPressure: string;
    globalSnapshotInterval: number;
    
    // Structural exits
    pendingStructuralExits: number;
    
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Predator controller configuration
 */
export const PREDATOR_CONFIG = {
    // Entry priorities
    priorityThresholds: {
        high: { minMHI: 0.75, minReflexivity: 0.10 },
        medium: { minMHI: 0.60, minReflexivity: 0.05 },
        low: { minMHI: 0.45, minReflexivity: 0 },
    },
    
    // Specialist focus
    maxSimultaneousPools: 5,         // Trade like a predator, not a generalist
    preferSpecialistPools: true,
    specialistBonus: 0.10,           // +10% size for trusted pools
    
    // Reflexivity integration
    maxReflexivityBonus: 0.15,       // Cap reflexivity boost at 15%
    
    // Logging
    verboseLogging: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// CORE CONTROLLER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON GUARD - PREVENTS RE-INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════
let predatorInitialized = false;
let predatorControllerId: string = '';
let predatorCreatedAt: number = 0;

/**
 * Check if predator controller has been initialized.
 */
export function isPredatorInitialized(): boolean {
    return predatorInitialized;
}

/**
 * Get the predator controller ID for debugging.
 */
export function getPredatorControllerId(): string {
    return predatorControllerId;
}

/**
 * Get predator controller age in seconds.
 */
export function getPredatorAge(): number {
    if (!predatorCreatedAt) return 0;
    return Math.floor((Date.now() - predatorCreatedAt) / 1000);
}

/**
 * Log predator persistence status.
 */
export function logPredatorPersistence(): void {
    logger.info(`[PREDATOR] 🔒 Controller persistent | ID: ${predatorControllerId} | Age: ${getPredatorAge()}s`);
}

/**
 * Initialize the predator controller.
 * Call once at bot startup.
 * THROWS if called twice.
 */
export function initializePredatorController(): void {
    // ═══════════════════════════════════════════════════════════════════════════
    // SINGLETON GUARD - BLOCK RE-INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════
    if (predatorInitialized) {
        const error = new Error('ENGINE RECREATE BLOCKED - PredatorController already initialized. This is a singleton.');
        logger.error('[PREDATOR] 🚨 FATAL: Attempted to re-initialize PredatorController!');
        logger.error('[PREDATOR] 🚨 This indicates an architectural bug in control flow.');
        logger.error(`[PREDATOR] 🚨 Controller already running with ID: ${predatorControllerId}`);
        throw error;
    }
    
    // Mark as initialized
    predatorInitialized = true;
    predatorControllerId = `predator_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    predatorCreatedAt = Date.now();
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('🦅 PREDATOR CONTROLLER INITIALIZED (SINGLETON)');
    logger.info(`   Controller ID: ${predatorControllerId}`);
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('  Modules:');
    logger.info('    ✓ Microstructure Health Index (MHI)');
    logger.info('    ✓ Non-Equilibrium Reinjection Engine');
    logger.info('    ✓ Cross-Pool Reflexivity Scoring');
    logger.info('    ✓ Adaptive Snapshot Frequency');
    logger.info('    ✓ Dynamic Stop Harmonics');
    logger.info('    ✓ Pool Personality Profiler');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('  Strategy: SPECIALIST PREDATOR');
    logger.info(`  Max Simultaneous Pools: ${PREDATOR_CONFIG.maxSimultaneousPools}`);
    logger.info('  Exit Strategy: STRUCTURAL DECAY ONLY');
    logger.info('═══════════════════════════════════════════════════════════════');
}

/**
 * Register a pool for predator tracking.
 * Call when discovering pools.
 */
export function registerPool(
    poolId: string,
    poolName: string,
    baseToken: string,
    quoteToken: string
): void {
    // Register for reflexivity tracking
    registerPoolTokens(poolId, baseToken, quoteToken, poolName);
    
    // Initialize adaptive snapshot
    updatePoolFrequencyState(poolId);
    
    // Initialize volatility tracking
    updateVolatilityState(poolId);
    
    // Initialize ecosystem state
    updateEcosystemState(poolId);
}

/**
 * Unified entry evaluation using all predator modules.
 */
export function evaluatePredatorEntry(
    poolId: string,
    poolName: string
): PredatorEntryEvaluation {
    const now = Date.now();
    const blockedReasons: string[] = [];
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: MHI GATING (The final gatekeeper)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const mhiResult = computeMHI(poolId);
    
    if (!mhiResult || !mhiResult.valid) {
        blockedReasons.push('No MHI data');
        return createBlockedEntry(poolId, poolName, blockedReasons, now);
    }
    
    if (!mhiResult.canEnter) {
        blockedReasons.push(`MHI too low: ${mhiResult.mhi.toFixed(3)} (${mhiResult.sizingTier})`);
        return createBlockedEntry(poolId, poolName, blockedReasons, now);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: BLACKLIST CHECK
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (isBlacklisted(poolId)) {
        blockedReasons.push('Pool is blacklisted from severe exit');
        return createBlockedEntry(poolId, poolName, blockedReasons, now);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: REFLEXIVITY SCORING
    // ═══════════════════════════════════════════════════════════════════════════
    
    const reflexivity = computeReflexivity(poolId);
    const reflexivityScore = reflexivity?.reflexivityScore ?? 0;
    const reflexivityMultiplier = reflexivity?.reflexivityMultiplier ?? 1.0;
    const isPredatorOpportunity = reflexivity?.predatorOpportunity ?? false;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: SPECIALIST POOL CHECK
    // ═══════════════════════════════════════════════════════════════════════════
    
    const personality = getPoolPersonality(poolId);
    const isSpecialist = isSpecialistPool(poolId);
    const trustScore = personality?.trustScore ?? 0.5;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: CALCULATE FINAL SIZE MULTIPLIER
    // ═══════════════════════════════════════════════════════════════════════════
    
    let finalSizeMultiplier = mhiResult.sizeMultiplier;
    
    // Apply reflexivity bonus (capped)
    finalSizeMultiplier *= Math.min(reflexivityMultiplier, 1 + PREDATOR_CONFIG.maxReflexivityBonus);
    
    // Apply specialist bonus
    if (isSpecialist && PREDATOR_CONFIG.preferSpecialistPools) {
        finalSizeMultiplier *= (1 + PREDATOR_CONFIG.specialistBonus);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: DETERMINE PRIORITY
    // ═══════════════════════════════════════════════════════════════════════════
    
    let priority: 'HIGH' | 'MEDIUM' | 'LOW';
    const thresholds = PREDATOR_CONFIG.priorityThresholds;
    
    if (mhiResult.mhi >= thresholds.high.minMHI || reflexivityScore >= thresholds.high.minReflexivity || isPredatorOpportunity) {
        priority = 'HIGH';
    } else if (mhiResult.mhi >= thresholds.medium.minMHI || reflexivityScore >= thresholds.medium.minReflexivity) {
        priority = 'MEDIUM';
    } else {
        priority = 'LOW';
    }
    
    return {
        poolId,
        poolName,
        canEnter: true,
        blockedReasons: [],
        mhi: mhiResult.mhi,
        mhiTier: mhiResult.sizingTier,
        sizeMultiplier: mhiResult.sizeMultiplier,
        reflexivityScore,
        reflexivityMultiplier,
        isPredatorOpportunity,
        finalSizeMultiplier,
        priority,
        isSpecialistPool: isSpecialist,
        trustScore,
        timestamp: now,
    };
}

/**
 * Create a blocked entry result
 */
function createBlockedEntry(
    poolId: string,
    poolName: string,
    blockedReasons: string[],
    timestamp: number
): PredatorEntryEvaluation {
    return {
        poolId,
        poolName,
        canEnter: false,
        blockedReasons,
        mhi: 0,
        mhiTier: 'BLOCKED',
        sizeMultiplier: 0,
        reflexivityScore: 0,
        reflexivityMultiplier: 1.0,
        isPredatorOpportunity: false,
        finalSizeMultiplier: 0,
        priority: 'LOW',
        isSpecialistPool: false,
        trustScore: 0,
        timestamp,
    };
}

/**
 * Unified exit evaluation using structural decay.
 */
export function evaluatePredatorExit(
    tradeId: string,
    poolId: string,
    tier: RiskTier
): PredatorExitEvaluation {
    const now = Date.now();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: STRUCTURAL DECAY EVALUATION
    // This is the PRIMARY exit signal - no price-based exits
    // ═══════════════════════════════════════════════════════════════════════════
    
    const structuralDecay = evaluateStructuralExit(tradeId);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: GET DYNAMIC THRESHOLDS (volatility-adjusted)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const baseThresholds = {
        velocityDropFactor: getVelocityDropFactor(tier),
        entropyDropFactor: getEntropyDropFactor(tier),
        liquidityOutflowPct: getLiquidityOutflowPct(tier),
        minHealthScore: getMinHealthScore(tier),
    };
    
    const dynamicThresholds = getDynamicHarmonicThresholds(poolId, tier, baseThresholds);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: DETERMINE EXIT DECISION
    // Only structural decay triggers exit - no price, no profit targets
    // ═══════════════════════════════════════════════════════════════════════════
    
    const shouldExit = structuralDecay.shouldExit;
    const exitReason = structuralDecay.reason;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: DETERMINE REINJECTION TRACKING
    // Will track for potential re-entry if structure heals
    // ═══════════════════════════════════════════════════════════════════════════
    
    const willTrackForReinjection = shouldExit && 
        structuralDecay.decaySeverity !== 'SEVERE' &&
        dynamicThresholds.volatilityLevel !== 'HIGH';
    
    return {
        tradeId,
        poolId,
        shouldExit,
        exitReason,
        structuralDecay,
        volatilityLevel: dynamicThresholds.volatilityLevel,
        bandMultiplier: dynamicThresholds.bandMultiplier,
        dynamicThresholds,
        willTrackForReinjection,
        timestamp: now,
    };
}

/**
 * Register a trade for predator monitoring.
 * Call when opening a position.
 */
export function registerPredatorTrade(
    tradeId: string,
    poolId: string
): void {
    // Register for structural decay tracking
    registerDecayTracking(tradeId, poolId);
    
    logger.debug(`[PREDATOR] Registered trade ${tradeId.slice(0, 8)}... for predator monitoring`);
}

/**
 * Handle trade exit and initiate reinjection tracking.
 * Call when closing a position.
 */
export function handlePredatorExit(
    tradeId: string,
    poolId: string,
    poolName: string,
    exitReason: string,
    pnl: number,
    pnlPercent: number,
    entryMHI?: number,
    entryEntropy?: number
): void {
    // Unregister from decay tracking
    unregisterDecayTracking(tradeId);
    
    // Register for reinjection tracking
    registerExit(poolId, poolName, exitReason, pnl, pnlPercent, entryMHI, entryEntropy);
    
    // Update pool personality with trade result
    updatePoolPersonality(poolId, pnl, pnl >= 0);
    
    logger.info(
        `[PREDATOR] Exit handled for ${poolName} | ` +
        `reason=${exitReason} | ` +
        `pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ` +
        `tracking for reinjection`
    );
}

/**
 * Get current reinjection opportunities.
 */
export function getPredatorReinjections(): ReinjectionOpportunity[] {
    return getReinjectionOpportunities();
}

/**
 * Consume a reinjection opportunity after re-entry.
 */
export function consumePredatorReinjection(poolId: string): void {
    consumeReinjection(poolId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run predator cycle update.
 * Call on each telemetry refresh.
 */
export function runPredatorCycle(poolIds: string[]): PredatorCycleSummary {
    const now = Date.now();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: UPDATE ECOSYSTEM STATES
    // ═══════════════════════════════════════════════════════════════════════════
    
    updateAllEcosystemStates(poolIds);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: UPDATE REINJECTION TRACKING
    // ═══════════════════════════════════════════════════════════════════════════
    
    updateReinjectionTracking();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: UPDATE GLOBAL SNAPSHOT FREQUENCY
    // ═══════════════════════════════════════════════════════════════════════════
    
    for (const poolId of poolIds) {
        updatePoolFrequencyState(poolId);
        updateVolatilityState(poolId);
    }
    
    const globalFreq = updateGlobalFrequencyState();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: GATHER STATISTICS
    // ═══════════════════════════════════════════════════════════════════════════
    
    // MHI distribution
    const mhiTierCounts: Record<MHISizingTier, number> = { MAX: 0, HIGH: 0, MEDIUM: 0, LOW: 0, BLOCKED: 0 };
    let poolsWithMHI = 0;
    let entryEligible = 0;
    
    for (const poolId of poolIds) {
        const mhi = computeMHI(poolId);
        if (mhi && mhi.valid) {
            poolsWithMHI++;
            mhiTierCounts[mhi.sizingTier]++;
            if (mhi.canEnter) entryEligible++;
        }
    }
    
    // Reflexivity opportunities
    const predatorOpps = getPredatorOpportunities();
    const migrationTargets = getMigrationTargets();
    
    // Reinjection stats
    const reinjectionStats = getReinjectionStats();
    
    // Specialist pools
    const specialists = getTopTrustedPools(5);
    
    // Structural exits
    const structuralExits = getStructuralExitSignals();
    
    return {
        totalPools: poolIds.length,
        poolsWithMHI,
        entryEligible,
        mhiTierCounts,
        predatorOpportunities: predatorOpps.length,
        migrationTargets: migrationTargets.length,
        trackedForReinjection: reinjectionStats.trackedPools,
        readyForReinjection: reinjectionStats.readyForReinjection,
        blacklistedPools: reinjectionStats.blacklistedPools,
        specialistPoolCount: specialists.length,
        topSpecialists: specialists.slice(0, 3).map(s => s.poolName),
        marketPressure: globalFreq.marketPressure,
        globalSnapshotInterval: globalFreq.currentIntervalMs,
        pendingStructuralExits: structuralExits.length,
        timestamp: now,
    };
}

/**
 * Log predator cycle summary
 */
export function logPredatorCycleSummary(summary: PredatorCycleSummary): void {
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('🦅 PREDATOR CYCLE SUMMARY');
    logger.info('═══════════════════════════════════════════════════════════════');
    
    // MHI Distribution
    logger.info(
        `  MHI Tiers: ` +
        `🟢${summary.mhiTierCounts.MAX} ` +
        `🔵${summary.mhiTierCounts.HIGH} ` +
        `🟡${summary.mhiTierCounts.MEDIUM} ` +
        `🟠${summary.mhiTierCounts.LOW} ` +
        `🔴${summary.mhiTierCounts.BLOCKED} | ` +
        `Entry Eligible: ${summary.entryEligible}`
    );
    
    // Predator Opportunities
    if (summary.predatorOpportunities > 0 || summary.migrationTargets > 0) {
        logger.info(
            `  🎯 Opportunities: ` +
            `Predator=${summary.predatorOpportunities} | ` +
            `Migration=${summary.migrationTargets}`
        );
    }
    
    // Reinjection
    if (summary.trackedForReinjection > 0 || summary.readyForReinjection > 0) {
        logger.info(
            `  🔄 Reinjection: ` +
            `Tracking=${summary.trackedForReinjection} | ` +
            `Ready=${summary.readyForReinjection} | ` +
            `Blacklisted=${summary.blacklistedPools}`
        );
    }
    
    // Specialist Focus
    if (summary.specialistPoolCount > 0) {
        logger.info(
            `  🏆 Specialists: ${summary.specialistPoolCount} trusted pools | ` +
            `Top: ${summary.topSpecialists.join(', ')}`
        );
    }
    
    // Adaptive Telemetry
    logger.info(
        `  📡 Telemetry: ` +
        `Pressure=${summary.marketPressure.toUpperCase()} | ` +
        `Interval=${summary.globalSnapshotInterval}ms`
    );
    
    // Structural Exits
    if (summary.pendingStructuralExits > 0) {
        logger.warn(`  ⚠️ Structural Exits Pending: ${summary.pendingStructuralExits}`);
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clear all predator controller state.
 */
export function clearPredatorState(): void {
    clearReinjectionState();
    clearReflexivityState();
    clearFrequencyState();
    clearDynamicHarmonicsState();
    logger.info('[PREDATOR] Cleared all predator state');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // Re-export key functions for convenience
    computeMHI,
    passesMHIGating,
    getMHIAdjustedSize,
    canScaleWithMHI,
    getReinjectionOpportunities,
    getPredatorOpportunities,
    getMigrationTargets,
    getTopTrustedPools,
    isSpecialistPool,
    getGlobalSnapshotInterval,
    getPoolsDueForSnapshot,
    getStructuralExitSignals,
};

