/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SCAN LOOP — THE SOLE RUNTIME ORCHESTRATOR
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module is THE ONLY runtime loop in the system.
 * 
 * ARCHITECTURAL RULES:
 * 1. NO module-level mutable state
 * 2. All state is instance properties
 * 3. Only start() runs background loop logic
 * 4. Engine is a STATELESS executor - we invoke it, it never runs on its own
 * 5. Predator is ADVISORY ONLY - it suggests, we decide
 * 
 * ORCHESTRATION RESPONSIBILITIES:
 * - Fetch telemetry
 * - Score pools
 * - Enforce risk gates
 * - Enforce kill switch
 * - Invoke engine.placePools() for entries
 * - Invoke engine.executeExit() for exits
 * - Schedule next cycle
 * 
 * NO engine.update() calls. Engine has NO internal loops.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Pool } from '../core/normalizePools';
import { logAction } from '../db/supabase';
import logger from '../utils/logger';
import { deduplicatePools, isDuplicatePair } from '../utils/arbitrage';
import { ActivePosition, TokenType } from '../types';

import {
    getLiveDLMMState,
    recordSnapshot,
    getPoolHistory,
    logMicrostructureMetrics,
    registerPosition,
    evaluatePositionExit,
    getAlivePoolIds,
    fetchBatchTelemetry,
    cleanup as cleanupTelemetry,
} from '../services/dlmmTelemetry';

import {
    batchScorePools,
    Tier4EnrichedPool,
} from '../scoring/microstructureScoring';

import { discoverDLMMUniverses, enrichedPoolToPool, EnrichedPool } from '../services/dlmmIndexer';
import { 
    shouldRefreshDiscovery, 
    updateDiscoveryCache, 
    getCachedEnrichedPools,
    recordEntry,
    recordNoEntryCycle,
    updateRegime,
    setKillSwitch,
    getDiscoveryCacheStatus,
    PoolMeta,
    CachedEnrichedPool,
    DISCOVERY_REFRESH_MS,
} from '../services/discoveryCache';
import { enterPosition, hasActiveTrade, exitPosition } from '../core/trading';
import {
    evaluateKillSwitch, 
    KillSwitchContext, 
    PoolMetrics,
} from '../core/killSwitch';

import {
    registerPool,
    evaluatePredatorEntry,
    registerPredatorTrade,
    handlePredatorExit,
    getPredatorReinjections,
    runPredatorCycle,
    logPredatorCycleSummary,
    clearPredatorState,
    computeMHI,
    getPredatorOpportunities,
    getStructuralExitSignals,
    PREDATOR_CONFIG,
} from '../engine/predatorController';
import { ExecutionEngine, ScoredPool, Position } from '../engine/ExecutionEngine';
import { capitalManager } from '../services/capitalManager';
import { loadActiveTradesFromDB, getAllActiveTrades } from '../db/models/Trade';
import {
    checkCapitalGating,
    assignRiskBatch,
    getAllowedPools,
    calculatePortfolioState,
    logPortfolioRiskSummary,
    PORTFOLIO_CONSTRAINTS,
    RiskTier,
    PoolRiskAssignment,
    ActivePosition as RiskActivePosition,
} from '../engine/riskBucketEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS (immutable, safe at module level)
// ═══════════════════════════════════════════════════════════════════════════════

const LOOP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_HOLD_TIME_MS = 4 * 60 * 60 * 1000; // 4 hours
const EXECUTION_MIN_SCORE = 24;
const PERSISTENCE_LOG_INTERVAL = 60_000;
const STATUS_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';

// ═══════════════════════════════════════════════════════════════════════════════
// POOL UNIVERSE LIMIT — PREVENTS OOM KILLS
// ═══════════════════════════════════════════════════════════════════════════════
// 
// CRITICAL: Discovery can return 800+ pools. Hydrating telemetry, scoring,
// and predator metadata for all of them causes RAM to exceed VPS limits.
// This limit is applied BEFORE any enrichment to prevent OOM.
//
// The limit slices pools sorted by base signal (TVL × velocity ratio).
// Only the top POOL_LIMIT pools are processed per cycle.
// ═══════════════════════════════════════════════════════════════════════════════

const POOL_LIMIT = parseInt(process.env.POOL_LIMIT || '50', 10);

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS (stateless, pure)
// ═══════════════════════════════════════════════════════════════════════════════

