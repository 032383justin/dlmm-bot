/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CAPITAL CONCENTRATION — PREDATOR MODE v1 CAPITAL DEPLOYMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * INITIAL PHASE:
 * - Max active pools: 3-5
 * - Initial allocation: 2-5% per pool
 * 
 * POST-GRADUATION:
 * - Ramp capital AGGRESSIVELY into survivors
 * - Favor fewer pools with HIGHER dominance
 * 
 * IDLE CAPITAL: Acceptable only while identifying prey.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    PREDATOR_MODE_V1_ENABLED,
    CAPITAL_CONCENTRATION_CONFIG,
    PREY_SELECTION_HARD_FILTERS,
    isEntryAllowedByReserve,
    calculateMaxEntrySizeUsd,
} from '../config/predatorModeV1';
import {
    isInGlobalBootstrapMode,
    evaluateGraduation,
} from './bootstrapProbeMode';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface CapitalAllocation {
    poolAddress: string;
    poolName: string;
    allocationPct: number;
    allocationUsd: number;
    phase: 'INITIAL' | 'GRADUATED' | 'SCALED';
    isHighPriority: boolean;
}

export interface PortfolioState {
    totalEquityUsd: number;
    deployedUsd: number;
    availableUsd: number;
    utilizationPct: number;
    activePoolCount: number;
    graduatedPoolCount: number;
    positions: PoolPosition[];
    // NEW: Reserve tracking
    maxDeployableUsd: number;
    reserveUsd: number;
    reservePct: number;
    isCapitalGateLocked: boolean;
    capitalGateReason: string;
}

export interface PoolPosition {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    entrySizeUsd: number;
    currentValueUsd: number;
    feesAccruedUsd: number;
    allocationPct: number;
    isGraduated: boolean;
    preyScore: number;
}

export interface AllocationDecision {
    shouldDeploy: boolean;
    allocationUsd: number;
    allocationPct: number;
    reason: string;
    poolsToDeployTo: CapitalAllocation[];
}

