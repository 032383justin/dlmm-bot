/**
 * ExecutionEngine.ts - Tier 4 Institutional Architecture
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 EXECUTION ENGINE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Entry Conditions:
 * - tier4Score >= dynamic entryThreshold (28/32/36 based on regime)
 * - migrationDirection NOT blocking
 * - All slope conditions positive or within tolerance
 * 
 * Exit Conditions:
 * - tier4Score < dynamic exitThreshold (18/22/30 based on regime)
 * - Migration reversal detected
 * - Fee intensity collapse ≥ 35%
 * 
 * Dynamic Thresholds:
 * - BULL: ENTRY=28, EXIT=18
 * - NEUTRAL: ENTRY=32, EXIT=22
 * - BEAR: ENTRY=36, EXIT=30
 * 
 * Bin Width (dynamic):
 * - score > 45 → narrow bins (5-12)
 * - score > 35 → medium bins (8-18)
 * - else → wide bins (12-26)
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
    computeSlopeMultiplier,
    recordEntryBaseline,
    clearEntryBaseline,
    clearNegativeVelocityCount,
} from '../scoring/momentumEngine';
import {
    computeTier4Score,
    evaluateTier4Entry,
    logTier4Cycle,
    logEntryBlock,
    getBinWidthConfig,
    checkMigrationBlock,
    Tier4EnrichedPool,
    REGIME_THRESHOLDS,
} from '../scoring/microstructureScoring';
import {
    calcEntrySize,
    calcScaleSize,
    canAddPosition,
    calcBinWidth,
} from './positionSizingEngine';
import {
    MarketRegime,
    MigrationDirection,
    BinWidthConfig,
    Tier4Score,
} from '../types';

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
    
    // Tier 4 enrichment
    tier4?: Tier4Score | null;
    microMetrics?: MicrostructureMetrics;
    isMarketAlive?: boolean;
    
    // Tier 4 quick access
    tier4Score?: number;
    regime?: MarketRegime;
    migrationDirection?: MigrationDirection;
    entryThreshold?: number;
    exitThreshold?: number;
    binWidth?: BinWidthConfig;
    
    // Slopes
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
    
    // Tier 4: Entry state
    entryTier4Score: number;
    entryRegime: MarketRegime;
    entryMigrationDirection: MigrationDirection;
    entryVelocitySlope: number;
    entryLiquiditySlope: number;
    entryEntropySlope: number;
    entryBinWidth: BinWidthConfig;
    entryThreshold: number;
    exitThreshold: number;
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
// TIER 4 EXIT EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface Tier4ExitEvaluation {
    shouldExit: boolean;
    reason: string;
    tier4Score: number;
    exitThreshold: number;
    regime: MarketRegime;
    feeIntensityDrop: number;
    migrationReversal: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CAPITAL = 10_000;
const DEFAULT_TAKE_PROFIT = 0.04;
const DEFAULT_STOP_LOSS = -0.02;
const DEFAULT_REBALANCE_INTERVAL = 15 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_POOLS = 3;
const TICK_SPACING_ESTIMATE = 0.0001;

// Tier 4 exit thresholds
const EXIT_THRESHOLDS = {
    feeIntensityCollapse: 0.35,
};

const MAX_EXPOSURE = 0.30;

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

        logger.info('[EXECUTION] Engine initialized (Tier 4 Architecture)', {
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
     * Place positions in pools that pass Tier 4 entry conditions.
     */
    public placePools(pools: ScoredPool[]): void {
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('[EXECUTION] placePools called (Tier 4)');
        logger.info(`[EXECUTION] Pool count: ${pools.length}`);

        // Enrich pools with Tier 4 data and sort by score
        const enrichedPools = pools.map(pool => this.enrichWithTier4(pool));
        const sorted = [...enrichedPools].sort((a, b) => (b.tier4Score ?? 0) - (a.tier4Score ?? 0));
        this.poolQueue = sorted;

        // Get current total exposure
        const currentTotalExposure = this.positions
            .filter(p => !p.closed)
            .reduce((sum, p) => sum + p.sizeUSD, 0);

        // Filter for Tier 4 entry conditions
        const openPoolAddresses = new Set(
            this.positions.filter(p => !p.closed).map(p => p.pool)
        );
        
        const eligiblePools: ScoredPool[] = [];
        
        for (const pool of sorted) {
            // Skip if already have position
            if (openPoolAddresses.has(pool.address)) {
                continue;
            }
            
            // Check Tier 4 entry conditions
            const entryCheck = this.checkTier4EntryConditions(pool);
            
            if (entryCheck.canEnter) {
                eligiblePools.push(pool);
                
                // Log Tier 4 cycle metrics
                logTier4Cycle(pool.address);
                
                logger.info(`[EXECUTION] ✓ ${pool.address.slice(0, 8)}... passes Tier 4 entry`);
            } else {
                if (entryCheck.blockReason) {
                    logEntryBlock(pool.address, entryCheck.blockReason);
                }
                logger.info(`[EXECUTION] ✗ ${pool.address.slice(0, 8)}... blocked: ${entryCheck.blockReason || 'threshold not met'}`);
            }
        }

        // Calculate open slots
        const openPositionCount = this.positions.filter(p => !p.closed).length;
        const slotsAvailable = this.maxConcurrentPools - openPositionCount;

        if (slotsAvailable <= 0) {
            logger.info('[EXECUTION] No slots available for new positions');
            return;
        }

        // Select top eligible pools
        const poolsToEnter = eligiblePools.slice(0, slotsAvailable);

        if (poolsToEnter.length === 0) {
            logger.info('[EXECUTION] No pools pass Tier 4 entry conditions');
            return;
        }

        // Enter each pool with Tier 4 sizing
        for (const pool of poolsToEnter) {
            const tier4 = computeTier4Score(pool.address);
            if (!tier4 || !tier4.valid) continue;
            
            const volatility = this.estimateVolatility(pool);
            const sizing = calcEntrySize(
                tier4.tier4Score, 
                volatility, 
                this.capital,
                tier4.regime
            );
            
            if (sizing.size > 0) {
                const exposureCheck = canAddPosition(sizing.size, currentTotalExposure, this.capital);
                
                if (exposureCheck.allowed) {
                    this.enterPosition(pool, sizing.size, tier4);
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
        
        for (const position of this.positions) {
            if (position.closed) continue;

            // Find current pool data
            const poolData = this.poolQueue.find(p => p.address === position.pool);
            if (poolData) {
                this.updatePositionPrice(position, poolData);
            }

            // Check Tier 4 exit conditions
            const exitEval = this.evaluateTier4Exit(position.pool, position);
            
            if (exitEval.shouldExit) {
                logger.info(
                    `[EXIT] reason="${exitEval.reason}" ` +
                    `pool=${position.pool.slice(0, 8)}... ` +
                    `tier4Score=${exitEval.tier4Score.toFixed(1)} ` +
                    `exitThreshold=${exitEval.exitThreshold} ` +
                    `regime=${exitEval.regime}`
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
    // TIER 4 ENTRY CONDITIONS
    // ═══════════════════════════════════════════════════════════════════════════

    private enrichWithTier4(pool: ScoredPool): ScoredPool {
        const tier4 = computeTier4Score(pool.address);
        
        return {
            ...pool,
            tier4,
            tier4Score: tier4?.tier4Score ?? 0,
            regime: tier4?.regime ?? 'NEUTRAL',
            migrationDirection: tier4?.migrationDirection ?? 'neutral',
            entryThreshold: tier4?.entryThreshold ?? 32,
            exitThreshold: tier4?.exitThreshold ?? 22,
            binWidth: tier4?.binWidth,
            velocitySlope: tier4?.velocitySlope ?? 0,
            liquiditySlope: tier4?.liquiditySlope ?? 0,
            entropySlope: tier4?.entropySlope ?? 0,
        };
    }

    private checkTier4EntryConditions(pool: ScoredPool): { 
        canEnter: boolean; 
        blockReason?: string;
    } {
        const evaluation = evaluateTier4Entry({ 
            address: pool.address, 
            name: pool.tokenA.symbol + '/' + pool.tokenB.symbol 
        } as any);
        
        return {
            canEnter: evaluation.canEnter,
            blockReason: evaluation.blocked ? evaluation.blockReason : undefined,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 4 EXIT EVALUATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Evaluate Tier 4 exit conditions:
     * - tier4Score < dynamic exitThreshold
     * - Migration reversal
     * - Fee intensity collapse ≥ 35%
     */
    public evaluateTier4Exit(poolId: string, position: Position): Tier4ExitEvaluation {
        const tier4 = computeTier4Score(poolId);
        const metrics = computeMicrostructureMetrics(poolId);
        
        const result: Tier4ExitEvaluation = {
            shouldExit: false,
            reason: '',
            tier4Score: tier4?.tier4Score ?? 0,
            exitThreshold: tier4?.exitThreshold ?? 22,
            regime: tier4?.regime ?? 'NEUTRAL',
            feeIntensityDrop: 0,
            migrationReversal: false,
        };
        
        if (!tier4 || !tier4.valid || !metrics) {
            return result;
        }
        
        // Check if score below exit threshold
        if (tier4.tier4Score < tier4.exitThreshold) {
            result.shouldExit = true;
            result.reason = `Tier4 score ${tier4.tier4Score.toFixed(1)} < exit threshold ${tier4.exitThreshold} (${tier4.regime})`;
            return result;
        }
        
        // Check migration reversal
        const history = getPoolHistory(poolId);
        if (history.length >= 2) {
            const latest = history[history.length - 1];
            const previous = history[history.length - 2];
            const timeDeltaSec = (latest.fetchedAt - previous.fetchedAt) / 1000;
            const liquiditySlopePerMin = timeDeltaSec > 0 
                ? ((latest.liquidityUSD - previous.liquidityUSD) / latest.liquidityUSD) * (60 / timeDeltaSec)
                : 0;
            
            const migrationBlock = checkMigrationBlock(position.entryMigrationDirection, liquiditySlopePerMin);
            
            if (migrationBlock.blocked) {
                result.shouldExit = true;
                result.reason = `Migration reversal: ${migrationBlock.reason}`;
                result.migrationReversal = true;
                return result;
            }
        }
        
        // Check fee intensity collapse
        if (position.entryFeeIntensity > 0) {
            const feeIntensityDrop = (position.entryFeeIntensity - metrics.feeIntensity) / position.entryFeeIntensity;
            result.feeIntensityDrop = feeIntensityDrop;
            
            if (feeIntensityDrop >= EXIT_THRESHOLDS.feeIntensityCollapse) {
                result.shouldExit = true;
                result.reason = `Fee intensity collapse ${(feeIntensityDrop * 100).toFixed(1)}% >= ${EXIT_THRESHOLDS.feeIntensityCollapse * 100}%`;
                return result;
            }
        }
        
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SCALE OPPORTUNITY CHECK
    // ═══════════════════════════════════════════════════════════════════════════

    private checkScaleOpportunity(position: Position, pool: ScoredPool): void {
        const tier4 = computeTier4Score(pool.address);
        
        if (!tier4 || !tier4.valid) {
            return;
        }
        
        // Check if score is high enough (> 45 for scaling in Tier 4)
        if (tier4.tier4Score < 45) {
            return;
        }
        
        // Check slopes are improving vs baseline
        if (tier4.velocitySlope <= position.entryVelocitySlope) {
            return;
        }
        
        if (tier4.liquiditySlope <= position.entryLiquiditySlope) {
            return;
        }
        
        // Calculate scale size
        const volatility = this.estimateVolatility(pool);
        const currentExposure = position.sizeUSD;
        const scaleResult = calcScaleSize(
            tier4.tier4Score,
            volatility,
            this.capital,
            pool.address,
            currentExposure,
            tier4.regime
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
            `tier4Score=${tier4.tier4Score.toFixed(1)} ` +
            `regime=${tier4.regime}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENTRY LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    private enterPosition(pool: ScoredPool, sizeUSD: number, tier4: Tier4Score): void {
        // Calculate bin cluster based on Tier 4 bin width
        const binWidth = tier4.binWidth;
        const halfWidth = Math.floor((binWidth.min + binWidth.max) / 4);
        const bins = this.calculateBinRange(pool.activeBin, halfWidth);

        // Calculate entry price from active bin
        const entryPrice = this.binToPrice(pool.activeBin);

        // Get current microstructure metrics
        const metrics = pool.microMetrics || computeMicrostructureMetrics(pool.address);
        
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
            
            // Tier 4: Entry state
            entryTier4Score: tier4.tier4Score,
            entryRegime: tier4.regime,
            entryMigrationDirection: tier4.migrationDirection,
            entryVelocitySlope: tier4.velocitySlope,
            entryLiquiditySlope: tier4.liquiditySlope,
            entryEntropySlope: tier4.entropySlope,
            entryBinWidth: tier4.binWidth,
            entryThreshold: tier4.entryThreshold,
            exitThreshold: tier4.exitThreshold,
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
            entryTier4Score: tier4.tier4Score,
            entryRegime: tier4.regime,
            entryMigrationDirection: tier4.migrationDirection,
            entryVelocitySlope: tier4.velocitySlope,
            entryLiquiditySlope: tier4.liquiditySlope,
            entryEntropySlope: tier4.entropySlope,
        };
        registerPosition(binPosition);

        // Tier 4 logging
        logger.info(`[REGIME] ${tier4.regime} (multiplier=${tier4.regimeMultiplier.toFixed(2)})`);
        logger.info(`[MIGRATION] direction=${tier4.migrationDirection} slopeL=${tier4.liquiditySlope.toFixed(6)}`);
        logger.info(`[TIER4 SCORE] ${tier4.tier4Score.toFixed(2)} (base=${tier4.baseScore.toFixed(2)})`);
        logger.info(`[THRESHOLDS] entry=${tier4.entryThreshold} exit=${tier4.exitThreshold}`);
        logger.info(`[BIN WIDTH] ${tier4.binWidth.label} (${tier4.binWidth.min}-${tier4.binWidth.max})`);
        
        logger.info(
            `[POSITION] ENTRY size=${((sizeUSD / this.capital) * 100).toFixed(1)}% ` +
            `wallet=$${this.capital.toFixed(0)} ` +
            `amount=$${sizeUSD.toFixed(2)} ` +
            `symbol=${position.symbol} ` +
            `regime=${tier4.regime}`
        );
    }

    private calculateBinRange(activeBin: number, halfWidth: number = 2): number[] {
        const bins: number[] = [];
        for (let i = -halfWidth; i <= halfWidth; i++) {
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
            `holdTime=${this.formatDuration(holdTime)} ` +
            `entryRegime=${position.entryRegime}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REBALANCE
    // ═══════════════════════════════════════════════════════════════════════════

    private rebalance(): void {
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('[EXECUTION] Rebalance cycle (Tier 4)');

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
            if (this.positions.some(pos => pos.pool === p.address && !pos.closed)) {
                return false;
            }
            const entryCheck = this.checkTier4EntryConditions(p);
            return entryCheck.canEnter;
        });

        if (bestQueuedPool && worstPosition.pnl < 0) {
            const worstPoolData = this.poolQueue.find(p => p.address === worstPosition.pool);
            const worstScore = worstPoolData?.tier4Score ?? worstPoolData?.score ?? 0;
            const bestScore = bestQueuedPool.tier4Score ?? bestQueuedPool.score ?? 0;
            
            if (bestScore > worstScore * 1.2) {
                const tier4 = computeTier4Score(bestQueuedPool.address);
                
                logger.info('[EXECUTION] Rotating out underperformer', {
                    exiting: worstPosition.pool.slice(0, 8),
                    entering: bestQueuedPool.address.slice(0, 8),
                    currentPnl: worstPosition.pnl.toFixed(2),
                    oldScore: worstScore.toFixed(2),
                    newScore: bestScore.toFixed(2),
                    newRegime: tier4?.regime,
                });

                this.exitPosition(worstPosition, 'ROTATION');
                
                if (tier4 && tier4.valid) {
                    const volatility = this.estimateVolatility(bestQueuedPool);
                    const sizing = calcEntrySize(tier4.tier4Score, volatility, this.capital, tier4.regime);
                    
                    if (sizing.size > 0) {
                        this.enterPosition(bestQueuedPool, sizing.size, tier4);
                    }
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
        const metrics = pool.microMetrics;
        if (!metrics) return 0.5;
        return Math.min(1, metrics.binVelocity / 100);
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

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG / INSPECTION
    // ═══════════════════════════════════════════════════════════════════════════

    public printStatus(): void {
        const status = this.getPortfolioStatus();
        
        const divider = '═══════════════════════════════════════════════════════════════';
        logger.info(`\n${divider}`);
        logger.info('PORTFOLIO STATUS (TIER 4)');
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
                logger.info(`    Tier4: ${pos.entryTier4Score.toFixed(1)} | Regime: ${pos.entryRegime} | Bin: ${pos.entryBin}→${pos.currentBin}`);
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