const categorizeToken = (pool: Pool): TokenType => {
    const name = pool.name.toUpperCase();
    if (name.includes('USDC') || name.includes('USDT') || name.includes('DAI')) {
        return 'stable';
    }
    const blueChips = ['SOL', 'BTC', 'WBTC', 'ETH', 'JUP', 'JLP', 'JITOSOL'];
    for (const token of blueChips) {
        if (name === token || name.startsWith(token + '-') || name.endsWith('-' + token)) {
            return 'blue-chip';
        }
    }
    return 'meme';
};

/**
 * Limit pool universe to prevent OOM.
 * Sorts by base signal (TVL × velocity ratio) and slices to POOL_LIMIT.
 * Called BEFORE any telemetry, scoring, or predator enrichment.
 */
const limitPoolUniverse = (pools: EnrichedPool[], limit: number): EnrichedPool[] => {
    if (pools.length <= limit) {
        return pools;
    }
    
    // Sort by base signal: TVL × velocityLiquidityRatio (higher = better)
    // This is a cheap pre-enrichment sort using discovery data only
    const sorted = [...pools].sort((a, b) => {
        const scoreA = (a.tvl || 0) * (a.velocityLiquidityRatio || 0);
        const scoreB = (b.tvl || 0) * (b.velocityLiquidityRatio || 0);
        return scoreB - scoreA;
    });
    
    const limited = sorted.slice(0, limit);
    
    logger.warn(`[POOL-LIMIT] ⚠️ Universe limited: ${pools.length} discovered → ${limited.length} processed (POOL_LIMIT=${limit})`);
    logger.info(`[POOL-LIMIT] Top pool: ${limited[0]?.symbol || limited[0]?.address?.slice(0, 8)} (TVL=$${((limited[0]?.tvl || 0) / 1000).toFixed(0)}k)`);
    
    return limited;
};

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN LOOP CLASS — THE SOLE RUNTIME ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

export class ScanLoop {
    // ═══════════════════════════════════════════════════════════════════════════
    // INSTANCE STATE
    // ═══════════════════════════════════════════════════════════════════════════
    
    private readonly engine: ExecutionEngine;
    private readonly engineId: string;
    private readonly intervalMs: number;
    
    private activePositions: ActivePosition[] = [];
    private trackedPoolAddresses: string[] = [];
    private botStartTime: number = 0;
    private totalSnapshotCount: number = 0;
    private lastPersistenceLogTime: number = 0;
    private lastStatusCheckTime: number = 0;
    
    private initializationComplete: boolean = false;
    private isScanning: boolean = false;
    private isRunning: boolean = false;
    private stopRequested: boolean = false;
    
    private loopTimeout: ReturnType<typeof setTimeout> | null = null;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════
    
    constructor(engine: ExecutionEngine, engineId: string, intervalMs: number = LOOP_INTERVAL_MS) {
        this.engine = engine;
        this.engineId = engineId;
        this.intervalMs = intervalMs;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Start the scan loop - THE ONLY RUNTIME DRIVER
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('[SCAN-LOOP] Already running, ignoring start()');
            return;
        }
        
        this.isRunning = true;
        this.stopRequested = false;
        this.botStartTime = Date.now();
        this.lastStatusCheckTime = Date.now();
        
        // Load active trades from database
        const activeTrades = await loadActiveTradesFromDB();
        for (const trade of activeTrades) {
            this.activePositions.push({
                poolAddress: trade.pool,
                entryTime: trade.timestamp,
                entryScore: trade.score,
                entryPrice: trade.entryPrice,
                peakScore: trade.score,
                amount: trade.size,
                entryTVL: trade.liquidity,
                entryVelocity: trade.velocity,
                consecutiveCycles: 1,
                consecutiveLowVolumeCycles: 0,
                tokenType: 'meme',
                entryBin: trade.entryBin || 0,
            });
        }
        
        this.initializationComplete = true;
        
        logger.info('');
        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info('✅ SCAN LOOP INITIALIZED — SOLE RUNTIME DRIVER');
        logger.info(`   Engine: ${this.engineId} (STATELESS MODE)`);
        logger.info(`   Active Positions: ${this.activePositions.length}`);
        logger.info(`   Interval: ${this.intervalMs / 1000}s`);
        logger.info('   Engine has NO internal loops — ScanLoop orchestrates ALL');
        logger.info('═══════════════════════════════════════════════════════════════════');
        
