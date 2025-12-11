/**
 * ExecutionEngine.ts - Stateful Execution Engine
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 EXECUTION ENGINE — STATEFUL MODE WITH INTERNAL LOOPS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * ARCHITECTURAL RULES:
 * 1. Engine runs internal timers for continuous monitoring
 * 2. ScanLoop still runs every 120s but is NOT the sole driver
 * 3. Engine evaluates exit conditions continuously
 * 4. Positions are monitored in real-time
 * 
 * PUBLIC API:
 * - initialize() — one-time setup, recovers positions from DB
 * - start() — starts all internal runtime loops
 * - stop() — stops all internal loops gracefully
 * - placePools(pools) — evaluate and queue pools for entry
 * - executeEntry(pool, size) — execute a single entry
 * - executeExit(positionId, reason) — execute a single exit
 * - evaluatePositionHealth(positionId) — check if position should exit
 * - getPortfolioStatus() — get current state
 * - closeAll(reason) — emergency close all
 * 
 * INTERNAL LOOPS (started by start()):
 * - Price watcher (5s) — updates position prices
 * - Exit watcher (10s) — evaluates exit conditions
 * - Snapshot timer (60s) — writes portfolio snapshots
 * - PnL drift updater (15s) — recalculates unrealized PnL
 * - Regime updater (30s) — updates regime and migration direction
 * - Bin tracker (5s) — tracks bin movements
 * 
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
    getEntryBaseline,
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
import { capitalManager } from '../services/capitalManager';
import { 
    saveTradeToDB, 
    createTrade,
    updateTradeExitInDB,
    loadActiveTradesFromDB,
    registerTrade,
    unregisterTrade,
    getAllActiveTrades,
    createDefaultExecutionData,
    Trade,
    TradeExitState,
    canExitTrade,
    acquireExitLock,
    markTradeClosed,
    releaseExitLock,
    getTrade,
} from '../db/models/Trade';
import { RiskTier, assignRiskTier, calculateLeverage } from './riskBucketEngine';
import { logAction } from '../db/supabase';
import {
    persistTradeEntry,
    persistTradeExit,
    updatePositionState,
} from '../integrations/persistence/tradePersistence';
import {
    evaluateHarmonicStop,
    registerHarmonicTrade,
    unregisterHarmonicTrade,
    createMicroMetricsSnapshot,
    createHarmonicContext,
    MicroMetricsSnapshot,
    HarmonicDecision,
} from './harmonicStops';

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
    id: string;               // Trade ID from database
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
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT STATE GUARD - SINGLE EXIT AUTHORITY PATTERN
    // ═══════════════════════════════════════════════════════════════════════════
    exitState: 'open' | 'closing' | 'closed';
    pendingExit: boolean;
}

export interface PortfolioSnapshot {
    capital: number;
    lockedCapital: number;
    totalEquity: number;
    openPositions: Position[];
    closedPositions: Position[];
    realized: number;
    unrealized: number;
    equity: number;
    ts: Date;
}

export interface ExecutionEngineConfig {
    capital?: number;
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

export interface PositionHealthEvaluation {
    positionId: string;
    shouldExit: boolean;
    exitReason: string;
    exitType: 'HARMONIC' | 'TIER4' | 'NONE';
    tier4Eval?: Tier4ExitEvaluation;
    harmonicDecision?: HarmonicDecision;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CAPITAL = 10_000;
const DEFAULT_TAKE_PROFIT = 0.04;
const DEFAULT_STOP_LOSS = -0.02;
const DEFAULT_MAX_CONCURRENT_POOLS = 3;
const TICK_SPACING_ESTIMATE = 0.0001;

// Tier 4 exit thresholds
const EXIT_THRESHOLDS = {
    feeIntensityCollapse: 0.35,
};

const MAX_EXPOSURE = 0.30;

// ═══════════════════════════════════════════════════════════════════════════════
// STATEFUL MODE INTERVALS (milliseconds)
// ═══════════════════════════════════════════════════════════════════════════════
const PRICE_WATCHER_INTERVAL = 5_000;      // 5 seconds
const EXIT_WATCHER_INTERVAL = 10_000;      // 10 seconds
const SNAPSHOT_INTERVAL = 60_000;          // 60 seconds
const PNL_DRIFT_INTERVAL = 15_000;         // 15 seconds
const REGIME_UPDATER_INTERVAL = 30_000;    // 30 seconds
const BIN_TRACKER_INTERVAL = 5_000;        // 5 seconds

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION ENGINE CLASS — STATEFUL EXECUTOR WITH INTERNAL LOOPS
// ═══════════════════════════════════════════════════════════════════════════════

export class ExecutionEngine {
    private initialCapital: number;
    private takeProfit: number;
    private stopLoss: number;
    private maxConcurrentPools: number;
    private allocationStrategy: 'equal' | 'weighted';

    public positions: Position[] = [];
    private closedPositions: Position[] = [];
    private poolQueue: ScoredPool[] = [];
    private initialized: boolean = false;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STATEFUL MODE — INTERNAL LOOP TIMERS
    // ═══════════════════════════════════════════════════════════════════════════
    private running: boolean = false;
    private priceWatcherTimer: NodeJS.Timeout | null = null;
    private exitWatcherTimer: NodeJS.Timeout | null = null;
    private snapshotTimer: NodeJS.Timeout | null = null;
    private pnlDriftTimer: NodeJS.Timeout | null = null;
    private regimeUpdaterTimer: NodeJS.Timeout | null = null;
    private binTrackerTimer: NodeJS.Timeout | null = null;
    
    // Loop execution guards (prevent overlapping runs)
    private priceWatcherRunning: boolean = false;
    private exitWatcherRunning: boolean = false;
    private snapshotRunning: boolean = false;
    private pnlDriftRunning: boolean = false;
    private regimeUpdaterRunning: boolean = false;
    private binTrackerRunning: boolean = false;

    constructor(config: ExecutionEngineConfig = {}) {
        this.initialCapital = config.capital ?? DEFAULT_CAPITAL;
        this.takeProfit = config.takeProfit ?? DEFAULT_TAKE_PROFIT;
        this.stopLoss = config.stopLoss ?? DEFAULT_STOP_LOSS;
        this.maxConcurrentPools = config.maxConcurrentPools ?? DEFAULT_MAX_CONCURRENT_POOLS;
        this.allocationStrategy = config.allocationStrategy ?? 'equal';

        logger.info('[ENGINE] Stateful mode enabled');
        logger.info('[EXECUTION] Engine instance created (STATEFUL MODE)', {
            initialCapital: this.initialCapital,
            maxExposure: `${MAX_EXPOSURE * 100}%`,
            maxConcurrentPools: this.maxConcurrentPools,
        });
    }

    /**
     * Initialize engine - recovers positions from database
     * NOTE: Capital manager is already initialized by bootstrap.ts
     * DO NOT call capitalManager.initialize() here - it's already done.
     */
    async initialize(): Promise<boolean> {
        if (this.initialized) {
            return true;
        }

        try {
            // Verify capital manager is ready
            const balance = await capitalManager.getBalance();
            if (balance < 0) {
                logger.error('[EXECUTION] ❌ Capital manager not ready');
                return false;
            }

            // Load active trades from database
            const activeTrades = await loadActiveTradesFromDB();
            
            // Convert trades to positions and register for harmonic monitoring
            for (const trade of activeTrades) {
                const position = this.tradeToPosition(trade);
                if (position) {
                    this.positions.push(position);
                    
                    // Register recovered trade for harmonic monitoring
                    const baselineSnapshot = createMicroMetricsSnapshot(
                        trade.timestamp,
                        trade.velocity > 0 ? trade.velocity / 100 : 0.05,
                        trade.velocity > 0 ? trade.velocity / 100 : 0.1,
                        0,
                        0.7,
                        0.02,
                        trade.velocitySlope,
                        trade.liquiditySlope,
                        trade.entropySlope
                    );
                    
                    let tier: 'A' | 'B' | 'C' | 'D' = 'C';
                    if (trade.score >= 40) tier = 'A';
                    else if (trade.score >= 32) tier = 'B';
                    else if (trade.score >= 24) tier = 'C';
                    else tier = 'D';
                    
                    registerHarmonicTrade(
                        trade.id,
                        trade.pool,
                        trade.poolName,
                        tier,
                        baselineSnapshot
                    );
                    
                    logger.info(`[EXECUTION] Recovered position: ${trade.poolName} ($${trade.size})`);
                }
            }

            const currentBalance = await capitalManager.getBalance();
            const state = await capitalManager.getFullState();
            
            logger.info('[EXECUTION] ✅ Engine initialized (STATEFUL MODE)', {
                availableBalance: `$${currentBalance.toFixed(2)}`,
                lockedBalance: `$${state?.locked_balance?.toFixed(2) || 0}`,
                totalPnL: `$${state?.total_realized_pnl?.toFixed(2) || 0}`,
                recoveredPositions: this.positions.length,
            });

            this.initialized = true;
            return true;

        } catch (err: any) {
            logger.error(`[EXECUTION] ❌ Initialization failed: ${err.message}`);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATEFUL MODE — START/STOP RUNTIME LOOPS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Start all internal runtime loops
     * This makes the engine run continuously, not just when invoked by ScanLoop
     */
    public start(): void {
        if (this.running) {
            logger.warn('[ENGINE] Already running - ignoring start()');
            return;
        }

        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('[ENGINE] Starting internal runtime loops...');
        logger.info('   Engine Mode: STATEFUL');

        let loopCount = 0;

        // Price watcher - updates position prices from pool data
        logger.info('[ENGINE] Starting price watcher...');
        this.priceWatcherTimer = setInterval(() => this.runPriceWatcher(), PRICE_WATCHER_INTERVAL);
        loopCount++;

        // Exit watcher - evaluates exit conditions continuously
        logger.info('[ENGINE] Starting exit watcher...');
        this.exitWatcherTimer = setInterval(() => this.runExitWatcher(), EXIT_WATCHER_INTERVAL);
        loopCount++;

        // Snapshot timer - writes portfolio snapshots
        logger.info('[ENGINE] Starting snapshot timer...');
        this.snapshotTimer = setInterval(() => this.runSnapshotWriter(), SNAPSHOT_INTERVAL);
        loopCount++;

        // PnL drift updater - recalculates unrealized PnL
        logger.info('[ENGINE] Starting PnL drift updater...');
        this.pnlDriftTimer = setInterval(() => this.runPnlDriftUpdater(), PNL_DRIFT_INTERVAL);
        loopCount++;

        // Regime updater - updates regime and migration direction
        logger.info('[ENGINE] Starting regime updater...');
        this.regimeUpdaterTimer = setInterval(() => this.runRegimeUpdater(), REGIME_UPDATER_INTERVAL);
        loopCount++;

        // Bin tracker - tracks bin movements
        logger.info('[ENGINE] Starting bin tracker...');
        this.binTrackerTimer = setInterval(() => this.runBinTracker(), BIN_TRACKER_INTERVAL);
        loopCount++;

        this.running = true;
        logger.info(`[ENGINE] ✅ Started ${loopCount} internal loops`);
        logger.info('═══════════════════════════════════════════════════════════════');
    }

    /**
     * Stop all internal runtime loops
     */
    public stop(): void {
        if (!this.running) {
            logger.warn('[ENGINE] Not running - ignoring stop()');
            return;
        }

        logger.info('[ENGINE] Stopping internal runtime loops...');

        if (this.priceWatcherTimer) {
            clearInterval(this.priceWatcherTimer);
            this.priceWatcherTimer = null;
        }
        if (this.exitWatcherTimer) {
            clearInterval(this.exitWatcherTimer);
            this.exitWatcherTimer = null;
        }
        if (this.snapshotTimer) {
            clearInterval(this.snapshotTimer);
            this.snapshotTimer = null;
        }
        if (this.pnlDriftTimer) {
            clearInterval(this.pnlDriftTimer);
            this.pnlDriftTimer = null;
        }
        if (this.regimeUpdaterTimer) {
            clearInterval(this.regimeUpdaterTimer);
            this.regimeUpdaterTimer = null;
        }
        if (this.binTrackerTimer) {
            clearInterval(this.binTrackerTimer);
            this.binTrackerTimer = null;
        }

        this.running = false;
        logger.info('[ENGINE] ✅ All internal loops stopped');
    }

    /**
     * Check if engine is running
     */
    public isRunning(): boolean {
        return this.running;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // INTERNAL LOOP IMPLEMENTATIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Price watcher loop - updates position prices from telemetry
     */
    private async runPriceWatcher(): Promise<void> {
        if (this.priceWatcherRunning) return;
        this.priceWatcherRunning = true;

        try {
            const openPositions = this.positions.filter(p => !p.closed);
            
            for (const position of openPositions) {
                const poolData = this.poolQueue.find(p => p.address === position.pool);
                if (poolData) {
                    this.updatePositionPrice(position, poolData);
                }
            }
        } catch (err: any) {
            logger.error(`[ENGINE] Price watcher error: ${err.message}`);
        } finally {
            this.priceWatcherRunning = false;
        }
    }

    /**
     * Exit watcher loop - evaluates exit conditions for all positions
     */
    private async runExitWatcher(): Promise<void> {
        if (this.exitWatcherRunning) return;
        this.exitWatcherRunning = true;

        try {
            const openPositions = this.positions.filter(p => !p.closed && p.exitState === 'open');
            
            for (const position of openPositions) {
                const health = this.evaluatePositionHealth(position.id);
                
                if (health.shouldExit) {
                    logger.info(`[ENGINE] Exit watcher triggered exit for ${position.symbol}: ${health.exitReason}`);
                    await this.executeExit(position.id, health.exitReason, 'EXIT_WATCHER');
                }
            }
        } catch (err: any) {
            logger.error(`[ENGINE] Exit watcher error: ${err.message}`);
        } finally {
            this.exitWatcherRunning = false;
        }
    }

    /**
     * Snapshot writer loop - writes portfolio state periodically
     */
    private async runSnapshotWriter(): Promise<void> {
        if (this.snapshotRunning) return;
        this.snapshotRunning = true;

        try {
            const openPositions = this.positions.filter(p => !p.closed);
            const unrealized = openPositions.reduce((sum, p) => sum + p.pnl, 0);
            
            const state = await capitalManager.getFullState();
            if (state) {
                const snapshot = {
                    timestamp: new Date().toISOString(),
                    availableBalance: state.available_balance,
                    lockedBalance: state.locked_balance,
                    totalRealizedPnl: state.total_realized_pnl,
                    unrealizedPnl: unrealized,
                    openPositionCount: openPositions.length,
                    equity: state.available_balance + state.locked_balance + unrealized,
                };
                
                // Log snapshot (actual DB write happens via existing logAction)
                try {
                    await logAction('PORTFOLIO_SNAPSHOT', snapshot);
                } catch {
                    // Ignore snapshot logging errors
                }
            }
        } catch (err: any) {
            logger.error(`[ENGINE] Snapshot writer error: ${err.message}`);
        } finally {
            this.snapshotRunning = false;
        }
    }

    /**
     * PnL drift updater loop - recalculates unrealized PnL for all positions
     */
    private async runPnlDriftUpdater(): Promise<void> {
        if (this.pnlDriftRunning) return;
        this.pnlDriftRunning = true;

        try {
            const openPositions = this.positions.filter(p => !p.closed);
            
            for (const position of openPositions) {
                // PnL is recalculated in updatePositionPrice
                const priceChange = (position.currentPrice - position.entryPrice) / position.entryPrice;
                position.pnlPercent = priceChange;
                position.pnl = priceChange * position.sizeUSD;
            }
        } catch (err: any) {
            logger.error(`[ENGINE] PnL drift updater error: ${err.message}`);
        } finally {
            this.pnlDriftRunning = false;
        }
    }

    /**
     * Regime updater loop - updates regime and migration direction for positions
     */
    private async runRegimeUpdater(): Promise<void> {
        if (this.regimeUpdaterRunning) return;
        this.regimeUpdaterRunning = true;

        try {
            const openPositions = this.positions.filter(p => !p.closed);
            
            for (const position of openPositions) {
                const tier4 = computeTier4Score(position.pool);
                if (tier4 && tier4.valid) {
                    // Update current regime info (entry values stay fixed)
                    const poolData = this.poolQueue.find(p => p.address === position.pool);
                    if (poolData) {
                        poolData.regime = tier4.regime;
                        poolData.migrationDirection = tier4.migrationDirection;
                        poolData.tier4Score = tier4.tier4Score;
                    }
                    
                    // Update position in database with new regime and health score
                    await updatePositionState(position.id, {
                        regime: tier4.regime,
                        healthScore: tier4.tier4Score,
                    });
                }
            }
        } catch (err: any) {
            logger.error(`[ENGINE] Regime updater error: ${err.message}`);
        } finally {
            this.regimeUpdaterRunning = false;
        }
    }

    /**
     * Bin tracker loop - tracks bin movements for all positions
     */
    private async runBinTracker(): Promise<void> {
        if (this.binTrackerRunning) return;
        this.binTrackerRunning = true;

        try {
            const openPositions = this.positions.filter(p => !p.closed);
            
            for (const position of openPositions) {
                const poolData = this.poolQueue.find(p => p.address === position.pool);
                if (poolData && poolData.activeBin) {
                    const previousBin = position.currentBin;
                    position.currentBin = poolData.activeBin;
                    position.binOffset = Math.abs(poolData.activeBin - position.entryBin);
                    
                    // Update position in database if bin changed
                    if (poolData.activeBin !== previousBin) {
                        await updatePositionState(position.id, {
                            currentBin: poolData.activeBin,
                        });
                    }
                    
                    // Log significant bin movements
                    if (Math.abs(poolData.activeBin - previousBin) >= 3) {
                        logger.info(`[BIN_TRACKER] ${position.symbol} bin moved: ${previousBin} → ${poolData.activeBin} (offset: ${position.binOffset})`);
                    }
                }
            }
        } catch (err: any) {
            logger.error(`[ENGINE] Bin tracker error: ${err.message}`);
        } finally {
            this.binTrackerRunning = false;
        }
    }

    /**
     * Convert a Trade record to a Position object
     */
    private tradeToPosition(trade: Trade): Position | null {
        return {
            id: trade.id,
            pool: trade.pool,
            symbol: trade.poolName,
            entryPrice: trade.entryPrice,
            currentPrice: trade.entryPrice,
            sizeUSD: trade.size,
            pnl: 0,
            pnlPercent: 0,
            bins: trade.entryBin ? [trade.entryBin] : [],
            openedAt: trade.timestamp,
            closed: false,
            
            entryBin: trade.entryBin || 0,
            currentBin: trade.entryBin || 0,
            binOffset: 0,
            
            entryFeeIntensity: 0,
            entrySwapVelocity: trade.velocity,
            entry3mFeeIntensity: 0,
            
            entryTier4Score: trade.score,
            entryRegime: 'NEUTRAL' as MarketRegime,
            entryMigrationDirection: 'neutral' as MigrationDirection,
            entryVelocitySlope: trade.velocitySlope,
            entryLiquiditySlope: trade.liquiditySlope,
            entryEntropySlope: trade.entropySlope,
            entryBinWidth: { min: 8, max: 18, label: 'medium' as const },
            entryThreshold: 32,
            exitThreshold: 22,
            
            exitState: trade.exitState || 'open',
            pendingExit: trade.pendingExit || false,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API — INVOKED BY SCANLOOP ONLY
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Place positions in pools that pass Tier 4 entry conditions.
     * Called by ScanLoop during each cycle.
     */
    public async placePools(pools: ScoredPool[]): Promise<void> {
        if (!this.initialized) {
            logger.warn('[EXECUTION] Engine not initialized - call initialize() first');
            return;
        }

        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('[EXECUTION] placePools called (Tier 4)');
        logger.info(`[EXECUTION] Pool count: ${pools.length}`);

        // Get current capital from database
        let currentCapital: number;
        try {
            currentCapital = await capitalManager.getBalance();
        } catch (err: any) {
            logger.error(`[EXECUTION] Failed to get capital: ${err.message}`);
            return;
        }

        if (currentCapital <= 0) {
            logger.warn(`[EXECUTION] No available capital: $${currentCapital.toFixed(2)}`);
            return;
        }

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
            if (openPoolAddresses.has(pool.address)) {
                continue;
            }
            
            const entryCheck = this.checkTier4EntryConditions(pool);
            
            if (entryCheck.canEnter) {
                eligiblePools.push(pool);
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
                currentCapital,
                tier4.regime
            );
            
            if (sizing.size > 0) {
                const exposureCheck = canAddPosition(sizing.size, currentTotalExposure, currentCapital);
                
                if (exposureCheck.allowed) {
                    await this.executeEntry(pool, sizing.size, tier4);
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
     * Execute a single entry. Called by ScanLoop.
     */
    public async executeEntry(pool: ScoredPool, sizeUSD: number, tier4?: Tier4Score): Promise<boolean> {
        if (!tier4) {
            tier4 = computeTier4Score(pool.address) ?? undefined;
            if (!tier4 || !tier4.valid) {
                logger.warn(`[EXECUTION] Cannot enter ${pool.address.slice(0, 8)}... - no valid Tier4 score`);
                return false;
            }
        }
        
        // Assign risk tier based on score
        const riskTier = assignRiskTier(tier4.tier4Score);
        const leverage = calculateLeverage(tier4.tier4Score, riskTier);
        
        // Create execution data for true fill price tracking
        const entryPrice = this.binToPrice(pool.activeBin);
        const executionData = createDefaultExecutionData(sizeUSD, entryPrice);
        
        // Create trade object
        const trade = createTrade(
            {
                address: pool.address,
                name: `${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
                currentPrice: entryPrice,
                score: tier4.tier4Score,
                liquidity: pool.liquidityUSD,
                velocity: 0,
            },
            sizeUSD,
            'standard',
            {
                entropy: 0,
                velocitySlope: tier4.velocitySlope,
                liquiditySlope: tier4.liquiditySlope,
                entropySlope: tier4.entropySlope,
            },
            executionData,
            riskTier,
            leverage,
            pool.activeBin
        );

        // ALLOCATE CAPITAL
        try {
            const allocated = await capitalManager.allocate(trade.id, sizeUSD);
            if (!allocated) {
                logger.warn(`[EXECUTION] Entry blocked: insufficient capital for $${sizeUSD.toFixed(2)}`);
                return false;
            }
        } catch (err: any) {
            logger.error(`[EXECUTION] Capital allocation failed: ${err.message}`);
            return false;
        }

        // SAVE TO DATABASE
        try {
            await saveTradeToDB(trade);
        } catch (err: any) {
            logger.error(`[EXECUTION] Trade persistence failed: ${err.message}`);
            try {
                await capitalManager.release(trade.id);
            } catch {
                // Already logged
            }
            return false;
        }

        // Register in memory
        registerTrade(trade);

        // Persist to positions table (in addition to trades table)
        try {
            await persistTradeEntry(trade);
        } catch (persistErr: any) {
            logger.error(`[DB-ERROR] Failed to persist position: ${persistErr.message}`);
        }

        // Calculate bin cluster
        const binWidth = tier4.binWidth;
        const halfWidth = Math.floor((binWidth.min + binWidth.max) / 4);
        const bins = this.calculateBinRange(pool.activeBin, halfWidth);

        // Get current microstructure metrics
        const metrics = pool.microMetrics || computeMicrostructureMetrics(pool.address);
        
        // Get 3-minute fee intensity
        const swaps3m = getSwapHistory(pool.address, 3 * 60 * 1000);
        const history = getPoolHistory(pool.address);
        const latestLiquidity = history.length > 0 ? history[history.length - 1].liquidityUSD : 0;
        const fees3m = swaps3m.reduce((sum, s) => sum + s.feePaid, 0);
        const entry3mFeeIntensity = latestLiquidity > 0 ? fees3m / latestLiquidity : 0;

        const position: Position = {
            id: trade.id,
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
            
            entryBin: pool.activeBin,
            currentBin: pool.activeBin,
            binOffset: 0,
            
            entryFeeIntensity: metrics?.feeIntensity ?? 0,
            entrySwapVelocity: metrics?.swapVelocity ?? 0,
            entry3mFeeIntensity,
            
            entryTier4Score: tier4.tier4Score,
            entryRegime: tier4.regime,
            entryMigrationDirection: tier4.migrationDirection,
            entryVelocitySlope: tier4.velocitySlope,
            entryLiquiditySlope: tier4.liquiditySlope,
            entryEntropySlope: tier4.entropySlope,
            entryBinWidth: tier4.binWidth,
            entryThreshold: tier4.entryThreshold,
            exitThreshold: tier4.exitThreshold,
            
            exitState: 'open',
            pendingExit: false,
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

        // Register for harmonic monitoring
        const baselineSnapshot = createMicroMetricsSnapshot(
            Date.now(),
            metrics?.binVelocity ? metrics.binVelocity / 100 : 0.05,
            metrics?.swapVelocity ? metrics.swapVelocity / 100 : 0.1,
            0,
            metrics?.poolEntropy ?? 0.7,
            metrics?.feeIntensity ? metrics.feeIntensity / 100 : 0.02,
            tier4.velocitySlope,
            tier4.liquiditySlope,
            tier4.entropySlope
        );
        
        registerHarmonicTrade(
            trade.id,
            pool.address,
            `${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
            riskTier,
            baselineSnapshot
        );

        // Log entry
        try {
            await logAction('ENTRY', {
                tradeId: trade.id,
                poolAddress: pool.address,
                poolName: `${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
                entry_price: entryPrice,
                entry_amount_base: executionData.netReceivedBase,
                entry_amount_quote: executionData.netReceivedQuote,
                entry_value_usd: executionData.entryAssetValueUsd,
                size: sizeUSD,
                bin: pool.activeBin,
                riskTier,
                leverage,
                regime: tier4.regime,
                microMetrics: {
                    velocitySlope: tier4.velocitySlope,
                    liquiditySlope: tier4.liquiditySlope,
                    entropySlope: tier4.entropySlope,
                },
            });
        } catch (logErr) {
            logger.warn(`[EXECUTION] Failed to log ENTRY to database: ${logErr}`);
        }

        const currentCapital = await capitalManager.getBalance();
        logger.info(
            `[POSITION] ENTRY size=${((sizeUSD / (currentCapital + sizeUSD)) * 100).toFixed(1)}% ` +
            `wallet=$${currentCapital.toFixed(0)} ` +
            `amount=$${sizeUSD.toFixed(2)} ` +
            `symbol=${position.symbol} ` +
            `regime=${tier4.regime}`
        );

        return true;
    }

    /**
     * Execute a single exit. Called by ScanLoop.
     * This is the SINGLE entry point for all exit requests.
     */
    public async executeExit(positionId: string, reason: string, caller: string = 'SCAN_LOOP'): Promise<boolean> {
        const position = this.positions.find(p => p.id === positionId);
        if (!position) {
            logger.warn(`[EXIT_AUTH] Position ${positionId.slice(0, 8)}... not found - ignoring exit request from ${caller}`);
            return false;
        }
        
        return this.exitPositionInternal(position, reason, caller);
    }

    /**
     * Evaluate position health and return exit recommendation.
     * Called by ScanLoop to decide whether to exit.
     * Engine does NOT execute - it only advises.
     */
    public evaluatePositionHealth(positionId: string): PositionHealthEvaluation {
        const position = this.positions.find(p => p.id === positionId);
        
        if (!position || position.closed) {
            return {
                positionId,
                shouldExit: false,
                exitReason: '',
                exitType: 'NONE',
            };
        }

        // Update position price from pool queue
        const poolData = this.poolQueue.find(p => p.address === position.pool);
        if (poolData) {
            this.updatePositionPrice(position, poolData);
        }

        // Check harmonic stops
        const harmonicDecision = this.evaluateHarmonicStopForPosition(position);
        
        if (harmonicDecision && harmonicDecision.type === 'FULL_EXIT') {
            return {
                positionId,
                shouldExit: true,
                exitReason: `HARMONIC_EXIT: ${harmonicDecision.reason}`,
                exitType: 'HARMONIC',
                harmonicDecision,
            };
        }

        // Check Tier 4 exit conditions
        const tier4Eval = this.evaluateTier4Exit(position.pool, position);
        
        if (tier4Eval.shouldExit) {
            return {
                positionId,
                shouldExit: true,
                exitReason: tier4Eval.reason,
                exitType: 'TIER4',
                tier4Eval,
            };
        }

        return {
            positionId,
            shouldExit: false,
            exitReason: '',
            exitType: 'NONE',
            tier4Eval,
        };
    }

    /**
     * Get current portfolio snapshot.
     */
    public async getPortfolioStatus(): Promise<PortfolioSnapshot> {
        const openPositions = this.positions.filter(p => !p.closed);
        const unrealized = openPositions.reduce((sum, p) => sum + p.pnl, 0);
        
        let capital = this.initialCapital;
        let lockedCapital = 0;
        let totalRealized = 0;

        try {
            const state = await capitalManager.getFullState();
            if (state) {
                capital = state.available_balance;
                lockedCapital = state.locked_balance;
                totalRealized = state.total_realized_pnl;
            }
        } catch {
            // Use defaults
        }

        const totalEquity = capital + lockedCapital;
        const equity = totalEquity + unrealized;

        return {
            capital,
            lockedCapital,
            totalEquity,
            openPositions: [...openPositions],
            closedPositions: [...this.closedPositions],
            realized: totalRealized,
            unrealized,
            equity,
            ts: new Date(),
        };
    }

    /**
     * Force close all positions.
     */
    public async closeAll(reason: string = 'MANUAL_CLOSE'): Promise<void> {
        logger.info('[EXECUTION] Closing all positions', { reason });

        for (const position of this.positions) {
            if (!position.closed) {
                await this.exitPositionInternal(position, reason, 'CLOSE_ALL');
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
     * Get all open positions (for ScanLoop to iterate)
     */
    public getOpenPositions(): Position[] {
        return this.positions.filter(p => !p.closed);
    }

    /**
     * Get total equity.
     */
    public async getEquity(): Promise<number> {
        const unrealized = this.positions
            .filter(p => !p.closed)
            .reduce((sum, p) => sum + p.pnl, 0);
        
        try {
            const equity = await capitalManager.getEquity();
            return equity + unrealized;
        } catch {
            return this.initialCapital + unrealized;
        }
    }

    /**
     * Update pool queue for position price updates.
     * Called by ScanLoop before evaluating positions.
     */
    public updatePoolQueue(pools: ScoredPool[]): void {
        this.poolQueue = pools;
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
    // HARMONIC STOP EVALUATION
    // ═══════════════════════════════════════════════════════════════════════════

    private evaluateHarmonicStopForPosition(position: Position): HarmonicDecision | null {
        const metrics = computeMicrostructureMetrics(position.pool);
        if (!metrics) return null;
        
        const slopes = getMomentumSlopes(position.pool);
        if (!slopes || !slopes.valid) return null;
        
        const history = getPoolHistory(position.pool);
        if (history.length < 2) return null;
        
        const latest = history[history.length - 1];
        const previous = history[history.length - 2];
        const liquidityFlowPct = previous.liquidityUSD > 0
            ? (latest.liquidityUSD - previous.liquidityUSD) / previous.liquidityUSD
            : 0;
        
        const currentSnapshot = createMicroMetricsSnapshot(
            Date.now(),
            metrics.binVelocity / 100,
            metrics.swapVelocity / 100,
            liquidityFlowPct,
            metrics.poolEntropy,
            metrics.feeIntensity / 100,
            slopes.velocitySlope,
            slopes.liquiditySlope,
            slopes.entropySlope
        );
        
        const entryBaseline = getEntryBaseline(position.pool);
        
        let baselineSnapshot: MicroMetricsSnapshot;
        if (entryBaseline) {
            baselineSnapshot = createMicroMetricsSnapshot(
                position.openedAt,
                position.entrySwapVelocity,
                position.entrySwapVelocity,
                0,
                0.7,
                position.entryFeeIntensity,
                entryBaseline.velocitySlope,
                entryBaseline.liquiditySlope,
                entryBaseline.entropySlope
            );
        } else {
            baselineSnapshot = createMicroMetricsSnapshot(
                position.openedAt,
                position.entrySwapVelocity,
                position.entrySwapVelocity,
                0,
                0.7,
                position.entryFeeIntensity,
                position.entryVelocitySlope,
                position.entryLiquiditySlope,
                position.entryEntropySlope
            );
        }
        
        let tier: 'A' | 'B' | 'C' | 'D';
        if (position.entryTier4Score >= 40) tier = 'A';
        else if (position.entryTier4Score >= 32) tier = 'B';
        else if (position.entryTier4Score >= 24) tier = 'C';
        else tier = 'D';
        
        const ctx = createHarmonicContext(
            position.id,
            position.pool,
            position.symbol,
            tier,
            position.openedAt,
            position.entryPrice,
            position.sizeUSD,
            baselineSnapshot
        );
        
        return evaluateHarmonicStop(ctx, currentSnapshot);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT LOGIC - SINGLE EXIT AUTHORITY
    // ═══════════════════════════════════════════════════════════════════════════

    private async exitPositionInternal(position: Position, reason: string, caller: string): Promise<boolean> {
        // Guard checks
        if (position.closed) {
            logger.info(`[GUARD] Skipping duplicate exit for trade ${position.id.slice(0, 8)}... — already closed`);
            return false;
        }

        if (position.exitState !== 'open') {
            logger.info(`[GUARD] Skipping duplicate exit for trade ${position.id.slice(0, 8)}... — already ${position.exitState}`);
            return false;
        }

        if (position.pendingExit) {
            logger.info(`[GUARD] Skipping duplicate exit for trade ${position.id.slice(0, 8)}... — exit pending`);
            return false;
        }

        // Acquire exit lock
        if (!acquireExitLock(position.id, caller)) {
            return false;
        }

        position.pendingExit = true;
        position.exitState = 'closing';

        logger.info(`[EXIT_AUTH] Exit granted for trade ${position.id.slice(0, 8)}... via ${caller}`);

        const pnl = position.pnl;
        const exitAssetValueUsd = position.sizeUSD + pnl;
        const exitFeesPaid = exitAssetValueUsd * 0.003;
        const exitSlippageUsd = exitAssetValueUsd * 0.001;

        // Update DB
        try {
            await updateTradeExitInDB(position.id, {
                exitPrice: position.currentPrice,
                exitAssetValueUsd,
                exitFeesPaid,
                exitSlippageUsd,
            }, reason);
        } catch (err: any) {
            logger.error(`[EXECUTION] Failed to update trade exit: ${err.message}`);
            releaseExitLock(position.id);
            position.pendingExit = false;
            position.exitState = 'open';
            logger.warn(`[GUARD] DB write failed - exit aborted for trade ${position.id.slice(0, 8)}...`);
            return false;
        }

        // Apply P&L
        try {
            await capitalManager.applyPNL(position.id, pnl);
        } catch (err: any) {
            logger.error(`[EXECUTION] Failed to apply P&L: ${err.message}`);
        }

        // Persist exit to positions table
        try {
            await persistTradeExit(position.id, {
                exitPrice: position.currentPrice,
                exitTime: Date.now(),
                pnl: pnl,
                pnlUsd: pnl,
                pnlPercent: position.pnlPercent,
                exitReason: reason,
                exitAssetValueUsd: exitAssetValueUsd,
                exitFeesPaid: exitFeesPaid,
                exitSlippageUsd: exitSlippageUsd,
            });
        } catch (persistErr: any) {
            logger.error(`[DB-ERROR] Failed to persist exit: ${persistErr.message}`);
        }

        // Update state
        position.closed = true;
        position.closedAt = Date.now();
        position.exitReason = reason;
        position.exitState = 'closed';
        position.pendingExit = false;

        this.closedPositions.push({ ...position });
        
        // Cleanup
        unregisterPosition(position.pool);
        clearEntryBaseline(position.pool);
        clearNegativeVelocityCount(position.pool);
        unregisterHarmonicTrade(position.id);
        markTradeClosed(position.id);
        unregisterTrade(position.id);

        const holdTime = position.closedAt - position.openedAt;
        const pnlSign = pnl >= 0 ? '+' : '';

        // Log exit
        try {
            await logAction('TRADE_EXIT', {
                tradeId: position.id,
                poolAddress: position.pool,
                poolName: position.symbol,
                exitPrice: position.currentPrice,
                entryPrice: position.entryPrice,
                sizeUSD: position.sizeUSD,
                pnl,
                pnlPercent: position.pnlPercent,
                holdTimeMs: holdTime,
                reason,
                caller,
                regime: position.entryRegime,
            });
        } catch (logErr) {
            logger.warn(`[EXECUTION] Failed to log TRADE_EXIT: ${logErr}`);
        }

        logger.info(
            `[TRADE_EXIT] reason="${reason}" ` +
            `pool=${position.pool.slice(0, 8)}... ` +
            `pnl=${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${(position.pnlPercent * 100).toFixed(2)}%) ` +
            `holdTime=${this.formatDuration(holdTime)} ` +
            `caller=${caller}`
        );

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UTILITY
    // ═══════════════════════════════════════════════════════════════════════════

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

    private updatePositionPrice(position: Position, pool: ScoredPool): void {
        const currentPrice = this.binToPrice(pool.activeBin);
        position.currentPrice = currentPrice;
        
        position.currentBin = pool.activeBin;
        position.binOffset = Math.abs(pool.activeBin - position.entryBin);

        const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
        position.pnlPercent = priceChange;
        position.pnl = priceChange * position.sizeUSD;
    }

    private estimateVolatility(pool: ScoredPool): number {
        const metrics = pool.microMetrics;
        if (!metrics) return 0.5;
        return Math.min(1, metrics.binVelocity / 100);
    }

    private formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBUG / INSPECTION
    // ═══════════════════════════════════════════════════════════════════════════

    public async printStatus(): Promise<void> {
        const status = await this.getPortfolioStatus();
        
        const divider = '═══════════════════════════════════════════════════════════════';
        logger.info(`\n${divider}`);
        logger.info('PORTFOLIO STATUS (STATEFUL ENGINE)');
        logger.info(divider);
        logger.info(`Available:    $${status.capital.toFixed(2)}`);
        logger.info(`Locked:       $${status.lockedCapital.toFixed(2)}`);
        logger.info(`Total Equity: $${status.totalEquity.toFixed(2)}`);
        logger.info(`Realized:     $${status.realized.toFixed(2)}`);
        logger.info(`Unrealized:   $${status.unrealized.toFixed(2)}`);
        logger.info(`Net Equity:   $${status.equity.toFixed(2)}`);
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
            takeProfit: this.takeProfit,
            stopLoss: this.stopLoss,
            maxConcurrentPools: this.maxConcurrentPools,
            allocationStrategy: this.allocationStrategy,
        };
    }

    public async reset(): Promise<void> {
        await this.closeAll('RESET');
        await capitalManager.reset(this.initialCapital);
        
        this.positions = [];
        this.closedPositions = [];
        this.poolQueue = [];
        
        logger.info('[EXECUTION] Engine reset to initial state');
    }
}

export default ExecutionEngine;
