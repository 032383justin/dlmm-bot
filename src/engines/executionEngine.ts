/**
 * Execution Engine
 * 
 * Production DLMM execution module with:
 * - Top 3 pool selection by score
 * - 30%/30%/40% capital allocation
 * - Gaussian bin distribution around activeBin
 * - Conditional rebalancing (score drop, price move, liquidity drain)
 * - Global drawdown exit protection
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool with score from scoring pipeline
 */
export interface ScoredPool {
    id: string;
    mintA: string;
    mintB: string;
    score: number;
    activeBin: number;
    binStep: number;
    binCount: number;
    tvl: number;
    volume24h: number;
    price: number;
    liquidity: number;
}

/**
 * Gaussian bin allocation
 */
export interface BinAllocation {
    binId: number;
    weight: number;        // 0-1 normalized weight
    liquidityAmount: number;
}

/**
 * Deployed position state
 */
export interface DeployedPosition {
    poolAddress: string;
    mintA: string;
    mintB: string;
    
    // Entry state
    entryScore: number;
    entryPrice: number;
    entryLiquidity: number;
    entryActiveBin: number;
    
    // Current state
    currentScore: number;
    currentPrice: number;
    currentLiquidity: number;
    currentActiveBin: number;
    
    // Allocation
    allocationPercent: number;
    deployedAmount: number;
    
    // Bins
    bins: BinAllocation[];
    gaussianCenter: number;
    gaussianWidth: number;
    
    // Timestamps
    deployedAt: number;
    lastUpdated: number;
}

/**
 * Rebalance trigger result
 */
export interface RebalanceTrigger {
    triggered: boolean;
    reason: 'SCORE_DROP' | 'PRICE_MOVE' | 'LIQUIDITY_DRAIN' | null;
    details: string;
    currentValue: number;
    threshold: number;
}

/**
 * Execution cycle result
 */
