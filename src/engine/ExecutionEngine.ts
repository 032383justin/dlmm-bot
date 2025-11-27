/**
 * ExecutionEngine.ts - Tier 3 Architecture
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * DLMM-native execution engine with:
 * - Slope-based entry conditions (velocitySlope, liquiditySlope, entropySlope > 0)
 * - Momentum-based scaling
 * - Hard exit rules (no price, no TVL checks)
 * 
 * Entry Condition:
 *   score >= 32 && velocitySlope > 0 && liquiditySlope > 0 && entropySlope > 0
 * 
 * Scale Condition:
 *   existingPosition && score >= 45 && velocitySlope > baseline && liquiditySlope > baseline
 * 
 * Exit Conditions (HARD):
 *   - feeIntensity collapse ≥ 35% from entry
 *   - velocitySlope negative 2 snapshots in a row
 *   - entropySlope < 0
 *   - liquiditySlope < 0
 * 
 * NO bootstrap cycle.
 * NO observe only.
 * NO minimum history for 24h data.
 * Trade ONLY based on live slope dynamics + entropy trend.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    computeMicrostructureMetrics,
    MicrostructureMetrics,
    registerPosition,
    unregisterPosition,
    BinFocusedPosition,
    getSwapHistory,
    getPoolHistory,
} from '../services/dlmmTelemetry';
import {
    getMomentumSlopes,
    computeMomentumScore,
    recordEntryBaseline,
    getEntryBaseline,
    clearEntryBaseline,
    checkNegativeVelocityStreak,
    clearNegativeVelocityCount,
    MomentumSlopes,
} from '../scoring/momentumEngine';
import {
    calcEntrySize,
    calcScaleSize,
    canAddPosition,
    getMaxAddableSize,
    ENTRY_THRESHOLDS,
    MAX_EXPOSURE,
} from './positionSizingEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TokenInfo {
    symbol: string;
    decimals: number;
}

export interface ScoredPool {
    address: string;
    score: number;
    liquidityUSD: number;
    volume24h: number;
    binCount: number;
    activeBin: number;
    tokenA: TokenInfo;
    tokenB: TokenInfo;
    
    // Microstructure enrichment (optional, preferred)
    microMetrics?: MicrostructureMetrics;
    isMarketAlive?: boolean;
    
    // Momentum slopes
    velocitySlope?: number;
    liquiditySlope?: number;
    entropySlope?: number;
}

export interface Position {
    pool: string;
    symbol: string;
    entryPrice: number;
    currentPrice: number;
    sizeUSD: number;
    pnl: number;
    pnlPercent: number;
    bins: number[];
    openedAt: number;
    closedAt?: number;
    closed: boolean;
    exitReason?: string;
    
    // Bin-focused tracking
    entryBin: number;
    currentBin: number;
    binOffset: number;
    
    // Microstructure at entry
    entryFeeIntensity: number;
    entrySwapVelocity: number;
    entry3mFeeIntensity: number;
    
    // Tier 3: Entry baselines for scaling
    entryVelocitySlope: number;
    entryLiquiditySlope: number;
}

export interface PortfolioSnapshot {
    capital: number;
    openPositions: Position[];
    closedPositions: Position[];
    realized: number;
    unrealized: number;
    equity: number;
    ts: Date;
}

export interface ExecutionEngineConfig {
    capital?: number;
    rebalanceInterval?: number;
    takeProfit?: number;
    stopLoss?: number;
    maxConcurrentPools?: number;
    allocationStrategy?: 'equal' | 'weighted';
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT SIGNAL INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

export interface ExitEvaluation {
    shouldExit: boolean;
    reason: string;
    feeIntensityDrop: number;
    velocityNegativeStreak: boolean;
    entropySlope: number;
    liquiditySlope: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CAPITAL = 10_000;
const DEFAULT_TAKE_PROFIT = 0.04;      // +4% (traditional, kept as fallback)
const DEFAULT_STOP_LOSS = -0.02;       // -2% (traditional, kept as fallback)
const DEFAULT_REBALANCE_INTERVAL = 15 * 60 * 1000;  // 15 minutes
const DEFAULT_MAX_CONCURRENT_POOLS = 3;
const BIN_RANGE_OFFSET = 2;            // ±2 bins around activeBin
const TICK_SPACING_ESTIMATE = 0.0001;  // Price increment per bin (estimate)

// Tier 3 exit thresholds
const EXIT_THRESHOLDS = {
    feeIntensityCollapse: 0.35,        // 35% drop from entry
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class ExecutionEngine {
    private capital: number;
    private initialCapital: number;
    private rebalanceInterval: number;
    private takeProfit: number;
    private stopLoss: number;
    private maxConcurrentPools: number;
    private allocationStrategy: 'equal' | 'weighted';

    private positions: Position[] = [];
    private closedPositions: Position[] = [];
    private realized: number = 0;
    private lastRebalanceTime: number = 0;
    private poolQueue: ScoredPool[] = [];

    constructor(config: ExecutionEngineConfig = {}) {
        this.capital = config.capital ?? DEFAULT_CAPITAL;
        this.initialCapital = this.capital;
        this.rebalanceInterval = config.rebalanceInterval ?? DEFAULT_REBALANCE_INTERVAL;
        this.takeProfit = config.takeProfit ?? DEFAULT_TAKE_PROFIT;
        this.stopLoss = config.stopLoss ?? DEFAULT_STOP_LOSS;
        this.maxConcurrentPools = config.maxConcurrentPools ?? DEFAULT_MAX_CONCURRENT_POOLS;
        this.allocationStrategy = config.allocationStrategy ?? 'equal';

        this.log('Engine initialized (Tier 3 Architecture)', {
            capital: this.capital,
            maxExposure: `${MAX_EXPOSURE * 100}%`,
            rebalanceInterval: `${this.rebalanceInterval / 60000} min`,
            maxConcurrentPools: this.maxConcurrentPools,
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Place positions in pools that pass Tier 3 entry conditions.
     * 
     * Entry Condition:
     *   score >= 32 && velocitySlope > 0 && liquiditySlope > 0 && entropySlope > 0
     */
    public placePools(pools: ScoredPool[]): void {
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('[EXECUTION] placePools called (Tier 3)');
        logger.info(`[EXECUTION] Pool count: ${pools.length}`);

        // Sort by score descending
        const sorted = [...pools].sort((a, b) => b.score - a.score);
        this.poolQueue = sorted;

        // Get current total exposure
        const currentTotalExposure = this.positions
            .filter(p => !p.closed)
            .reduce((sum, p) => sum + p.sizeUSD, 0);

        // Filter for Tier 3 entry conditions
        const openPoolAddresses = new Set(
            this.positions.filter(p => !p.closed).map(p => p.pool)
        );
        
        const eligiblePools: ScoredPool[] = [];
        
        for (const pool of sorted) {
            // Skip if already have position
            if (openPoolAddresses.has(pool.address)) {
                continue;
            }
            
            // Check Tier 3 entry conditions
            const entryCheck = this.checkTier3EntryConditions(pool);
            
            if (entryCheck.canEnter) {
                eligiblePools.push(pool);
                logger.info(`[EXECUTION] ✓ ${pool.address.slice(0, 8)}... passes entry: ${entryCheck.reason}`);
            } else {
                logger.info(`[EXECUTION] ✗ ${pool.address.slice(0, 8)}... blocked: ${entryCheck.reason}`);
            }
        }

        // Calculate open slots
        const openPositionCount = this.positions.filter(p => !p.closed).length;
        const slotsAvailable = this.maxConcurrentPools - openPositionCount;

        if (slotsAvailable <= 0) {
            logger.info('[EXECUTION] No slots available for new positions');
            return;
        }

        // Select top eligible pools for available slots
        const poolsToEnter = eligiblePools.slice(0, slotsAvailable);

        if (poolsToEnter.length === 0) {
            logger.info('[EXECUTION] No pools pass Tier 3 entry conditions');
            return;
        }

        // Enter each pool with elastic sizing
        for (const pool of poolsToEnter) {
            const volatility = this.estimateVolatility(pool);
            const sizing = calcEntrySize(pool.score, volatility, this.capital);
            
            if (sizing.size > 0) {
                // Check exposure limit
                const exposureCheck = canAddPosition(sizing.size, currentTotalExposure, this.capital);
                
                if (exposureCheck.allowed) {
                    this.enterPosition(pool, sizing.size);
                } else {
                    logger.info(`[EXECUTION] Entry blocked by exposure: ${exposureCheck.reason}`);
                }
            }
        }

        logger.info('[EXECUTION] placePools complete', {
            entered: poolsToEnter.filter(p => 
                this.positions.some(pos => pos.pool === p.address && !pos.closed)
            ).length,
            totalOpen: this.positions.filter(p => !p.closed).length,
        });
    }

    /**
     * Update all positions and check exit/scale conditions.
     */
    public update(): void {
        const now = Date.now();
        
        // Update each open position
        for (const position of this.positions) {
            if (position.closed) continue;

            // Find current pool data
            const poolData = this.poolQueue.find(p => p.address === position.pool);
            if (poolData) {
                this.updatePositionPrice(position, poolData);
            }

            // Check Tier 3 exit conditions (HARD)
            const exitEval = this.evaluateExit(position.pool, position);
            
            if (exitEval.shouldExit) {
                logger.info(
                    `[EXIT] reason="${exitEval.reason}" pool=${position.pool.slice(0, 8)}... ` +
                    `feeIntensityDrop=${(exitEval.feeIntensityDrop * 100).toFixed(1)}% ` +
                    `slopeE=${exitEval.entropySlope.toFixed(6)} slopeL=${exitEval.liquiditySlope.toFixed(6)}`
                );
                this.exitPosition(position, exitEval.reason);
                continue;
            }
            
            // Check scaling opportunity
            if (poolData) {
                this.checkScaleOpportunity(position, poolData);
            }
        }

        // Check for rebalance
        if (now - this.lastRebalanceTime >= this.rebalanceInterval) {
            this.rebalance();
            this.lastRebalanceTime = now;
        }
    }

    /**
     * Get current portfolio snapshot.
     */
    public getPortfolioStatus(): PortfolioSnapshot {
        const openPositions = this.positions.filter(p => !p.closed);
        const unrealized = openPositions.reduce((sum, p) => sum + p.pnl, 0);
        const equity = this.capital + unrealized;

        return {
            capital: this.capital,
            openPositions: [...openPositions],
            closedPositions: [...this.closedPositions],
            realized: this.realized,
            unrealized,
            equity,
            ts: new Date(),
        };
    }

    /**
     * Force close all positions.
     */
    public closeAll(reason: string = 'MANUAL_CLOSE'): void {
        logger.info('[EXECUTION] Closing all positions', { reason });

        for (const position of this.positions) {
            if (!position.closed) {
                this.exitPosition(position, reason);
            }
        }
    }

    /**
     * Get open position count.
     */
    public getOpenPositionCount(): number {
        return this.positions.filter(p => !p.closed).length;
    }

    /**
     * Get total equity.
     */
    public getEquity(): number {
        const unrealized = this.positions
            .filter(p => !p.closed)
            .reduce((sum, p) => sum + p.pnl, 0);
        return this.capital + unrealized;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 3 ENTRY CONDITIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Check Tier 3 entry conditions:
     *   score >= 32 && velocitySlope > 0 && liquiditySlope > 0 && entropySlope > 0
     */
    private checkTier3EntryConditions(pool: ScoredPool): { canEnter: boolean; reason: string } {
        // Get momentum slopes
        const slopes = getMomentumSlopes(pool.address);
        
        // Check score threshold
        if (pool.score < ENTRY_THRESHOLDS.refuseBelow) {
            return {
                canEnter: false,
                reason: `Score ${pool.score.toFixed(1)} < ${ENTRY_THRESHOLDS.refuseBelow}`,
            };
        }
        
        // Check slopes exist
        if (!slopes || !slopes.valid) {
            return {
                canEnter: false,
                reason: 'Insufficient snapshot history for slopes',
            };
        }
        
        // Check velocitySlope > 0
        if (slopes.velocitySlope <= 0) {
            return {
                canEnter: false,
                reason: `velocitySlope ${slopes.velocitySlope.toFixed(6)} <= 0`,
            };
        }
        
        // Check liquiditySlope > 0
        if (slopes.liquiditySlope <= 0) {
            return {
                canEnter: false,
                reason: `liquiditySlope ${slopes.liquiditySlope.toFixed(6)} <= 0`,
            };
        }
        
        // Check entropySlope > 0
        if (slopes.entropySlope <= 0) {
            return {
                canEnter: false,
                reason: `entropySlope ${slopes.entropySlope.toFixed(6)} <= 0`,
            };
        }
        
        return {
            canEnter: true,
            reason: `score=${pool.score.toFixed(1)} slopeV=${slopes.velocitySlope.toFixed(6)} slopeL=${slopes.liquiditySlope.toFixed(6)} slopeE=${slopes.entropySlope.toFixed(6)}`,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 3 EXIT EVALUATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Evaluate exit conditions (HARD rules):
     * - feeIntensity collapse ≥ 35% from entry
     * - velocitySlope negative 2 snapshots in a row
     * - entropySlope < 0
     * - liquiditySlope < 0
     * 
     * NO price check.
     * NO TVL check.
     */
    public evaluateExit(poolId: string, position: Position): ExitEvaluation {
        const slopes = getMomentumSlopes(poolId);
        const metrics = computeMicrostructureMetrics(poolId);
        
        const result: ExitEvaluation = {
            shouldExit: false,
            reason: '',
            feeIntensityDrop: 0,
            velocityNegativeStreak: false,
            entropySlope: slopes?.entropySlope ?? 0,
            liquiditySlope: slopes?.liquiditySlope ?? 0,
        };
        
        if (!slopes || !slopes.valid || !metrics) {
            // Can't evaluate - don't exit on missing data
            return result;
        }
        
        // Check fee intensity collapse (35% drop from entry)
        if (position.entryFeeIntensity > 0) {
            const feeIntensityDrop = (position.entryFeeIntensity - metrics.feeIntensity) / position.entryFeeIntensity;
            result.feeIntensityDrop = feeIntensityDrop;
            
            if (feeIntensityDrop >= EXIT_THRESHOLDS.feeIntensityCollapse) {
                result.shouldExit = true;
                result.reason = `Fee intensity collapse ${(feeIntensityDrop * 100).toFixed(1)}% >= ${EXIT_THRESHOLDS.feeIntensityCollapse * 100}%`;
                return result;
            }
        }
        
        // Check velocity negative streak (2 consecutive)
        const hasNegativeStreak = checkNegativeVelocityStreak(poolId);
        result.velocityNegativeStreak = hasNegativeStreak;
        
        if (hasNegativeStreak) {
            result.shouldExit = true;
            result.reason = 'Velocity slope negative 2 snapshots in a row';
            return result;
        }
        
        // Check entropySlope < 0
        if (slopes.entropySlope < 0) {
            result.shouldExit = true;
            result.reason = `Entropy slope ${slopes.entropySlope.toFixed(6)} < 0`;
            return result;
        }
        
        // Check liquiditySlope < 0
        if (slopes.liquiditySlope < 0) {
            result.shouldExit = true;
            result.reason = `Liquidity slope ${slopes.liquiditySlope.toFixed(6)} < 0`;
            return result;
        }
        
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SCALE OPPORTUNITY CHECK
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Check and execute scaling opportunity.
     * 
     * Scale Condition:
     *   existingPosition && score >= 45 && velocitySlope > baseline && liquiditySlope > baseline
     */
    private checkScaleOpportunity(position: Position, pool: ScoredPool): void {
        // Get current slopes
        const slopes = getMomentumSlopes(pool.address);
        
        if (!slopes || !slopes.valid) {
            return;
        }
        
        // Check score threshold
        if (pool.score < 45) {
            return;
        }
        
        // Check slopes vs baseline
        if (slopes.velocitySlope <= position.entryVelocitySlope) {
            return;
        }
        
        if (slopes.liquiditySlope <= position.entryLiquiditySlope) {
            return;
        }
        
        // Calculate scale size
        const volatility = this.estimateVolatility(pool);
        const currentExposure = position.sizeUSD;
        const scaleResult = calcScaleSize(
            pool.score,
            volatility,
            this.capital,
            pool.address,
            currentExposure
        );
        
        if (!scaleResult.canScale || scaleResult.size <= 0) {
            return;
        }
        
        // Check total exposure limit
        const totalExposure = this.positions
            .filter(p => !p.closed)
            .reduce((sum, p) => sum + p.sizeUSD, 0);
        
        const exposureCheck = canAddPosition(scaleResult.size, totalExposure, this.capital);
        
        if (!exposureCheck.allowed) {
            logger.info(`[EXECUTION] Scale blocked by exposure: ${exposureCheck.reason}`);
            return;
        }
        
        // Execute scale
        position.sizeUSD += scaleResult.size;
        
        logger.info(
            `[POSITION] SCALE pool=${pool.address.slice(0, 8)}... ` +
            `added=$${scaleResult.size.toFixed(2)} ` +
            `newSize=$${position.sizeUSD.toFixed(2)} ` +
            `score=${pool.score.toFixed(1)} ` +
            `slopeV=${slopes.velocitySlope.toFixed(6)} > ${position.entryVelocitySlope.toFixed(6)} ` +
            `slopeL=${slopes.liquiditySlope.toFixed(6)} > ${position.entryLiquiditySlope.toFixed(6)}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENTRY LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    private enterPosition(pool: ScoredPool, sizeUSD: number): void {
        // Calculate entry bin cluster: ±2 bins around activeBin
        const bins = this.calculateBinRange(pool.activeBin);

        // Calculate entry price from active bin
        const entryPrice = this.binToPrice(pool.activeBin);

        // Get current microstructure metrics
        const metrics = pool.microMetrics || computeMicrostructureMetrics(pool.address);
        
        // Get momentum slopes for baseline
        const slopes = getMomentumSlopes(pool.address);
        
        // Get 3-minute fee intensity
        const swaps3m = getSwapHistory(pool.address, 3 * 60 * 1000);
        const history = getPoolHistory(pool.address);
        const latestLiquidity = history.length > 0 ? history[history.length - 1].liquidityUSD : 0;
        const fees3m = swaps3m.reduce((sum, s) => sum + s.feePaid, 0);
        const entry3mFeeIntensity = latestLiquidity > 0 ? fees3m / latestLiquidity : 0;

        const position: Position = {
            pool: pool.address,
            symbol: `${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
            entryPrice,
            currentPrice: entryPrice,
            sizeUSD,
            pnl: 0,
            pnlPercent: 0,
            bins,
            openedAt: Date.now(),
            closed: false,
            
            // Bin-focused tracking
            entryBin: pool.activeBin,
            currentBin: pool.activeBin,
            binOffset: 0,
            
            // Microstructure at entry
            entryFeeIntensity: metrics?.feeIntensity ?? 0,
            entrySwapVelocity: metrics?.swapVelocity ?? 0,
            entry3mFeeIntensity,
            
            // Tier 3: Entry baselines for scaling
            entryVelocitySlope: slopes?.velocitySlope ?? 0,
            entryLiquiditySlope: slopes?.liquiditySlope ?? 0,
        };

        this.positions.push(position);
        
        // Record baseline for this pool
        recordEntryBaseline(pool.address);
        
        // Register with telemetry service
        const binPosition: BinFocusedPosition = {
            poolId: pool.address,
            entryBin: pool.activeBin,
            entryTime: Date.now(),
            entryFeeIntensity: metrics?.feeIntensity ?? 0,
            entrySwapVelocity: metrics?.swapVelocity ?? 0,
            entry3mFeeIntensity,
            entry3mSwapVelocity: metrics?.rawSwapCount ? metrics.rawSwapCount / 180 : 0,
        };
        registerPosition(binPosition);

        // Log with Tier 3 format
        logger.info(
            `[MOMENTUM] pool=${pool.address.slice(0, 8)}... ` +
            `slopeV=${slopes?.velocitySlope?.toFixed(6) ?? 'N/A'} ` +
            `slopeL=${slopes?.liquiditySlope?.toFixed(6) ?? 'N/A'} ` +
            `slopeE=${slopes?.entropySlope?.toFixed(6) ?? 'N/A'} ` +
            `score=${pool.score.toFixed(1)}`
        );
        
        logger.info(
            `[POSITION] ENTRY size=${((sizeUSD / this.capital) * 100).toFixed(1)}% ` +
            `wallet=$${this.capital.toFixed(0)} ` +
            `amount=$${sizeUSD.toFixed(2)} ` +
            `symbol=${position.symbol}`
        );
    }

    private calculateBinRange(activeBin: number): number[] {
        const bins: number[] = [];
        for (let i = -BIN_RANGE_OFFSET; i <= BIN_RANGE_OFFSET; i++) {
            bins.push(activeBin + i);
        }
        return bins;
    }

    private binToPrice(bin: number): number {
        return 1 + (bin * TICK_SPACING_ESTIMATE);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRICE UPDATE
    // ═══════════════════════════════════════════════════════════════════════════

    private updatePositionPrice(position: Position, pool: ScoredPool): void {
        const currentPrice = this.binToPrice(pool.activeBin);
        position.currentPrice = currentPrice;
        
        position.currentBin = pool.activeBin;
        position.binOffset = Math.abs(pool.activeBin - position.entryBin);

        const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
        position.pnlPercent = priceChange;
        position.pnl = priceChange * position.sizeUSD;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    private exitPosition(position: Position, reason: string): void {
        if (position.closed) return;

        position.closed = true;
        position.closedAt = Date.now();
        position.exitReason = reason;

        // Realize PnL
        this.realized += position.pnl;
        this.capital += position.pnl;

        // Move to closed positions
        this.closedPositions.push({ ...position });
        
        // Cleanup
        unregisterPosition(position.pool);
        clearEntryBaseline(position.pool);
        clearNegativeVelocityCount(position.pool);

        const holdTime = position.closedAt - position.openedAt;

        logger.info(
            `[EXIT] reason="${reason}" ` +
            `pool=${position.pool.slice(0, 8)}... ` +
            `pnl=$${position.pnl.toFixed(2)} (${(position.pnlPercent * 100).toFixed(2)}%) ` +
            `holdTime=${this.formatDuration(holdTime)}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REBALANCE
    // ═══════════════════════════════════════════════════════════════════════════

    private rebalance(): void {
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('[EXECUTION] Rebalance cycle (Tier 3)');

        const openPositions = this.positions.filter(p => !p.closed);

        if (openPositions.length === 0) {
            logger.info('[EXECUTION] No open positions to rebalance');
            return;
        }

        // Sort by PnL ascending (worst first)
        const sorted = [...openPositions].sort((a, b) => a.pnl - b.pnl);

        // Check if worst performer should be rotated out
        const worstPosition = sorted[0];
        const bestQueuedPool = this.poolQueue.find(p => {
            // Not already in positions
            if (this.positions.some(pos => pos.pool === p.address && !pos.closed)) {
                return false;
            }
            // Passes Tier 3 entry conditions
            const entryCheck = this.checkTier3EntryConditions(p);
            return entryCheck.canEnter;
        });

        if (bestQueuedPool && worstPosition.pnl < 0) {
            const worstPoolData = this.poolQueue.find(p => p.address === worstPosition.pool);
            
            if (worstPoolData && bestQueuedPool.score > worstPoolData.score * 1.2) {
                logger.info('[EXECUTION] Rotating out underperformer', {
                    exiting: worstPosition.pool.slice(0, 8),
                    entering: bestQueuedPool.address.slice(0, 8),
                    currentPnl: worstPosition.pnl.toFixed(2),
                    oldScore: worstPoolData.score.toFixed(2),
                    newScore: bestQueuedPool.score.toFixed(2),
                });

                this.exitPosition(worstPosition, 'ROTATION');
                
                const volatility = this.estimateVolatility(bestQueuedPool);
                const sizing = calcEntrySize(bestQueuedPool.score, volatility, this.capital);
                
                if (sizing.size > 0) {
                    this.enterPosition(bestQueuedPool, sizing.size);
                }
            }
        }

        logger.info('[EXECUTION] Rebalance complete', {
            openPositions: this.positions.filter(p => !p.closed).length,
            totalRealized: this.realized.toFixed(2),
            equity: this.getEquity().toFixed(2),
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UTILITY
    // ═══════════════════════════════════════════════════════════════════════════

    private estimateVolatility(pool: ScoredPool): number {
        // Simple volatility estimate from bin velocity
        const metrics = pool.microMetrics;
        if (!metrics) return 0.5;
        
        // Normalize binVelocity to 0-1 range
        return Math.min(1, metrics.binVelocity / 100);
    }

    private truncate(address: string): string {
        if (address.length <= 12) return address;
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    private formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        }
        if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        }
        return `${seconds}s`;
    }

    private log(message: string, data?: Record<string, unknown>): void {
        if (data) {
            logger.info(`[EXECUTION] ${message} ${JSON.stringify(data)}`);
        } else {
            logger.info(`[EXECUTION] ${message}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG / INSPECTION
    // ═══════════════════════════════════════════════════════════════════════════

    public printStatus(): void {
        const status = this.getPortfolioStatus();
        
        const divider = '═══════════════════════════════════════════════════════════════';
        logger.info(`\n${divider}`);
        logger.info('PORTFOLIO STATUS (TIER 3)');
        logger.info(divider);
        logger.info(`Capital:      $${status.capital.toFixed(2)}`);
        logger.info(`Realized:     $${status.realized.toFixed(2)}`);
        logger.info(`Unrealized:   $${status.unrealized.toFixed(2)}`);
        logger.info(`Equity:       $${status.equity.toFixed(2)}`);
        logger.info(`Open Pos:     ${status.openPositions.length}`);
        logger.info(`Closed Pos:   ${status.closedPositions.length}`);
        logger.info('───────────────────────────────────────────────────────────────');
        
        if (status.openPositions.length > 0) {
            logger.info('OPEN POSITIONS:');
            for (const pos of status.openPositions) {
                const pnlSign = pos.pnl >= 0 ? '+' : '';
                logger.info(`  ${pos.symbol} | $${pos.sizeUSD.toFixed(0)} | ${pnlSign}$${pos.pnl.toFixed(2)} (${pnlSign}${(pos.pnlPercent * 100).toFixed(2)}%)`);
                logger.info(`    Entry Bin: ${pos.entryBin} | Current: ${pos.currentBin} | Offset: ${pos.binOffset}`);
                logger.info(`    Entry slopeV: ${pos.entryVelocitySlope.toFixed(6)} | slopeL: ${pos.entryLiquiditySlope.toFixed(6)}`);
            }
        }
        
        logger.info(divider + '\n');
    }

    public getConfig(): ExecutionEngineConfig {
        return {
            capital: this.initialCapital,
            rebalanceInterval: this.rebalanceInterval,
            takeProfit: this.takeProfit,
            stopLoss: this.stopLoss,
            maxConcurrentPools: this.maxConcurrentPools,
            allocationStrategy: this.allocationStrategy,
        };
    }

    public reset(): void {
        this.capital = this.initialCapital;
        this.positions = [];
        this.closedPositions = [];
        this.realized = 0;
        this.lastRebalanceTime = 0;
        this.poolQueue = [];
        logger.info('[EXECUTION] Engine reset to initial state');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export default ExecutionEngine;
