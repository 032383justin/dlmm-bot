/**
 * ExecutionEngine.ts - Tier 4 Institutional Architecture
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 EXECUTION ENGINE WITH PERSISTENT CAPITAL MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * CRITICAL: All capital operations now go through capitalManager
 * - No more in-memory P&L tracking
 * - Capital persists across bot restarts
 * - Trade persistence is MANDATORY
 * 
 * Entry Conditions:
 * - tier4Score >= dynamic entryThreshold (28/32/36 based on regime)
 * - migrationDirection NOT blocking
 * - All slope conditions positive or within tolerance
 * - Capital available (via capitalManager)
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
// NOTE: Singleton management is handled by singletonRegistry.ts
// DO NOT instantiate this class directly - use getEngine() from singletonRegistry
// ═══════════════════════════════════════════════════════════════════════════════

export class ExecutionEngine {
    private initialCapital: number;
    private rebalanceInterval: number;
    private takeProfit: number;
    private stopLoss: number;
    private maxConcurrentPools: number;
    private allocationStrategy: 'equal' | 'weighted';

    public positions: Position[] = [];
    private closedPositions: Position[] = [];
    private lastRebalanceTime: number = 0;
    private poolQueue: ScoredPool[] = [];
    private initialized: boolean = false;

    constructor(config: ExecutionEngineConfig = {}) {
        this.initialCapital = config.capital ?? DEFAULT_CAPITAL;
        this.rebalanceInterval = config.rebalanceInterval ?? DEFAULT_REBALANCE_INTERVAL;
        this.takeProfit = config.takeProfit ?? DEFAULT_TAKE_PROFIT;
        this.stopLoss = config.stopLoss ?? DEFAULT_STOP_LOSS;
        this.maxConcurrentPools = config.maxConcurrentPools ?? DEFAULT_MAX_CONCURRENT_POOLS;
        this.allocationStrategy = config.allocationStrategy ?? 'equal';

        logger.info('[EXECUTION] Engine instance created', {
            initialCapital: this.initialCapital,
            maxExposure: `${MAX_EXPOSURE * 100}%`,
            rebalanceInterval: `${this.rebalanceInterval / 60000} min`,
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
            // DO NOT initialize capital manager here - bootstrap already did it
            // Just verify it's ready
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
                    // Use entry values as baseline since we don't have full metrics
                    const baselineSnapshot = createMicroMetricsSnapshot(
                        trade.timestamp,
                        trade.velocity > 0 ? trade.velocity / 100 : 0.05,
                        trade.velocity > 0 ? trade.velocity / 100 : 0.1,
                        0, // Neutral flow
                        0.7, // Default entropy
                        0.02, // Default fee intensity
                        trade.velocitySlope,
                        trade.liquiditySlope,
                        trade.entropySlope
                    );
                    
                    // Determine tier from score
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
            
            logger.info('[EXECUTION] ✅ Engine initialized', {
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
            
            // Exit state guard - recovered trades are open
            exitState: trade.exitState || 'open',
            pendingExit: trade.pendingExit || false,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Place positions in pools that pass Tier 4 entry conditions.
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
                currentCapital,
                tier4.regime
            );
            
            if (sizing.size > 0) {
                const exposureCheck = canAddPosition(sizing.size, currentTotalExposure, currentCapital);
                
                if (exposureCheck.allowed) {
                    await this.enterPosition(pool, sizing.size, tier4);
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
     * 
     * Exit order of precedence:
     * 1. Harmonic stops (microstructure health collapse)
     * 2. Tier 4 exit conditions (score/migration/fee collapse)
     * 3. Scaling opportunities
     */
    public async update(): Promise<void> {
        if (!this.initialized) {
            return;
        }

        const now = Date.now();
        
        for (const position of this.positions) {
            if (position.closed) continue;

            // Find current pool data
            const poolData = this.poolQueue.find(p => p.address === position.pool);
            if (poolData) {
                this.updatePositionPrice(position, poolData);
            }

            // ═══════════════════════════════════════════════════════════════════
            // STEP 1: HARMONIC STOPS (per-position microstructure health)
            // Runs BEFORE other exit conditions
            // NOTE: Harmonic module now only SIGNALS intent - execution is centralized
            // ═══════════════════════════════════════════════════════════════════
            const harmonicDecision = await this.evaluateHarmonicStopForPosition(position);
            
            if (harmonicDecision && harmonicDecision.type === 'FULL_EXIT') {
                const exitReason = `HARMONIC_EXIT: ${harmonicDecision.reason}`;
                
                logger.warn(
                    `[HARMONIC-SIGNAL] trade ${position.id.slice(0, 8)}... | ` +
                    `reason="${harmonicDecision.reason}" | ` +
                    `healthScore=${harmonicDecision.healthScore.toFixed(2)} | ` +
                    `pool=${position.pool.slice(0, 8)}...`
                );
                
                // Execute exit via centralized authority
                const exited = await this.exitPosition(position, exitReason, 'HARMONIC_STOPS');
                
                if (exited) {
                    continue; // Exit successful, move to next position
                }
                // If exit was blocked by guards, continue to other checks
            }

            // ═══════════════════════════════════════════════════════════════════
            // STEP 2: TIER 4 EXIT CONDITIONS
            // ═══════════════════════════════════════════════════════════════════
            const exitEval = this.evaluateTier4Exit(position.pool, position);
            
            if (exitEval.shouldExit) {
                logger.info(
                    `[TIER4-SIGNAL] reason="${exitEval.reason}" ` +
                    `pool=${position.pool.slice(0, 8)}... ` +
                    `tier4Score=${exitEval.tier4Score.toFixed(1)} ` +
                    `exitThreshold=${exitEval.exitThreshold} ` +
                    `regime=${exitEval.regime}`
                );
                
                // Execute exit via centralized authority
                const exited = await this.exitPosition(position, exitEval.reason, 'TIER4_SCORING');
                
                if (exited) {
                    continue; // Exit successful, move to next position
                }
                // If exit was blocked by guards, continue to scaling checks
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // STEP 3: SCALING OPPORTUNITY
            // ═══════════════════════════════════════════════════════════════════
            if (poolData) {
                await this.checkScaleOpportunity(position, poolData);
            }
        }

        // Check for rebalance
        if (now - this.lastRebalanceTime >= this.rebalanceInterval) {
            await this.rebalance();
            this.lastRebalanceTime = now;
        }
    }

    /**
     * Evaluate harmonic stop conditions for a position.
     * Builds current metrics snapshot and calls the harmonic evaluator.
     */
    private async evaluateHarmonicStopForPosition(
        position: Position
    ): Promise<HarmonicDecision | null> {
        // Get current microstructure metrics
        const metrics = computeMicrostructureMetrics(position.pool);
        if (!metrics) {
            // No telemetry available - cannot evaluate
            return null;
        }
        
        // Get current slopes
        const slopes = getMomentumSlopes(position.pool);
        if (!slopes || !slopes.valid) {
            // No slope data - cannot evaluate
            return null;
        }
        
        // Get history for liquidity flow calculation
        const history = getPoolHistory(position.pool);
        if (history.length < 2) {
            return null;
        }
        
        // Calculate liquidity flow percentage
        const latest = history[history.length - 1];
        const previous = history[history.length - 2];
        const liquidityFlowPct = previous.liquidityUSD > 0
            ? (latest.liquidityUSD - previous.liquidityUSD) / previous.liquidityUSD
            : 0;
        
        // Build current metrics snapshot
        const currentSnapshot = createMicroMetricsSnapshot(
            Date.now(),
            metrics.binVelocity / 100,        // Normalize from 0-100 to raw
            metrics.swapVelocity / 100,       // Normalize from 0-100 to raw
            liquidityFlowPct,
            metrics.poolEntropy,
            metrics.feeIntensity / 100,       // Normalize from 0-100 to raw
            slopes.velocitySlope,
            slopes.liquiditySlope,
            slopes.entropySlope
        );
        
        // Get baseline (entry snapshot)
        // Try to get from entry baseline, fall back to position entry values
        const entryBaseline = getEntryBaseline(position.pool);
        
        let baselineSnapshot: MicroMetricsSnapshot;
        if (entryBaseline) {
            // Use recorded baseline slopes
            baselineSnapshot = createMicroMetricsSnapshot(
                position.openedAt,
                position.entrySwapVelocity,  // Use entry swap velocity as proxy for bin velocity
                position.entrySwapVelocity,
                0, // Baseline flow is 0 (neutral)
                0.7, // Default healthy entropy
                position.entryFeeIntensity,
                entryBaseline.velocitySlope,
                entryBaseline.liquiditySlope,
                entryBaseline.entropySlope
            );
        } else {
            // Fall back to position entry values
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
        
        // Determine tier from position
        // Map entryTier4Score to risk tier
        let tier: 'A' | 'B' | 'C' | 'D';
        if (position.entryTier4Score >= 40) {
            tier = 'A';
        } else if (position.entryTier4Score >= 32) {
            tier = 'B';
        } else if (position.entryTier4Score >= 24) {
            tier = 'C';
        } else {
            tier = 'D';
        }
        
        // Build harmonic context
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
        
        // Evaluate harmonic stop
        return evaluateHarmonicStop(ctx, currentSnapshot);
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
                await this.exitPosition(position, reason, 'MANUAL_CLOSE');
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

    private async checkScaleOpportunity(position: Position, pool: ScoredPool): Promise<void> {
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
        
        // Get current capital
        let currentCapital: number;
        try {
            currentCapital = await capitalManager.getBalance();
        } catch {
            return;
        }

        // Calculate scale size
        const volatility = this.estimateVolatility(pool);
        const currentExposure = position.sizeUSD;
        const scaleResult = calcScaleSize(
            tier4.tier4Score,
            volatility,
            currentCapital,
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
        
        const exposureCheck = canAddPosition(scaleResult.size, totalExposure, currentCapital);
        
        if (!exposureCheck.allowed) {
            logger.info(`[EXECUTION] Scale blocked by exposure: ${exposureCheck.reason}`);
            return;
        }
        
        // Allocate additional capital
        try {
            const allocated = await capitalManager.allocate(`${position.id}_scale_${Date.now()}`, scaleResult.size);
            if (!allocated) {
                logger.info('[EXECUTION] Scale blocked: insufficient capital');
                return;
            }
        } catch {
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

    private async enterPosition(pool: ScoredPool, sizeUSD: number, tier4: Tier4Score): Promise<void> {
        // Assign risk tier based on score
        const riskTier = assignRiskTier(tier4.tier4Score);
        const leverage = calculateLeverage(tier4.tier4Score, riskTier);
        
        // Create execution data for true fill price tracking
        const entryPrice = this.binToPrice(pool.activeBin);
        const executionData = createDefaultExecutionData(sizeUSD, entryPrice);
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 1: Create trade object with execution data
        // ═══════════════════════════════════════════════════════════════════════
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

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 2: ALLOCATE CAPITAL - MUST SUCCEED
        // ═══════════════════════════════════════════════════════════════════════
        try {
            const allocated = await capitalManager.allocate(trade.id, sizeUSD);
            if (!allocated) {
                logger.warn(`[EXECUTION] Entry blocked: insufficient capital for $${sizeUSD.toFixed(2)}`);
                return;
            }
        } catch (err: any) {
            logger.error(`[EXECUTION] Capital allocation failed: ${err.message}`);
            return;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 3: SAVE TO DATABASE - MUST SUCCEED
        // ═══════════════════════════════════════════════════════════════════════
        try {
            await saveTradeToDB(trade);
        } catch (err: any) {
            // Release capital on failure
            logger.error(`[EXECUTION] Trade persistence failed: ${err.message}`);
            try {
                await capitalManager.release(trade.id);
            } catch {
                // Already logged
            }
            return;
        }

        // STEP 4: Register in memory
        registerTrade(trade);

        // Calculate bin cluster based on Tier 4 bin width
        const binWidth = tier4.binWidth;
        const halfWidth = Math.floor((binWidth.min + binWidth.max) / 4);
        const bins = this.calculateBinRange(pool.activeBin, halfWidth);

        // Entry price already calculated above

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
            
            // Exit state guard - new positions are open
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

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 6: REGISTER FOR HARMONIC MONITORING
        // Captures baseline microstructure snapshot at entry
        // ═══════════════════════════════════════════════════════════════════════
        const baselineSnapshot = createMicroMetricsSnapshot(
            Date.now(),
            metrics?.binVelocity ? metrics.binVelocity / 100 : 0.05,
            metrics?.swapVelocity ? metrics.swapVelocity / 100 : 0.1,
            0, // Neutral flow at entry
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

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 5: LOG ENTRY TO DATABASE
        // This is the ONLY valid ENTRY log - emitted after:
        //   1. capitalManager.allocate() succeeded
        //   2. Trade inserted into Supabase successfully
        //   3. DLMM SDK position registered (bins placed)
        // ═══════════════════════════════════════════════════════════════════════
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
            // Log failure is non-fatal but should be monitored
            logger.warn(`[EXECUTION] Failed to log ENTRY to database: ${logErr}`);
        }

        // Tier 4 logging (console)
        logger.info(`[REGIME] ${tier4.regime} (multiplier=${tier4.regimeMultiplier.toFixed(2)})`);
        logger.info(`[MIGRATION] direction=${tier4.migrationDirection} slopeL=${tier4.liquiditySlope.toFixed(6)}`);
        logger.info(`[TIER4 SCORE] ${tier4.tier4Score.toFixed(2)} (base=${tier4.baseScore.toFixed(2)})`);
        logger.info(`[THRESHOLDS] entry=${tier4.entryThreshold} exit=${tier4.exitThreshold}`);
        logger.info(`[BIN WIDTH] ${tier4.binWidth.label} (${tier4.binWidth.min}-${tier4.binWidth.max})`);
        
        const currentCapital = await capitalManager.getBalance();
        logger.info(
            `[POSITION] ENTRY size=${((sizeUSD / (currentCapital + sizeUSD)) * 100).toFixed(1)}% ` +
            `wallet=$${currentCapital.toFixed(0)} ` +
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
    // EXIT LOGIC - SINGLE EXIT AUTHORITY
    // ═══════════════════════════════════════════════════════════════════════════
    // 
    // THIS IS THE ONLY PLACE WHERE EXITS ACTUALLY EXECUTE.
    // All other modules (harmonic, migration, score) should call this function.
    // 
    // Order of operations:
    // 1. Validate exit guards (exitState, pendingExit)
    // 2. Acquire exit lock
    // 3. Calculate PnL
    // 4. Write to DB
    // 5. Release capital
    // 6. Unregister harmonics
    // 7. Unregister slopes
    // 8. Mark trade as closed
    // 9. Remove from registry
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Request an exit for a position (public method for other modules)
     * This is the SINGLE entry point for all exit requests.
     * 
     * @param positionId - Position ID to exit
     * @param reason - Exit reason
     * @param caller - Name of the calling module (for audit trail)
     * @returns true if exit was executed, false if blocked by guards
     */
    public async requestExit(positionId: string, reason: string, caller: string): Promise<boolean> {
        const position = this.positions.find(p => p.id === positionId);
        if (!position) {
            logger.warn(`[EXIT_AUTH] Position ${positionId.slice(0, 8)}... not found - ignoring exit request from ${caller}`);
            return false;
        }
        
        return this.exitPosition(position, reason, caller);
    }

    /**
     * Internal exit execution with single exit authority guards
     * 
     * @param position - Position to exit
     * @param reason - Exit reason
     * @param caller - Name of the calling module (for logging)
     * @returns true if exit was executed, false if blocked
     */
    private async exitPosition(position: Position, reason: string, caller: string = 'EXECUTION_ENGINE'): Promise<boolean> {
        // ═══════════════════════════════════════════════════════════════════════
        // GUARD 1: Check if already closed
        // ═══════════════════════════════════════════════════════════════════════
        if (position.closed) {
            logger.info(`[GUARD] Skipping duplicate exit for trade ${position.id.slice(0, 8)}... — already closed`);
            return false;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // GUARD 2: Check exit state
        // ═══════════════════════════════════════════════════════════════════════
        if (position.exitState !== 'open') {
            logger.info(`[GUARD] Skipping duplicate exit for trade ${position.id.slice(0, 8)}... — already ${position.exitState}`);
            return false;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // GUARD 3: Check pending exit flag
        // ═══════════════════════════════════════════════════════════════════════
        if (position.pendingExit) {
            logger.info(`[GUARD] Skipping duplicate exit for trade ${position.id.slice(0, 8)}... — exit pending`);
            return false;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // ACQUIRE EXIT LOCK - Sets state to 'closing' and pendingExit to true
        // ═══════════════════════════════════════════════════════════════════════
        if (!acquireExitLock(position.id, caller)) {
            // Lock acquisition failed - another exit is in progress
            return false;
        }

        // Update position state
        position.pendingExit = true;
        position.exitState = 'closing';

        logger.info(`[EXIT_AUTH] Exit granted for trade ${position.id.slice(0, 8)}... via ${caller}`);

        // Calculate PnL
        const pnl = position.pnl;
        
        // Estimate exit execution data (in live trading, this would come from actual swap)
        const exitAssetValueUsd = position.sizeUSD + pnl;
        const exitFeesPaid = exitAssetValueUsd * 0.003; // Estimate 0.3% fee
        const exitSlippageUsd = exitAssetValueUsd * 0.001; // Estimate 0.1% slippage

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 1: Update trade in database with TRUE fill prices
        // CRITICAL: If this fails, do NOT proceed with capital release
        // ═══════════════════════════════════════════════════════════════════════
        try {
            await updateTradeExitInDB(position.id, {
                exitPrice: position.currentPrice,
                exitAssetValueUsd,
                exitFeesPaid,
                exitSlippageUsd,
            }, reason);
        } catch (err: any) {
            logger.error(`[EXECUTION] Failed to update trade exit: ${err.message}`);
            // Release lock and revert state - do not proceed
            releaseExitLock(position.id);
            position.pendingExit = false;
            position.exitState = 'open';
            logger.warn(`[GUARD] DB write failed - exit aborted for trade ${position.id.slice(0, 8)}...`);
            return false;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 2: Apply P&L to capital and release locked funds
        // ═══════════════════════════════════════════════════════════════════════
        try {
            await capitalManager.applyPNL(position.id, pnl);
        } catch (err: any) {
            logger.error(`[EXECUTION] Failed to apply P&L: ${err.message}`);
            // Capital release failed but DB is updated - log but continue
            // This needs manual reconciliation
        }

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 3: Update position state
        // ═══════════════════════════════════════════════════════════════════════
        position.closed = true;
        position.closedAt = Date.now();
        position.exitReason = reason;
        position.exitState = 'closed';
        position.pendingExit = false;

        // Move to closed positions
        this.closedPositions.push({ ...position });
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 4: Cleanup telemetry
        // ═══════════════════════════════════════════════════════════════════════
        unregisterPosition(position.pool);
        clearEntryBaseline(position.pool);
        clearNegativeVelocityCount(position.pool);

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 5: Unregister from harmonic monitoring
        // ═══════════════════════════════════════════════════════════════════════
        unregisterHarmonicTrade(position.id);

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 6: Mark trade as closed in registry and unregister
        // CRITICAL: This must be LAST - after all other cleanup
        // ═══════════════════════════════════════════════════════════════════════
        markTradeClosed(position.id);
        unregisterTrade(position.id);

        const holdTime = position.closedAt - position.openedAt;
        const pnlSign = pnl >= 0 ? '+' : '';

        // ═══════════════════════════════════════════════════════════════════════
        // STEP 7: Log SINGLE exit event to database
        // This is the ONLY exit log - action: TRADE_EXIT
        // ═══════════════════════════════════════════════════════════════════════
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
            `caller=${caller} ` +
            `entryRegime=${position.entryRegime}`
        );

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REBALANCE
    // ═══════════════════════════════════════════════════════════════════════════

    private async rebalance(): Promise<void> {
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('[EXECUTION] Rebalance cycle (Tier 4)');

        const openPositions = this.positions.filter(p => !p.closed);

        if (openPositions.length === 0) {
            logger.info('[EXECUTION] No open positions to rebalance');
            return;
        }

        // Get current capital
        let currentCapital: number;
        try {
            currentCapital = await capitalManager.getBalance();
        } catch {
            logger.warn('[EXECUTION] Could not get capital for rebalance');
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

                await this.exitPosition(worstPosition, 'ROTATION', 'REBALANCE');
                
                if (tier4 && tier4.valid) {
                    const volatility = this.estimateVolatility(bestQueuedPool);
                    const sizing = calcEntrySize(tier4.tier4Score, volatility, currentCapital, tier4.regime);
                    
                    if (sizing.size > 0) {
                        await this.enterPosition(bestQueuedPool, sizing.size, tier4);
                    }
                }
            }
        }

        const totalRealized = (await capitalManager.getFullState())?.total_realized_pnl ?? 0;
        const equity = await this.getEquity();

        logger.info('[EXECUTION] Rebalance complete', {
            openPositions: this.positions.filter(p => !p.closed).length,
            totalRealized: totalRealized.toFixed(2),
            equity: equity.toFixed(2),
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

    public async printStatus(): Promise<void> {
        const status = await this.getPortfolioStatus();
        
        const divider = '═══════════════════════════════════════════════════════════════';
        logger.info(`\n${divider}`);
        logger.info('PORTFOLIO STATUS (TIER 4 - PERSISTENT CAPITAL)');
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
            rebalanceInterval: this.rebalanceInterval,
            takeProfit: this.takeProfit,
            stopLoss: this.stopLoss,
            maxConcurrentPools: this.maxConcurrentPools,
            allocationStrategy: this.allocationStrategy,
        };
    }

    public async reset(): Promise<void> {
        // Close all positions first
        await this.closeAll('RESET');
        
        // Reset capital
        await capitalManager.reset(this.initialCapital);
        
        this.positions = [];
        this.closedPositions = [];
        this.lastRebalanceTime = 0;
        this.poolQueue = [];
        
        logger.info('[EXECUTION] Engine reset to initial state');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export default ExecutionEngine;
