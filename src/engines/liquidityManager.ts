/**
 * Liquidity Manager - Top-Level Orchestrator
 * 
 * Tier-3 DLMM Strategy Layer
 * 
 * Coordinates:
 * - Liquidity Deployment Engine (zone-based deployment)
 * - Rebalance Engine (bin-shift rebalancing + auto-compound)
 * - Exit Engine (position closure)
 * 
 * Uses:
 * - Meteora DLMM API results from discovery pipeline
 * - Real-time RPC for activeBin + reserves
 * 
 * Does NOT touch:
 * - Scoring module
 * - Telemetry
 * - Discovery pipeline
 */

import logger from '../utils/logger';
import { Connection, PublicKey } from '@solana/web3.js';

// Engine imports
import {
    createDeploymentPlan,
    executeDeploymentPlan,
    calculatePositionSize,
    getActivePositions,
    getActivePoolCount,
    getTotalDeployedCapital,
    PoolLiquidityPosition,
    POSITION_LIMITS,
} from './liquidityEngine';

import {
    rebalanceAllPositions,
    compoundAllPositions,
    REBALANCE_CONFIG,
} from './rebalanceEngine';

import {
    checkAllExitConditions,
    PoolExitMetrics,
    ExitResult,
} from './exitEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool candidate from discovery pipeline
 */
export interface PoolCandidate {
    id: string;           // Pool address
    mintA: string;
    mintB: string;
    tvl: number;
    volume24h: number;
    activeBin: number;
    binStep: number;
    feeTier: number;
    price: number;
    score?: number;       // From scoring pipeline
}

/**
 * Manager configuration
 */
export interface ManagerConfig {
    totalCapital: number;
    rpcUrl: string;
    dryRun: boolean;      // If true, simulate but don't execute
}

/**
 * Cycle result
 */
