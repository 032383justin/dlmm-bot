/**
 * ExecutionEngine.ts
 * 
 * DLMM-native execution engine with bin-focused position management.
 * Uses microstructure metrics for entry/exit decisions.
 * 
 * CRITICAL CHANGES:
 * - Entry uses bin-cluster targeting
 * - Exit monitors bin offset from entry
 * - Rebalance when |activeBin - entryBin| >= 2
 * - Exit when feeIntensity collapses or swapVelocity drops
 */

import logger from '../utils/logger';
import {
    computeMicrostructureMetrics,
    MicrostructureMetrics,
    evaluatePositionExit,
    registerPosition,
    unregisterPosition,
    BinFocusedPosition,
    getSwapHistory,
    getPoolHistory,
    EXIT_THRESHOLDS,
} from '../services/dlmmTelemetry';

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
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CAPITAL = 10_000;
const DEFAULT_TAKE_PROFIT = 0.04;      // +4%
const DEFAULT_STOP_LOSS = -0.02;       // -2%
const DEFAULT_REBALANCE_INTERVAL = 15 * 60 * 1000;  // 15 minutes
const DEFAULT_MAX_CONCURRENT_POOLS = 3;
const BIN_RANGE_OFFSET = 2;            // ±2 bins around activeBin
const TICK_SPACING_ESTIMATE = 0.0001;  // Price increment per bin (estimate)

