"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const state_1 = require("./utils/state");
const supabase_1 = require("./db/supabase");
const logger_1 = __importDefault(require("./utils/logger"));
const volatility_1 = require("./utils/volatility");
const arbitrage_1 = require("./utils/arbitrage");
// ═══════════════════════════════════════════════════════════════════════════════
// NEW: Microstructure Telemetry Imports (SDK-based)
// ═══════════════════════════════════════════════════════════════════════════════
const dlmmTelemetry_1 = require("./services/dlmmTelemetry");
const microstructureScoring_1 = require("./scoring/microstructureScoring");
const dlmmIndexer_1 = require("./services/dlmmIndexer");
const trading_1 = require("./core/trading");
const ExecutionEngine_1 = require("./engine/ExecutionEngine");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
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
let activePositions = [];
// Kill switch state
let killSwitchPauseUntil = 0;
// Telemetry refresh timer
let telemetryRefreshTimer = null;
// Execution Engine (paper trading)
const executionEngine = new ExecutionEngine_1.ExecutionEngine({
    capital: PAPER_CAPITAL,
    rebalanceInterval: 15 * 60 * 1000,
    takeProfit: 0.04,
    stopLoss: -0.02,
    maxConcurrentPools: 3,
    allocationStrategy: 'equal',
});
const enginePositions = [];
// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
const categorizeToken = (pool) => {
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
let trackedPoolAddresses = [];
/**
 * Refresh telemetry for tracked pools using Meteora DLMM SDK
 */
async function refreshTelemetry() {
    if (trackedPoolAddresses.length === 0) {
        logger_1.default.debug('[TELEMETRY] No pools to refresh');
        return;
    }
    try {
        // Fetch telemetry using SDK with batch processing + retry
        const telemetryArray = await (0, dlmmTelemetry_1.fetchBatchTelemetry)(trackedPoolAddresses);
        // Record snapshots for each pool
        for (const telemetry of telemetryArray) {
            (0, dlmmTelemetry_1.recordSnapshot)(telemetry);
        }
        logger_1.default.debug(`[TELEMETRY] Refreshed ${telemetryArray.length}/${trackedPoolAddresses.length} pools via SDK`);
    }
    catch (error) {
        logger_1.default.error('[TELEMETRY] SDK refresh failed:', error);
    }
}
/**
 * Update tracked pool addresses
 */
function updateTrackedPools(addresses) {
    trackedPoolAddresses = addresses;
}
// Note: Telemetry refresh is now done during scan cycle using SDK
// No interval timer needed - we fetch on-chain state directly during each scan
// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION (runs ONCE on startup)
// ═══════════════════════════════════════════════════════════════════════════════
async function initializeBot() {
    if (BOT_INITIALIZED) {
        logger_1.default.debug('[INIT] initializeBot skipped — already initialized');
        return;
    }
    BOT_INITIALIZED = true;
    logger_1.default.info('[INIT] 🚀 INITIALIZING BOT...');
    logger_1.default.info('[INIT] 🧬 Using METEORA DLMM SDK for on-chain telemetry');
    logger_1.default.info('[INIT] 📊 Microstructure scoring (no 24h metrics)');
    // Note: SDK-based telemetry is fetched during each scan cycle
    // No WebSocket needed - we fetch on-chain state directly
    (0, dlmmTelemetry_1.initializeSwapStream)(); // Logs that SDK is being used
    // PAPER MODE: Simple clean start - no complex state sync that causes boot loops
    if (PAPER_TRADING) {
        logger_1.default.info('[INIT] 🎮 PAPER TRADING MODE');
        // Always start clean in paper mode to avoid boot loops from state mismatch
        paperTradingBalance = PAPER_CAPITAL;
        paperTradingPnL = 0;
        activePositions = [];
        await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
        logger_1.default.info(`[INIT] 💰 Starting balance: $${paperTradingBalance.toFixed(2)}`);
        logger_1.default.info('[INIT] 📊 Positions cleared - fresh start');
    }
    else {
        // LIVE MODE: Full state recovery
        logger_1.default.info('[INIT] ⚠️  LIVE TRADING MODE - Real money at risk!');
        const { supabase } = await Promise.resolve().then(() => __importStar(require('./db/supabase')));
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
                    const pool = log.details?.pool;
                    const amount = log.details?.amount;
                    const score = log.details?.score;
                    const type = log.details?.type;
                    const entryBin = log.details?.entryBin || 0;
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
                }
                else if (log.action === 'EXIT') {
                    const pool = log.details?.pool;
                    if (pool)
                        exitedPools.add(pool);
                }
            }
            for (const pool of exitedPools) {
                entryMap.delete(pool);
            }
            activePositions = Array.from(entryMap.values());
            logger_1.default.info(`[INIT] ✅ Recovered ${activePositions.length} active positions`);
        }
    }
    logger_1.default.info('[INIT] ✅ Initialization complete');
}
// ═══════════════════════════════════════════════════════════════════════════════
// ROTATION MANAGER (entry/exit logic)
// ═══════════════════════════════════════════════════════════════════════════════
const manageRotation = async (rankedPools) => {
    const now = Date.now();
    const remainingPositions = [];
    let exitSignalCount = 0;
    // 1. Check Exits with Microstructure Triggers
    for (const pos of activePositions) {
        const pool = rankedPools.find(p => p.address === pos.poolAddress);
        if (!pool) {
            logger_1.default.warn(`Active pool ${pos.poolAddress} not found in ranked list. Skipping exit check this cycle.`);
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
        const exitSignal = (0, dlmmTelemetry_1.evaluatePositionExit)(pos.poolAddress);
        if (exitSignal?.shouldExit) {
            if (PAPER_TRADING) {
                const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
                // Estimate fees based on microstructure
                const metrics = pool.microMetrics;
                const estimatedFees = metrics ? (metrics.rawFeesGenerated * pos.amount / 1000) : 0;
                paperTradingPnL += estimatedFees;
                paperTradingBalance += estimatedFees;
                await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
                logger_1.default.warn(`[MICRO-EXIT] ${pool.name} - ${exitSignal.reason}`);
                logger_1.default.info(`[PAPER] P&L: ${estimatedFees >= 0 ? '+' : ''}$${estimatedFees.toFixed(2)} | Total: $${paperTradingPnL.toFixed(2)}`);
            }
            await (0, supabase_1.logAction)('EXIT', {
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
            logger_1.default.info(`[REBALANCE] ${pool.name} - bin offset ${exitSignal.binOffset} >= 2`);
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
                await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
                logger_1.default.warn(`[PAPER] ${reason} - Exiting ${pool.name} immediately`);
            }
            await (0, supabase_1.logAction)('EXIT', {
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
        logger_1.default.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit. Exiting ALL positions.`);
        activePositions = [];
        await (0, supabase_1.logAction)('MARKET_CRASH_EXIT', { exitSignalCount });
        return;
    }
    activePositions = remainingPositions;
    // 2. Check Entries with Microstructure Gating
    const totalCapital = PAPER_TRADING ? paperTradingBalance : parseFloat(process.env.TOTAL_CAPITAL || '10000');
    const deployedCapital = activePositions.reduce((sum, p) => sum + p.amount, 0);
    let availableCapital = totalCapital - deployedCapital;
    if (availableCapital < 0)
        availableCapital = 0;
    const startingCapital = parseFloat(process.env.PAPER_CAPITAL || '10000');
    const validCandidates = [];
    const typeCount = {
        'stable': activePositions.filter(p => p.tokenType === 'stable').length,
        'blue-chip': activePositions.filter(p => p.tokenType === 'blue-chip').length,
        'meme': activePositions.filter(p => p.tokenType === 'meme').length,
    };
    const PRIORITY_THRESHOLD = 40;
    const CANDIDATE_THRESHOLD = 24;
    for (const candidate of rankedPools) {
        if (activePositions.length + validCandidates.length >= 5)
            break;
        if (activePositions.find(p => p.poolAddress === candidate.address))
            continue;
        // ═══════════════════════════════════════════════════════════════════
        // CRITICAL: Skip pools without valid telemetry
        // ═══════════════════════════════════════════════════════════════════
        if (!candidate.hasValidTelemetry) {
            logger_1.default.debug(`[GATING] Skipping ${candidate.name} - no valid telemetry`);
            continue;
        }
        // ═══════════════════════════════════════════════════════════════════
        // CRITICAL: Skip pools where market is not alive
        // ═══════════════════════════════════════════════════════════════════
        if (!candidate.isMarketAlive) {
            const gating = (0, microstructureScoring_1.getEntryGatingStatus)(candidate);
            logger_1.default.info(`[GATING] ${candidate.name} - market dormant:`);
            if (!gating.binVelocity.passes) {
                logger_1.default.info(`   → binVelocity ${gating.binVelocity.value.toFixed(4)} < ${gating.binVelocity.required}`);
            }
            if (!gating.swapVelocity.passes) {
                logger_1.default.info(`   → swapVelocity ${gating.swapVelocity.value.toFixed(4)} < ${gating.swapVelocity.required}`);
            }
            if (!gating.poolEntropy.passes) {
                logger_1.default.info(`   → poolEntropy ${gating.poolEntropy.value.toFixed(4)} < ${gating.poolEntropy.required}`);
            }
            if (!gating.liquidityFlow.passes) {
                logger_1.default.info(`   → liquidityFlow ${(gating.liquidityFlow.value * 100).toFixed(4)}% < ${gating.liquidityFlow.required * 100}%`);
            }
            continue;
        }
        const candidateType = categorizeToken(candidate);
        const activePools = activePositions.map(pos => rankedPools.find(p => p.address === pos.poolAddress)).filter((p) => p !== undefined);
        if ((0, arbitrage_1.isDuplicatePair)(candidate, activePools)) {
            logger_1.default.info(`Skipping ${candidate.name} - duplicate token pair`);
            continue;
        }
        // Score thresholds using microstructure score
        if (candidate.microScore < CANDIDATE_THRESHOLD) {
            logger_1.default.info(`Skipping ${candidate.name} - microScore ${candidate.microScore.toFixed(1)} below threshold ${CANDIDATE_THRESHOLD}`);
            continue;
        }
        // Add to valid candidates
        validCandidates.push({ pool: candidate, type: candidateType });
        typeCount[candidateType]++;
        const isPriority = candidate.microScore >= PRIORITY_THRESHOLD;
        logger_1.default.info(`${isPriority ? '🚀 [PRIORITY]' : '📈 [CANDIDATE]'} ${candidate.name} (µScore ${candidate.microScore.toFixed(1)}) - market alive, gating passed`);
    }
    // Execute entries
    if (validCandidates.length > 0) {
        const totalScoreSum = validCandidates.reduce((sum, c) => sum + c.pool.microScore, 0);
        logger_1.default.info(`Found ${validCandidates.length} valid candidates. Total µScore Sum: ${totalScoreSum.toFixed(2)}`);
        for (const { pool, type } of validCandidates) {
            const weight = pool.microScore / totalScoreSum;
            let amount = availableCapital * weight;
            const volatilityMultiplier = (0, volatility_1.getVolatilityMultiplier)(pool);
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
                logger_1.default.info(`⏭️  Skipping ${pool.name}: Allocation too small ($${amount.toFixed(2)})`);
                continue;
            }
            availableCapital -= amount;
            if (availableCapital < 0)
                availableCapital = 0;
            const totalDeployed = activePositions.reduce((sum, p) => sum + p.amount, 0) + amount;
            const deploymentPct = (totalDeployed / totalCapital) * 100;
            if (deploymentPct > 100) {
                continue;
            }
            if ((0, trading_1.hasActiveTrade)(pool.address)) {
                logger_1.default.warn(`⚠️ Already have open trade on ${pool.name}`);
                continue;
            }
            const sizingMode = (0, trading_1.getSizingMode)(pool.microScore >= PRIORITY_THRESHOLD);
            const tradeResult = await (0, trading_1.enterPosition)(pool, sizingMode, availableCapital, startingCapital);
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
                const history = (0, dlmmTelemetry_1.getPoolHistory)(pool.address);
                const latestState = history.length > 0 ? history[history.length - 1] : null;
                if (latestState) {
                    (0, dlmmTelemetry_1.registerPosition)({
                        poolId: pool.address,
                        entryBin: latestState.activeBin,
                        entryTime: now,
                        entryFeeIntensity: pool.microMetrics?.feeIntensity ?? 0,
                        entrySwapVelocity: pool.microMetrics?.swapVelocity ?? 0,
                        entry3mFeeIntensity: pool.microMetrics?.feeIntensity ?? 0,
                        entry3mSwapVelocity: pool.microMetrics?.swapVelocity ?? 0,
                    });
                }
                await (0, supabase_1.logAction)('ENTRY', {
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
            }
            else {
                logger_1.default.warn(`⚠️ Trade execution failed for ${pool.name}: ${tradeResult.reason}`);
            }
        }
    }
};
// ═══════════════════════════════════════════════════════════════════════════════
// SCAN CYCLE (runs continuously)
// ═══════════════════════════════════════════════════════════════════════════════
async function scanCycle() {
    logger_1.default.warn('[TRACE] scanCycle CALLED');
    const startTime = Date.now();
    try {
        logger_1.default.info('--- Starting Scan Cycle (Microstructure Mode) ---');
        // Discovery parameters
        const discoveryParams = {
            minTVL: 250000,
            minVolume24h: 150000,
            minTraders24h: 300,
            maxPools: 30,
        };
        const cacheStatus = (0, dlmmIndexer_1.getCacheStatus)();
        if (cacheStatus.cached) {
            logger_1.default.info(`📦 [UNIVERSE] Using cached universe (${cacheStatus.poolCount} pools, age: ${Math.round(cacheStatus.age / 1000)}s)`);
        }
        // DISCOVERY: Hard try/catch - NO throw, NO exit, NO restart
        logger_1.default.warn('[TRACE] DISCOVERY CALL START');
        let poolUniverse = [];
        try {
            poolUniverse = await (0, dlmmIndexer_1.discoverDLMMUniverses)(discoveryParams);
        }
        catch (discoveryError) {
            logger_1.default.error('[DISCOVERY] Fetch failed:', {
                error: discoveryError?.message || discoveryError,
                params: discoveryParams,
            });
            return; // soft fail, wait for next interval
        }
        // Validate return shape
        if (!Array.isArray(poolUniverse) || poolUniverse.length === 0) {
            logger_1.default.warn('[DISCOVERY] No pools returned. Sleeping + retry next cycle.');
            return;
        }
        logger_1.default.info(`[DISCOVERY] ✅ Fetched ${poolUniverse.length} pools`);
        // Convert to Pool format
        const pools = poolUniverse.map(ep => (0, dlmmIndexer_1.enrichedPoolToPool)(ep));
        const activeAddresses = new Set(activePositions.map(p => p.poolAddress));
        let enrichedCandidates = pools;
        // Add missing active pools
        const missingActivePools = [];
        for (const pos of activePositions) {
            const inUniverse = enrichedCandidates.find(p => p.address === pos.poolAddress);
            if (!inUniverse) {
                logger_1.default.info(`📍 Adding active position ${pos.poolAddress} to monitoring`);
                missingActivePools.push({
                    address: pos.poolAddress,
                    name: 'Active Position',
                    tokenX: '', tokenY: '', mintX: '', mintY: '',
                    liquidity: 0, volume24h: 0, volume1h: 0, volume4h: 0,
                    velocity: 0, fees24h: 0, apr: 0, binStep: 0, baseFee: 0, binCount: 0,
                    createdAt: 0, holderCount: 0, topHolderPercent: 0, isRenounced: true,
                    riskScore: 0, dilutionScore: 0, score: 0, currentPrice: 0,
                });
            }
        }
        if (missingActivePools.length > 0) {
            enrichedCandidates = [...enrichedCandidates, ...missingActivePools];
        }
        logger_1.default.info(`📊 Processing ${enrichedCandidates.length} pools`);
        // ═══════════════════════════════════════════════════════════════════════
        // MICROSTRUCTURE SCORING (SDK-based - replaces 24h metrics)
        // ═══════════════════════════════════════════════════════════════════════
        // Extract pool addresses for SDK telemetry
        const poolAddresses = enrichedCandidates.map(p => p.address);
        updateTrackedPools(poolAddresses);
        // Fetch on-chain telemetry using Meteora DLMM SDK
        logger_1.default.info(`[DLMM-SDK] Fetching on-chain state for ${poolAddresses.length} pools...`);
        await refreshTelemetry();
        // Score using microstructure metrics
        const microEnrichedPools = (0, microstructureScoring_1.batchScorePools)(enrichedCandidates);
        // Log telemetry stats
        const validCount = microEnrichedPools.filter(p => p.hasValidTelemetry).length;
        const aliveCount = microEnrichedPools.filter(p => p.isMarketAlive).length;
        logger_1.default.info(`📊 Telemetry: ${validCount}/${microEnrichedPools.length} valid, ${aliveCount} markets alive`);
        // Log top pools with microstructure metrics
        const topPools = microEnrichedPools.slice(0, 5);
        logger_1.default.info('═══════════════════════════════════════════════════════════════');
        logger_1.default.info('TOP 5 POOLS (Microstructure Ranked):');
        for (const pool of topPools) {
            if (pool.microMetrics) {
                (0, dlmmTelemetry_1.logMicrostructureMetrics)(pool.microMetrics);
            }
            else {
                logger_1.default.info(`  ${pool.name} - µScore: ${pool.microScore.toFixed(1)} (no telemetry)`);
            }
        }
        logger_1.default.info('═══════════════════════════════════════════════════════════════');
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
            logger_1.default.error(`🚨 KILL SWITCH: Only ${(aliveRatio * 100).toFixed(1)}% of markets alive`);
            logger_1.default.error('🚨 Liquidating all positions and pausing trading for 10 minutes');
            for (const pos of activePositions) {
                await (0, supabase_1.logAction)('EXIT', {
                    pool: pos.poolAddress,
                    reason: 'KILL SWITCH: Market-wide dormancy',
                    emergencyExit: true,
                    paperTrading: PAPER_TRADING,
                    paperPnL: PAPER_TRADING ? paperTradingPnL : undefined,
                });
            }
            activePositions = [];
            killSwitchPauseUntil = Date.now() + (10 * 60 * 1000);
            await (0, supabase_1.logAction)('KILL_SWITCH', {
                reason: 'Market-wide dormancy',
                aliveRatio,
                positionsLiquidated: activePositions.length,
                pauseUntil: new Date(killSwitchPauseUntil).toISOString(),
            });
            const duration = Date.now() - startTime;
            logger_1.default.info(`Cycle completed in ${duration}ms. Sleeping...`);
            return;
        }
        // Check kill switch pause
        if (killSwitchPauseUntil > Date.now()) {
            const remainingSeconds = Math.ceil((killSwitchPauseUntil - Date.now()) / 1000);
            logger_1.default.warn(`⏸️  Trading paused by kill switch. Resuming in ${remainingSeconds}s`);
            return;
        }
        // Sort and deduplicate
        const sortedPools = microEnrichedPools.sort((a, b) => b.microScore - a.microScore);
        const deduplicatedPools = (0, arbitrage_1.deduplicatePools)(sortedPools);
        logger_1.default.info(`Deduplicated ${sortedPools.length} pools to ${deduplicatedPools.length} unique pairs`);
        // ExecutionEngine: Evaluate universe for paper trading positions
        if (deduplicatedPools.length === 0) {
            logger_1.default.info('[EXEC] No pools available, sleeping...');
            return;
        }
        // Convert to ScoredPool format for engine (with microstructure enrichment)
        const scoredPoolsForEngine = deduplicatedPools.map((p) => ({
            address: p.address,
            score: p.microScore,
            liquidityUSD: p.liquidity,
            volume24h: p.volume24h,
            binCount: p.binCount || 1,
            activeBin: p.activeBin || 0,
            tokenA: { symbol: p.name.split('-')[0] || 'TOKEN', decimals: 9 },
            tokenB: { symbol: p.name.split('-')[1] || 'TOKEN', decimals: 9 },
            microMetrics: p.microMetrics || undefined,
            isMarketAlive: p.isMarketAlive,
        }));
        // Find highest scoring pool
        const bestPool = scoredPoolsForEngine.reduce((best, pool) => pool.score > best.score ? pool : best, scoredPoolsForEngine[0]);
        logger_1.default.info(`[EXEC] Selected pool: ${bestPool.tokenA.symbol}/${bestPool.tokenB.symbol} (µScore: ${bestPool.score.toFixed(2)})`);
        // Check if score meets minimum threshold AND market is alive
        if (bestPool.score >= EXECUTION_MIN_SCORE && bestPool.isMarketAlive) {
            const allocation = executionEngine.getPortfolioStatus().capital / 3;
            logger_1.default.info(`[EXEC] Allocating capital: $${allocation.toFixed(2)}`);
            logger_1.default.info(`[EXEC] Opening position: ${bestPool.tokenA.symbol}/${bestPool.tokenB.symbol}`);
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
                    }
                    else {
                        enginePositions.push(pos);
                    }
                }
            }
        }
        else {
            const reason = bestPool.score < EXECUTION_MIN_SCORE
                ? `score ${bestPool.score.toFixed(2)} < ${EXECUTION_MIN_SCORE}`
                : 'market not alive';
            logger_1.default.info(`[EXEC] Best pool skipped: ${reason}`);
            executionEngine.update();
        }
        // Rotation engine
        await manageRotation(microEnrichedPools);
        const duration = Date.now() - startTime;
        logger_1.default.info(`Cycle completed in ${duration}ms. Sleeping...`);
        await (0, supabase_1.logAction)('HEARTBEAT', {
            duration,
            candidates: microEnrichedPools.length,
            validTelemetry: validCount,
            aliveMarkets: aliveCount,
            paperTrading: PAPER_TRADING,
            paperBalance: PAPER_TRADING ? paperTradingBalance : undefined,
        });
    }
    catch (error) {
        logger_1.default.error('❌ Error in scan cycle:', error);
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════
let isScanning = false;
async function runScanCycle() {
    if (isScanning) {
        logger_1.default.warn('⏳ Previous scan still running, skipping this interval');
        return;
    }
    isScanning = true;
    try {
        await scanCycle();
    }
    catch (error) {
        logger_1.default.error('❌ Unhandled error in scan cycle:', error);
    }
    finally {
        isScanning = false;
    }
}
async function main() {
    // STEP 1: Initialize ONCE
    await initializeBot();
    // STEP 2: Run first scan immediately
    await runScanCycle();
    // STEP 3: Schedule recurring scans via setInterval (NO while loop)
    setInterval(runScanCycle, LOOP_INTERVAL_MS);
    logger_1.default.info(`🔄 Scan loop started. Interval: ${LOOP_INTERVAL_MS / 1000}s`);
    logger_1.default.info('🧬 Using MICROSTRUCTURE-BASED SCORING (no 24h/TVL metrics)');
}
// Cleanup on exit
process.on('SIGINT', () => {
    logger_1.default.info('Shutting down...');
    (0, dlmmTelemetry_1.cleanup)();
    if (telemetryRefreshTimer) {
        clearInterval(telemetryRefreshTimer);
    }
    process.exit(0);
});
process.on('SIGTERM', () => {
    logger_1.default.info('Shutting down...');
    (0, dlmmTelemetry_1.cleanup)();
    if (telemetryRefreshTimer) {
        clearInterval(telemetryRefreshTimer);
    }
    process.exit(0);
});
// Start the bot
main().catch(console.error);
//# sourceMappingURL=index.js.map