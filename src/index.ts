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
// NEW: Microstructure Telemetry Imports (SDK-based)
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
    fetchBatchTelemetry,
    fetchPoolTelemetry,
    DLMMState,
    DLMMTelemetry,
    MicrostructureMetrics,
    BinFocusedPosition,
    cleanup as cleanupTelemetry,
} from './services/dlmmTelemetry';

import {
    scoreMicrostructure,
    enrichPoolWithTier4,
    batchScorePools,
    filterValidPools,
    passesEntryGating,
    getEntryGatingStatus,
    Tier4EnrichedPool,
    logTier4Cycle,
} from './scoring/microstructureScoring';

import { discoverDLMMUniverses, enrichedPoolToPool, EnrichedPool, getCacheStatus } from './services/dlmmIndexer';
import { evaluateEntry, evaluateTransitionGate, TransitionGateResult } from './core/structuralEntry';
import { enterPosition, getSizingMode, hasActiveTrade, exitPosition } from './core/trading';
import { evaluateExit } from './core/structuralExit';
import { evaluateKill } from './core/killSwitch';
import { BOT_CONFIG } from './config/constants';
import { ExecutionEngine, ScoredPool, Position } from './engine/ExecutionEngine';
import { capitalManager } from './services/capitalManager';
import { loadActiveTradesFromDB, getAllActiveTrades } from './db/models/Trade';
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
// TELEMETRY REFRESH (SDK-based - runs during scan cycle)
// ═══════════════════════════════════════════════════════════════════════════════

// Store pool addresses for telemetry refresh
let trackedPoolAddresses: string[] = [];

/**
 * Refresh telemetry for tracked pools using Meteora DLMM SDK
 */
async function refreshTelemetry(): Promise<void> {
    if (trackedPoolAddresses.length === 0) {
        logger.debug('[TELEMETRY] No pools to refresh');
        return;
    }
    
    try {
        // Fetch telemetry using SDK with batch processing + retry
        const telemetryArray = await fetchBatchTelemetry(trackedPoolAddresses);
        
        // Record snapshots for each pool
        for (const telemetry of telemetryArray) {
            recordSnapshot(telemetry);
        }
        
        logger.debug(`[TELEMETRY] Refreshed ${telemetryArray.length}/${trackedPoolAddresses.length} pools via SDK`);
        
    } catch (error) {
        logger.error('[TELEMETRY] SDK refresh failed:', error);
    }
}

/**
 * Update tracked pool addresses
 */
function updateTrackedPools(addresses: string[]): void {
    trackedPoolAddresses = addresses;
}