// Microstructure thresholds
const MIN_MICROSTRUCTURE_SCORE = 25;   // Minimum score to enter
const MIN_MARKET_ALIVE = true;         // Require market to be alive for entry

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

        this.log('Engine initialized', {
            capital: this.capital,
            takeProfit: `${this.takeProfit * 100}%`,
            stopLoss: `${this.stopLoss * 100}%`,
            rebalanceInterval: `${this.rebalanceInterval / 60000} min`,
            maxConcurrentPools: this.maxConcurrentPools,
            allocationStrategy: this.allocationStrategy,
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Place positions in top scored pools with microstructure gating
     */
    public placePools(pools: ScoredPool[]): void {
        this.log('═══════════════════════════════════════════════════════════════');
        this.log('placePools called', { poolCount: pools.length });

        // Sort by score descending
        const sorted = [...pools].sort((a, b) => b.score - a.score);

        // Store queue for rotation
        this.poolQueue = sorted;

        // Filter out pools we already have positions in
        const openPoolAddresses = new Set(
            this.positions.filter(p => !p.closed).map(p => p.pool)
        );
        
        // Filter for market alive + minimum score
        const availablePools = sorted.filter(p => {
            if (openPoolAddresses.has(p.address)) return false;
            
            // Check microstructure gating
            if (p.microMetrics) {
                if (!p.microMetrics.isMarketAlive && MIN_MARKET_ALIVE) {
                    this.log(`Skipping ${p.address.slice(0, 8)}... - market not alive`);
                    return false;
                }
                if (p.score < MIN_MICROSTRUCTURE_SCORE) {
                    this.log(`Skipping ${p.address.slice(0, 8)}... - score ${p.score.toFixed(1)} < ${MIN_MICROSTRUCTURE_SCORE}`);
                    return false;
                }
            }
            
            return true;
        });

        // Calculate open slots
        const openPositionCount = this.positions.filter(p => !p.closed).length;
        const slotsAvailable = this.maxConcurrentPools - openPositionCount;

        if (slotsAvailable <= 0) {
            this.log('No slots available for new positions');
            return;
        }

        // Select top pools for available slots
        const poolsToEnter = availablePools.slice(0, slotsAvailable);

        if (poolsToEnter.length === 0) {
            this.log('No new pools to enter (all filtered by gating)');
            return;
        }

        // Calculate allocation per pool
        const allocationPerPool = this.calculateAllocation(poolsToEnter.length);

        // Enter each pool
        for (const pool of poolsToEnter) {
            this.enterPosition(pool, allocationPerPool);
        }

        this.log('placePools complete', {
            entered: poolsToEnter.length,
            totalOpen: this.positions.filter(p => !p.closed).length,
        });
    }

    /**
     * Update all positions with current prices and check exit conditions
     */
    public update(): void {
        const now = Date.now();
        
        // Update each open position
        for (const position of this.positions) {
            if (position.closed) continue;

            // Find current pool data from queue
            const poolData = this.poolQueue.find(p => p.address === position.pool);
            if (poolData) {
                this.updatePositionPrice(position, poolData);
            }

            // Check microstructure exit conditions
            this.checkMicrostructureExit(position);
            
            // Check traditional exit conditions
            if (!position.closed) {
                this.checkExitConditions(position);
            }
        }

        // Check for rebalance
        if (now - this.lastRebalanceTime >= this.rebalanceInterval) {
            this.rebalance();
            this.lastRebalanceTime = now;
        }
    }

    /**
     * Get current portfolio snapshot
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
     * Force close all positions
     */
    public closeAll(reason: string = 'MANUAL_CLOSE'): void {
        this.log('Closing all positions', { reason });

        for (const position of this.positions) {
            if (!position.closed) {
                this.exitPosition(position, reason);
            }
        }
    }

    /**
     * Get open position count
     */
    public getOpenPositionCount(): number {
        return this.positions.filter(p => !p.closed).length;
    }

    /**
     * Get total equity
     */
    public getEquity(): number {
        const unrealized = this.positions
            .filter(p => !p.closed)
            .reduce((sum, p) => sum + p.pnl, 0);
        return this.capital + unrealized;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ALLOCATION LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    private calculateAllocation(poolCount: number): number {
        if (this.allocationStrategy === 'equal') {
            return this.capital / this.maxConcurrentPools;
        }

        // Weighted: first pool gets more
        const weights = [0.40, 0.35, 0.25];
        const totalWeight = weights.slice(0, poolCount).reduce((a, b) => a + b, 0);
        return (this.capital * (weights[0] ?? 0.33)) / totalWeight;
    }

    private calculatePositionAllocation(poolIndex: number, totalPools: number): number {
        if (this.allocationStrategy === 'equal') {
            return this.capital / this.maxConcurrentPools;
        }

        const weights = [0.40, 0.35, 0.25];
        return this.capital * (weights[poolIndex] ?? 0.25);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ENTRY LOGIC (BIN-FOCUSED)
    // ═══════════════════════════════════════════════════════════════════════════

    private enterPosition(pool: ScoredPool, sizeUSD: number): void {
        // Calculate entry bin cluster: ±2 bins around activeBin
        const bins = this.calculateBinRange(pool.activeBin);

        // Calculate entry price from active bin
        const entryPrice = this.binToPrice(pool.activeBin);

        // Get current microstructure metrics for entry tracking
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
        };

        this.positions.push(position);
        
        // Register with telemetry service for exit monitoring
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

        this.log('✅ Position opened (bin-focused)', {
            symbol: position.symbol,
            pool: this.truncate(pool.address),
            score: pool.score.toFixed(2),
            sizeUSD: sizeUSD.toFixed(2),
            entryPrice: entryPrice.toFixed(6),
            entryBin: pool.activeBin,
            binCluster: `[${bins[0]} → ${bins[bins.length - 1]}]`,
            marketAlive: pool.microMetrics?.isMarketAlive ?? 'N/A',
        });
    }

    private calculateBinRange(activeBin: number): number[] {
        const bins: number[] = [];
        for (let i = -BIN_RANGE_OFFSET; i <= BIN_RANGE_OFFSET; i++) {
            bins.push(activeBin + i);
        }
        return bins;
    }

    private binToPrice(bin: number): number {
        // Simplified price calculation: base price * (1 + bin * tickSpacing)
        // In reality this depends on binStep, but we simulate
        return 1 + (bin * TICK_SPACING_ESTIMATE);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRICE UPDATE LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    private updatePositionPrice(position: Position, pool: ScoredPool): void {
        // Calculate current price from active bin
        const currentPrice = this.binToPrice(pool.activeBin);
        position.currentPrice = currentPrice;
        
        // Update bin tracking
        position.currentBin = pool.activeBin;
        position.binOffset = Math.abs(pool.activeBin - position.entryBin);

        // Calculate PnL
        const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
        position.pnlPercent = priceChange;
        position.pnl = priceChange * position.sizeUSD;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MICROSTRUCTURE EXIT LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    private checkMicrostructureExit(position: Position): void {
        // Get exit signal from telemetry service
        const exitSignal = evaluatePositionExit(position.pool);
        
        if (!exitSignal) return;
        
        // Check for rebalance condition
        if (exitSignal.shouldRebalance) {
            this.log('🔄 Rebalance triggered (bin offset)', {
                symbol: position.symbol,
                entryBin: exitSignal.entryBin,
                currentBin: exitSignal.currentBin,
                offset: exitSignal.binOffset,
            });
            // Note: Actual rebalance logic would adjust position here
        }
        
        // Check for exit condition
        if (exitSignal.shouldExit) {
            this.exitPosition(position, `MICROSTRUCTURE: ${exitSignal.reason}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // TRADITIONAL EXIT LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    private checkExitConditions(position: Position): void {
        // Check take profit
        if (position.pnlPercent >= this.takeProfit) {
            this.exitPosition(position, 'TAKE_PROFIT');
            return;
        }

        // Check stop loss
        if (position.pnlPercent <= this.stopLoss) {
            this.exitPosition(position, 'STOP_LOSS');
            return;
        }
    }

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
        
        // Unregister from telemetry service
        unregisterPosition(position.pool);

        const holdTime = position.closedAt - position.openedAt;

        this.log('🚨 Position closed', {
            symbol: position.symbol,
            pool: this.truncate(position.pool),
            reason,
            pnl: position.pnl.toFixed(2),
            pnlPercent: `${(position.pnlPercent * 100).toFixed(2)}%`,
            holdTime: this.formatDuration(holdTime),
            entryBin: position.entryBin,
            exitBin: position.currentBin,
            binOffset: position.binOffset,
            newCapital: this.capital.toFixed(2),
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ROTATION LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    private rebalance(): void {
        this.log('═══════════════════════════════════════════════════════════════');
        this.log('Rebalance cycle started');

        const openPositions = this.positions.filter(p => !p.closed);

        if (openPositions.length === 0) {
            this.log('No open positions to rebalance');
            return;
        }

        // Sort by PnL ascending (worst first)
        const sorted = [...openPositions].sort((a, b) => a.pnl - b.pnl);

        // Close worst performer if we have room for better pools
        const worstPosition = sorted[0];
        const bestQueuedPool = this.poolQueue.find(
            p => !this.positions.some(pos => pos.pool === p.address && !pos.closed) &&
                 (p.microMetrics?.isMarketAlive ?? true) // Must have alive market
        );

        if (bestQueuedPool && worstPosition.pnl < 0) {
            // Find the score of worst position's pool
            const worstPoolData = this.poolQueue.find(p => p.address === worstPosition.pool);
            
            if (worstPoolData && bestQueuedPool.score > worstPoolData.score * 1.2) {
                // New pool is significantly better, rotate
                this.log('Rotating out of underperformer', {
                    exiting: this.truncate(worstPosition.pool),
                    entering: this.truncate(bestQueuedPool.address),
                    currentPnl: worstPosition.pnl.toFixed(2),
                    oldScore: worstPoolData.score.toFixed(2),
                    newScore: bestQueuedPool.score.toFixed(2),
                    newMarketAlive: bestQueuedPool.microMetrics?.isMarketAlive ?? 'N/A',
                });

                this.exitPosition(worstPosition, 'ROTATION');
                
                // Enter new position with same allocation
                const allocation = this.calculateAllocation(1);
                this.enterPosition(bestQueuedPool, allocation);
            }
        }

        this.log('Rebalance complete', {
            openPositions: this.positions.filter(p => !p.closed).length,
            totalRealized: this.realized.toFixed(2),
            equity: this.getEquity().toFixed(2),
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UTILITY METHODS
    // ═══════════════════════════════════════════════════════════════════════════

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
        const timestamp = new Date().toISOString();
        if (data) {
            console.log(`[${timestamp}] [EXECUTION] ${message}`, JSON.stringify(data));
        } else {
            console.log(`[${timestamp}] [EXECUTION] ${message}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG / INSPECTION
    // ═══════════════════════════════════════════════════════════════════════════

    public printStatus(): void {
        const status = this.getPortfolioStatus();
        
        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('PORTFOLIO STATUS (BIN-FOCUSED)');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(`Capital:      $${status.capital.toFixed(2)}`);
        console.log(`Realized:     $${status.realized.toFixed(2)}`);
        console.log(`Unrealized:   $${status.unrealized.toFixed(2)}`);
        console.log(`Equity:       $${status.equity.toFixed(2)}`);
        console.log(`Open Pos:     ${status.openPositions.length}`);
        console.log(`Closed Pos:   ${status.closedPositions.length}`);
        console.log('───────────────────────────────────────────────────────────────');
        
        if (status.openPositions.length > 0) {
            console.log('OPEN POSITIONS:');
            for (const pos of status.openPositions) {
                const pnlSign = pos.pnl >= 0 ? '+' : '';
                console.log(`  ${pos.symbol} | $${pos.sizeUSD.toFixed(0)} | ${pnlSign}$${pos.pnl.toFixed(2)} (${pnlSign}${(pos.pnlPercent * 100).toFixed(2)}%)`);
                console.log(`    Entry Bin: ${pos.entryBin} | Current: ${pos.currentBin} | Offset: ${pos.binOffset}`);
            }
        }
        
        console.log('═══════════════════════════════════════════════════════════════\n');
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
        this.log('Engine reset to initial state');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export default ExecutionEngine;
