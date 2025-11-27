import { savePaperTradingState, loadPaperTradingState } from './utils/state';
import { Pool } from './core/normalizePools';
import { applySafetyFilters, calculateRiskScore } from './core/safetyFilters';
import { calculateDilutionScore } from './core/dilution';
import { logAction, saveSnapshot } from './db/supabase';
import { saveBinSnapshot } from './db/binHistory';
import logger from './utils/logger';
import { getVolatilityMultiplier, calculateVolatility } from './utils/volatility';
import { deduplicatePools, isDuplicatePair } from './utils/arbitrage';
import { ActivePosition, TokenType } from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// NEW: Microstructure Telemetry Imports
// ═══════════════════════════════════════════════════════════════════════════════
import {
    initializeSwapStream,
    getLiveDLMMState,
    getAllLiveDLMMStates,
    recordSnapshot,
    computeMicrostructureMetrics,
    getPoolHistory,
    logMicrostructureMetrics,
    registerPosition,
    evaluatePositionExit,
    refreshAllPoolMetrics,
    getRankedPools,
    getAlivePoolIds,
    DLMMState,
    MicrostructureMetrics,
    BinFocusedPosition,
    cleanup as cleanupTelemetry,
} from './services/dlmmTelemetry';

import {
    scoreMicrostructure,
    enrichPoolWithMicrostructure,
    batchScorePools,
    filterValidPools,
    passesEntryGating,
    getEntryGatingStatus,
    MicrostructureEnrichedPool,
} from './scoring/microstructureScoring';

import { discoverDLMMUniverses, enrichedPoolToPool, EnrichedPool, getCacheStatus } from './services/dlmmIndexer';
import { evaluateEntry, evaluateTransitionGate, TransitionGateResult } from './core/structuralEntry';
import { enterPosition, getSizingMode, hasActiveTrade } from './core/trading';
import { evaluateExit } from './core/structuralExit';
import { evaluateKill } from './core/killSwitch';
import { BOT_CONFIG } from './config/constants';
import { ExecutionEngine, ScoredPool, Position } from './engine/ExecutionEngine';
import dotenv from 'dotenv';

dotenv.config();

// Initialization guard - MUST BE AT TOP - prevents re-initialization
let BOT_INITIALIZED = false;

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const LOOP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const TELEMETRY_REFRESH_INTERVAL_MS = 10 * 1000; // 10 seconds for telemetry
const MIN_HOLD_TIME_MS = 4 * 60 * 60 * 1000; // 4 hours
const EXECUTION_MIN_SCORE = 24; // Minimum microstructure score to open position

// Paper Trading Mode
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const PAPER_CAPITAL = parseFloat(process.env.PAPER_CAPITAL || '10000');
const RESET_STATE = process.env.RESET_STATE === 'true';

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL STATE (persists across scan cycles)
// ═══════════════════════════════════════════════════════════════════════════════

let paperTradingBalance = PAPER_CAPITAL;
let paperTradingPnL = 0;
let activePositions: ActivePosition[] = [];

// Kill switch state
let killSwitchPauseUntil = 0;

// Telemetry refresh timer
let telemetryRefreshTimer: NodeJS.Timeout | null = null;

// Execution Engine (paper trading)
const executionEngine = new ExecutionEngine({
    capital: PAPER_CAPITAL,
    rebalanceInterval: 15 * 60 * 1000,
    takeProfit: 0.04,
    stopLoss: -0.02,
    maxConcurrentPools: 3,
    allocationStrategy: 'equal',
});
const enginePositions: Position[] = [];

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

// ═══════════════════════════════════════════════════════════════════════════════
// TELEMETRY REFRESH (runs every 10 seconds)
// ═══════════════════════════════════════════════════════════════════════════════

async function refreshTelemetry(): Promise<void> {
    try {
        // Fetch all live states from Meteora API
        const states = await getAllLiveDLMMStates();
        
        // Record snapshots for each pool
        for (const state of states) {
            recordSnapshot(state);
        }
        
        logger.debug(`[TELEMETRY] Refreshed ${states.length} pool snapshots`);
        
    } catch (error) {
        logger.error('[TELEMETRY] Refresh failed:', error);
    }
}

