/**
 * Risk Bucket Engine - Tier 4 Portfolio Risk Management
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * REPLACES: Trade count limiting ("max 5 trades active")
 * WITH: Dynamic risk bucket allocation based on μScore
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Risk Tiers:
 * - Tier A (Core):        μScore ≥ 40  → leverage 1.4-1.8x, size cap 10-12%
 * - Tier B (Momentum):    μScore 32-40 → leverage 1.0x, size cap 6-8%
 * - Tier C (Speculative): μScore 24-32 → no leverage, size cap 3-4%
 * - Tier D (Noise):       μScore < 24  → FORBIDDEN
 * 
 * Portfolio Constraints:
 * - Max 18-25% of capital deployed across volatile pairs
 * - Max 4-8% per pair with migration penalties
 * - Dynamic capital increase only on momentum chains
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// RISK TIER DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export type RiskTier = 'A' | 'B' | 'C' | 'D';

export interface RiskTierConfig {
    tier: RiskTier;
    name: string;
    minScore: number;
    maxScore: number;
    leverageMin: number;
    leverageMax: number;
    sizeCapMin: number;      // Minimum size cap as % of capital
    sizeCapMax: number;      // Maximum size cap as % of capital
    maxPoolsInTier: number;  // Max positions in this tier
    allowed: boolean;        // Whether trading is allowed
}

/**
 * Risk tier configurations
 */