export interface ExecutionCycleResult {
    timestamp: number;
    poolsDeployed: number;
    poolsRebalanced: number;
    poolsExited: number;
    globalDrawdown: number;
    emergencyExit: boolean;
    totalDeployed: number;
    errors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execution configuration
 */
export const EXECUTION_CONFIG = {
    // Pool selection
    maxPools: 3,
    allocations: [0.30, 0.30, 0.40] as const,  // 30%/30%/40%
    
    // Gaussian distribution
    gaussianWidthDivisor: 4,  // width = binCount / X
    minGaussianWidth: 3,
    maxGaussianWidth: 20,
    
    // Rebalance thresholds
    scoreDropThreshold: 0.15,      // 15% score drop
    priceMoveThreshold: 0.015,     // 1.5% price move
    liquidityDrainThreshold: 0.12, // 12% liquidity drain
    
    // Global exit
    globalDrawdownThreshold: 0.05, // 5% global drawdown
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Active deployed positions
const deployedPositions: Map<string, DeployedPosition> = new Map();

// Capital tracking
let totalCapital = 0;
let initialPortfolioValue = 0;
let currentPortfolioValue = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// GAUSSIAN DISTRIBUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Gaussian weight for a bin
 */
function gaussianWeight(binId: number, center: number, width: number): number {
    const sigma = width / 2;  // Standard deviation
    const exponent = -Math.pow(binId - center, 2) / (2 * Math.pow(sigma, 2));
    return Math.exp(exponent);
}

/**
 * Generate Gaussian bin distribution around activeBin
 */
export function generateGaussianDistribution(
    activeBin: number,
    binCount: number,
    totalAmount: number
): { bins: BinAllocation[]; width: number } {
    // Calculate dynamic width
    let width = Math.floor(binCount / EXECUTION_CONFIG.gaussianWidthDivisor);
    width = Math.max(EXECUTION_CONFIG.minGaussianWidth, width);
    width = Math.min(EXECUTION_CONFIG.maxGaussianWidth, width);
    
    const halfWidth = Math.floor(width / 2);
    const bins: BinAllocation[] = [];
    let totalWeight = 0;
    
    // Generate weights for each bin in range
    for (let offset = -halfWidth; offset <= halfWidth; offset++) {
        const binId = activeBin + offset;
        const weight = gaussianWeight(binId, activeBin, width);
        totalWeight += weight;
        bins.push({ binId, weight, liquidityAmount: 0 });
    }
    
    // Normalize weights and calculate liquidity amounts
    for (const bin of bins) {
        bin.weight = bin.weight / totalWeight;
        bin.liquidityAmount = totalAmount * bin.weight;
    }
    
    logger.debug(`[EXECUTION] Gaussian distribution: center=${activeBin}, width=${width}, bins=${bins.length}`);
    
    return { bins, width };
}

// ═══════════════════════════════════════════════════════════════════════════════
// POOL SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Select top pools by score
 */
export function selectTopPools(pools: ScoredPool[]): ScoredPool[] {
    // Sort by score descending
    const sorted = [...pools].sort((a, b) => b.score - a.score);
    
    // Take top N
    const selected = sorted.slice(0, EXECUTION_CONFIG.maxPools);
    
    logger.info(`[EXECUTION] Selected top ${selected.length} pools`, {
        pools: selected.map(p => ({
            id: p.id.slice(0, 8) + '...',
            score: p.score.toFixed(2),
        })),
    });
    
    return selected;
}

/**
 * Calculate allocation for each selected pool
 */
export function calculateAllocations(
    pools: ScoredPool[],
    capital: number
): Map<string, number> {
    const allocations = new Map<string, number>();
    
    for (let i = 0; i < pools.length && i < EXECUTION_CONFIG.allocations.length; i++) {
        const pool = pools[i];
        const allocation = capital * EXECUTION_CONFIG.allocations[i];
        allocations.set(pool.id, allocation);
        
        logger.debug(`[EXECUTION] Allocation: ${pool.id.slice(0, 8)}... = $${allocation.toFixed(2)} (${EXECUTION_CONFIG.allocations[i] * 100}%)`);
    }
    
    return allocations;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEPLOYMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deploy to a single pool with Gaussian distribution
 */
export async function deployToPool(
    pool: ScoredPool,
    amount: number,
    allocationPercent: number
): Promise<DeployedPosition | null> {
    try {
        logger.info(`[EXECUTION] 🚀 Deploying to ${pool.id.slice(0, 8)}...`, {
            amount: amount.toFixed(2),
            activeBin: pool.activeBin,
            binCount: pool.binCount,
        });
        
        // Generate Gaussian distribution
        const { bins, width } = generateGaussianDistribution(
            pool.activeBin,
            pool.binCount,
            amount
        );
        
        // TODO: Replace with actual Meteora DLMM SDK calls
        // for (const bin of bins) {
        //     await dlmmPool.addLiquidityToBin(bin.binId, bin.liquidityAmount);
        // }
        
        // Simulate deployment
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const position: DeployedPosition = {
            poolAddress: pool.id,
            mintA: pool.mintA,
            mintB: pool.mintB,
            
            // Entry state
            entryScore: pool.score,
            entryPrice: pool.price,
            entryLiquidity: pool.liquidity,
            entryActiveBin: pool.activeBin,
            
            // Current state (same as entry initially)
            currentScore: pool.score,
            currentPrice: pool.price,
            currentLiquidity: pool.liquidity,
            currentActiveBin: pool.activeBin,
            
            // Allocation
            allocationPercent,
            deployedAmount: amount,
            
            // Bins
            bins,
            gaussianCenter: pool.activeBin,
            gaussianWidth: width,
            
            // Timestamps
            deployedAt: Date.now(),
            lastUpdated: Date.now(),
        };
        
        // Store position
        deployedPositions.set(pool.id, position);
        
        logger.info(`[EXECUTION] ✅ Deployed to ${pool.id.slice(0, 8)}...`, {
            bins: bins.length,
            gaussianWidth: width,
        });
        
        return position;
        
    } catch (err: any) {
        logger.error(`[EXECUTION] ❌ Failed to deploy to ${pool.id}`, {
            error: err?.message,
        });
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REBALANCING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if position needs rebalancing
 */
export function checkRebalanceTriggers(position: DeployedPosition): RebalanceTrigger {
    // Check score drop
    const scoreDrop = (position.entryScore - position.currentScore) / position.entryScore;
    if (scoreDrop >= EXECUTION_CONFIG.scoreDropThreshold) {
        return {
            triggered: true,
            reason: 'SCORE_DROP',
            details: `Score dropped ${(scoreDrop * 100).toFixed(1)}% (threshold: ${EXECUTION_CONFIG.scoreDropThreshold * 100}%)`,
            currentValue: scoreDrop,
            threshold: EXECUTION_CONFIG.scoreDropThreshold,
        };
    }
    
    // Check price move
    const priceMove = Math.abs(position.currentPrice - position.entryPrice) / position.entryPrice;
    if (priceMove >= EXECUTION_CONFIG.priceMoveThreshold) {
        return {
            triggered: true,
            reason: 'PRICE_MOVE',
            details: `Price moved ${(priceMove * 100).toFixed(2)}% (threshold: ${EXECUTION_CONFIG.priceMoveThreshold * 100}%)`,
            currentValue: priceMove,
            threshold: EXECUTION_CONFIG.priceMoveThreshold,
        };
    }
    
    // Check liquidity drain
    const liquidityDrain = (position.entryLiquidity - position.currentLiquidity) / position.entryLiquidity;
    if (liquidityDrain >= EXECUTION_CONFIG.liquidityDrainThreshold) {
        return {
            triggered: true,
            reason: 'LIQUIDITY_DRAIN',
            details: `Liquidity drained ${(liquidityDrain * 100).toFixed(1)}% (threshold: ${EXECUTION_CONFIG.liquidityDrainThreshold * 100}%)`,
            currentValue: liquidityDrain,
            threshold: EXECUTION_CONFIG.liquidityDrainThreshold,
        };
    }
    
    return {
        triggered: false,
        reason: null,
        details: '',
        currentValue: 0,
        threshold: 0,
    };
}

/**
 * Rebalance a position - redistribute Gaussian around new activeBin
 */
export async function rebalancePosition(
    position: DeployedPosition,
    newActiveBin: number
): Promise<boolean> {
    try {
        logger.info(`[EXECUTION] 🔄 Rebalancing ${position.poolAddress.slice(0, 8)}...`, {
            oldCenter: position.gaussianCenter,
            newCenter: newActiveBin,
        });
        
        // Generate new Gaussian distribution
        const { bins, width } = generateGaussianDistribution(
            newActiveBin,
            position.bins.length * 2,  // Estimate binCount
            position.deployedAmount
        );
        
        // TODO: Replace with actual Meteora DLMM SDK calls
        // 1. Remove liquidity from old bins
        // 2. Add liquidity to new bins
        
        // Simulate rebalance
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Update position
        position.bins = bins;
        position.gaussianCenter = newActiveBin;
        position.gaussianWidth = width;
        position.currentActiveBin = newActiveBin;
        position.lastUpdated = Date.now();
        
        logger.info(`[EXECUTION] ✅ Rebalanced ${position.poolAddress.slice(0, 8)}...`);
        
        return true;
        
    } catch (err: any) {
        logger.error(`[EXECUTION] ❌ Failed to rebalance ${position.poolAddress}`, {
            error: err?.message,
        });
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL DRAWDOWN & EXIT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate global portfolio drawdown
 */
export function calculateGlobalDrawdown(): number {
    if (initialPortfolioValue === 0) return 0;
    
    // Calculate current value of all positions
    let currentValue = 0;
    for (const position of deployedPositions.values()) {
        currentValue += position.deployedAmount;  // Simplified - should include P&L
    }
    
    currentPortfolioValue = currentValue;
    const drawdown = (initialPortfolioValue - currentValue) / initialPortfolioValue;
    
    return Math.max(0, drawdown);
}

/**
 * Check if global drawdown threshold is breached
 */
export function isGlobalDrawdownBreached(): boolean {
    const drawdown = calculateGlobalDrawdown();
    return drawdown >= EXECUTION_CONFIG.globalDrawdownThreshold;
}

/**
 * Emergency exit all positions
 */
export async function emergencyExitAll(): Promise<number> {
    logger.warn('[EXECUTION] 🚨 EMERGENCY EXIT - Global drawdown threshold breached');
    
    let exited = 0;
    
    for (const [poolAddress, position] of deployedPositions) {
        try {
            logger.warn(`[EXECUTION] Exiting ${poolAddress.slice(0, 8)}...`);
            
            // TODO: Replace with actual Meteora DLMM SDK calls
            // await dlmmPool.removeAllLiquidity(position);
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            deployedPositions.delete(poolAddress);
            exited++;
            
            logger.info(`[EXECUTION] ✅ Exited ${poolAddress.slice(0, 8)}...`);
            
        } catch (err: any) {
            logger.error(`[EXECUTION] ❌ Failed to exit ${poolAddress}`, {
                error: err?.message,
            });
        }
    }
    
    logger.warn(`[EXECUTION] Emergency exit complete: ${exited} positions closed`);
    
    return exited;
}

/**
 * Exit a single position
 */
export async function exitPosition(poolAddress: string): Promise<boolean> {
    const position = deployedPositions.get(poolAddress);
    if (!position) {
        logger.warn(`[EXECUTION] No position found for ${poolAddress}`);
        return false;
    }
    
    try {
        logger.info(`[EXECUTION] Exiting ${poolAddress.slice(0, 8)}...`);
        
        // TODO: Replace with actual Meteora DLMM SDK calls
        await new Promise(resolve => setTimeout(resolve, 100));
        
        deployedPositions.delete(poolAddress);
        
        logger.info(`[EXECUTION] ✅ Exited ${poolAddress.slice(0, 8)}...`);
        return true;
        
    } catch (err: any) {
        logger.error(`[EXECUTION] ❌ Failed to exit ${poolAddress}`, {
            error: err?.message,
        });
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE POSITION STATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update position with latest pool data
 */
export function updatePositionState(
    poolAddress: string,
    score: number,
    price: number,
    liquidity: number,
    activeBin: number
): void {
    const position = deployedPositions.get(poolAddress);
    if (!position) return;
    
    position.currentScore = score;
    position.currentPrice = price;
    position.currentLiquidity = liquidity;
    position.currentActiveBin = activeBin;
    position.lastUpdated = Date.now();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXECUTION CYCLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize execution engine
 */
export function initialize(capital: number): void {
    totalCapital = capital;
    initialPortfolioValue = capital;
    currentPortfolioValue = capital;
    
    logger.info('[EXECUTION] Execution engine initialized', {
        capital: capital.toFixed(2),
        maxPools: EXECUTION_CONFIG.maxPools,
        allocations: EXECUTION_CONFIG.allocations.map(a => `${a * 100}%`).join('/'),
    });
}

/**
 * Run full execution cycle
 */
export async function runExecutionCycle(
    scoredPools: ScoredPool[]
): Promise<ExecutionCycleResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    
    logger.info('[EXECUTION] ═══════════════════════════════════════════════════════════════');
    logger.info('[EXECUTION] 🔄 Starting execution cycle');
    logger.info('[EXECUTION] ═══════════════════════════════════════════════════════════════');
    
    // Step 0: Check global drawdown
    const globalDrawdown = calculateGlobalDrawdown();
    if (isGlobalDrawdownBreached()) {
        const exited = await emergencyExitAll();
        return {
            timestamp: Date.now(),
            poolsDeployed: 0,
            poolsRebalanced: 0,
            poolsExited: exited,
            globalDrawdown,
            emergencyExit: true,
            totalDeployed: 0,
            errors: ['Global drawdown threshold breached - emergency exit'],
        };
    }
    
    // Step 1: Update existing position states
    for (const pool of scoredPools) {
        updatePositionState(
            pool.id,
            pool.score,
            pool.price,
            pool.liquidity,
            pool.activeBin
        );
    }
    
    // Step 2: Check rebalance triggers and rebalance if needed
    let poolsRebalanced = 0;
    for (const [poolAddress, position] of deployedPositions) {
        const trigger = checkRebalanceTriggers(position);
        if (trigger.triggered) {
            logger.warn(`[EXECUTION] Rebalance triggered for ${poolAddress.slice(0, 8)}...`, {
                reason: trigger.reason,
                details: trigger.details,
            });
            
            const success = await rebalancePosition(position, position.currentActiveBin);
            if (success) {
                poolsRebalanced++;
            } else {
                errors.push(`Rebalance failed for ${poolAddress}`);
            }
        }
    }
    
    // Step 3: Select top pools and deploy if we have capacity
    let poolsDeployed = 0;
    const currentPositionCount = deployedPositions.size;
    
    if (currentPositionCount < EXECUTION_CONFIG.maxPools) {
        // Filter out pools we already have positions in
        const availablePools = scoredPools.filter(p => !deployedPositions.has(p.id));
        const topPools = selectTopPools(availablePools);
        
        // Calculate how many new positions we can open
        const slotsAvailable = EXECUTION_CONFIG.maxPools - currentPositionCount;
        const poolsToDeploy = topPools.slice(0, slotsAvailable);
        
        // Calculate available capital
        const deployedCapital = Array.from(deployedPositions.values())
            .reduce((sum, p) => sum + p.deployedAmount, 0);
        const availableCapital = totalCapital - deployedCapital;
        
        // Calculate allocations for new pools
        const allocations = calculateAllocations(poolsToDeploy, availableCapital);
        
        // Deploy to each pool
        for (let i = 0; i < poolsToDeploy.length; i++) {
            const pool = poolsToDeploy[i];
            const amount = allocations.get(pool.id) || 0;
            const allocationPercent = EXECUTION_CONFIG.allocations[i] || 0;
            
            if (amount > 0) {
                const result = await deployToPool(pool, amount, allocationPercent);
                if (result) {
                    poolsDeployed++;
                } else {
                    errors.push(`Deployment failed for ${pool.id}`);
                }
            }
        }
    }
    
    // Calculate totals
    const totalDeployed = Array.from(deployedPositions.values())
        .reduce((sum, p) => sum + p.deployedAmount, 0);
    
    const result: ExecutionCycleResult = {
        timestamp: Date.now(),
        poolsDeployed,
        poolsRebalanced,
        poolsExited: 0,
        globalDrawdown,
        emergencyExit: false,
        totalDeployed,
        errors,
    };
    
    logger.info('[EXECUTION] ═══════════════════════════════════════════════════════════════');
    logger.info('[EXECUTION] ✅ Cycle complete', {
        duration: `${Date.now() - startTime}ms`,
        deployed: poolsDeployed,
        rebalanced: poolsRebalanced,
        positions: deployedPositions.size,
        totalDeployed: totalDeployed.toFixed(2),
        drawdown: `${(globalDrawdown * 100).toFixed(2)}%`,
    });
    logger.info('[EXECUTION] ═══════════════════════════════════════════════════════════════');
    
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE ACCESSORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get all deployed positions
 */
export function getDeployedPositions(): DeployedPosition[] {
    return Array.from(deployedPositions.values());
}

/**
 * Get position for a specific pool
 */
export function getPosition(poolAddress: string): DeployedPosition | undefined {
    return deployedPositions.get(poolAddress);
}

/**
 * Get current status
 */
export function getStatus(): {
    positionCount: number;
    totalDeployed: number;
    globalDrawdown: number;
    drawdownThreshold: number;
} {
    return {
        positionCount: deployedPositions.size,
        totalDeployed: Array.from(deployedPositions.values())
            .reduce((sum, p) => sum + p.deployedAmount, 0),
        globalDrawdown: calculateGlobalDrawdown(),
        drawdownThreshold: EXECUTION_CONFIG.globalDrawdownThreshold,
    };
}

/**
 * Reset state (for testing)
 */
export function reset(): void {
    deployedPositions.clear();
    totalCapital = 0;
    initialPortfolioValue = 0;
    currentPortfolioValue = 0;
    logger.info('[EXECUTION] State reset');
}