// Note: Telemetry refresh is now done during scan cycle using SDK
// No interval timer needed - we fetch on-chain state directly during each scan

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
    logger.info('[INIT] 🧬 Using METEORA DLMM SDK for on-chain telemetry');
    logger.info('[INIT] 📊 Microstructure scoring (no 24h metrics)');
    logger.info('[INIT] 💾 PERSISTENT CAPITAL MANAGEMENT ENABLED');

    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL: Initialize Capital Manager FIRST
    // ═══════════════════════════════════════════════════════════════════════════
    logger.info('[INIT] 💰 Initializing capital manager...');
    const capitalReady = await capitalManager.initialize(PAPER_CAPITAL);
    
    if (!capitalReady) {
        logger.error('[INIT] ❌ FATAL: Capital manager initialization failed');
        logger.error('[INIT] ❌ Please ensure database is available and run SQL migrations');
        logger.error('[INIT] ❌ See supabase/capital_tables.sql for required tables');
        process.exit(1);
    }

    // Get current capital state
    const capitalState = await capitalManager.getFullState();
    if (capitalState) {
        logger.info(`[INIT] 💰 Capital State:`);
        logger.info(`[INIT]    Available: $${capitalState.available_balance.toFixed(2)}`);
        logger.info(`[INIT]    Locked: $${capitalState.locked_balance.toFixed(2)}`);
        logger.info(`[INIT]    Total P&L: $${capitalState.total_realized_pnl.toFixed(2)}`);
    }

    // Initialize execution engine (which also recovers active trades)
    const engineReady = await executionEngine.initialize();
    if (!engineReady) {
        logger.error('[INIT] ❌ Execution engine initialization failed');
        process.exit(1);
    }

    // Note: SDK-based telemetry is fetched during each scan cycle
    // No WebSocket needed - we fetch on-chain state directly
    initializeSwapStream(); // Logs that SDK is being used

    // Load active trades from database into local state
    const activeTrades = await loadActiveTradesFromDB();
    for (const trade of activeTrades) {
        activePositions.push({
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
            tokenType: 'meme', // Default to meme when loading from DB
            entryBin: trade.entryBin || 0,
        });
    }

    logger.info(`[INIT] ✅ Recovered ${activePositions.length} active positions from database`);

    if (PAPER_TRADING) {
        logger.info('[INIT] 🎮 PAPER TRADING MODE');
    } else {
        logger.info('[INIT] ⚠️  LIVE TRADING MODE - Real money at risk!');
    }

    logger.info('[INIT] ✅ Initialization complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROTATION MANAGER (entry/exit logic)
// ═══════════════════════════════════════════════════════════════════════════════

const manageRotation = async (rankedPools: Tier4EnrichedPool[]) => {
    const now = Date.now();
    const remainingPositions: ActivePosition[] = [];
    let exitSignalCount = 0;

    // Get current capital from database
    let currentBalance: number;
    try {
        currentBalance = await capitalManager.getBalance();
    } catch (err: any) {
        logger.error(`[ROTATION] Failed to get capital: ${err.message}`);
        return;
    }

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
            // Find trade ID for this position
            const activeTrades = getAllActiveTrades();
            const trade = activeTrades.find(t => t.pool === pos.poolAddress);
            
            if (trade) {
                const exitResult = await exitPosition(trade.id, {
                    exitPrice: pool.currentPrice,
                    reason: `MICROSTRUCTURE: ${exitSignal.reason}`,
                });
                
                if (exitResult.success) {
                    logger.warn(`[MICRO-EXIT] ${pool.name} - ${exitSignal.reason}`);
                    logger.info(`[EXIT] P&L: ${(exitResult.pnl ?? 0) >= 0 ? '+' : ''}$${(exitResult.pnl ?? 0).toFixed(2)}`);
                }
            }

            await logAction('EXIT', {
                pool: pool.address,
                reason: `MICROSTRUCTURE: ${exitSignal.reason}`,
                binOffset: exitSignal.binOffset,
                feeIntensityDrop: exitSignal.feeIntensityDrop,
                currentSwapVelocity: exitSignal.currentSwapVelocity,
                paperTrading: PAPER_TRADING,
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

            // Find trade ID for this position
            const activeTrades = getAllActiveTrades();
            const trade = activeTrades.find(t => t.pool === pos.poolAddress);
            
            if (trade) {
                const exitResult = await exitPosition(trade.id, {
                    exitPrice: pool.currentPrice,
                    reason,
                });
                
                if (exitResult.success) {
                    logger.warn(`[EMERGENCY] ${pool.name} - ${reason}`);
                    logger.info(`[EXIT] P&L: ${(exitResult.pnl ?? 0) >= 0 ? '+' : ''}$${(exitResult.pnl ?? 0).toFixed(2)}`);
                }
            }

            await logAction('EXIT', {
                pool: pool.address,
                reason,
                emergencyExit: true,
                holdTimeMinutes: (now - pos.entryTime) / (1000 * 60),
                currentScore: pool.score,
                paperTrading: PAPER_TRADING,
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
        
        // Exit all remaining positions
        for (const pos of remainingPositions) {
            const activeTrades = getAllActiveTrades();
            const trade = activeTrades.find(t => t.pool === pos.poolAddress);
            if (trade) {
                await exitPosition(trade.id, {
                    exitPrice: 0, // Will use current price
                    reason: 'MARKET_CRASH_EXIT',
                });
            }
        }
        
        activePositions = [];
        await logAction('MARKET_CRASH_EXIT', { exitSignalCount });
        return;
    }

    activePositions = remainingPositions;

    // 2. Check Entries with Microstructure Gating
    const totalEquity = await capitalManager.getEquity();
    const deployedCapital = activePositions.reduce((sum, p) => sum + p.amount, 0);
    let availableCapital = currentBalance;
    if (availableCapital < 0) availableCapital = 0;

    const validCandidates: { pool: Tier4EnrichedPool; type: TokenType }[] = [];

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
        // TIER 4: Skip pools that fail Tier 4 gating
        // ═══════════════════════════════════════════════════════════════════
        if (!candidate.isMarketAlive) {
            const gating = getEntryGatingStatus(candidate);
            logger.info(`[GATING] ${candidate.name} - Tier 4 gating failed:`);
            if (!gating.tier4Score.passes) {
                logger.info(`   → tier4Score ${gating.tier4Score.value.toFixed(1)} < ${gating.tier4Score.required} (${gating.regime.value})`);
            }
            if (!gating.snapshotCount.passes) {
                logger.info(`   → snapshotCount ${gating.snapshotCount.value} < ${gating.snapshotCount.required}`);
            }
            if (!gating.liquidityUSD.passes) {
                logger.info(`   → liquidityUSD ${gating.liquidityUSD.value.toFixed(2)} <= ${gating.liquidityUSD.required}`);
            }
            if (gating.migration.blocked) {
                logger.info(`   → migration BLOCKED: ${gating.migration.reason}`);
            }
            continue;
        }

        const candidateType = categorizeToken(candidate);
        const activePools = activePositions.map(pos => 
            rankedPools.find(p => p.address === pos.poolAddress)
        ).filter((p): p is Tier4EnrichedPool => p !== undefined);

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
            const deploymentPct = (totalDeployed / totalEquity) * 100;

            if (deploymentPct > 100) {
                continue;
            }

            if (hasActiveTrade(pool.address)) {
                logger.warn(`⚠️ Already have open trade on ${pool.name}`);
                continue;
            }

            const sizingMode = getSizingMode(pool.microScore >= PRIORITY_THRESHOLD);
            
            // ═══════════════════════════════════════════════════════════════════
            // ENTER POSITION - Uses capital manager internally
            // If DB insert fails → trade is aborted (no graceful degradation)
            // ═══════════════════════════════════════════════════════════════════
            const tradeResult = await enterPosition(pool as any, sizingMode, availableCapital, totalEquity);

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

        // Get current capital from database
        let currentBalance: number;
        try {
            currentBalance = await capitalManager.getBalance();
            logger.info(`[CAPITAL] Available: $${currentBalance.toFixed(2)}`);
        } catch (err: any) {
            logger.error(`[CAPITAL] Failed to get balance: ${err.message}`);
            logger.error('[CAPITAL] Cannot proceed without capital - sleeping...');
            return;
        }

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
        // MICROSTRUCTURE SCORING (SDK-based - replaces 24h metrics)
        // ═══════════════════════════════════════════════════════════════════════
        
        // Extract pool addresses for SDK telemetry
        const poolAddresses = enrichedCandidates.map(p => p.address);
        updateTrackedPools(poolAddresses);
        
        // Fetch on-chain telemetry using Meteora DLMM SDK
        logger.info(`[DLMM-SDK] Fetching on-chain state for ${poolAddresses.length} pools...`);
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
                const activeTrades = getAllActiveTrades();
                const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                if (trade) {
                    await exitPosition(trade.id, {
                        exitPrice: 0,
                        reason: 'KILL SWITCH: Market-wide dormancy',
                    });
                }
                
                await logAction('EXIT', {
                    pool: pos.poolAddress,
                    reason: 'KILL SWITCH: Market-wide dormancy',
                    emergencyExit: true,
                    paperTrading: PAPER_TRADING,
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
        const deduplicatedPools = deduplicatePools(sortedPools) as Tier4EnrichedPool[];
        logger.info(`Deduplicated ${sortedPools.length} pools to ${deduplicatedPools.length} unique pairs`);

        // ExecutionEngine: Evaluate universe for paper trading positions
        if (deduplicatedPools.length === 0) {
            logger.info('[EXEC] No pools available, sleeping...');
            return;
        }

        // Convert to ScoredPool format for engine (with microstructure enrichment)
        const scoredPoolsForEngine: ScoredPool[] = deduplicatedPools.map((p: Tier4EnrichedPool) => ({
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
            const portfolioStatus = await executionEngine.getPortfolioStatus();
            const allocation = portfolioStatus.capital / 3;
            logger.info(`[EXEC] Allocating capital: $${allocation.toFixed(2)}`);
            logger.info(`[EXEC] Opening position: ${bestPool.tokenA.symbol}/${bestPool.tokenB.symbol}`);

            // Place pools and update engine state
            await executionEngine.placePools(scoredPoolsForEngine);
            await executionEngine.update();

            // Store positions in persistent state
            const engineStatus = await executionEngine.getPortfolioStatus();
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
            await executionEngine.update();
        }

        // Rotation engine
        await manageRotation(microEnrichedPools);

        const duration = Date.now() - startTime;
        
        // Log current capital state
        const capitalState = await capitalManager.getFullState();
        
        logger.info(`Cycle completed in ${duration}ms. Sleeping...`);
        logger.info(`💰 Capital: Available=$${capitalState?.available_balance.toFixed(2) || 0} | Locked=$${capitalState?.locked_balance.toFixed(2) || 0} | P&L=$${capitalState?.total_realized_pnl.toFixed(2) || 0}`);

        await logAction('HEARTBEAT', {
            duration,
            candidates: microEnrichedPools.length,
            validTelemetry: validCount,
            aliveMarkets: aliveCount,
            paperTrading: PAPER_TRADING,
            capital: {
                available: capitalState?.available_balance || 0,
                locked: capitalState?.locked_balance || 0,
                totalPnL: capitalState?.total_realized_pnl || 0,
            },
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
    logger.info('💾 PERSISTENT CAPITAL MANAGEMENT ENABLED');
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