        // Start the recursive loop
        await this.loop();
    }
    
    /**
     * Stop the scan loop gracefully
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            logger.info('[SCAN-LOOP] Not running, ignoring stop()');
            return;
        }
        
        logger.info('[SCAN-LOOP] 🛑 Stop requested, waiting for current cycle to complete...');
        this.stopRequested = true;
        
        // Cancel pending timeout
        if (this.loopTimeout) {
            clearTimeout(this.loopTimeout);
            this.loopTimeout = null;
        }
        
        // Wait for current scan to complete (if running)
        const maxWait = 60_000; // 60 seconds max wait
        const startWait = Date.now();
        
        while (this.isScanning && Date.now() - startWait < maxWait) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (this.isScanning) {
            logger.warn('[SCAN-LOOP] ⚠️ Force stopping after timeout');
        }
        
        this.isRunning = false;
        
        logger.info('[SCAN-LOOP] ✅ Stopped');
    }
    
    /**
     * Get current active positions (readonly)
     */
    getActivePositions(): readonly ActivePosition[] {
        return this.activePositions;
    }
    
    /**
     * Check if loop is currently running
     */
    isLoopRunning(): boolean {
        return this.isRunning;
    }
    
    /**
     * Cleanup resources - call after stop()
     */
    async cleanup(): Promise<void> {
        logger.info('[SCAN-LOOP] 🧹 Cleaning up resources...');
        
        // Cleanup telemetry
        cleanupTelemetry();
        
        // Clear predator state
        clearPredatorState();
        
        logger.info('[SCAN-LOOP] ✅ Cleanup complete');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: RECURSIVE LOOP
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Recursive async loop - waits for completion before scheduling next
     */
    private async loop(): Promise<void> {
        if (this.stopRequested) {
            logger.info('[SCAN-LOOP] Loop exiting due to stop request');
            return;
        }
        
        // Run the scan cycle
        await this.runScanCycle();
        
        // Schedule next iteration only if not stopped
        if (!this.stopRequested && this.isRunning) {
            this.loopTimeout = setTimeout(() => this.loop(), this.intervalMs);
        }
    }
    
    /**
     * Run a single scan cycle with overlap protection
     */
    private async runScanCycle(): Promise<void> {
        if (this.isScanning) {
            logger.warn('⏳ Previous scan still running, skipping');
            return;
        }
        
        this.isScanning = true;
        
        try {
            await this.scanCycle();
        } catch (error: any) {
            logger.error(`❌ Scan error: ${error?.message || error}`);
        } finally {
            this.isScanning = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: TELEMETRY HELPERS
    // ═══════════════════════════════════════════════════════════════════════════
    
    private async refreshTelemetry(): Promise<void> {
        if (this.trackedPoolAddresses.length === 0) {
            logger.debug('[TELEMETRY] No pools to refresh');
            return;
        }
        try {
            const telemetryArray = await fetchBatchTelemetry(this.trackedPoolAddresses);
            for (const telemetry of telemetryArray) {
                recordSnapshot(telemetry);
            }
            logger.debug(`[TELEMETRY] Refreshed ${telemetryArray.length}/${this.trackedPoolAddresses.length} pools via SDK`);
        } catch (error) {
            logger.error('[TELEMETRY] SDK refresh failed:', error);
        }
    }
    
    private updateTrackedPools(addresses: string[]): void {
        this.trackedPoolAddresses = addresses;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: POSITION HEALTH CHECK (REPLACES engine.update())
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Evaluate all open positions and exit if needed.
     * THIS REPLACES engine.update() - ScanLoop is now the orchestrator.
     */
    private async evaluateAndExitPositions(scoredPools: ScoredPool[]): Promise<void> {
        // Update pool queue in engine for price updates
        this.engine.updatePoolQueue(scoredPools);
        
        // Get open positions from engine
        const openPositions = this.engine.getOpenPositions();
        
        for (const position of openPositions) {
            // Evaluate position health
            const healthEval = this.engine.evaluatePositionHealth(position.id);
            
            if (healthEval.shouldExit) {
                // ScanLoop decides to exit - invoke engine
                logger.info(`[SCAN-LOOP] Exit signal for ${position.pool.slice(0, 8)}... - ${healthEval.exitType}: ${healthEval.exitReason}`);
                
                const exited = await this.engine.executeExit(
                    position.id,
                    healthEval.exitReason,
                    `SCAN_LOOP_${healthEval.exitType}`
                );
                
                if (exited) {
                    // Remove from our tracking
                    this.activePositions = this.activePositions.filter(
                        ap => ap.poolAddress !== position.pool
                    );
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: ROTATION MANAGER
    // ═══════════════════════════════════════════════════════════════════════════
    
    private async manageRotation(rankedPools: Tier4EnrichedPool[]): Promise<number> {
        const now = Date.now();
        const remainingPositions: ActivePosition[] = [];
        let exitSignalCount = 0;

        let currentBalance: number;
        try {
            currentBalance = await capitalManager.getBalance();
        } catch (err: any) {
            logger.error(`[ROTATION] Failed to get capital: ${err.message}`);
            return 0;
        }

        // Check exits
        for (const pos of this.activePositions) {
            const pool = rankedPools.find(p => p.address === pos.poolAddress);
            if (!pool) {
                remainingPositions.push(pos);
                continue;
            }

            const holdTime = now - pos.entryTime;
            if (pool.score > pos.peakScore) {
                pos.peakScore = pool.score;
            }

            // Microstructure exit check
            const exitSignal = evaluatePositionExit(pos.poolAddress);
            if (exitSignal?.shouldExit) {
                const activeTrades = getAllActiveTrades();
                const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                if (trade) {
                    const exitResult = await exitPosition(trade.id, {
                        exitPrice: pool.currentPrice,
                        reason: `MICROSTRUCTURE: ${exitSignal.reason}`,
                    }, 'MICROSTRUCTURE_EXIT');
                    if (exitResult.success) {
                        logger.warn(`[MICRO-EXIT] ${pool.name} - ${exitSignal.reason}`);
                        exitSignalCount++;
                        const mhiResult = computeMHI(pos.poolAddress);
                        handlePredatorExit(trade.id, pos.poolAddress, pool.name,
                            `MICROSTRUCTURE: ${exitSignal.reason}`, exitResult.pnl ?? 0,
                            (exitResult.pnl ?? 0) / pos.amount, mhiResult?.mhi,
                            pool.microMetrics?.poolEntropy);
                    }
                }
                continue;
            }

            // Min hold time check - ENFORCED BY SCANLOOP, NOT ENGINE
            const bypassMinHold = pos.entryScore < 55;
            if (holdTime < MIN_HOLD_TIME_MS && !bypassMinHold) {
                remainingPositions.push(pos);
                continue;
            }

            // Emergency exit
            const scoreCrash = pos.entryScore > 0 ? (pos.entryScore - pool.score) / pos.entryScore : 0;
            const emergencyExit = pool.score < 15 || scoreCrash > 0.50;
            if (emergencyExit) {
                const reason = pool.score < 15 ? 'Emergency: Score Below 15' : 'Emergency: Score Crash (-50%)';
                const activeTrades = getAllActiveTrades();
                const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                if (trade) {
                    const exitResult = await exitPosition(trade.id, { exitPrice: pool.currentPrice, reason }, 'EMERGENCY_EXIT');
                    if (exitResult.success) {
                        logger.warn(`[EMERGENCY] ${pool.name} - ${reason}`);
                        exitSignalCount++;
                    }
                }
                continue;
            }

            remainingPositions.push(pos);
        }

        // Market crash detection
        if (exitSignalCount >= 3 && this.activePositions.length >= 3) {
            logger.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit.`);
            for (const pos of remainingPositions) {
                const activeTrades = getAllActiveTrades();
                const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                if (trade) {
                    await exitPosition(trade.id, { exitPrice: 0, reason: 'MARKET_CRASH_EXIT' }, 'MARKET_CRASH');
                }
            }
            this.activePositions = [];
            return 0;
        }

        this.activePositions = remainingPositions;

        // Risk bucket assignment
        let rotationBalance: number, rotationEquity: number;
        try {
            rotationBalance = await capitalManager.getBalance();
            rotationEquity = await capitalManager.getEquity();
        } catch (err: any) {
            logger.error(`[ROTATION] Failed to get capital: ${err.message}`);
            return 0;
        }

        const riskActivePositions: RiskActivePosition[] = this.activePositions.map(pos => {
            const pool = rankedPools.find(p => p.address === pos.poolAddress);
            const microScore = pool?.microScore ?? pos.entryScore;
            let tier: RiskTier = 'C';
            if (microScore >= 40) tier = 'A';
            else if (microScore >= 32) tier = 'B';
            else if (microScore >= 24) tier = 'C';
            else tier = 'D';
            return { poolAddress: pos.poolAddress, tier, size: pos.amount, entryScore: pos.entryScore };
        });

        const portfolioState = calculatePortfolioState(rotationEquity, rotationBalance, riskActivePositions);
        logPortfolioRiskSummary(portfolioState);

        const poolsForRiskAssignment = rankedPools
            .filter(p => p.hasValidTelemetry && p.isMarketAlive)
            .filter(p => !this.activePositions.find(ap => ap.poolAddress === p.address))
            .map(p => ({
                address: p.address, name: p.name, microScore: p.microScore,
                liquiditySlope: (p as any).liquiditySlope ?? 0,
            }));

        const riskAssignments = assignRiskBatch(poolsForRiskAssignment, rotationEquity, rotationBalance, riskActivePositions);
        const allowedAssignments = getAllowedPools(riskAssignments);

        const validCandidates: { pool: Tier4EnrichedPool; type: TokenType; riskAssignment: PoolRiskAssignment }[] = [];

        for (const assignment of allowedAssignments) {
            const pool = rankedPools.find(p => p.address === assignment.poolAddress);
            if (!pool) continue;

            const activePools = this.activePositions.map(pos => 
                rankedPools.find(p => p.address === pos.poolAddress)
            ).filter((p): p is Tier4EnrichedPool => p !== undefined);

            if (isDuplicatePair(pool, activePools)) continue;

            // Predator is ADVISORY ONLY - we check but make final decision
            const predatorEval = evaluatePredatorEntry(pool.address, pool.name);
            if (!predatorEval.canEnter) {
                logger.debug(`[PREDATOR-ADVISORY] ${pool.name} - blocked by predator: ${predatorEval.blockedReasons.join(', ')}`);
                continue;
            }

            const candidateType = categorizeToken(pool);
            const mhiAdjustedSize = assignment.finalSize * predatorEval.finalSizeMultiplier;
            validCandidates.push({ pool, type: candidateType, riskAssignment: { ...assignment, finalSize: mhiAdjustedSize } });
        }

        // Execute entries - SCANLOOP DECIDES, ENGINE EXECUTES
        let entriesThisCycle = 0;
        if (validCandidates.length > 0) {
            let availableForTrades = rotationBalance;

            for (const { pool, type, riskAssignment } of validCandidates) {
                const amount = riskAssignment.finalSize;
                if (amount < 10 || availableForTrades < amount) continue;
                if (hasActiveTrade(pool.address)) continue;

                const sizingMode = riskAssignment.tier === 'A' ? 'aggressive' : 'standard';
                const tradeResult = await enterPosition(pool as any, sizingMode, amount, rotationEquity, riskAssignment.tier, riskAssignment.leverage);

                if (tradeResult.success && tradeResult.trade) {
                    const tradeSize = tradeResult.trade.size;
                    availableForTrades -= tradeSize;
                    entriesThisCycle++;
                    recordEntry();

                    this.activePositions.push({
                        poolAddress: pool.address, entryTime: Date.now(), entryScore: pool.microScore,
                        entryPrice: pool.currentPrice, peakScore: pool.microScore, amount: tradeSize,
                        entryTVL: pool.liquidity, entryVelocity: pool.velocity, consecutiveCycles: 1,
                        consecutiveLowVolumeCycles: 0, tokenType: type,
                    });

                    const history = getPoolHistory(pool.address);
                    const latestState = history.length > 0 ? history[history.length - 1] : null;
                    if (latestState) {
                        registerPosition({
                            poolId: pool.address, entryBin: latestState.activeBin, entryTime: Date.now(),
                            entryFeeIntensity: pool.microMetrics?.feeIntensity ?? 0,
                            entrySwapVelocity: pool.microMetrics?.swapVelocity ?? 0,
                            entry3mFeeIntensity: pool.microMetrics?.feeIntensity ?? 0,
                            entry3mSwapVelocity: pool.microMetrics?.swapVelocity ?? 0,
                        });
                    }
                    registerPredatorTrade(tradeResult.trade.id, pool.address);
                }
            }
        }
        return entriesThisCycle;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: SCAN CYCLE — THE SOLE ORCHESTRATOR
    // ═══════════════════════════════════════════════════════════════════════════
    
    private async scanCycle(): Promise<void> {
        const startTime = Date.now();

        try {
            if (!this.initializationComplete) {
                logger.error('🚨 scanCycle called before initialization');
                return;
            }

            // Periodic status log
            if (Date.now() - this.lastPersistenceLogTime >= PERSISTENCE_LOG_INTERVAL) {
                logger.info(`[STATUS] Engine: ${this.engineId} | Uptime: ${Math.floor((Date.now() - this.botStartTime) / 1000)}s`);
                this.lastPersistenceLogTime = Date.now();
            }

            // Periodic status check (replaces engine's internal status loop)
            if (Date.now() - this.lastStatusCheckTime >= STATUS_CHECK_INTERVAL) {
                await this.engine.printStatus();
                this.lastStatusCheckTime = Date.now();
            }

            logger.info('═══════════════════════════════════════════════════════════════════');
            logger.info('🔄 SCAN CYCLE START (SCANLOOP = SOLE ORCHESTRATOR)');
            logger.info('═══════════════════════════════════════════════════════════════════');

            // STEP 1: CAPITAL GATING - ScanLoop enforces
            let currentBalance: number, totalEquity: number;
            try {
                currentBalance = await capitalManager.getBalance();
                totalEquity = await capitalManager.getEquity();
            } catch (err: any) {
                logger.error(`[CAPITAL] Failed to get balance: ${err.message}`);
                return;
            }

            const capitalGate = checkCapitalGating(currentBalance);
            if (!capitalGate.canTrade) {
                logger.warn(`[CAPITAL GATE] ❌ ${capitalGate.reason}`);
                return;
            }

            // STEP 2: DISCOVERY
            const currentPoolIds = this.activePositions.map(p => p.poolAddress);
            const discoveryCheck = shouldRefreshDiscovery(currentPoolIds);
            let poolUniverse: EnrichedPool[] = [];

            if (!discoveryCheck.shouldRefresh) {
                const cachedPools = getCachedEnrichedPools();
                if (cachedPools && cachedPools.length > 0) {
                    poolUniverse = cachedPools.map(cp => ({ ...cp } as EnrichedPool));
                }
            } else {
                try {
                    poolUniverse = await discoverDLMMUniverses({ minTVL: 200000, minVolume24h: 75000, minTraders24h: 35 });
                    if (poolUniverse.length > 0) {
                        const poolMetas: PoolMeta[] = poolUniverse.map(p => ({
                            address: p.address, name: p.symbol || p.address.slice(0, 8),
                            score: p.velocityLiquidityRatio || 0, mhi: 0, regime: 'NEUTRAL' as const, lastUpdated: Date.now(),
                        }));
                        const cachedEnriched: CachedEnrichedPool[] = poolUniverse.map(p => ({ ...p }));
                        updateDiscoveryCache(poolMetas, discoveryCheck.reason, cachedEnriched);
                    }
                } catch (err: any) {
                    logger.error('[DISCOVERY] Failed:', err?.message);
                    recordNoEntryCycle();
                    return;
                }
            }

            if (!Array.isArray(poolUniverse) || poolUniverse.length === 0) {
                logger.warn('[DISCOVERY] No qualified pools');
                recordNoEntryCycle();
                return;
            }

            // ═══════════════════════════════════════════════════════════════════
            // POOL LIMIT — PREVENT OOM KILLS
            // Applied BEFORE telemetry, scoring, or predator enrichment
            // ═══════════════════════════════════════════════════════════════════
            const rawPoolCount = poolUniverse.length;
            poolUniverse = limitPoolUniverse(poolUniverse, POOL_LIMIT);
            
            if (rawPoolCount > POOL_LIMIT) {
                logger.info(`[MEMORY] Processing ${poolUniverse.length} pools (discarded ${rawPoolCount - poolUniverse.length} to prevent OOM)`);
            }

            // STEP 3: TELEMETRY & SCORING (now limited to POOL_LIMIT pools)
            const pools: Pool[] = poolUniverse.map(ep => enrichedPoolToPool(ep) as Pool);
            const poolAddresses = pools.map(p => p.address);
            this.updateTrackedPools(poolAddresses);

            for (const pool of pools) {
                registerPool(pool.address, pool.name, pool.mintX || '', pool.mintY || '');
            }

            await this.refreshTelemetry();
            const microEnrichedPools = batchScorePools(pools);

            // STEP 4: PREDATOR CYCLE (ADVISORY ONLY)
            const predatorSummary = runPredatorCycle(poolAddresses);

            // STEP 5: KILL SWITCH - ScanLoop enforces
            this.totalSnapshotCount += microEnrichedPools.filter(p => p.hasValidTelemetry).length;
            const killSwitchPoolMetrics: PoolMetrics[] = microEnrichedPools
                .filter(p => p.microMetrics)
                .map(p => ({
                    poolId: p.address, swapVelocity: (p.microMetrics?.swapVelocity ?? 0) / 100,
                    liquidityFlowPct: 0, entropy: p.microMetrics?.poolEntropy ?? 0,
                    feeIntensity: (p.microMetrics?.feeIntensity ?? 0) / 100,
                    feeIntensityBaseline60s: 0, microScore: p.microScore,
                }));

            const killDecision = evaluateKillSwitch({
                poolMetrics: killSwitchPoolMetrics, snapshotCount: this.totalSnapshotCount,
                runtimeMs: Date.now() - this.botStartTime, activeTradesCount: this.activePositions.length,
            });

            if (killDecision.killAll) {
                logger.error(`🚨 KILL SWITCH: ${killDecision.reason}`);
                setKillSwitch(true);
                for (const pos of this.activePositions) {
                    const activeTrades = getAllActiveTrades();
                    const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                    if (trade) {
                        await exitPosition(trade.id, { exitPrice: 0, reason: `KILL SWITCH: ${killDecision.reason}` }, 'KILL_SWITCH');
                    }
                }
                this.activePositions = [];
                return;
            }

            if (killDecision.shouldPause) {
                logger.warn(`⏸️ Trading paused: ${killDecision.reason}`);
                return;
            }

            // STEP 6: POOL PREPARATION
            const sortedPools = microEnrichedPools.sort((a, b) => b.microScore - a.microScore);
            const deduplicatedPools = deduplicatePools(sortedPools) as Tier4EnrichedPool[];

            if (deduplicatedPools.length === 0) {
                recordNoEntryCycle();
                return;
            }

            const scoredPoolsForEngine: ScoredPool[] = deduplicatedPools.map((p: Tier4EnrichedPool) => ({
                address: p.address, score: p.microScore, liquidityUSD: p.liquidity,
                volume24h: p.volume24h, binCount: p.binCount || 1, activeBin: (p as any).activeBin || 0,
                tokenA: { symbol: p.name.split('-')[0] || 'TOKEN', decimals: 9 },
                tokenB: { symbol: p.name.split('-')[1] || 'TOKEN', decimals: 9 },
                microMetrics: p.microMetrics || undefined, isMarketAlive: p.isMarketAlive,
            }));

            // STEP 7: EVALUATE EXISTING POSITIONS (REPLACES engine.update())
            await this.evaluateAndExitPositions(scoredPoolsForEngine);

            // STEP 8: INVOKE ENGINE FOR ENTRIES (if conditions met)
            const bestPool = scoredPoolsForEngine.reduce((best, pool) => pool.score > best.score ? pool : best, scoredPoolsForEngine[0]);

            if (bestPool.score >= EXECUTION_MIN_SCORE && bestPool.isMarketAlive) {
                // ScanLoop invokes engine for entries - engine does NOT run on its own
                await this.engine.placePools(scoredPoolsForEngine);
            }

            // STEP 9: ROTATION (additional entries via risk bucket engine)
            const entriesThisCycle = await this.manageRotation(microEnrichedPools);

            // STEP 10: MONITORING
            if (entriesThisCycle === 0) recordNoEntryCycle();

            const regimes = microEnrichedPools.slice(0, 10).map(p => p.regime);
            const regimeCounts = { BULL: 0, NEUTRAL: 0, BEAR: 0 };
            for (const r of regimes) if (r && regimeCounts[r] !== undefined) regimeCounts[r]++;
            const dominantRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0][0] as 'BULL' | 'NEUTRAL' | 'BEAR';
            updateRegime(dominantRegime);

            if (!killDecision.killAll && !killDecision.shouldPause) setKillSwitch(false);

            const duration = Date.now() - startTime;
            logger.info(`✅ Scan cycle complete: ${duration}ms | Entries: ${entriesThisCycle}`);
            logPredatorCycleSummary(predatorSummary);

        } catch (error) {
            logger.error('❌ Error in scan cycle:', error);
        }
    }
}
