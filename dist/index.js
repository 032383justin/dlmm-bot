"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supabase_1 = require("./db/supabase");
const logger_1 = __importDefault(require("./utils/logger"));
const arbitrage_1 = require("./utils/arbitrage");
// ═══════════════════════════════════════════════════════════════════════════════
// NEW: Microstructure Telemetry Imports (SDK-based)
// ═══════════════════════════════════════════════════════════════════════════════
const dlmmTelemetry_1 = require("./services/dlmmTelemetry");
const microstructureScoring_1 = require("./scoring/microstructureScoring");
const dlmmIndexer_1 = require("./services/dlmmIndexer");
const discoveryCache_1 = require("./services/discoveryCache");
const trading_1 = require("./core/trading");
const killSwitch_1 = require("./core/killSwitch");
// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 PREDATOR MODULES
// ═══════════════════════════════════════════════════════════════════════════════
const predatorController_1 = require("./engine/predatorController");
const ExecutionEngine_1 = require("./engine/ExecutionEngine");
const singleton_1 = require("./core/singleton");
const capitalManager_1 = require("./services/capitalManager");
const predatorController_2 = require("./engine/predatorController");
const Trade_1 = require("./db/models/Trade");
const riskBucketEngine_1 = require("./engine/riskBucketEngine");
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
const RESET_PAPER_BALANCE = process.env.RESET_PAPER_BALANCE === 'true'; // Force reset paper capital to PAPER_CAPITAL
// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL STATE (persists across scan cycles)
// ═══════════════════════════════════════════════════════════════════════════════
let activePositions = [];
// Bot start time for runtime tracking
let botStartTime = 0;
// Snapshot count for kill switch
let totalSnapshotCount = 0;
// Telemetry refresh timer
let telemetryRefreshTimer = null;
// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETONS - CREATED AT MODULE LOAD (ROOT LEVEL)
// ═══════════════════════════════════════════════════════════════════════════════
// These are created ONCE when this module is first imported.
// They persist for the entire process lifetime.
// NO initialization inside functions - this happens at the ROOT.
// 
// Uses globalThis.__DLMM_REGISTRY__ for TRUE global singleton behavior.
// Registry will ABORT PROCESS (process.exit(1)) on any duplicate registration.
// NO conditional checks - if this code runs twice, it's a FATAL error.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('🏭 [ENTRYPOINT] CREATING PROCESS-LEVEL SINGLETONS');
console.log('═══════════════════════════════════════════════════════════════════');
// Create and register ExecutionEngine
// If this is a duplicate registration, Singleton.register() will ABORT the process
const engine = new ExecutionEngine_1.ExecutionEngine({
    capital: PAPER_CAPITAL,
    rebalanceInterval: 15 * 60 * 1000,
    takeProfit: 0.04,
    stopLoss: -0.02,
    maxConcurrentPools: 3,
    allocationStrategy: 'equal',
});
singleton_1.Singleton.register('ExecutionEngine', engine);
// Initialize and register PredatorController
(0, predatorController_2.initializePredatorController)();
singleton_1.Singleton.register('PredatorController', { initialized: true });
console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('✅ [ENTRYPOINT] SINGLETONS CREATED - LOCKED FOR PROCESS LIFETIME');
console.log('═══════════════════════════════════════════════════════════════════');
singleton_1.Singleton.logStatus();
// Get reference to the singleton engine
const executionEngine = singleton_1.Singleton.get('ExecutionEngine');
const enginePositions = [];
// Track initialization state for validation
let initializationComplete = false;
let lastPersistenceLogTime = 0;
const PERSISTENCE_LOG_INTERVAL = 60000; // Log every 60 seconds
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
    botStartTime = Date.now();
    logger_1.default.info('[INIT] 🚀 INITIALIZING BOT...');
    logger_1.default.info('[INIT] 🧬 Using METEORA DLMM SDK for on-chain telemetry');
    logger_1.default.info('[INIT] 📊 Microstructure scoring (no 24h metrics)');
    logger_1.default.info('[INIT] 💾 PERSISTENT CAPITAL MANAGEMENT ENABLED');
    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL: Initialize Capital Manager FIRST
    // ═══════════════════════════════════════════════════════════════════════════
    logger_1.default.info('[INIT] 💰 Initializing capital manager...');
    const capitalReady = await capitalManager_1.capitalManager.initialize(PAPER_CAPITAL);
    if (!capitalReady) {
        logger_1.default.error('[INIT] ❌ FATAL: Capital manager initialization failed');
        logger_1.default.error('[INIT] ❌ Please ensure database is available and run SQL migrations');
        logger_1.default.error('[INIT] ❌ See supabase/capital_tables.sql for required tables');
        process.exit(1);
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // PAPER TRADING RESET SUPPORT
    // If RESET_PAPER_BALANCE=true, reset capital to PAPER_CAPITAL ($10,000 default)
    // This clears all positions and locks for a fresh start
    // ═══════════════════════════════════════════════════════════════════════════
    if (PAPER_TRADING && RESET_PAPER_BALANCE) {
        logger_1.default.info('═══════════════════════════════════════════════════════════════');
        logger_1.default.info('[INIT] 🔄 RESET_PAPER_BALANCE detected - Resetting paper trading state...');
        logger_1.default.info(`[INIT] 💰 New balance will be: $${PAPER_CAPITAL.toFixed(2)}`);
        logger_1.default.info('═══════════════════════════════════════════════════════════════');
        const resetResult = await capitalManager_1.capitalManager.resetCapital(PAPER_CAPITAL);
        if (resetResult.success) {
            logger_1.default.info(`[INIT] ✅ Paper balance reset complete`);
            logger_1.default.info(`[INIT]    Trades cleared: ${resetResult.tradesCleared}`);
            logger_1.default.info(`[INIT]    Locks cleared: ${resetResult.locksCleared}`);
            logger_1.default.info(`[INIT]    New balance: $${resetResult.newBalance.toFixed(2)}`);
        }
        else {
            logger_1.default.error(`[INIT] ❌ Paper balance reset failed: ${resetResult.error}`);
            // Continue anyway - the bot can still run with existing state
        }
        // Clear in-memory state
        activePositions = [];
        logger_1.default.info('[INIT] 🧹 Cleared in-memory positions');
    }
    // Get current capital state
    const capitalState = await capitalManager_1.capitalManager.getFullState();
    if (capitalState) {
        logger_1.default.info(`[INIT] 💰 Capital State:`);
        logger_1.default.info(`[INIT]    Available: $${capitalState.available_balance.toFixed(2)}`);
        logger_1.default.info(`[INIT]    Locked: $${capitalState.locked_balance.toFixed(2)}`);
        logger_1.default.info(`[INIT]    Total P&L: $${capitalState.total_realized_pnl.toFixed(2)}`);
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // SINGLETONS ALREADY CREATED AT ROOT LEVEL - VERIFY ONLY
    // ═══════════════════════════════════════════════════════════════════════════
    logger_1.default.info('[INIT] 🔒 Verifying singletons (created at entrypoint)...');
    if (!singleton_1.Singleton.has('ExecutionEngine')) {
        throw new Error('FATAL: ExecutionEngine not registered. Entrypoint bug.');
    }
    if (!singleton_1.Singleton.has('PredatorController')) {
        throw new Error('FATAL: PredatorController not registered. Entrypoint bug.');
    }
    const engineId = singleton_1.Singleton.getId('ExecutionEngine');
    const predatorId = singleton_1.Singleton.getId('PredatorController');
    logger_1.default.info(`[INIT]    Engine ID: ${engineId}`);
    logger_1.default.info(`[INIT]    Predator ID: ${predatorId}`);
    // Initialize execution engine async components (DB recovery)
    // NOTE: This is async init, NOT singleton creation
    const engineReady = await executionEngine.initialize();
    if (!engineReady) {
        logger_1.default.error('[INIT] ❌ Execution engine DB recovery failed');
        process.exit(1);
    }
    // Note: SDK-based telemetry is fetched during each scan cycle
    (0, dlmmTelemetry_1.initializeSwapStream)();
    // Load active trades from database into local state
    const activeTrades = await (0, Trade_1.loadActiveTradesFromDB)();
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
    logger_1.default.info(`[INIT] ✅ Recovered ${activePositions.length} active positions from database`);
    if (PAPER_TRADING) {
        logger_1.default.info('[INIT] 🎮 PAPER TRADING MODE');
    }
    else {
        logger_1.default.info('[INIT] ⚠️  LIVE TRADING MODE - Real money at risk!');
    }
    // Mark initialization complete and lock process
    initializationComplete = true;
    singleton_1.Singleton.markInitialized();
    logger_1.default.info('[INIT] ════════════════════════════════════════════════════════════');
    logger_1.default.info('[INIT] ✅ INITIALIZATION COMPLETE - PROCESS LOCKED');
    logger_1.default.info(`[INIT]    Engine ID: ${singleton_1.Singleton.getId('ExecutionEngine')}`);
    logger_1.default.info(`[INIT]    Predator ID: ${singleton_1.Singleton.getId('PredatorController')}`);
    logger_1.default.info('[INIT]    Any re-initialization attempt will throw FATAL error.');
    logger_1.default.info('[INIT] ════════════════════════════════════════════════════════════');
}
// ═══════════════════════════════════════════════════════════════════════════════
// ROTATION MANAGER (entry/exit logic)
// ═══════════════════════════════════════════════════════════════════════════════
const manageRotation = async (rankedPools) => {
    const now = Date.now();
    const remainingPositions = [];
    let exitSignalCount = 0;
    // Get current capital from database
    let currentBalance;
    try {
        currentBalance = await capitalManager_1.capitalManager.getBalance();
    }
    catch (err) {
        logger_1.default.error(`[ROTATION] Failed to get capital: ${err.message}`);
        return 0;
    }
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
            // Find trade ID for this position
            const activeTrades = (0, Trade_1.getAllActiveTrades)();
            const trade = activeTrades.find(t => t.pool === pos.poolAddress);
            if (trade) {
                const exitResult = await (0, trading_1.exitPosition)(trade.id, {
                    exitPrice: pool.currentPrice,
                    reason: `MICROSTRUCTURE: ${exitSignal.reason}`,
                }, 'MICROSTRUCTURE_EXIT');
                if (exitResult.success) {
                    logger_1.default.warn(`[MICRO-EXIT] ${pool.name} - ${exitSignal.reason}`);
                    logger_1.default.info(`[EXIT] P&L: ${(exitResult.pnl ?? 0) >= 0 ? '+' : ''}$${(exitResult.pnl ?? 0).toFixed(2)}`);
                    exitSignalCount++;
                    // ═══════════════════════════════════════════════════════════
                    // HANDLE PREDATOR EXIT - Track for potential reinjection
                    // ═══════════════════════════════════════════════════════════
                    const mhiResult = (0, predatorController_1.computeMHI)(pos.poolAddress);
                    (0, predatorController_1.handlePredatorExit)(trade.id, pos.poolAddress, pool.name, `MICROSTRUCTURE: ${exitSignal.reason}`, exitResult.pnl ?? 0, (exitResult.pnl ?? 0) / pos.amount, mhiResult?.mhi, pool.microMetrics?.poolEntropy);
                }
                else {
                    // Exit was blocked by guards - likely already closing/closed
                    logger_1.default.info(`[GUARD] Microstructure exit blocked: ${exitResult.reason}`);
                }
            }
            // NOTE: TRADE_EXIT log is now emitted by exitPosition - no duplicate EXIT log here
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
            // Find trade ID for this position
            const activeTrades = (0, Trade_1.getAllActiveTrades)();
            const trade = activeTrades.find(t => t.pool === pos.poolAddress);
            if (trade) {
                const exitResult = await (0, trading_1.exitPosition)(trade.id, {
                    exitPrice: pool.currentPrice,
                    reason,
                }, 'EMERGENCY_EXIT');
                if (exitResult.success) {
                    logger_1.default.warn(`[EMERGENCY] ${pool.name} - ${reason}`);
                    logger_1.default.info(`[EXIT] P&L: ${(exitResult.pnl ?? 0) >= 0 ? '+' : ''}$${(exitResult.pnl ?? 0).toFixed(2)}`);
                    exitSignalCount++;
                    // ═══════════════════════════════════════════════════════════
                    // HANDLE PREDATOR EXIT - Track for potential reinjection
                    // ═══════════════════════════════════════════════════════════
                    const mhiResult = (0, predatorController_1.computeMHI)(pos.poolAddress);
                    (0, predatorController_1.handlePredatorExit)(trade.id, pos.poolAddress, pool.name, reason, exitResult.pnl ?? 0, (exitResult.pnl ?? 0) / pos.amount, mhiResult?.mhi, pool.microMetrics?.poolEntropy);
                }
                else {
                    // Exit was blocked by guards - likely already closing/closed
                    logger_1.default.info(`[GUARD] Emergency exit blocked: ${exitResult.reason}`);
                }
            }
            // NOTE: TRADE_EXIT log is now emitted by exitPosition - no duplicate EXIT log here
            continue;
        }
        // Position still valid
        remainingPositions.push(pos);
    }
    // Market crash detection
    if (exitSignalCount >= 3 && activePositions.length >= 3) {
        logger_1.default.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit. Exiting ALL positions.`);
        // Exit all remaining positions
        for (const pos of remainingPositions) {
            const activeTrades = (0, Trade_1.getAllActiveTrades)();
            const trade = activeTrades.find(t => t.pool === pos.poolAddress);
            if (trade) {
                const exitResult = await (0, trading_1.exitPosition)(trade.id, {
                    exitPrice: 0, // Will use current price
                    reason: 'MARKET_CRASH_EXIT',
                }, 'MARKET_CRASH');
                if (!exitResult.success) {
                    logger_1.default.info(`[GUARD] Market crash exit blocked for ${trade.poolName}: ${exitResult.reason}`);
                }
            }
        }
        activePositions = [];
        await (0, supabase_1.logAction)('MARKET_CRASH_EXIT', { exitSignalCount });
        return 0;
    }
    activePositions = remainingPositions;
    // ═══════════════════════════════════════════════════════════════════════
    // PATCH 2: RISK BUCKET ASSIGNMENT - REPLACES TRADE COUNT LIMITING
    // ═══════════════════════════════════════════════════════════════════════
    // Get current capital state
    let rotationBalance;
    let rotationEquity;
    try {
        rotationBalance = await capitalManager_1.capitalManager.getBalance();
        rotationEquity = await capitalManager_1.capitalManager.getEquity();
    }
    catch (err) {
        logger_1.default.error(`[ROTATION] Failed to get capital: ${err.message}`);
        return 0;
    }
    // Convert active positions to risk format
    const riskActivePositions = activePositions.map(pos => {
        const pool = rankedPools.find(p => p.address === pos.poolAddress);
        const microScore = pool?.microScore ?? pos.entryScore;
        // Determine tier based on score
        let tier = 'C';
        if (microScore >= 40)
            tier = 'A';
        else if (microScore >= 32)
            tier = 'B';
        else if (microScore >= 24)
            tier = 'C';
        else
            tier = 'D';
        return {
            poolAddress: pos.poolAddress,
            tier,
            size: pos.amount,
            entryScore: pos.entryScore,
        };
    });
    // Calculate portfolio risk state
    const portfolioState = (0, riskBucketEngine_1.calculatePortfolioState)(rotationEquity, rotationBalance, riskActivePositions);
    (0, riskBucketEngine_1.logPortfolioRiskSummary)(portfolioState);
    // Prepare pools for risk assignment (only those with valid telemetry and alive)
    const poolsForRiskAssignment = rankedPools
        .filter(p => p.hasValidTelemetry && p.isMarketAlive)
        .filter(p => !activePositions.find(ap => ap.poolAddress === p.address))
        .map(p => ({
        address: p.address,
        name: p.name,
        microScore: p.microScore,
        liquiditySlope: p.liquiditySlope ?? 0,
    }));
    // Assign risk tiers to all candidate pools
    const riskAssignments = (0, riskBucketEngine_1.assignRiskBatch)(poolsForRiskAssignment, rotationEquity, rotationBalance, riskActivePositions);
    // Get only allowed pools
    const allowedAssignments = (0, riskBucketEngine_1.getAllowedPools)(riskAssignments);
    logger_1.default.info(`[RISK] Assigned ${riskAssignments.length} pools → ${allowedAssignments.length} allowed for entry`);
    // Log blocked pools
    const blockedAssignments = riskAssignments.filter(a => !a.allowed);
    for (const blocked of blockedAssignments.slice(0, 5)) {
        logger_1.default.info(`[RISK] ✗ ${blocked.poolName} - ${blocked.blockReason}`);
    }
    // Build valid candidates from allowed risk assignments
    const validCandidates = [];
    for (const assignment of allowedAssignments) {
        const pool = rankedPools.find(p => p.address === assignment.poolAddress);
        if (!pool)
            continue;
        // Check for duplicate pairs
        const activePools = activePositions.map(pos => rankedPools.find(p => p.address === pos.poolAddress)).filter((p) => p !== undefined);
        if ((0, arbitrage_1.isDuplicatePair)(pool, activePools)) {
            logger_1.default.info(`[RISK] Skipping ${pool.name} - duplicate token pair`);
            continue;
        }
        // ═══════════════════════════════════════════════════════════════════
        // MHI GATING - The final gatekeeper for entries
        // ═══════════════════════════════════════════════════════════════════
        const predatorEval = (0, predatorController_1.evaluatePredatorEntry)(pool.address, pool.name);
        if (!predatorEval.canEnter) {
            logger_1.default.info(`[MHI] Skipping ${pool.name} - ${predatorEval.blockedReasons.join(', ')}`);
            continue;
        }
        const candidateType = categorizeToken(pool);
        // Adjust size based on MHI tier and reflexivity
        const mhiAdjustedSize = assignment.finalSize * predatorEval.finalSizeMultiplier;
        validCandidates.push({ pool, type: candidateType, riskAssignment: { ...assignment, finalSize: mhiAdjustedSize } });
        logger_1.default.info(`🎯 [TIER ${assignment.tier}] ${pool.name} | ` +
            `µScore=${assignment.microScore.toFixed(1)} | ` +
            `MHI=${predatorEval.mhi.toFixed(2)} (${predatorEval.mhiTier}) | ` +
            `size=$${mhiAdjustedSize.toFixed(2)} (MHI-adj) | ` +
            `${predatorEval.isPredatorOpportunity ? '🦅 PREDATOR' : ''}`);
    }
    // ═══════════════════════════════════════════════════════════════════════
    // EXECUTE ENTRIES USING RISK BUCKET SIZING
    // Size comes from risk assignment, NOT score-weighted allocation
    // ═══════════════════════════════════════════════════════════════════════
    let entriesThisCycle = 0;
    if (validCandidates.length > 0) {
        logger_1.default.info(`[RISK] Executing ${validCandidates.length} valid candidates`);
        let availableForTrades = rotationBalance;
        for (const { pool, type, riskAssignment } of validCandidates) {
            // Use size from risk assignment (already includes leverage + penalties)
            const amount = riskAssignment.finalSize;
            if (amount < 10) {
                logger_1.default.info(`⏭️  Skipping ${pool.name}: Allocation too small ($${amount.toFixed(2)})`);
                continue;
            }
            if (availableForTrades < amount) {
                logger_1.default.info(`⏭️  Skipping ${pool.name}: Insufficient capital ($${availableForTrades.toFixed(2)} < $${amount.toFixed(2)})`);
                continue;
            }
            if ((0, trading_1.hasActiveTrade)(pool.address)) {
                logger_1.default.warn(`⚠️ Already have open trade on ${pool.name}`);
                continue;
            }
            // Determine sizing mode based on tier
            const sizingMode = riskAssignment.tier === 'A' ? 'aggressive' : 'standard';
            // ═══════════════════════════════════════════════════════════════════
            // ENTER POSITION WITH RISK BUCKET SIZE
            // Uses capital manager internally
            // If DB insert fails → trade is aborted (no graceful degradation)
            // ═══════════════════════════════════════════════════════════════════
            const tradeResult = await (0, trading_1.enterPosition)(pool, sizingMode, amount, // Pass the risk-calculated size
            rotationEquity, riskAssignment.tier, riskAssignment.leverage);
            if (tradeResult.success && tradeResult.trade) {
                const tradeSize = tradeResult.trade.size;
                availableForTrades -= tradeSize;
                entriesThisCycle++;
                // Record entry for discovery cache tracking
                (0, discoveryCache_1.recordEntry)();
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
                // ═══════════════════════════════════════════════════════════════
                // REGISTER FOR PREDATOR MONITORING (structural decay tracking)
                // ═══════════════════════════════════════════════════════════════
                (0, predatorController_1.registerPredatorTrade)(tradeResult.trade.id, pool.address);
                // NOTE: ENTRY log is emitted by ExecutionEngine after full position registration
                // No duplicate logging here
            }
            else {
                logger_1.default.warn(`⚠️ Trade execution failed for ${pool.name}: ${tradeResult.reason}`);
            }
        }
    }
    return entriesThisCycle;
};
// ═══════════════════════════════════════════════════════════════════════════════
// SCAN CYCLE (runs continuously)
// ═══════════════════════════════════════════════════════════════════════════════
async function scanCycle() {
    const startTime = Date.now();
    try {
        // ═══════════════════════════════════════════════════════════════════════
        // SINGLETON VALIDATION - GUARD AGAINST RE-INITIALIZATION
        // ═══════════════════════════════════════════════════════════════════════
        if (!initializationComplete || !singleton_1.Singleton.isInitialized()) {
            throw new Error('FATAL: scanCycle called before initialization complete');
        }
        // Periodic persistence log (every 60 seconds)
        if (Date.now() - lastPersistenceLogTime >= PERSISTENCE_LOG_INTERVAL) {
            singleton_1.Singleton.logStatus();
            singleton_1.Singleton.validate();
            lastPersistenceLogTime = Date.now();
        }
        // ═══════════════════════════════════════════════════════════════════════
        // LIFECYCLE DIAGRAM
        // ═══════════════════════════════════════════════════════════════════════
        logger_1.default.info('═══════════════════════════════════════════════════════════════════');
        logger_1.default.info('🔄 SCAN CYCLE LIFECYCLE:');
        logger_1.default.info('   INIT ✅ → DISCOVERY → CANDIDATES → SCORE → SIGNALS → EXECUTE → MONITOR');
        logger_1.default.info('═══════════════════════════════════════════════════════════════════');
        logger_1.default.info('--- Starting Scan Cycle (Microstructure Mode + Risk Buckets) ---');
        // ═══════════════════════════════════════════════════════════════════════
        // PATCH 1: CAPITAL GATING - BEFORE ANYTHING ELSE
        // Skip entire cycle if insufficient capital
        // ═══════════════════════════════════════════════════════════════════════
        let currentBalance;
        let totalEquity;
        try {
            currentBalance = await capitalManager_1.capitalManager.getBalance();
            totalEquity = await capitalManager_1.capitalManager.getEquity();
            logger_1.default.info(`[CAPITAL] Available: $${currentBalance.toFixed(2)} | Total Equity: $${totalEquity.toFixed(2)}`);
        }
        catch (err) {
            logger_1.default.error(`[CAPITAL] Failed to get balance: ${err.message}`);
            logger_1.default.error('[CAPITAL] Cannot proceed without capital - sleeping...');
            return;
        }
        // Capital gating check BEFORE any scoring
        const capitalGate = (0, riskBucketEngine_1.checkCapitalGating)(currentBalance);
        if (!capitalGate.canTrade) {
            logger_1.default.warn(`[CAPITAL GATE] ❌ ${capitalGate.reason}`);
            logger_1.default.warn('[PREDATOR] Insufficient capital. Waiting for next cycle...');
            await (0, supabase_1.logAction)('CAPITAL_GATE_BLOCK', {
                reason: capitalGate.reason,
                availableCapital: currentBalance,
                minRequired: riskBucketEngine_1.PORTFOLIO_CONSTRAINTS.minExecutionCapital,
            });
            // DO NOT restart or reinitialize - just wait for next scan cycle
            return;
        }
        logger_1.default.info(`[CAPITAL GATE] ✅ ${capitalGate.reason}`);
        // ═══════════════════════════════════════════════════════════════════════
        // STAGE: DISCOVERY
        // ═══════════════════════════════════════════════════════════════════════
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        logger_1.default.info('📍 STAGE: DISCOVERY');
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        // ═══════════════════════════════════════════════════════════════════════
        // INTELLIGENT DISCOVERY CACHING
        // ═══════════════════════════════════════════════════════════════════════
        // Discovery runs at 15-minute intervals, NOT every scan
        // Force refresh only on: MHI<0.35, alivePools<5, 4 no-entry cycles, 
        // kill switch, or regime flip
        //
        // CRITICAL DISTINCTION:
        //   SCAN = observe state of known pools (telemetry refresh)
        //   DISCOVER = rebuild the entire universe of pools
        //
        // When cache is valid: SCAN only, NO DISCOVER
        // ═══════════════════════════════════════════════════════════════════════
        // Get current pool IDs for force refresh evaluation
        const currentPoolIds = activePositions.map(p => p.poolAddress);
        // Check if discovery refresh is needed
        const discoveryCheck = (0, discoveryCache_1.shouldRefreshDiscovery)(currentPoolIds);
        const discoveryCacheStatus = (0, discoveryCache_1.getDiscoveryCacheStatus)();
        let poolUniverse = [];
        if (!discoveryCheck.shouldRefresh) {
            // ═══════════════════════════════════════════════════════════════════
            // SCAN MODE: Use cached pools - NO full discovery
            // This is the normal path - we observe known pools without rebuilding
            // ═══════════════════════════════════════════════════════════════════
            const cacheAgeMin = Math.round(discoveryCheck.cacheAge / 60000);
            const remainingMin = Math.round((discoveryCache_1.DISCOVERY_REFRESH_MS - discoveryCheck.cacheAge) / 60000);
            logger_1.default.info(`📦 [SCAN-MODE] Using cached pool universe | Age: ${cacheAgeMin}m | Next discovery: ${remainingMin}m`);
            logger_1.default.info(`   Pools: ${discoveryCacheStatus.poolCount} | GlobalMHI: ${discoveryCacheStatus.globalMHI.toFixed(3)} | NoEntryCycles: ${discoveryCacheStatus.noEntryCycles}`);
            // Get cached enriched pools directly - NO discovery call
            const cachedPools = (0, discoveryCache_1.getCachedEnrichedPools)();
            if (cachedPools && cachedPools.length > 0) {
                // Convert cached pools to EnrichedPool format
                poolUniverse = cachedPools.map(cp => ({
                    address: cp.address,
                    symbol: cp.symbol,
                    baseMint: cp.baseMint,
                    quoteMint: cp.quoteMint,
                    tvl: cp.tvl,
                    volume24h: cp.volume24h,
                    fees24h: cp.fees24h,
                    price: cp.price,
                    priceImpact: cp.priceImpact,
                    traders24h: cp.traders24h,
                    holders: cp.holders,
                    liquidity: cp.liquidity,
                    entropy: cp.entropy,
                    binCount: cp.binCount,
                    velocity: cp.velocity,
                    activeBin: cp.activeBin,
                    migrationDirection: cp.migrationDirection,
                    lastUpdated: cp.lastUpdated,
                    feeRate: cp.feeRate,
                    velocityLiquidityRatio: cp.velocityLiquidityRatio,
                    turnover24h: cp.turnover24h,
                    feeEfficiency: cp.feeEfficiency,
                }));
                logger_1.default.info(`📦 [SCAN-MODE] Loaded ${poolUniverse.length} pools from cache (no discovery)`);
            }
            else {
                // Cache exists but no enriched pools - fallback to discovery
                logger_1.default.warn('[SCAN-MODE] Cache exists but no enriched pools - forcing discovery');
                const discoveryParams = {
                    minTVL: 200000,
                    minVolume24h: 75000,
                    minTraders24h: 35,
                };
                try {
                    poolUniverse = await (0, dlmmIndexer_1.discoverDLMMUniverses)(discoveryParams);
                    // Store enriched pools in cache for next scan
                    if (poolUniverse.length > 0) {
                        const poolMetas = poolUniverse.map(p => ({
                            address: p.address,
                            name: p.symbol || p.address.slice(0, 8),
                            score: p.velocityLiquidityRatio || 0,
                            mhi: 0,
                            regime: 'NEUTRAL',
                            lastUpdated: Date.now(),
                        }));
                        const cachedEnriched = poolUniverse.map(p => ({
                            address: p.address,
                            symbol: p.symbol,
                            baseMint: p.baseMint,
                            quoteMint: p.quoteMint,
                            tvl: p.tvl,
                            volume24h: p.volume24h,
                            fees24h: p.fees24h,
                            price: p.price,
                            priceImpact: p.priceImpact,
                            traders24h: p.traders24h,
                            holders: p.holders,
                            liquidity: p.liquidity,
                            entropy: p.entropy,
                            binCount: p.binCount,
                            velocity: p.velocity,
                            activeBin: p.activeBin,
                            migrationDirection: p.migrationDirection,
                            lastUpdated: p.lastUpdated,
                            feeRate: p.feeRate,
                            velocityLiquidityRatio: p.velocityLiquidityRatio,
                            turnover24h: p.turnover24h,
                            feeEfficiency: p.feeEfficiency,
                        }));
                        (0, discoveryCache_1.updateDiscoveryCache)(poolMetas, 'INITIAL', cachedEnriched);
                    }
                }
                catch (discoveryError) {
                    logger_1.default.error('[SCAN-MODE] Fallback discovery failed:', {
                        error: discoveryError?.message || discoveryError,
                    });
                    logger_1.default.warn('[PREDATOR] Discovery error. Waiting for next cycle. NO restart.');
                    (0, discoveryCache_1.recordNoEntryCycle)();
                    // DO NOT restart or reinitialize - just wait for next scan cycle
                    return;
                }
            }
        }
        else {
            // ═══════════════════════════════════════════════════════════════════
            // DISCOVERY MODE: Full universe rebuild
            // This only happens when: time expired, MHI critical, alive pools low,
            // no-entry streak, kill switch, or regime flip
            // ═══════════════════════════════════════════════════════════════════
            logger_1.default.info('═══════════════════════════════════════════════════════════════════');
            logger_1.default.info(`🔄 [DISCOVERY-MODE] FULL UNIVERSE REBUILD | Reason: ${discoveryCheck.reason}`);
            logger_1.default.info('═══════════════════════════════════════════════════════════════════');
            const discoveryParams = {
                minTVL: 200000,
                minVolume24h: 75000,
                minTraders24h: 35,
            };
            try {
                poolUniverse = await (0, dlmmIndexer_1.discoverDLMMUniverses)(discoveryParams);
                // Update discovery cache with BOTH metadata AND enriched pools
                if (poolUniverse.length > 0) {
                    const poolMetas = poolUniverse.map(p => ({
                        address: p.address,
                        name: p.symbol || p.address.slice(0, 8),
                        score: p.velocityLiquidityRatio || 0,
                        mhi: 0, // Will be computed during scoring
                        regime: 'NEUTRAL',
                        lastUpdated: Date.now(),
                    }));
                    // Store enriched pools for subsequent scan cycles
                    const cachedEnriched = poolUniverse.map(p => ({
                        address: p.address,
                        symbol: p.symbol,
                        baseMint: p.baseMint,
                        quoteMint: p.quoteMint,
                        tvl: p.tvl,
                        volume24h: p.volume24h,
                        fees24h: p.fees24h,
                        price: p.price,
                        priceImpact: p.priceImpact,
                        traders24h: p.traders24h,
                        holders: p.holders,
                        liquidity: p.liquidity,
                        entropy: p.entropy,
                        binCount: p.binCount,
                        velocity: p.velocity,
                        activeBin: p.activeBin,
                        migrationDirection: p.migrationDirection,
                        lastUpdated: p.lastUpdated,
                        feeRate: p.feeRate,
                        velocityLiquidityRatio: p.velocityLiquidityRatio,
                        turnover24h: p.turnover24h,
                        feeEfficiency: p.feeEfficiency,
                    }));
                    (0, discoveryCache_1.updateDiscoveryCache)(poolMetas, discoveryCheck.reason, cachedEnriched);
                }
            }
            catch (discoveryError) {
                logger_1.default.error('[DISCOVERY-MODE] Full refresh failed:', {
                    error: discoveryError?.message || discoveryError,
                    reason: discoveryCheck.reason,
                });
                logger_1.default.warn('[PREDATOR] Discovery error. Waiting for next cycle. NO restart.');
                (0, discoveryCache_1.recordNoEntryCycle)();
                // DO NOT restart or reinitialize - just wait for next scan cycle
                return;
            }
        }
        // ═══════════════════════════════════════════════════════════════════════
        // GUARDRAIL: Zero candidates after discovery
        // DO NOT reinitialize. Just wait for next scan cycle.
        // ═══════════════════════════════════════════════════════════════════════
        if (!Array.isArray(poolUniverse) || poolUniverse.length === 0) {
            logger_1.default.warn('═══════════════════════════════════════════════════════════════════');
            logger_1.default.warn('[PREDATOR] No qualified pools. Waiting for next cycle...');
            logger_1.default.warn('   Discovery returned 0 pools after all filters.');
            logger_1.default.warn('   This is normal when market activity is low.');
            logger_1.default.warn('   Bot will retry in next scan cycle. NO restart needed.');
            logger_1.default.warn('═══════════════════════════════════════════════════════════════════');
            (0, discoveryCache_1.recordNoEntryCycle)();
            // DO NOT restart or reinitialize - just wait for next scan cycle
            return;
        }
        logger_1.default.info(`[DISCOVERY] ✅ ${poolUniverse.length} pools in universe`);
        // ═══════════════════════════════════════════════════════════════════════
        // STAGE: CANDIDATES
        // ═══════════════════════════════════════════════════════════════════════
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        logger_1.default.info('📍 STAGE: CANDIDATES');
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
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
        // STAGE: SCORE
        // ═══════════════════════════════════════════════════════════════════════
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        logger_1.default.info('📍 STAGE: SCORE (Microstructure + MHI + Predator)');
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        // Extract pool addresses for SDK telemetry
        const poolAddresses = enrichedCandidates.map(p => p.address);
        updateTrackedPools(poolAddresses);
        // Register pools for predator tracking (ecosystem + reflexivity)
        for (const pool of enrichedCandidates) {
            (0, predatorController_1.registerPool)(pool.address, pool.name, pool.mintX || '', pool.mintY || '');
        }
        // Fetch on-chain telemetry using Meteora DLMM SDK
        logger_1.default.info(`[DLMM-SDK] Fetching on-chain state for ${poolAddresses.length} pools...`);
        await refreshTelemetry();
        // Score using microstructure metrics
        const microEnrichedPools = (0, microstructureScoring_1.batchScorePools)(enrichedCandidates);
        // Log telemetry stats
        const validCount = microEnrichedPools.filter(p => p.hasValidTelemetry).length;
        const aliveCount = microEnrichedPools.filter(p => p.isMarketAlive).length;
        logger_1.default.info(`📊 Telemetry: ${validCount}/${microEnrichedPools.length} valid, ${aliveCount} markets alive`);
        // ═══════════════════════════════════════════════════════════════════════
        // TIER 4 PREDATOR CYCLE
        // Update ecosystem states, reflexivity, and MHI for all pools
        // ═══════════════════════════════════════════════════════════════════════
        const predatorSummary = (0, predatorController_1.runPredatorCycle)(poolAddresses);
        // Log predator opportunities
        const predatorOpps = (0, predatorController_1.getPredatorOpportunities)();
        if (predatorOpps.length > 0) {
            logger_1.default.info(`🦅 PREDATOR OPPORTUNITIES: ${predatorOpps.length} pools with draining neighbors`);
            for (const opp of predatorOpps.slice(0, 3)) {
                logger_1.default.info(`   → ${opp.poolName} | reflexivity=${(opp.reflexivityScore * 100).toFixed(1)}%`);
            }
        }
        // Check for reinjection opportunities
        const reinjections = (0, predatorController_1.getPredatorReinjections)();
        if (reinjections.length > 0) {
            logger_1.default.info(`🔄 REINJECTION READY: ${reinjections.length} pools have healed structure`);
            for (const reinj of reinjections.slice(0, 3)) {
                logger_1.default.info(`   → ${reinj.poolName} | MHI=${reinj.currentMHI.toFixed(2)} | confidence=${(reinj.confidence * 100).toFixed(1)}%`);
            }
        }
        // Check for structural exit signals
        const structuralExits = (0, predatorController_1.getStructuralExitSignals)();
        if (structuralExits.length > 0) {
            logger_1.default.warn(`⚠️ STRUCTURAL DECAY: ${structuralExits.length} trades need exit`);
            for (const exit of structuralExits) {
                logger_1.default.warn(`   → Trade ${exit.tradeId.slice(0, 8)}... | ${exit.reason}`);
            }
        }
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
        // ═══════════════════════════════════════════════════════════════════════
        // STAGE: SIGNALS (Kill Switch + Harmonic Stops)
        // ═══════════════════════════════════════════════════════════════════════
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        logger_1.default.info('📍 STAGE: SIGNALS');
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        // ═══════════════════════════════════════════════════════════════════════
        // KILL SWITCH CHECK (reduced hyper-sensitivity)
        // Uses OR conditions for alive detection, AND conditions for kill trigger
        // ═══════════════════════════════════════════════════════════════════════
        // Update snapshot count
        totalSnapshotCount += validCount;
        // Build pool metrics for kill switch evaluation
        const killSwitchPoolMetrics = microEnrichedPools
            .filter(p => p.microMetrics)
            .map(p => {
            const metrics = p.microMetrics;
            const history = (0, dlmmTelemetry_1.getPoolHistory)(p.address);
            // Calculate 60s baseline fee intensity
            const now = Date.now();
            const baseline60s = history
                .filter(h => now - h.fetchedAt <= 60000)
                .reduce((sum, h) => sum + (h.feeRateBps / 10000), 0);
            const avgBaseline60s = history.length > 0 ? baseline60s / Math.max(1, history.filter(h => now - h.fetchedAt <= 60000).length) : 0;
            // Calculate liquidity flow percentage
            let liquidityFlowPct = 0;
            if (history.length >= 2) {
                const latest = history[history.length - 1];
                const previous = history[history.length - 2];
                liquidityFlowPct = previous.liquidityUSD > 0
                    ? (latest.liquidityUSD - previous.liquidityUSD) / previous.liquidityUSD
                    : 0;
            }
            return {
                poolId: p.address,
                swapVelocity: metrics.swapVelocity / 100, // Normalize from 0-100 to raw
                liquidityFlowPct,
                entropy: metrics.poolEntropy,
                feeIntensity: metrics.feeIntensity / 100,
                feeIntensityBaseline60s: avgBaseline60s,
                microScore: p.microScore,
            };
        });
        // Build kill switch context
        const killSwitchContext = {
            poolMetrics: killSwitchPoolMetrics,
            snapshotCount: totalSnapshotCount,
            runtimeMs: Date.now() - botStartTime,
            activeTradesCount: activePositions.length,
        };
        // Evaluate kill switch with new reduced-sensitivity logic
        const killDecision = (0, killSwitch_1.evaluateKillSwitch)(killSwitchContext);
        if (killDecision.killAll) {
            logger_1.default.error(`🚨 KILL SWITCH TRIGGERED: ${killDecision.reason}`);
            logger_1.default.error(`🚨 Liquidating all ${activePositions.length} positions and pausing for ${killDecision.pauseDurationMs / 60000} minutes`);
            // Signal kill switch to discovery cache for force refresh
            (0, discoveryCache_1.setKillSwitch)(true);
            let liquidatedCount = 0;
            for (const pos of activePositions) {
                const activeTrades = (0, Trade_1.getAllActiveTrades)();
                const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                if (trade) {
                    const exitResult = await (0, trading_1.exitPosition)(trade.id, {
                        exitPrice: 0,
                        reason: `KILL SWITCH: ${killDecision.reason}`,
                    }, 'KILL_SWITCH');
                    if (exitResult.success) {
                        liquidatedCount++;
                    }
                    else {
                        logger_1.default.info(`[GUARD] Kill switch exit blocked for ${trade.poolName}: ${exitResult.reason}`);
                    }
                }
                // NOTE: TRADE_EXIT log is now emitted by exitPosition - no duplicate EXIT log here
            }
            activePositions = [];
            await (0, supabase_1.logAction)('KILL_SWITCH', {
                reason: killDecision.reason,
                debug: killDecision.debug,
                positionsLiquidated: liquidatedCount,
                pauseDurationMs: killDecision.pauseDurationMs,
            });
            const duration = Date.now() - startTime;
            logger_1.default.info(`Cycle completed in ${duration}ms. Sleeping...`);
            return;
        }
        // Check if kill switch is pausing trading (cooldown or waiting for resume)
        if (killDecision.shouldPause) {
            const remainingSeconds = Math.ceil(killDecision.pauseDurationMs / 1000);
            logger_1.default.warn(`⏸️  Trading paused by kill switch. ${killDecision.reason}. Resuming in ${remainingSeconds}s`);
            return;
        }
        // ═══════════════════════════════════════════════════════════════════════
        // STAGE: EXECUTE (Entry/Exit/Monitor)
        // ═══════════════════════════════════════════════════════════════════════
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        logger_1.default.info('📍 STAGE: EXECUTE');
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        // Sort and deduplicate
        const sortedPools = microEnrichedPools.sort((a, b) => b.microScore - a.microScore);
        const deduplicatedPools = (0, arbitrage_1.deduplicatePools)(sortedPools);
        logger_1.default.info(`Deduplicated ${sortedPools.length} pools to ${deduplicatedPools.length} unique pairs`);
        // ═══════════════════════════════════════════════════════════════════════
        // GUARDRAIL: Zero qualified candidates after scoring
        // DO NOT reinitialize. Just wait for next scan cycle.
        // ═══════════════════════════════════════════════════════════════════════
        if (deduplicatedPools.length === 0) {
            logger_1.default.warn('[PREDATOR] No qualified pools after scoring. Waiting for next cycle...');
            (0, discoveryCache_1.recordNoEntryCycle)();
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
            const portfolioStatus = await executionEngine.getPortfolioStatus();
            const allocation = portfolioStatus.capital / 3;
            logger_1.default.info(`[EXEC] Allocating capital: $${allocation.toFixed(2)}`);
            logger_1.default.info(`[EXEC] Opening position: ${bestPool.tokenA.symbol}/${bestPool.tokenB.symbol}`);
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
            await executionEngine.update();
        }
        // Rotation engine
        const entriesThisCycle = await manageRotation(microEnrichedPools);
        // ═══════════════════════════════════════════════════════════════════════
        // STAGE: MONITOR (Update cache, track state, log summary)
        // ═══════════════════════════════════════════════════════════════════════
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        logger_1.default.info('📍 STAGE: MONITOR');
        logger_1.default.info('───────────────────────────────────────────────────────────────────');
        const duration = Date.now() - startTime;
        // ═══════════════════════════════════════════════════════════════════════
        // DISCOVERY CACHE STATE TRACKING
        // ═══════════════════════════════════════════════════════════════════════
        // Track no-entry cycles for discovery cache force refresh
        if (entriesThisCycle === 0) {
            (0, discoveryCache_1.recordNoEntryCycle)();
        }
        // Track dominant regime for regime flip detection
        // Use the most common regime from top pools
        const regimes = microEnrichedPools.slice(0, 10).map(p => p.regime);
        const regimeCounts = { BULL: 0, NEUTRAL: 0, BEAR: 0 };
        for (const r of regimes) {
            if (r && regimeCounts[r] !== undefined) {
                regimeCounts[r]++;
            }
        }
        const dominantRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0][0];
        (0, discoveryCache_1.updateRegime)(dominantRegime);
        // Clear kill switch if market recovered
        if (killDecision && !killDecision.killAll && !killDecision.shouldPause) {
            (0, discoveryCache_1.setKillSwitch)(false);
        }
        // Log current capital state
        const capitalState = await capitalManager_1.capitalManager.getFullState();
        logger_1.default.info('═══════════════════════════════════════════════════════════════════');
        logger_1.default.info('✅ SCAN CYCLE COMPLETE');
        logger_1.default.info('   INIT ✅ → DISCOVERY ✅ → CANDIDATES ✅ → SCORE ✅ → SIGNALS ✅ → EXECUTE ✅ → MONITOR ✅');
        logger_1.default.info('═══════════════════════════════════════════════════════════════════');
        logger_1.default.info(`Cycle completed in ${duration}ms. Entries: ${entriesThisCycle}. Sleeping...`);
        logger_1.default.info(`💰 Capital: Available=$${capitalState?.available_balance.toFixed(2) || 0} | Locked=$${capitalState?.locked_balance.toFixed(2) || 0} | P&L=$${capitalState?.total_realized_pnl.toFixed(2) || 0}`);
        // Log predator cycle summary
        (0, predatorController_1.logPredatorCycleSummary)(predatorSummary);
        // ═══════════════════════════════════════════════════════════════════════
        // CONSOLIDATED CYCLE PIPELINE SUMMARY
        // Shows the flow from discovery → filtering → scoring → entry eligible
        // ═══════════════════════════════════════════════════════════════════════
        logger_1.default.info('═══════════════════════════════════════════════════════════════');
        logger_1.default.info('📊 CYCLE PIPELINE SUMMARY');
        logger_1.default.info('═══════════════════════════════════════════════════════════════');
        logger_1.default.info(`  Discovery → Universe: ${poolUniverse.length} pools`);
        logger_1.default.info(`  Scoring → Candidates: ${microEnrichedPools.length} pools (telemetry valid: ${validCount})`);
        logger_1.default.info(`  MHI/Tier4 → Entry Eligible: ${predatorSummary.entryEligible} pools`);
        logger_1.default.info(`  Risk Engine → Entries This Cycle: ${entriesThisCycle}`);
        logger_1.default.info(`  Active Positions: ${activePositions.length}/${predatorController_1.PREDATOR_CONFIG.maxSimultaneousPools}`);
        logger_1.default.info('═══════════════════════════════════════════════════════════════');
        await (0, supabase_1.logAction)('HEARTBEAT', {
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
            predator: {
                mhiDistribution: predatorSummary.mhiTierCounts,
                predatorOpportunities: predatorSummary.predatorOpportunities,
                reinjectionReady: predatorSummary.readyForReinjection,
                structuralExitsPending: predatorSummary.pendingStructuralExits,
            },
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
        // Log full error details to help debug crashes
        logger_1.default.error(`❌ Error in scan cycle: ${error?.message || error}`, {
            stack: error?.stack,
            name: error?.name,
        });
        // DON'T rethrow - let the bot continue
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
    logger_1.default.info('💾 PERSISTENT CAPITAL MANAGEMENT ENABLED');
}
// ═══════════════════════════════════════════════════════════════════════════════
// CRASH PREVENTION - Global error handlers
// ═══════════════════════════════════════════════════════════════════════════════
process.on('uncaughtException', (error) => {
    logger_1.default.error(`[FATAL] Uncaught Exception: ${error.message}`, { stack: error.stack });
    // Don't exit - let PM2 restart if needed
});
process.on('unhandledRejection', (reason, promise) => {
    logger_1.default.error(`[FATAL] Unhandled Rejection at: ${promise}, reason: ${reason}`);
    // Don't exit - let PM2 restart if needed
});
// Cleanup on exit
process.on('SIGINT', () => {
    logger_1.default.info('Shutting down...');
    (0, dlmmTelemetry_1.cleanup)();
    (0, predatorController_1.clearPredatorState)();
    if (telemetryRefreshTimer) {
        clearInterval(telemetryRefreshTimer);
    }
    process.exit(0);
});
process.on('SIGTERM', () => {
    logger_1.default.info('Shutting down...');
    (0, dlmmTelemetry_1.cleanup)();
    (0, predatorController_1.clearPredatorState)();
    if (telemetryRefreshTimer) {
        clearInterval(telemetryRefreshTimer);
    }
    process.exit(0);
});
// Start the bot with full error protection
main().catch((error) => {
    logger_1.default.error(`[FATAL] Main function crashed: ${error.message}`, { stack: error.stack });
    // Don't call process.exit - let PM2 handle restart
});
//# sourceMappingURL=index.js.map