function startTelemetryRefresh(): void {
    if (telemetryRefreshTimer) {
        clearInterval(telemetryRefreshTimer);
    }
    
    telemetryRefreshTimer = setInterval(refreshTelemetry, TELEMETRY_REFRESH_INTERVAL_MS);
    logger.info(`[TELEMETRY] Started refresh loop (${TELEMETRY_REFRESH_INTERVAL_MS / 1000}s interval)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION (runs ONCE on startup)
// ═══════════════════════════════════════════════════════════════════════════════

async function initializeBot(): Promise<void> {
    if (BOT_INITIALIZED) {
        logger.debug('[INIT] initializeBot skipped — already initialized');
        return;
    }

    BOT_INITIALIZED = true;
    logger.info('[INIT] 🚀 INITIALIZING BOT...');
    logger.info('[INIT] 🧬 Using MICROSTRUCTURE-BASED SCORING (no 24h metrics)');

    // Initialize Helius WebSocket for live swap stream
    initializeSwapStream();
    
    // Start telemetry refresh loop
    startTelemetryRefresh();

    // PAPER MODE: Simple clean start - no complex state sync that causes boot loops
    if (PAPER_TRADING) {
        logger.info('[INIT] 🎮 PAPER TRADING MODE');
        
        // Always start clean in paper mode to avoid boot loops from state mismatch
        paperTradingBalance = PAPER_CAPITAL;
        paperTradingPnL = 0;
        activePositions = [];
        await savePaperTradingState(paperTradingBalance, paperTradingPnL);
        
        logger.info(`[INIT] 💰 Starting balance: $${paperTradingBalance.toFixed(2)}`);
        logger.info('[INIT] 📊 Positions cleared - fresh start');
    } else {
        // LIVE MODE: Full state recovery
        logger.info('[INIT] ⚠️  LIVE TRADING MODE - Real money at risk!');
        
        const { supabase } = await import('./db/supabase');
        const { data: allLogs } = await supabase
            .from('bot_logs')
            .select('*')
            .in('action', ['ENTRY', 'EXIT'])
            .order('timestamp', { ascending: true });

        if (allLogs) {
            const entryMap = new Map();
            const exitedPools = new Set();

            for (const log of allLogs) {
                if (log.action === 'ENTRY') {
                    const pool = (log.details as any)?.pool;
                    const amount = (log.details as any)?.amount;
                    const score = (log.details as any)?.score;
                    const type = (log.details as any)?.type;
                    const entryBin = (log.details as any)?.entryBin || 0;
                    if (pool && amount) {
                        entryMap.set(pool, {
                            poolAddress: pool,
                            entryTime: new Date(log.timestamp).getTime(),
                            entryScore: score || 0,
                            entryPrice: 0,
                            peakScore: score || 0,
                            amount,
                            entryTVL: 0,
                            entryVelocity: 0,
                            consecutiveCycles: 1,
                            consecutiveLowVolumeCycles: 0,
                            tokenType: type || 'unknown',
                            entryBin,
                        });
                    }
                } else if (log.action === 'EXIT') {
                    const pool = (log.details as any)?.pool;
                    if (pool) exitedPools.add(pool);
                }
            }

            for (const pool of exitedPools) {
                entryMap.delete(pool);
            }

            activePositions = Array.from(entryMap.values());
            logger.info(`[INIT] ✅ Recovered ${activePositions.length} active positions`);
        }
    }

    logger.info('[INIT] ✅ Initialization complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROTATION MANAGER (entry/exit logic)
// ═══════════════════════════════════════════════════════════════════════════════

const manageRotation = async (rankedPools: MicrostructureEnrichedPool[]) => {
    const now = Date.now();
    const remainingPositions: ActivePosition[] = [];
    let exitSignalCount = 0;

    // 1. Check Exits with Microstructure Triggers
    for (const pos of activePositions) {
        const pool = rankedPools.find(p => p.address === pos.poolAddress);

        if (!pool) {
            logger.warn(`Active pool ${pos.poolAddress} not found in ranked list. Skipping exit check this cycle.`);
            remainingPositions.push(pos);
            continue;
        }

        const holdTime = now - pos.entryTime;

        if (pool.score > pos.peakScore) {
            pos.peakScore = pool.score;
        }

        // ═══════════════════════════════════════════════════════════════════
        // MICROSTRUCTURE EXIT CHECK
        // ═══════════════════════════════════════════════════════════════════
        const exitSignal = evaluatePositionExit(pos.poolAddress);
        
        if (exitSignal?.shouldExit) {
            if (PAPER_TRADING) {
                const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
                // Estimate fees based on microstructure
                const metrics = pool.microMetrics;
                const estimatedFees = metrics ? (metrics.rawFeesGenerated * pos.amount / 1000) : 0;
                paperTradingPnL += estimatedFees;
                paperTradingBalance += estimatedFees;
                await savePaperTradingState(paperTradingBalance, paperTradingPnL);

                logger.warn(`[MICRO-EXIT] ${pool.name} - ${exitSignal.reason}`);
                logger.info(`[PAPER] P&L: ${estimatedFees >= 0 ? '+' : ''}$${estimatedFees.toFixed(2)} | Total: $${paperTradingPnL.toFixed(2)}`);
            }

            await logAction('EXIT', {
                pool: pool.address,
                reason: `MICROSTRUCTURE: ${exitSignal.reason}`,
                binOffset: exitSignal.binOffset,
                feeIntensityDrop: exitSignal.feeIntensityDrop,
                currentSwapVelocity: exitSignal.currentSwapVelocity,
                paperTrading: PAPER_TRADING,
                paperPnL: PAPER_TRADING ? paperTradingPnL : undefined,
            });
            exitSignalCount++;
            continue;
        }

        // Check rebalance
        if (exitSignal?.shouldRebalance) {
            logger.info(`[REBALANCE] ${pool.name} - bin offset ${exitSignal.binOffset} >= 2`);
            // In paper mode, just log. Real mode would adjust position.
        }

        // Min hold time check
        const bypassMinHold = pos.entryScore < 55;
        if (holdTime < MIN_HOLD_TIME_MS && !bypassMinHold) {
            remainingPositions.push(pos);
            continue;
        }

        // ═══════════════════════════════════════════════════════════════════
        // EMERGENCY EXIT (severe score/liquidity collapse)
        // ═══════════════════════════════════════════════════════════════════
        const scoreCrash = pos.entryScore > 0 ? (pos.entryScore - pool.score) / pos.entryScore : 0;
        const emergencyExit = pool.score < 15 || scoreCrash > 0.50;

        if (emergencyExit) {
            const reason = pool.score < 15 ? 'Emergency: Score Below 15' : 'Emergency: Score Crash (-50%)';

            if (PAPER_TRADING) {
                const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
                const metrics = pool.microMetrics;
                const estimatedFees = metrics ? (metrics.rawFeesGenerated * pos.amount / 1000) : 0;
                paperTradingPnL += estimatedFees;
                paperTradingBalance += estimatedFees;
                await savePaperTradingState(paperTradingBalance, paperTradingPnL);

                logger.warn(`[PAPER] ${reason} - Exiting ${pool.name} immediately`);
            }

            await logAction('EXIT', {
                pool: pool.address,
                reason,
                emergencyExit: true,
                holdTimeMinutes: (now - pos.entryTime) / (1000 * 60),
                currentScore: pool.score,
                paperTrading: PAPER_TRADING,
                paperPnL: PAPER_TRADING ? paperTradingPnL : undefined,
            });
            exitSignalCount++;
            continue;
        }

        // Position still valid
        remainingPositions.push(pos);
    }

    // Market crash detection
    if (exitSignalCount >= 3 && activePositions.length >= 3) {
        logger.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit. Exiting ALL positions.`);
        activePositions = [];
        await logAction('MARKET_CRASH_EXIT', { exitSignalCount });
        return;
    }

    activePositions = remainingPositions;

    // 2. Check Entries with Microstructure Gating
    const totalCapital = PAPER_TRADING ? paperTradingBalance : parseFloat(process.env.TOTAL_CAPITAL || '10000');
    const deployedCapital = activePositions.reduce((sum, p) => sum + p.amount, 0);
    let availableCapital = totalCapital - deployedCapital;
    if (availableCapital < 0) availableCapital = 0;

    const startingCapital = parseFloat(process.env.PAPER_CAPITAL || '10000');
    const validCandidates: { pool: MicrostructureEnrichedPool; type: TokenType }[] = [];

    const typeCount = {
        'stable': activePositions.filter(p => p.tokenType === 'stable').length,
        'blue-chip': activePositions.filter(p => p.tokenType === 'blue-chip').length,
        'meme': activePositions.filter(p => p.tokenType === 'meme').length,
    };

    const PRIORITY_THRESHOLD = 40;
    const CANDIDATE_THRESHOLD = 24;

    for (const candidate of rankedPools) {
        if (activePositions.length + validCandidates.length >= 5) break;
        if (activePositions.find(p => p.poolAddress === candidate.address)) continue;

        // ═══════════════════════════════════════════════════════════════════
        // CRITICAL: Skip pools without valid telemetry
        // ═══════════════════════════════════════════════════════════════════
        if (!candidate.hasValidTelemetry) {
            logger.debug(`[GATING] Skipping ${candidate.name} - no valid telemetry`);
            continue;
        }

        // ═══════════════════════════════════════════════════════════════════
        // CRITICAL: Skip pools where market is not alive
        // ═══════════════════════════════════════════════════════════════════
        if (!candidate.isMarketAlive) {
            const gating = getEntryGatingStatus(candidate);
            logger.info(`[GATING] ${candidate.name} - market dormant:`);
            if (!gating.binVelocity.passes) {
                logger.info(`   → binVelocity ${gating.binVelocity.value.toFixed(4)} < ${gating.binVelocity.required}`);
            }
            if (!gating.swapVelocity.passes) {
                logger.info(`   → swapVelocity ${gating.swapVelocity.value.toFixed(4)} < ${gating.swapVelocity.required}`);
            }
            if (!gating.poolEntropy.passes) {
                logger.info(`   → poolEntropy ${gating.poolEntropy.value.toFixed(4)} < ${gating.poolEntropy.required}`);
            }
            if (!gating.liquidityFlow.passes) {
                logger.info(`   → liquidityFlow ${(gating.liquidityFlow.value * 100).toFixed(4)}% < ${gating.liquidityFlow.required * 100}%`);
            }
            continue;
        }

        const candidateType = categorizeToken(candidate);
        const activePools = activePositions.map(pos => 
            rankedPools.find(p => p.address === pos.poolAddress)
        ).filter((p): p is MicrostructureEnrichedPool => p !== undefined);

        if (isDuplicatePair(candidate, activePools)) {
            logger.info(`Skipping ${candidate.name} - duplicate token pair`);
            continue;
        }

        // Score thresholds using microstructure score
        if (candidate.microScore < CANDIDATE_THRESHOLD) {
            logger.info(`Skipping ${candidate.name} - microScore ${candidate.microScore.toFixed(1)} below threshold ${CANDIDATE_THRESHOLD}`);
            continue;
        }

        // Add to valid candidates
        validCandidates.push({ pool: candidate, type: candidateType });
        typeCount[candidateType as keyof typeof typeCount]++;
        
        const isPriority = candidate.microScore >= PRIORITY_THRESHOLD;
        logger.info(`${isPriority ? '🚀 [PRIORITY]' : '📈 [CANDIDATE]'} ${candidate.name} (µScore ${candidate.microScore.toFixed(1)}) - market alive, gating passed`);
    }

    // Execute entries
    if (validCandidates.length > 0) {
        const totalScoreSum = validCandidates.reduce((sum, c) => sum + c.pool.microScore, 0);
        logger.info(`Found ${validCandidates.length} valid candidates. Total µScore Sum: ${totalScoreSum.toFixed(2)}`);

        for (const { pool, type } of validCandidates) {
            const weight = pool.microScore / totalScoreSum;
            let amount = availableCapital * weight;

            const volatilityMultiplier = getVolatilityMultiplier(pool);
            amount *= volatilityMultiplier;

            const { getTimeOfDayMultiplier } = require('./utils/timeOfDay');
            const timeMultiplier = getTimeOfDayMultiplier();
            amount *= timeMultiplier;

            if (pool.liquidity < 100000) {
                amount *= 0.5;
            }

            const maxAllowed = pool.liquidity * 0.05;
            if (amount > maxAllowed) {
                amount = maxAllowed;
            }

            if (availableCapital < amount) {
                amount = availableCapital;
            }

            if (amount < 10) {
                logger.info(`⏭️  Skipping ${pool.name}: Allocation too small ($${amount.toFixed(2)})`);
                continue;
            }

            availableCapital -= amount;
            if (availableCapital < 0) availableCapital = 0;

            const totalDeployed = activePositions.reduce((sum, p) => sum + p.amount, 0) + amount;
            const deploymentPct = (totalDeployed / totalCapital) * 100;

            if (deploymentPct > 100) {
                continue;
            }

            if (hasActiveTrade(pool.address)) {
                logger.warn(`⚠️ Already have open trade on ${pool.name}`);
                continue;
            }

            const sizingMode = getSizingMode(pool.microScore >= PRIORITY_THRESHOLD);
            const tradeResult = await enterPosition(pool as any, sizingMode, availableCapital, startingCapital);

            if (tradeResult.success && tradeResult.trade) {
                const tradeSize = tradeResult.trade.size;
                const currentBin = pool.microMetrics?.rawBinDelta ?? 0;

                activePositions.push({
                    poolAddress: pool.address,
                    entryTime: now,
                    entryScore: pool.microScore,
                    entryPrice: pool.currentPrice,
                    peakScore: pool.microScore,
                    amount: tradeSize,
                    entryTVL: pool.liquidity,
                    entryVelocity: pool.velocity,
                    consecutiveCycles: 1,
                    consecutiveLowVolumeCycles: 0,
                    tokenType: type,
                });

                // Register for microstructure monitoring
                const history = getPoolHistory(pool.address);
                const latestState = history.length > 0 ? history[history.length - 1] : null;
                if (latestState) {
                    registerPosition({
                        poolId: pool.address,
                        entryBin: latestState.activeBin,
                        entryTime: now,
                        entryFeeIntensity: pool.microMetrics?.feeIntensity ?? 0,
                        entrySwapVelocity: pool.microMetrics?.swapVelocity ?? 0,
                        entry3mFeeIntensity: pool.microMetrics?.feeIntensity ?? 0,
                        entry3mSwapVelocity: pool.microMetrics?.swapVelocity ?? 0,
                    });
                }

                await logAction('ENTRY', {
                    pool: pool.address,
                    poolName: pool.name,
                    score: pool.microScore,
                    amount: tradeSize,
                    type: type,
                    entryBin: latestState?.activeBin ?? 0,
                    microMetrics: {
                        binVelocity: pool.microMetrics?.binVelocity ?? 0,
                        liquidityFlow: pool.microMetrics?.liquidityFlow ?? 0,
                        swapVelocity: pool.microMetrics?.swapVelocity ?? 0,
                        feeIntensity: pool.microMetrics?.feeIntensity ?? 0,
                        poolEntropy: pool.microMetrics?.poolEntropy ?? 0,
                    },
                    sizingMode: sizingMode,
                    tradeId: tradeResult.trade.id,
                    paperTrading: PAPER_TRADING,
                    paperBalance: PAPER_TRADING ? paperTradingBalance : undefined,
                });
            } else {
                logger.warn(`⚠️ Trade execution failed for ${pool.name}: ${tradeResult.reason}`);
            }
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN CYCLE (runs continuously)
// ═══════════════════════════════════════════════════════════════════════════════

async function scanCycle(): Promise<void> {
    logger.warn('[TRACE] scanCycle CALLED');
    const startTime = Date.now();

    try {
        logger.info('--- Starting Scan Cycle (Microstructure Mode) ---');

        // Discovery parameters
        const discoveryParams = {
            minTVL: 250000,
            minVolume24h: 150000,
            minTraders24h: 300,
            maxPools: 30,
        };

        const cacheStatus = getCacheStatus();
        if (cacheStatus.cached) {
            logger.info(`📦 [UNIVERSE] Using cached universe (${cacheStatus.poolCount} pools, age: ${Math.round(cacheStatus.age / 1000)}s)`);
        }

        // DISCOVERY: Hard try/catch - NO throw, NO exit, NO restart
        logger.warn('[TRACE] DISCOVERY CALL START');
        let poolUniverse: EnrichedPool[] = [];
        try {
            poolUniverse = await discoverDLMMUniverses(discoveryParams);
        } catch (discoveryError: any) {
            logger.error('[DISCOVERY] Fetch failed:', {
                error: discoveryError?.message || discoveryError,
                params: discoveryParams,
            });
            return; // soft fail, wait for next interval
        }

        // Validate return shape
        if (!Array.isArray(poolUniverse) || poolUniverse.length === 0) {
            logger.warn('[DISCOVERY] No pools returned. Sleeping + retry next cycle.');
            return;
        }

        logger.info(`[DISCOVERY] ✅ Fetched ${poolUniverse.length} pools`);

        // Convert to Pool format
        const pools: Pool[] = poolUniverse.map(ep => enrichedPoolToPool(ep) as Pool);
        const activeAddresses = new Set(activePositions.map(p => p.poolAddress));

        let enrichedCandidates = pools;

        // Add missing active pools
        const missingActivePools: Pool[] = [];
        for (const pos of activePositions) {
            const inUniverse = enrichedCandidates.find(p => p.address === pos.poolAddress);
            if (!inUniverse) {
                logger.info(`📍 Adding active position ${pos.poolAddress} to monitoring`);
                missingActivePools.push({
                    address: pos.poolAddress,
                    name: 'Active Position',
                    tokenX: '', tokenY: '', mintX: '', mintY: '',
                    liquidity: 0, volume24h: 0, volume1h: 0, volume4h: 0,
                    velocity: 0, fees24h: 0, apr: 0, binStep: 0, baseFee: 0, binCount: 0,
                    createdAt: 0, holderCount: 0, topHolderPercent: 0, isRenounced: true,
                    riskScore: 0, dilutionScore: 0, score: 0, currentPrice: 0,
                } as Pool);
            }
        }

        if (missingActivePools.length > 0) {
            enrichedCandidates = [...enrichedCandidates, ...missingActivePools];
        }

        logger.info(`📊 Processing ${enrichedCandidates.length} pools`);

        // ═══════════════════════════════════════════════════════════════════════
        // MICROSTRUCTURE SCORING (replaces 24h metrics)
        // ═══════════════════════════════════════════════════════════════════════
        
        // Refresh telemetry for all pools
        await refreshTelemetry();
        
        // Score using microstructure metrics
        const microEnrichedPools = batchScorePools(enrichedCandidates);
        
        // Log telemetry stats
        const validCount = microEnrichedPools.filter(p => p.hasValidTelemetry).length;
        const aliveCount = microEnrichedPools.filter(p => p.isMarketAlive).length;
        logger.info(`📊 Telemetry: ${validCount}/${microEnrichedPools.length} valid, ${aliveCount} markets alive`);

        // Log top pools with microstructure metrics
        const topPools = microEnrichedPools.slice(0, 5);
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('TOP 5 POOLS (Microstructure Ranked):');
        for (const pool of topPools) {
            if (pool.microMetrics) {
                logMicrostructureMetrics(pool.microMetrics);
            } else {
                logger.info(`  ${pool.name} - µScore: ${pool.microScore.toFixed(1)} (no telemetry)`);
            }
        }
        logger.info('═══════════════════════════════════════════════════════════════');

        // Kill switch check
        const allMetrics = microEnrichedPools
            .filter(p => p.microMetrics)
            .map(p => ({
                poolId: p.address,
                score: p.microScore,
                isAlive: p.isMarketAlive,
            }));

        const aliveRatio = aliveCount / Math.max(validCount, 1);
        if (aliveRatio < 0.1 && validCount > 5) {
            logger.error(`🚨 KILL SWITCH: Only ${(aliveRatio * 100).toFixed(1)}% of markets alive`);
            logger.error('🚨 Liquidating all positions and pausing trading for 10 minutes');

            for (const pos of activePositions) {
                await logAction('EXIT', {
                    pool: pos.poolAddress,
                    reason: 'KILL SWITCH: Market-wide dormancy',
                    emergencyExit: true,
                    paperTrading: PAPER_TRADING,
                    paperPnL: PAPER_TRADING ? paperTradingPnL : undefined,
                });
            }

            activePositions = [];
            killSwitchPauseUntil = Date.now() + (10 * 60 * 1000);

            await logAction('KILL_SWITCH', {
                reason: 'Market-wide dormancy',
                aliveRatio,
                positionsLiquidated: activePositions.length,
                pauseUntil: new Date(killSwitchPauseUntil).toISOString(),
            });

            const duration = Date.now() - startTime;
            logger.info(`Cycle completed in ${duration}ms. Sleeping...`);
            return;
        }

        // Check kill switch pause
        if (killSwitchPauseUntil > Date.now()) {
            const remainingSeconds = Math.ceil((killSwitchPauseUntil - Date.now()) / 1000);
            logger.warn(`⏸️  Trading paused by kill switch. Resuming in ${remainingSeconds}s`);
            return;
        }

        // Sort and deduplicate
        const sortedPools = microEnrichedPools.sort((a, b) => b.microScore - a.microScore);
        const deduplicatedPools = deduplicatePools(sortedPools) as MicrostructureEnrichedPool[];
        logger.info(`Deduplicated ${sortedPools.length} pools to ${deduplicatedPools.length} unique pairs`);

        // ExecutionEngine: Evaluate universe for paper trading positions
        if (deduplicatedPools.length === 0) {
            logger.info('[EXEC] No pools available, sleeping...');
            return;
        }

        // Convert to ScoredPool format for engine (with microstructure enrichment)
        const scoredPoolsForEngine: ScoredPool[] = deduplicatedPools.map((p: MicrostructureEnrichedPool) => ({
            address: p.address,
            score: p.microScore,
            liquidityUSD: p.liquidity,
            volume24h: p.volume24h,
            binCount: p.binCount || 1,
            activeBin: (p as any).activeBin || 0,
            tokenA: { symbol: p.name.split('-')[0] || 'TOKEN', decimals: 9 },
            tokenB: { symbol: p.name.split('-')[1] || 'TOKEN', decimals: 9 },
            microMetrics: p.microMetrics || undefined,
            isMarketAlive: p.isMarketAlive,
        }));

        // Find highest scoring pool
        const bestPool = scoredPoolsForEngine.reduce((best, pool) =>
            pool.score > best.score ? pool : best
            , scoredPoolsForEngine[0]);

        logger.info(`[EXEC] Selected pool: ${bestPool.tokenA.symbol}/${bestPool.tokenB.symbol} (µScore: ${bestPool.score.toFixed(2)})`);

        // Check if score meets minimum threshold AND market is alive
        if (bestPool.score >= EXECUTION_MIN_SCORE && bestPool.isMarketAlive) {
            const allocation = executionEngine.getPortfolioStatus().capital / 3;
            logger.info(`[EXEC] Allocating capital: $${allocation.toFixed(2)}`);
            logger.info(`[EXEC] Opening position: ${bestPool.tokenA.symbol}/${bestPool.tokenB.symbol}`);

            // Place pools and update engine state
            executionEngine.placePools(scoredPoolsForEngine);
            executionEngine.update();

            // Store positions in persistent state
            const engineStatus = executionEngine.getPortfolioStatus();
            if (engineStatus.openPositions.length > 0) {
                for (const pos of engineStatus.openPositions) {
                    const existingIdx = enginePositions.findIndex(ep => ep.pool === pos.pool);
                    if (existingIdx >= 0) {
                        enginePositions[existingIdx] = pos;
                    } else {
                        enginePositions.push(pos);
                    }
                }
            }
        } else {
            const reason = bestPool.score < EXECUTION_MIN_SCORE
                ? `score ${bestPool.score.toFixed(2)} < ${EXECUTION_MIN_SCORE}`
                : 'market not alive';
            logger.info(`[EXEC] Best pool skipped: ${reason}`);
            executionEngine.update();
        }

        // Rotation engine
        await manageRotation(microEnrichedPools);

        const duration = Date.now() - startTime;
        logger.info(`Cycle completed in ${duration}ms. Sleeping...`);

        await logAction('HEARTBEAT', {
            duration,
            candidates: microEnrichedPools.length,
            validTelemetry: validCount,
            aliveMarkets: aliveCount,
            paperTrading: PAPER_TRADING,
            paperBalance: PAPER_TRADING ? paperTradingBalance : undefined,
        });

    } catch (error) {
        logger.error('❌ Error in scan cycle:', error);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

let isScanning = false;

async function runScanCycle(): Promise<void> {
    if (isScanning) {
        logger.warn('⏳ Previous scan still running, skipping this interval');
        return;
    }

    isScanning = true;
    try {
        await scanCycle();
    } catch (error) {
        logger.error('❌ Unhandled error in scan cycle:', error);
    } finally {
        isScanning = false;
    }
}

async function main(): Promise<void> {
    // STEP 1: Initialize ONCE
    await initializeBot();

    // STEP 2: Run first scan immediately
    await runScanCycle();

    // STEP 3: Schedule recurring scans via setInterval (NO while loop)
    setInterval(runScanCycle, LOOP_INTERVAL_MS);

    logger.info(`🔄 Scan loop started. Interval: ${LOOP_INTERVAL_MS / 1000}s`);
    logger.info('🧬 Using MICROSTRUCTURE-BASED SCORING (no 24h/TVL metrics)');
}

// Cleanup on exit
process.on('SIGINT', () => {
    logger.info('Shutting down...');
    cleanupTelemetry();
    if (telemetryRefreshTimer) {
        clearInterval(telemetryRefreshTimer);
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    cleanupTelemetry();
    if (telemetryRefreshTimer) {
        clearInterval(telemetryRefreshTimer);
    }
    process.exit(0);
});

// Start the bot
main().catch(console.error);