export interface CycleResult {
    timestamp: number;
    deployed: number;
    rebalanced: number;
    compounded: number;
    exited: number;
    totalPositions: number;
    totalDeployed: number;
    errors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let config: ManagerConfig | null = null;
let connection: Connection | null = null;
let isRunning = false;
let lastCycleTime = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the liquidity manager
 */
export function initialize(managerConfig: ManagerConfig): void {
    config = managerConfig;
    connection = new Connection(managerConfig.rpcUrl, 'confirmed');
    
    logger.info('[MANAGER] Liquidity Manager initialized', {
        totalCapital: managerConfig.totalCapital,
        maxDeployable: (managerConfig.totalCapital * POSITION_LIMITS.maxCapitalDeployedPercent / 100).toFixed(2),
        maxPools: POSITION_LIMITS.maxPools,
        dryRun: managerConfig.dryRun,
    });
}

/**
 * Check if manager is initialized
 */
function ensureInitialized(): void {
    if (!config || !connection) {
        throw new Error('[MANAGER] Not initialized. Call initialize() first.');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RPC DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch current activeBin from on-chain (placeholder for SDK integration)
 */
async function fetchActiveBin(poolAddress: string): Promise<number | null> {
    try {
        // TODO: Replace with actual Meteora DLMM SDK calls
        // const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
        // return dlmmPool.getActiveBin();
        
        // For now, return null to indicate we should use API data
        return null;
    } catch (err: any) {
        logger.error(`[MANAGER] Failed to fetch activeBin for ${poolAddress}`, {
            error: err?.message,
        });
        return null;
    }
}

/**
 * Fetch activeBins for all active positions
 */
async function fetchActiveBinsForPositions(): Promise<Map<string, number>> {
    const positions = getActivePositions();
    const activeBinMap = new Map<string, number>();

    for (const position of positions) {
        const activeBin = await fetchActiveBin(position.poolAddress);
        if (activeBin !== null) {
            activeBinMap.set(position.poolAddress, activeBin);
        } else {
            // Use stored activeBin as fallback
            activeBinMap.set(position.poolAddress, position.activeBin);
        }
    }

    return activeBinMap;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEPLOYMENT LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deploy liquidity to a new pool
 */
export async function deployToPool(candidate: PoolCandidate): Promise<PoolLiquidityPosition | null> {
    ensureInitialized();

    const poolCount = getActivePoolCount();
    const deployedCapital = getTotalDeployedCapital();

    // Calculate position size
    const sizing = calculatePositionSize(config!.totalCapital, deployedCapital, poolCount);

    if (!sizing.canDeploy) {
        logger.warn(`[MANAGER] Cannot deploy to ${candidate.id}: ${sizing.reason}`);
        return null;
    }

    // Use smaller of max allowed or what's reasonable for this pool
    const deployAmount = Math.min(
        sizing.maxAmount,
        candidate.tvl * 0.01  // Don't be more than 1% of pool TVL
    );

    if (deployAmount < 100) {
        logger.warn(`[MANAGER] Deploy amount too small for ${candidate.id}: $${deployAmount.toFixed(2)}`);
        return null;
    }

    logger.info(`[MANAGER] 🚀 Deploying to ${candidate.id}`, {
        amount: deployAmount.toFixed(2),
        activeBin: candidate.activeBin,
        tvl: candidate.tvl.toFixed(2),
    });

    // Create deployment plan
    const plan = createDeploymentPlan(
        candidate.id,
        candidate.activeBin,
        deployAmount
    );

    if (config!.dryRun) {
        logger.info(`[MANAGER] DRY RUN - Would deploy $${deployAmount.toFixed(2)} to ${candidate.id}`);
        return null;
    }

    // Execute deployment
    return executeDeploymentPlan(plan, candidate.mintA, candidate.mintB);
}

/**
 * Deploy to multiple pool candidates
 */
export async function deployToCandidates(candidates: PoolCandidate[]): Promise<number> {
    ensureInitialized();

    let deployed = 0;
    const maxNewPools = POSITION_LIMITS.maxPools - getActivePoolCount();

    if (maxNewPools <= 0) {
        logger.info('[MANAGER] At max pool capacity, skipping new deployments');
        return 0;
    }

    // Sort by score if available, otherwise by TVL
    const sorted = [...candidates].sort((a, b) => {
        if (a.score !== undefined && b.score !== undefined) {
            return b.score - a.score;
        }
        return b.tvl - a.tvl;
    });

    // Deploy to top candidates
    for (const candidate of sorted.slice(0, maxNewPools)) {
        // Skip if already have position
        const existingPosition = getActivePositions().find(p => p.poolAddress === candidate.id);
        if (existingPosition) {
            continue;
        }

        const result = await deployToPool(candidate);
        if (result) {
            deployed++;
        }
    }

    return deployed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REBALANCING LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run rebalancing cycle
 */
export async function runRebalanceCycle(): Promise<{ rebalanced: number; compounded: number }> {
    ensureInitialized();

    // Fetch current activeBins
    const activeBinMap = await fetchActiveBinsForPositions();

    // Rebalance positions with significant drift
    const rebalanceResult = await rebalanceAllPositions(activeBinMap);

    // Auto-compound eligible positions
    const compoundResults = await compoundAllPositions();

    return {
        rebalanced: rebalanceResult.rebalanced,
        compounded: compoundResults.length,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build exit metrics from pool data
 */
function buildExitMetrics(candidate: PoolCandidate, velocity: number = 1.0, fees24h: number = 1000): PoolExitMetrics {
    return {
        poolAddress: candidate.id,
        liquidityUSD: candidate.tvl,
        volume24hUSD: candidate.volume24h,
        previousVolume24hUSD: 0,  // Will be tracked internally
        activeBin: candidate.activeBin,
        velocity,
        fees24h,
    };
}

/**
 * Run exit check cycle
 */
export async function runExitCheckCycle(
    poolData: Map<string, PoolCandidate>,
    velocityMap: Map<string, number> = new Map(),
    feesMap: Map<string, number> = new Map()
): Promise<ExitResult[]> {
    ensureInitialized();

    // Build metrics map for all active positions
    const metricsMap = new Map<string, PoolExitMetrics>();
    const positions = getActivePositions();

    for (const position of positions) {
        const candidate = poolData.get(position.poolAddress);
        if (candidate) {
            const velocity = velocityMap.get(position.poolAddress) ?? 1.0;
            const fees24h = feesMap.get(position.poolAddress) ?? 1000;
            metricsMap.set(position.poolAddress, buildExitMetrics(candidate, velocity, fees24h));
        }
    }

    // Check and execute exits
    return checkAllExitConditions(metricsMap);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATION CYCLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run full management cycle
 * 
 * Order of operations:
 * 1. Check exits (remove bad positions first)
 * 2. Rebalance existing positions
 * 3. Auto-compound fees
 * 4. Deploy to new pools (if capacity available)
 */
export async function runManagementCycle(
    candidates: PoolCandidate[],
    velocityMap: Map<string, number> = new Map(),
    feesMap: Map<string, number> = new Map()
): Promise<CycleResult> {
    ensureInitialized();

    const startTime = Date.now();
    const errors: string[] = [];

    logger.info('[MANAGER] ═══════════════════════════════════════════════════════════════');
    logger.info('[MANAGER] 🔄 Starting management cycle');
    logger.info('[MANAGER] ═══════════════════════════════════════════════════════════════');

    // Build pool data map
    const poolData = new Map<string, PoolCandidate>();
    for (const candidate of candidates) {
        poolData.set(candidate.id, candidate);
    }

    // Step 1: Check exits
    let exited = 0;
    try {
        const exitResults = await runExitCheckCycle(poolData, velocityMap, feesMap);
        exited = exitResults.length;
    } catch (err: any) {
        errors.push(`Exit check failed: ${err.message}`);
        logger.error('[MANAGER] Exit check failed', { error: err.message });
    }

    // Step 2 & 3: Rebalance and compound
    let rebalanced = 0;
    let compounded = 0;
    try {
        const rebalanceResult = await runRebalanceCycle();
        rebalanced = rebalanceResult.rebalanced;
        compounded = rebalanceResult.compounded;
    } catch (err: any) {
        errors.push(`Rebalance failed: ${err.message}`);
        logger.error('[MANAGER] Rebalance failed', { error: err.message });
    }

    // Step 4: Deploy to new pools
    let deployed = 0;
    try {
        deployed = await deployToCandidates(candidates);
    } catch (err: any) {
        errors.push(`Deployment failed: ${err.message}`);
        logger.error('[MANAGER] Deployment failed', { error: err.message });
    }

    const totalPositions = getActivePoolCount();
    const totalDeployed = getTotalDeployedCapital();
    const duration = Date.now() - startTime;

    lastCycleTime = Date.now();

    const result: CycleResult = {
        timestamp: Date.now(),
        deployed,
        rebalanced,
        compounded,
        exited,
        totalPositions,
        totalDeployed,
        errors,
    };

    logger.info('[MANAGER] ═══════════════════════════════════════════════════════════════');
    logger.info('[MANAGER] ✅ Cycle complete', {
        duration: `${duration}ms`,
        deployed,
        rebalanced,
        compounded,
        exited,
        totalPositions,
        totalDeployed: totalDeployed.toFixed(2),
    });
    logger.info('[MANAGER] ═══════════════════════════════════════════════════════════════');

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS & MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current manager status
 */
export function getStatus(): {
    initialized: boolean;
    totalPositions: number;
    totalDeployed: number;
    maxCapacity: number;
    utilizationPercent: number;
    lastCycleTime: number;
} {
    const totalPositions = getActivePoolCount();
    const totalDeployed = getTotalDeployedCapital();
    const maxCapacity = config ? (config.totalCapital * POSITION_LIMITS.maxCapitalDeployedPercent / 100) : 0;

    return {
        initialized: config !== null,
        totalPositions,
        totalDeployed,
        maxCapacity,
        utilizationPercent: maxCapacity > 0 ? (totalDeployed / maxCapacity) * 100 : 0,
        lastCycleTime,
    };
}

/**
 * Get all active positions
 */
export function getPositions(): PoolLiquidityPosition[] {
    return getActivePositions();
}

/**
 * Shutdown manager
 */
export function shutdown(): void {
    logger.info('[MANAGER] Shutting down liquidity manager');
    config = null;
    connection = null;
    isRunning = false;
}

