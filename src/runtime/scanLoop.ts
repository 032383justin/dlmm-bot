/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SCAN LOOP — RUNTIME MODULE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module contains all scan/discovery/trading loop logic.
 * 
 * RULES:
 * 1. NO singleton access at import time
 * 2. Engine is passed as parameter to startScanLoop()
 * 3. All state is module-scoped but initialized at runtime
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
// MODULE STATE (initialized at runtime, not import time)
// ═══════════════════════════════════════════════════════════════════════════════

let activePositions: ActivePosition[] = [];
let botStartTime: number = 0;
let totalSnapshotCount: number = 0;
let trackedPoolAddresses: string[] = [];
let initializationComplete = false;
let lastPersistenceLogTime = 0;
let isScanning = false;

// Engine reference (set at runtime)
let engine: ExecutionEngine;
let engineId: string = '';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const LOOP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_HOLD_TIME_MS = 4 * 60 * 60 * 1000; // 4 hours
const EXECUTION_MIN_SCORE = 24;
const PERSISTENCE_LOG_INTERVAL = 60_000;
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
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

async function refreshTelemetry(): Promise<void> {
    if (trackedPoolAddresses.length === 0) {
        logger.debug('[TELEMETRY] No pools to refresh');
        return;
    }
    try {
        const telemetryArray = await fetchBatchTelemetry(trackedPoolAddresses);
        for (const telemetry of telemetryArray) {
            recordSnapshot(telemetry);
        }
        logger.debug(`[TELEMETRY] Refreshed ${telemetryArray.length}/${trackedPoolAddresses.length} pools via SDK`);
    } catch (error) {
        logger.error('[TELEMETRY] SDK refresh failed:', error);
    }
}