export interface ScalingDecision {
    shouldScale: boolean;
    poolsToScale: { poolAddress: string; additionalUsd: number; reason: string }[];
    poolsToReduce: { poolAddress: string; reduceByUsd: number; reason: string }[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

interface PoolCapitalState {
    poolAddress: string;
    poolName: string;
    tradeId: string;
    entrySizeUsd: number;
    currentValueUsd: number;
    feesAccruedUsd: number;
    entryTime: number;
    isGraduated: boolean;
    preyScore: number;
    lastScaleTime: number;
    scaleCount: number;
}

const poolStates = new Map<string, PoolCapitalState>();
let currentEquity = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize capital concentration with current equity
 */
export function initializeCapitalConcentration(equity: number): void {
    currentEquity = equity;
    logger.info(
        `[CAPITAL] 💰 Initialized capital concentration | ` +
        `equity=$${equity.toFixed(2)} | ` +
        `mode=${PREDATOR_MODE_V1_ENABLED ? 'PREDATOR' : 'STANDARD'}`
    );
}

/**
 * Update current equity
 */
export function updateEquity(equity: number): void {
    currentEquity = equity;
}

/**
 * Register a new position
 */
export function registerPosition(
    tradeId: string,
    poolAddress: string,
    poolName: string,
    entrySizeUsd: number,
    preyScore: number = 50
): void {
    poolStates.set(tradeId, {
        poolAddress,
        poolName,
        tradeId,
        entrySizeUsd,
        currentValueUsd: entrySizeUsd,
        feesAccruedUsd: 0,
        entryTime: Date.now(),
        isGraduated: false,
        preyScore,
        lastScaleTime: Date.now(),
        scaleCount: 0,
    });
    
    logger.info(
        `[CAPITAL] 📍 Position registered: ${poolName} | ` +
        `size=$${entrySizeUsd.toFixed(2)} | ` +
        `allocation=${((entrySizeUsd / currentEquity) * 100).toFixed(1)}%`
    );
}

/**
 * Update position value and fees
 */
export function updatePosition(
    tradeId: string,
    currentValueUsd: number,
    feesAccruedUsd: number
): void {
    const state = poolStates.get(tradeId);
    if (!state) return;
    
    state.currentValueUsd = currentValueUsd;
    state.feesAccruedUsd = feesAccruedUsd;
}

/**
 * Mark position as graduated (post-bootstrap)
 */
export function markPositionGraduated(tradeId: string): void {
    const state = poolStates.get(tradeId);
    if (!state) return;
    
    state.isGraduated = true;
    logger.info(`[CAPITAL] 🎓 Position graduated: ${state.poolName}`);
}

/**
 * Remove closed position
 */
export function removePosition(tradeId: string): void {
    const state = poolStates.get(tradeId);
    if (state) {
        logger.info(`[CAPITAL] 🚪 Position removed: ${state.poolName}`);
        poolStates.delete(tradeId);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO STATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current portfolio state
 */
export function getPortfolioState(): PortfolioState {
    const positions: PoolPosition[] = [];
    let deployedUsd = 0;
    let graduatedCount = 0;
    
    for (const state of poolStates.values()) {
        deployedUsd += state.currentValueUsd;
        if (state.isGraduated) graduatedCount++;
        
        positions.push({
            tradeId: state.tradeId,
            poolAddress: state.poolAddress,
            poolName: state.poolName,
            entrySizeUsd: state.entrySizeUsd,
            currentValueUsd: state.currentValueUsd,
            feesAccruedUsd: state.feesAccruedUsd,
            allocationPct: currentEquity > 0 ? (state.currentValueUsd / currentEquity) * 100 : 0,
            isGraduated: state.isGraduated,
            preyScore: state.preyScore,
        });
    }
    
    // Calculate max deployable based on GLOBAL_RESERVE_RATIO
    const maxDeployableUsd = currentEquity * (1 - CAPITAL_CONCENTRATION_CONFIG.GLOBAL_RESERVE_RATIO);
    const reserveUsd = currentEquity * CAPITAL_CONCENTRATION_CONFIG.GLOBAL_RESERVE_RATIO;
    const reservePct = CAPITAL_CONCENTRATION_CONFIG.GLOBAL_RESERVE_RATIO * 100;
    
    // Available = min of (reserve-based limit, old limit)
    const availableByReserve = Math.max(0, maxDeployableUsd - deployedUsd);
    const availableByBuffer = Math.max(0, currentEquity - deployedUsd - CAPITAL_CONCENTRATION_CONFIG.RESERVE_BUFFER_USD);
    const availableUsd = Math.min(availableByReserve, availableByBuffer);
    
    // Check if capital gate is locked
    const isCapitalGateLocked = deployedUsd >= maxDeployableUsd;
    const capitalGateReason = isCapitalGateLocked
        ? `CAPITAL_GATE_LOCKED: ${(deployedUsd / currentEquity * 100).toFixed(1)}% deployed >= ${((1 - CAPITAL_CONCENTRATION_CONFIG.GLOBAL_RESERVE_RATIO) * 100).toFixed(0)}% max`
        : `CAPITAL_AVAILABLE: ${(availableUsd).toFixed(2)} USD`;
    
    return {
        totalEquityUsd: currentEquity,
        deployedUsd,
        availableUsd,
        utilizationPct: currentEquity > 0 ? (deployedUsd / currentEquity) * 100 : 0,
        activePoolCount: poolStates.size,
        graduatedPoolCount: graduatedCount,
        positions,
        // NEW fields
        maxDeployableUsd,
        reserveUsd,
        reservePct,
        isCapitalGateLocked,
        capitalGateReason,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALLOCATION DECISIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate initial allocation for a new position
 * 
 * CRITICAL: Respects GLOBAL_RESERVE_RATIO (30% always free)
 * CRITICAL: Never allocates >20% of equity to a single pool on entry
 */
export function calculateInitialAllocation(
    preyScore: number = 50
): { minUsd: number; maxUsd: number; recommendedUsd: number; recommendedPct: number; blocked: boolean; blockReason: string } {
    const config = CAPITAL_CONCENTRATION_CONFIG.INITIAL;
    const portfolio = getPortfolioState();
    
    // Check if capital gate is locked
    if (portfolio.isCapitalGateLocked) {
        return {
            minUsd: 0,
            maxUsd: 0,
            recommendedUsd: 0,
            recommendedPct: 0,
            blocked: true,
            blockReason: portfolio.capitalGateReason,
        };
    }
    
    // Check if we can add more pools
    if (portfolio.activePoolCount >= config.MAX_ACTIVE_POOLS) {
        return {
            minUsd: 0,
            maxUsd: 0,
            recommendedUsd: 0,
            recommendedPct: 0,
            blocked: true,
            blockReason: `MAX_POOLS: ${portfolio.activePoolCount}/${config.MAX_ACTIVE_POOLS}`,
        };
    }
    
    // Calculate max entry size respecting BOTH reserve and per-pool limits
    const maxByReserve = portfolio.availableUsd;
    const maxByPoolLimit = currentEquity * CAPITAL_CONCENTRATION_CONFIG.MAX_SINGLE_POOL_ENTRY_PCT;  // 20%
    const maxByConfig = Math.min(
        CAPITAL_CONCENTRATION_CONFIG.MAX_POSITION_SIZE_USD,
        currentEquity * config.ALLOCATION_PER_POOL_MAX_PCT
    );
    
    const maxUsd = Math.min(maxByReserve, maxByPoolLimit, maxByConfig);
    
    // Calculate min
    const minUsd = Math.max(
        CAPITAL_CONCENTRATION_CONFIG.MIN_POSITION_SIZE_USD,
        currentEquity * config.ALLOCATION_PER_POOL_MIN_PCT
    );
    
    // Check if min > max (insufficient capital)
    if (minUsd > maxUsd) {
        return {
            minUsd: 0,
            maxUsd: 0,
            recommendedUsd: 0,
            recommendedPct: 0,
            blocked: true,
            blockReason: `INSUFFICIENT_CAPITAL: min=$${minUsd.toFixed(2)} > max=$${maxUsd.toFixed(2)}`,
        };
    }
    
    // Scale by prey score
    const scoreMultiplier = 0.5 + (preyScore / 200);  // 0.5-1.0
    const recommendedUsd = Math.min(maxUsd, (minUsd + maxUsd) / 2 * scoreMultiplier);
    const recommendedPct = currentEquity > 0 ? (recommendedUsd / currentEquity) * 100 : 0;
    
    return {
        minUsd,
        maxUsd,
        recommendedUsd: Math.max(minUsd, recommendedUsd),
        recommendedPct,
        blocked: false,
        blockReason: '',
    };
}

/**
 * Evaluate if we should deploy to new pools
 * 
 * CRITICAL: Enforces GLOBAL_RESERVE_RATIO (30% always free)
 */
export function evaluateDeploymentDecision(
    candidates: { poolAddress: string; poolName: string; preyScore: number }[]
): AllocationDecision {
    const portfolio = getPortfolioState();
    const config = CAPITAL_CONCENTRATION_CONFIG;
    
    // Check if we're in bootstrap and need to deploy
    const isBootstrap = isInGlobalBootstrapMode();
    
    // CRITICAL: Check if capital gate is locked (>70% deployed)
    if (portfolio.isCapitalGateLocked) {
        logger.warn(
            `[CAPITAL] 🚫 CAPITAL_GATE_LOCKED | ` +
            `deployed=${portfolio.utilizationPct.toFixed(1)}% >= max=${((1 - config.GLOBAL_RESERVE_RATIO) * 100).toFixed(0)}% | ` +
            `Allowing exits + reallocations only`
        );
        return {
            shouldDeploy: false,
            allocationUsd: 0,
            allocationPct: 0,
            reason: portfolio.capitalGateReason,
            poolsToDeployTo: [],
        };
    }
    
    // Check pool count limits
    if (portfolio.activePoolCount >= config.INITIAL.MAX_ACTIVE_POOLS) {
        return {
            shouldDeploy: false,
            allocationUsd: 0,
            allocationPct: 0,
            reason: `MAX_POOLS: ${portfolio.activePoolCount}/${config.INITIAL.MAX_ACTIVE_POOLS}`,
            poolsToDeployTo: [],
        };
    }
    
    // Check available capital (respects reserve)
    if (portfolio.availableUsd < config.MIN_POSITION_SIZE_USD) {
        return {
            shouldDeploy: false,
            allocationUsd: 0,
            allocationPct: 0,
            reason: `INSUFFICIENT_CAPITAL: $${portfolio.availableUsd.toFixed(2)} < $${config.MIN_POSITION_SIZE_USD} (reserve: $${portfolio.reserveUsd.toFixed(2)})`,
            poolsToDeployTo: [],
        };
    }
    
    // Sort candidates by prey score
    const sortedCandidates = [...candidates].sort((a, b) => b.preyScore - a.preyScore);
    
    // Calculate how many pools we can deploy to
    const slotsAvailable = config.INITIAL.MAX_ACTIVE_POOLS - portfolio.activePoolCount;
    const poolsToConsider = sortedCandidates.slice(0, Math.min(slotsAvailable, 3));
    
    const allocations: CapitalAllocation[] = [];
    let totalAllocation = 0;
    let remainingCapital = portfolio.availableUsd;
    
    for (const candidate of poolsToConsider) {
        const allocation = calculateInitialAllocation(candidate.preyScore);
        
        // Check if blocked
        if (allocation.blocked) {
            logger.debug(`[CAPITAL] Skipping ${candidate.poolName}: ${allocation.blockReason}`);
            continue;
        }
        
        if (allocation.recommendedUsd > 0 && remainingCapital >= allocation.recommendedUsd) {
            allocations.push({
                poolAddress: candidate.poolAddress,
                poolName: candidate.poolName,
                allocationPct: allocation.recommendedPct,
                allocationUsd: allocation.recommendedUsd,
                phase: isBootstrap ? 'INITIAL' : 'GRADUATED',
                isHighPriority: candidate.preyScore >= 70,
            });
            
            totalAllocation += allocation.recommendedUsd;
            remainingCapital -= allocation.recommendedUsd;
        }
    }
    
    if (allocations.length === 0) {
        return {
            shouldDeploy: false,
            allocationUsd: 0,
            allocationPct: 0,
            reason: 'NO_SUITABLE_CANDIDATES',
            poolsToDeployTo: [],
        };
    }
    
    return {
        shouldDeploy: true,
        allocationUsd: totalAllocation,
        allocationPct: currentEquity > 0 ? (totalAllocation / currentEquity) * 100 : 0,
        reason: `DEPLOYING: ${allocations.length} pools, $${totalAllocation.toFixed(2)} (reserve: $${portfolio.reserveUsd.toFixed(2)})`,
        poolsToDeployTo: allocations,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST-GRADUATION SCALING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate scaling decisions for graduated positions
 * 
 * POST-GRADUATION:
 * - Ramp capital AGGRESSIVELY into survivors
 * - Favor fewer pools with HIGHER dominance
 */
export function evaluateScalingDecisions(): ScalingDecision {
    const portfolio = getPortfolioState();
    const config = CAPITAL_CONCENTRATION_CONFIG.POST_GRADUATION;
    
    // Only scale if we have graduated positions and available capital
    const graduatedPositions = portfolio.positions.filter(p => p.isGraduated);
    
    if (graduatedPositions.length === 0) {
        return {
            shouldScale: false,
            poolsToScale: [],
            poolsToReduce: [],
        };
    }
    
    const poolsToScale: { poolAddress: string; additionalUsd: number; reason: string }[] = [];
    const poolsToReduce: { poolAddress: string; reduceByUsd: number; reason: string }[] = [];
    
    // Sort by performance (fees / current value)
    const sortedPositions = [...graduatedPositions].sort((a, b) => {
        const perfA = a.feesAccruedUsd / Math.max(1, a.currentValueUsd);
        const perfB = b.feesAccruedUsd / Math.max(1, b.currentValueUsd);
        return perfB - perfA;
    });
    
    // Scale up top performers
    const maxPerPool = currentEquity * config.MAX_PER_POOL_PCT;
    
    for (const position of sortedPositions.slice(0, config.TARGET_POOL_COUNT)) {
        const state = poolStates.get(position.tradeId);
        if (!state) continue;
        
        // Check if we can scale this pool
        const currentAllocation = position.allocationPct / 100;
        const targetAllocation = Math.min(config.MAX_PER_POOL_PCT, currentAllocation * 1.5);
        const additionalUsd = (targetAllocation - currentAllocation) * currentEquity;
        
        if (additionalUsd > CAPITAL_CONCENTRATION_CONFIG.MIN_POSITION_SIZE_USD &&
            additionalUsd <= portfolio.availableUsd) {
            
            const performanceRatio = position.feesAccruedUsd / Math.max(1, position.currentValueUsd);
            
            poolsToScale.push({
                poolAddress: position.poolAddress,
                additionalUsd,
                reason: `PERFORMANCE_SCALING: fees/value=${(performanceRatio * 100).toFixed(2)}%`,
            });
        }
    }
    
    // Consider reducing underperformers (excess pools beyond target count)
    if (graduatedPositions.length > config.TARGET_POOL_COUNT) {
        const underperformers = sortedPositions.slice(config.TARGET_POOL_COUNT);
        
        for (const position of underperformers) {
            const performanceRatio = position.feesAccruedUsd / Math.max(1, position.currentValueUsd);
            
            // Only suggest reduction if significantly underperforming
            if (performanceRatio < 0.005) {  // <0.5% fee yield
                poolsToReduce.push({
                    poolAddress: position.poolAddress,
                    reduceByUsd: position.currentValueUsd * 0.5,  // Suggest 50% reduction
                    reason: `UNDERPERFORMANCE: fees/value=${(performanceRatio * 100).toFixed(2)}%`,
                });
            }
        }
    }
    
    return {
        shouldScale: poolsToScale.length > 0 || poolsToReduce.length > 0,
        poolsToScale,
        poolsToReduce,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// IDLE CAPITAL HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if idle capital is acceptable
 * 
 * RULE: Idle capital is ACCEPTABLE only while identifying prey.
 * After bootstrap, idle capital is a FAILURE.
 */
export function isIdleCapitalAcceptable(): { acceptable: boolean; reason: string } {
    const portfolio = getPortfolioState();
    const isBootstrap = isInGlobalBootstrapMode();
    
    // During bootstrap, idle capital is acceptable (identifying prey)
    if (isBootstrap) {
        return {
            acceptable: true,
            reason: 'BOOTSTRAP_PHASE: Identifying prey',
        };
    }
    
    // If no candidates available, idle is acceptable
    if (portfolio.activePoolCount < CAPITAL_CONCENTRATION_CONFIG.INITIAL.MIN_ACTIVE_POOLS) {
        return {
            acceptable: true,
            reason: 'PREY_SELECTION: Searching for targets',
        };
    }
    
    // After bootstrap with available capital, check utilization
    const targetUtilization = 0.70;  // 70% minimum post-bootstrap
    
    if (portfolio.utilizationPct < targetUtilization * 100) {
        return {
            acceptable: false,
            reason: `UNDERUTILIZED: ${portfolio.utilizationPct.toFixed(0)}% < ${(targetUtilization * 100).toFixed(0)}% target`,
        };
    }
    
    return {
        acceptable: true,
        reason: 'OPTIMAL_UTILIZATION',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logCapitalConcentrationStatus(): void {
    if (!PREDATOR_MODE_V1_ENABLED) {
        logger.info('[CAPITAL] Concentration mode DISABLED');
        return;
    }
    
    const portfolio = getPortfolioState();
    const isBootstrap = isInGlobalBootstrapMode();
    const idleCheck = isIdleCapitalAcceptable();
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('💰 CAPITAL CONCENTRATION STATUS (v1.1 - FIXED)');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`  Phase: ${isBootstrap ? 'INITIAL (Bootstrap)' : 'POST-GRADUATION'}`);
    logger.info(`  Equity: $${portfolio.totalEquityUsd.toFixed(2)}`);
    logger.info(`  Deployed: $${portfolio.deployedUsd.toFixed(2)} (${portfolio.utilizationPct.toFixed(0)}%)`);
    logger.info(`  Max Deployable: $${portfolio.maxDeployableUsd.toFixed(2)} (${((1 - CAPITAL_CONCENTRATION_CONFIG.GLOBAL_RESERVE_RATIO) * 100).toFixed(0)}%)`);
    logger.info(`  Reserve: $${portfolio.reserveUsd.toFixed(2)} (${portfolio.reservePct.toFixed(0)}% ALWAYS FREE)`);
    logger.info(`  Available for Entry: $${portfolio.availableUsd.toFixed(2)}`);
    logger.info(`  Max Per Pool Entry: ${(CAPITAL_CONCENTRATION_CONFIG.MAX_SINGLE_POOL_ENTRY_PCT * 100).toFixed(0)}%`);
    
    const gateEmoji = portfolio.isCapitalGateLocked ? '🚫' : '✅';
    logger.info(`  Capital Gate: ${gateEmoji} ${portfolio.capitalGateReason}`);
    
    logger.info(`  Active Pools: ${portfolio.activePoolCount}/${CAPITAL_CONCENTRATION_CONFIG.INITIAL.MAX_ACTIVE_POOLS}`);
    logger.info(`  Graduated: ${portfolio.graduatedPoolCount}`);
    
    const idleEmoji = idleCheck.acceptable ? '✅' : '⚠️';
    logger.info(`  Idle Capital: ${idleEmoji} ${idleCheck.reason}`);
    
    if (portfolio.positions.length > 0) {
        logger.info('  Positions:');
        
        // Sort by allocation
        const sorted = [...portfolio.positions].sort((a, b) => b.allocationPct - a.allocationPct);
        
        for (const pos of sorted) {
            const gradEmoji = pos.isGraduated ? '🎓' : '🔍';
            const feeYield = pos.currentValueUsd > 0 
                ? ((pos.feesAccruedUsd / pos.currentValueUsd) * 100).toFixed(2) 
                : '0.00';
            
            logger.info(
                `    ${gradEmoji} ${pos.poolName}: $${pos.currentValueUsd.toFixed(2)} | ` +
                `${pos.allocationPct.toFixed(1)}% | ` +
                `fees=$${pos.feesAccruedUsd.toFixed(2)} (${feeYield}%) | ` +
                `score=${pos.preyScore}`
            );
        }
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

export function logAllocationDecision(decision: AllocationDecision): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    if (decision.shouldDeploy) {
        logger.info(
            `[CAPITAL] ✅ DEPLOY DECISION | ` +
            `pools=${decision.poolsToDeployTo.length} | ` +
            `total=$${decision.allocationUsd.toFixed(2)} (${decision.allocationPct.toFixed(1)}%) | ` +
            `${decision.reason}`
        );
        
        for (const alloc of decision.poolsToDeployTo) {
            const priorityTag = alloc.isHighPriority ? '🔥' : '  ';
            logger.info(
                `  ${priorityTag} ${alloc.poolName}: $${alloc.allocationUsd.toFixed(2)} (${alloc.allocationPct.toFixed(1)}%)`
            );
        }
    } else {
        logger.debug(
            `[CAPITAL] ⏸️ NO DEPLOYMENT | ${decision.reason}`
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    initializeCapitalConcentration,
    updateEquity,
    registerPosition,
    updatePosition,
    markPositionGraduated,
    removePosition,
    getPortfolioState,
    calculateInitialAllocation,
    evaluateDeploymentDecision,
    evaluateScalingDecisions,
    isIdleCapitalAcceptable,
    logCapitalConcentrationStatus,
    logAllocationDecision,
};