export const RISK_TIERS: Record<RiskTier, RiskTierConfig> = {
    A: {
        tier: 'A',
        name: 'CORE',
        minScore: 40,
        maxScore: 100,
        leverageMin: 1.4,
        leverageMax: 1.8,
        sizeCapMin: 0.10,    // 10%
        sizeCapMax: 0.12,    // 12%
        maxPoolsInTier: 3,
        allowed: true,
    },
    B: {
        tier: 'B',
        name: 'MOMENTUM',
        minScore: 32,
        maxScore: 40,
        leverageMin: 1.0,
        leverageMax: 1.0,
        sizeCapMin: 0.06,    // 6%
        sizeCapMax: 0.08,    // 8%
        maxPoolsInTier: 4,
        allowed: true,
    },
    C: {
        tier: 'C',
        name: 'SPECULATIVE',
        minScore: 24,
        maxScore: 32,
        leverageMin: 1.0,
        leverageMax: 1.0,
        sizeCapMin: 0.03,    // 3%
        sizeCapMax: 0.04,    // 4%
        maxPoolsInTier: 3,
        allowed: true,
    },
    D: {
        tier: 'D',
        name: 'NOISE',
        minScore: 0,
        maxScore: 24,
        leverageMin: 0,
        leverageMax: 0,
        sizeCapMin: 0,
        sizeCapMax: 0,
        maxPoolsInTier: 0,
        allowed: false,      // FORBIDDEN
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO CONSTRAINTS
// ═══════════════════════════════════════════════════════════════════════════════

export const PORTFOLIO_CONSTRAINTS = {
    // Max total deployed across all volatile pairs
    maxTotalDeployedPct: 0.25,           // 25% of capital
    
    // Max deployed for high-volatility pairs
    maxVolatilePairDeployedPct: 0.18,    // 18% for volatile pairs
    
    // Per-pair base cap
    perPairBaseCap: 0.08,                // 8% per pair max
    
    // Migration penalty factor (reduces size when liquidity exiting)
    migrationPenaltyFactor: 0.5,         // Cut size 50% on negative migration
    
    // Minimum capital to operate
    minExecutionCapital: 500,            // $500 minimum to trade
    
    // Minimum remaining after trades
    minRemainingCapitalPct: 0.05,        // Keep 5% liquid
};

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PoolRiskAssignment {
    poolAddress: string;
    poolName: string;
    microScore: number;
    tier: RiskTier;
    tierConfig: RiskTierConfig;
    leverage: number;
    maxSize: number;           // In USD
    maxSizePct: number;        // As percentage
    migrationPenalty: number;  // Multiplier (0.5 if exiting, 1.0 if stable/growing)
    finalSize: number;         // After penalties
    allowed: boolean;
    blockReason?: string;
}

export interface PortfolioRiskState {
    totalCapital: number;
    availableCapital: number;
    totalDeployed: number;
    deployedPct: number;
    tierAllocations: Record<RiskTier, {
        count: number;
        deployed: number;
        maxAllowed: number;
    }>;
    canAddPosition: boolean;
    remainingCapacity: number;
}

export interface ActivePosition {
    poolAddress: string;
    tier: RiskTier;
    size: number;
    entryScore: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RISK BUCKET ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assign a pool to a risk tier based on μScore
 */
export function assignRiskTier(microScore: number): RiskTier {
    if (microScore >= RISK_TIERS.A.minScore) return 'A';
    if (microScore >= RISK_TIERS.B.minScore) return 'B';
    if (microScore >= RISK_TIERS.C.minScore) return 'C';
    return 'D';
}

/**
 * Get risk tier configuration for a given tier
 */
export function getTierConfig(tier: RiskTier): RiskTierConfig {
    return RISK_TIERS[tier];
}

/**
 * Calculate leverage for a pool based on its score within the tier
 */
export function calculateLeverage(microScore: number, tier: RiskTier): number {
    const config = RISK_TIERS[tier];
    
    if (!config.allowed || tier === 'D') {
        return 0;
    }
    
    // Interpolate leverage within tier range
    const scoreRange = config.maxScore - config.minScore;
    const scoreProgress = scoreRange > 0 
        ? Math.min(1, (microScore - config.minScore) / scoreRange)
        : 0;
    
    const leverageRange = config.leverageMax - config.leverageMin;
    return config.leverageMin + (scoreProgress * leverageRange);
}

/**
 * Calculate size cap for a pool based on its score and tier
 */
export function calculateSizeCap(
    microScore: number, 
    tier: RiskTier, 
    totalCapital: number
): { sizePct: number; sizeUsd: number } {
    const config = RISK_TIERS[tier];
    
    if (!config.allowed || tier === 'D') {
        return { sizePct: 0, sizeUsd: 0 };
    }
    
    // Interpolate size cap within tier range
    const scoreRange = config.maxScore - config.minScore;
    const scoreProgress = scoreRange > 0 
        ? Math.min(1, (microScore - config.minScore) / scoreRange)
        : 0;
    
    const sizeRange = config.sizeCapMax - config.sizeCapMin;
    const sizePct = config.sizeCapMin + (scoreProgress * sizeRange);
    const sizeUsd = sizePct * totalCapital;
    
    return { sizePct, sizeUsd };
}

/**
 * Calculate migration penalty based on liquidity slope
 * Returns multiplier: 1.0 for stable/growing, 0.5 for exiting
 */
export function calculateMigrationPenalty(liquiditySlope: number): number {
    if (liquiditySlope < -0.02) {
        // Liquidity exiting - apply penalty
        return PORTFOLIO_CONSTRAINTS.migrationPenaltyFactor;
    }
    return 1.0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL RISK ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assign full risk parameters to a pool
 */
export function assignPoolRisk(
    poolAddress: string,
    poolName: string,
    microScore: number,
    liquiditySlope: number,
    totalCapital: number,
    portfolioState: PortfolioRiskState
): PoolRiskAssignment {
    const tier = assignRiskTier(microScore);
    const tierConfig = getTierConfig(tier);
    
    // Check if tier is forbidden
    if (!tierConfig.allowed) {
        return {
            poolAddress,
            poolName,
            microScore,
            tier,
            tierConfig,
            leverage: 0,
            maxSize: 0,
            maxSizePct: 0,
            migrationPenalty: 1.0,
            finalSize: 0,
            allowed: false,
            blockReason: `Tier ${tier} (${tierConfig.name}): μScore ${microScore.toFixed(1)} < 24 FORBIDDEN`,
        };
    }
    
    // Check tier capacity
    const tierAlloc = portfolioState.tierAllocations[tier];
    if (tierAlloc.count >= tierConfig.maxPoolsInTier) {
        return {
            poolAddress,
            poolName,
            microScore,
            tier,
            tierConfig,
            leverage: 0,
            maxSize: 0,
            maxSizePct: 0,
            migrationPenalty: 1.0,
            finalSize: 0,
            allowed: false,
            blockReason: `Tier ${tier} at capacity: ${tierAlloc.count}/${tierConfig.maxPoolsInTier} positions`,
        };
    }
    
    // Check portfolio capacity
    if (!portfolioState.canAddPosition) {
        return {
            poolAddress,
            poolName,
            microScore,
            tier,
            tierConfig,
            leverage: 0,
            maxSize: 0,
            maxSizePct: 0,
            migrationPenalty: 1.0,
            finalSize: 0,
            allowed: false,
            blockReason: `Portfolio at max deployment: ${(portfolioState.deployedPct * 100).toFixed(1)}%`,
        };
    }
    
    // Calculate base sizing
    const leverage = calculateLeverage(microScore, tier);
    const { sizePct, sizeUsd } = calculateSizeCap(microScore, tier, totalCapital);
    
    // Apply migration penalty
    const migrationPenalty = calculateMigrationPenalty(liquiditySlope);
    
    // Apply leverage to size
    const leveragedSize = sizeUsd * leverage;
    
    // Apply migration penalty
    const finalSize = leveragedSize * migrationPenalty;
    
    // Cap at remaining capacity
    const cappedSize = Math.min(finalSize, portfolioState.remainingCapacity);
    
    logger.info(
        `[RISK] ${poolName} → Tier ${tier} (${tierConfig.name}) | ` +
        `μScore=${microScore.toFixed(1)} | leverage=${leverage.toFixed(2)}x | ` +
        `baseCap=${(sizePct * 100).toFixed(1)}% | migPenalty=${migrationPenalty} | ` +
        `finalSize=$${cappedSize.toFixed(2)}`
    );
    
    return {
        poolAddress,
        poolName,
        microScore,
        tier,
        tierConfig,
        leverage,
        maxSize: sizeUsd,
        maxSizePct: sizePct,
        migrationPenalty,
        finalSize: cappedSize,
        allowed: cappedSize > 0,
        blockReason: cappedSize <= 0 ? 'Final size too small' : undefined,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate current portfolio risk state
 */
export function calculatePortfolioState(
    totalCapital: number,
    availableCapital: number,
    activePositions: ActivePosition[]
): PortfolioRiskState {
    // Initialize tier allocations
    const tierAllocations: PortfolioRiskState['tierAllocations'] = {
        A: { count: 0, deployed: 0, maxAllowed: RISK_TIERS.A.maxPoolsInTier },
        B: { count: 0, deployed: 0, maxAllowed: RISK_TIERS.B.maxPoolsInTier },
        C: { count: 0, deployed: 0, maxAllowed: RISK_TIERS.C.maxPoolsInTier },
        D: { count: 0, deployed: 0, maxAllowed: 0 },
    };
    
    // Aggregate current positions
    let totalDeployed = 0;
    
    for (const pos of activePositions) {
        totalDeployed += pos.size;
        tierAllocations[pos.tier].count++;
        tierAllocations[pos.tier].deployed += pos.size;
    }
    
    const deployedPct = totalCapital > 0 ? totalDeployed / totalCapital : 0;
    const maxDeployed = totalCapital * PORTFOLIO_CONSTRAINTS.maxTotalDeployedPct;
    const remainingCapacity = Math.max(0, maxDeployed - totalDeployed);
    const canAddPosition = deployedPct < PORTFOLIO_CONSTRAINTS.maxTotalDeployedPct;
    
    return {
        totalCapital,
        availableCapital,
        totalDeployed,
        deployedPct,
        tierAllocations,
        canAddPosition,
        remainingCapacity,
    };
}

/**
 * Check if capital is sufficient to begin trading cycle
 */
export function checkCapitalGating(availableCapital: number): {
    canTrade: boolean;
    reason: string;
} {
    if (availableCapital < PORTFOLIO_CONSTRAINTS.minExecutionCapital) {
        return {
            canTrade: false,
            reason: `Insufficient capital: $${availableCapital.toFixed(2)} < $${PORTFOLIO_CONSTRAINTS.minExecutionCapital} minimum`,
        };
    }
    
    return {
        canTrade: true,
        reason: `Capital OK: $${availableCapital.toFixed(2)} >= $${PORTFOLIO_CONSTRAINTS.minExecutionCapital}`,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH RISK ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════════

export interface PoolWithRisk {
    address: string;
    name: string;
    microScore: number;
    liquiditySlope: number;
}

/**
 * Assign risk tiers to a batch of pools
 * Filters out forbidden pools and ranks by final size
 */
export function assignRiskBatch(
    pools: PoolWithRisk[],
    totalCapital: number,
    availableCapital: number,
    activePositions: ActivePosition[]
): PoolRiskAssignment[] {
    const portfolioState = calculatePortfolioState(totalCapital, availableCapital, activePositions);
    
    const assignments: PoolRiskAssignment[] = [];
    
    // Create mutable copy of portfolio state for simulating assignments
    const simulatedState = { ...portfolioState };
    
    // Sort pools by score descending (best first)
    const sortedPools = [...pools].sort((a, b) => b.microScore - a.microScore);
    
    for (const pool of sortedPools) {
        const assignment = assignPoolRisk(
            pool.address,
            pool.name,
            pool.microScore,
            pool.liquiditySlope,
            totalCapital,
            simulatedState
        );
        
        assignments.push(assignment);
        
        // Update simulated state if assignment was allowed
        if (assignment.allowed) {
            simulatedState.tierAllocations[assignment.tier].count++;
            simulatedState.tierAllocations[assignment.tier].deployed += assignment.finalSize;
            simulatedState.totalDeployed += assignment.finalSize;
            simulatedState.remainingCapacity -= assignment.finalSize;
            simulatedState.deployedPct = simulatedState.totalDeployed / totalCapital;
            simulatedState.canAddPosition = simulatedState.deployedPct < PORTFOLIO_CONSTRAINTS.maxTotalDeployedPct;
        }
    }
    
    return assignments;
}

/**
 * Get only allowed pool assignments
 */
export function getAllowedPools(assignments: PoolRiskAssignment[]): PoolRiskAssignment[] {
    return assignments.filter(a => a.allowed);
}

/**
 * Log portfolio risk summary
 */
export function logPortfolioRiskSummary(state: PortfolioRiskState): void {
    const divider = '═══════════════════════════════════════════════════════════════';
    
    logger.info(`\n${divider}`);
    logger.info('PORTFOLIO RISK STATE');
    logger.info(divider);
    logger.info(`Total Capital:     $${state.totalCapital.toFixed(2)}`);
    logger.info(`Available:         $${state.availableCapital.toFixed(2)}`);
    logger.info(`Total Deployed:    $${state.totalDeployed.toFixed(2)} (${(state.deployedPct * 100).toFixed(1)}%)`);
    logger.info(`Remaining Capacity: $${state.remainingCapacity.toFixed(2)}`);
    logger.info(`Can Add Position:  ${state.canAddPosition ? 'YES' : 'NO'}`);
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info('TIER ALLOCATIONS:');
    
    for (const tier of ['A', 'B', 'C', 'D'] as RiskTier[]) {
        const alloc = state.tierAllocations[tier];
        const config = RISK_TIERS[tier];
        logger.info(
            `  Tier ${tier} (${config.name.padEnd(12)}): ` +
            `${alloc.count}/${alloc.maxAllowed} positions | ` +
            `$${alloc.deployed.toFixed(2)} deployed`
        );
    }
    
    logger.info(divider + '\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    assignRiskTier,
    getTierConfig,
    calculateLeverage,
    calculateSizeCap,
    calculateMigrationPenalty,
    assignPoolRisk,
    calculatePortfolioState,
    checkCapitalGating,
    assignRiskBatch,
    getAllowedPools,
    logPortfolioRiskSummary,
    RISK_TIERS,
    PORTFOLIO_CONSTRAINTS,
};