function updateTrackedPools(addresses: string[]): void {
    trackedPoolAddresses = addresses;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROTATION MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

const manageRotation = async (rankedPools: Tier4EnrichedPool[]): Promise<number> => {
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
    for (const pos of activePositions) {
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

        // Min hold time check
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
    if (exitSignalCount >= 3 && activePositions.length >= 3) {
        logger.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit.`);
        for (const pos of remainingPositions) {
            const activeTrades = getAllActiveTrades();
            const trade = activeTrades.find(t => t.pool === pos.poolAddress);
            if (trade) {
                await exitPosition(trade.id, { exitPrice: 0, reason: 'MARKET_CRASH_EXIT' }, 'MARKET_CRASH');
            }
        }
        activePositions = [];
        return 0;
    }

    activePositions = remainingPositions;

    // Risk bucket assignment
    let rotationBalance: number, rotationEquity: number;
    try {
        rotationBalance = await capitalManager.getBalance();
        rotationEquity = await capitalManager.getEquity();
    } catch (err: any) {
        logger.error(`[ROTATION] Failed to get capital: ${err.message}`);
        return 0;
    }

    const riskActivePositions: RiskActivePosition[] = activePositions.map(pos => {
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
        .filter(p => !activePositions.find(ap => ap.poolAddress === p.address))
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

        const activePools = activePositions.map(pos => 
            rankedPools.find(p => p.address === pos.poolAddress)
        ).filter((p): p is Tier4EnrichedPool => p !== undefined);

        if (isDuplicatePair(pool, activePools)) continue;

        const predatorEval = evaluatePredatorEntry(pool.address, pool.name);
        if (!predatorEval.canEnter) continue;

        const candidateType = categorizeToken(pool);
        const mhiAdjustedSize = assignment.finalSize * predatorEval.finalSizeMultiplier;
        validCandidates.push({ pool, type: candidateType, riskAssignment: { ...assignment, finalSize: mhiAdjustedSize } });
    }

    // Execute entries
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

                activePositions.push({
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
};

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN CYCLE
// ═══════════════════════════════════════════════════════════════════════════════

async function scanCycle(): Promise<void> {
    const startTime = Date.now();

    try {
        if (!initializationComplete) {
            logger.error('🚨 scanCycle called before initialization');
            return;
        }

        // Periodic status log
        if (Date.now() - lastPersistenceLogTime >= PERSISTENCE_LOG_INTERVAL) {
            logger.info(`[STATUS] Engine: ${engineId} | Uptime: ${Math.floor((Date.now() - botStartTime) / 1000)}s`);
            lastPersistenceLogTime = Date.now();
        }

        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info('🔄 SCAN CYCLE START');
        logger.info('═══════════════════════════════════════════════════════════════════');

        // Capital gating
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

        // Discovery
        const currentPoolIds = activePositions.map(p => p.poolAddress);
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

        // Convert and score
        const pools: Pool[] = poolUniverse.map(ep => enrichedPoolToPool(ep) as Pool);
        const poolAddresses = pools.map(p => p.address);
        updateTrackedPools(poolAddresses);

        for (const pool of pools) {
            registerPool(pool.address, pool.name, pool.mintX || '', pool.mintY || '');
        }

        await refreshTelemetry();
        const microEnrichedPools = batchScorePools(pools);

        // Predator cycle
        const predatorSummary = runPredatorCycle(poolAddresses);

        // Kill switch
        totalSnapshotCount += microEnrichedPools.filter(p => p.hasValidTelemetry).length;
        const killSwitchPoolMetrics: PoolMetrics[] = microEnrichedPools
            .filter(p => p.microMetrics)
            .map(p => ({
                poolId: p.address, swapVelocity: (p.microMetrics?.swapVelocity ?? 0) / 100,
                liquidityFlowPct: 0, entropy: p.microMetrics?.poolEntropy ?? 0,
                feeIntensity: (p.microMetrics?.feeIntensity ?? 0) / 100,
                feeIntensityBaseline60s: 0, microScore: p.microScore,
            }));

        const killDecision = evaluateKillSwitch({
            poolMetrics: killSwitchPoolMetrics, snapshotCount: totalSnapshotCount,
            runtimeMs: Date.now() - botStartTime, activeTradesCount: activePositions.length,
        });

        if (killDecision.killAll) {
            logger.error(`🚨 KILL SWITCH: ${killDecision.reason}`);
            setKillSwitch(true);
            for (const pos of activePositions) {
                const activeTrades = getAllActiveTrades();
                const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                if (trade) {
                    await exitPosition(trade.id, { exitPrice: 0, reason: `KILL SWITCH: ${killDecision.reason}` }, 'KILL_SWITCH');
                }
            }
            activePositions = [];
            return;
        }

        if (killDecision.shouldPause) {
            logger.warn(`⏸️ Trading paused: ${killDecision.reason}`);
            return;
        }

        // Execute
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

        const bestPool = scoredPoolsForEngine.reduce((best, pool) => pool.score > best.score ? pool : best, scoredPoolsForEngine[0]);

        if (bestPool.score >= EXECUTION_MIN_SCORE && bestPool.isMarketAlive) {
            await engine.placePools(scoredPoolsForEngine);
            await engine.update();
        } else {
            await engine.update();
        }

        const entriesThisCycle = await manageRotation(microEnrichedPools);

        // Monitor
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

async function runScanCycle(): Promise<void> {
    if (isScanning) {
        logger.warn('⏳ Previous scan still running, skipping');
        return;
    }
    isScanning = true;
    try {
        await scanCycle();
    } catch (error: any) {
        logger.error(`❌ Scan error: ${error?.message || error}`);
    } finally {
        isScanning = false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTED FUNCTION — CALLED BY start.ts
// ═══════════════════════════════════════════════════════════════════════════════

export async function startScanLoop(executionEngine: ExecutionEngine, execEngineId: string): Promise<void> {
    // Set module state at runtime
    engine = executionEngine;
    engineId = execEngineId;
    botStartTime = Date.now();

    // Load active trades
    const activeTrades = await loadActiveTradesFromDB();
    for (const trade of activeTrades) {
        activePositions.push({
            poolAddress: trade.pool, entryTime: trade.timestamp, entryScore: trade.score,
            entryPrice: trade.entryPrice, peakScore: trade.score, amount: trade.size,
            entryTVL: trade.liquidity, entryVelocity: trade.velocity, consecutiveCycles: 1,
            consecutiveLowVolumeCycles: 0, tokenType: 'meme', entryBin: trade.entryBin || 0,
        });
    }

    initializationComplete = true;

    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('✅ SCAN LOOP INITIALIZED');
    logger.info(`   Engine: ${engineId}`);
    logger.info(`   Active Positions: ${activePositions.length}`);
    logger.info('═══════════════════════════════════════════════════════════════════');

    // Run first scan immediately
    await runScanCycle();

    // Schedule recurring scans
    setInterval(runScanCycle, LOOP_INTERVAL_MS);

    logger.info(`🔄 Scan loop running. Interval: ${LOOP_INTERVAL_MS / 1000}s`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

export function cleanup(): void {
    cleanupTelemetry();
    clearPredatorState();
}

