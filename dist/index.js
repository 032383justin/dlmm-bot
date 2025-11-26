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
const scanPools_1 = require("./core/scanPools");
const state_1 = require("./utils/state");
const normalizePools_1 = require("./core/normalizePools");
const safetyFilters_1 = require("./core/safetyFilters");
const volume_1 = require("./core/volume");
const dilution_1 = require("./core/dilution");
const scorePool_1 = require("./scoring/scorePool");
const supabase_1 = require("./db/supabase");
const logger_1 = __importDefault(require("./utils/logger"));
const volatility_1 = require("./utils/volatility");
const arbitrage_1 = require("./utils/arbitrage");
// Microstructure brain imports
const dlmmTelemetry_1 = require("./core/dlmmTelemetry");
const structuralEntry_1 = require("./core/structuralEntry");
const structuralExit_1 = require("./core/structuralExit");
const killSwitch_1 = require("./core/killSwitch");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const LOOP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_HOLD_TIME_MS = 4 * 60 * 60 * 1000; // 4 hours
// Paper Trading Mode
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const PAPER_CAPITAL = parseFloat(process.env.PAPER_CAPITAL || '10000');
const RESET_STATE = process.env.RESET_STATE === 'true';
let paperTradingBalance = PAPER_CAPITAL;
let paperTradingPnL = 0;
let activePositions = [];
// Microstructure brain state
const binSnapshotHistory = new Map(); // poolId -> snapshots
const MAX_HISTORY_LENGTH = 20; // Keep last 20 snapshots per pool
let killSwitchPauseUntil = 0; // Timestamp when trading can resume after kill switch
const poolStates = {}; // Global pool state tracker
// Bin history database throttle (save every 5-10 seconds per pool to minimize costs)
const lastBinHistorySave = new Map(); // poolId -> last save timestamp
const BIN_HISTORY_SAVE_INTERVAL = 7000; // 7 seconds between saves per pool
// Token categorization for diversification
const categorizeToken = (pool) => {
    const name = pool.name.toUpperCase();
    // Stablecoins
    if (name.includes('USDC') || name.includes('USDT') || name.includes('DAI')) {
        return 'stable';
    }
    // Blue-chip: ONLY major tokens
    const blueChips = ['SOL', 'BTC', 'WBTC', 'ETH', 'JUP', 'JLP', 'JITOSOL'];
    for (const token of blueChips) {
        if (name === token || name.startsWith(token + '-') || name.endsWith('-' + token)) {
            return 'blue-chip';
        }
    }
    // Everything else is a meme/alt
    return 'meme';
};
const runBot = async () => {
    // Load saved paper trading state on first run
    if (PAPER_TRADING) {
        if (RESET_STATE) {
            logger_1.default.warn('🔄 RESET MODE: Starting fresh with clean slate');
            paperTradingBalance = PAPER_CAPITAL;
            paperTradingPnL = 0;
            await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
            // Clear all active positions from database
            const { supabase } = await Promise.resolve().then(() => __importStar(require('./db/supabase')));
            const { data: existingEntries } = await supabase
                .from('bot_logs')
                .select('*')
                .eq('action', 'ENTRY');
            if (existingEntries && existingEntries.length > 0) {
                logger_1.default.info(`🗑️  Found ${existingEntries.length} existing ENTRY logs to clear`);
                // We don't actually delete them, just log that we're starting fresh
                // The rebuild logic will handle finding active positions
            }
            logger_1.default.info(`✅ Reset complete: Balance=$${paperTradingBalance.toFixed(2)}, Total P&L=$${paperTradingPnL.toFixed(2)}`);
            logger_1.default.warn('⚠️  IMPORTANT: Set RESET_STATE=false in .env to prevent resetting on next restart!');
        }
        else {
            const savedState = await (0, state_1.loadPaperTradingState)();
            if (savedState) {
                paperTradingBalance = savedState.balance;
                paperTradingPnL = savedState.totalPnL;
                // Auto-correct balance if it doesn't match Capital + PnL
                const expectedBalance = PAPER_CAPITAL + paperTradingPnL;
                if (Math.abs(paperTradingBalance - expectedBalance) > 0.01) {
                    logger_1.default.warn(`⚠️ Balance mismatch detected! Saved: $${paperTradingBalance.toFixed(2)}, Expected: $${expectedBalance.toFixed(2)}`);
                    logger_1.default.info(`🔄 Auto-correcting balance to $${expectedBalance.toFixed(2)}`);
                    paperTradingBalance = expectedBalance;
                    await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
                }
                logger_1.default.info(`📊 Loaded saved state: Balance=$${paperTradingBalance.toFixed(2)}, Total P&L=$${paperTradingPnL.toFixed(2)}`);
            }
            else {
                // No saved state - start fresh at initial capital
                // Don't recalculate from logs as they may contain stale data from before resets
                logger_1.default.warn('📊 No saved state found. Starting fresh at initial capital.');
                paperTradingBalance = PAPER_CAPITAL;
                paperTradingPnL = 0;
                await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
            }
        }
    }
    if (PAPER_TRADING) {
        logger_1.default.info('🎮 PAPER TRADING MODE ENABLED 🎮');
        logger_1.default.info('No real money will be used. All trades are simulated.');
    }
    else {
        logger_1.default.info('Starting DLMM Rotation Bot...');
        logger_1.default.warn('⚠️  LIVE TRADING MODE - Real money at risk!');
    }
    // Rebuild active positions from database on startup
    logger_1.default.info('🔄 Rebuilding active positions from database...');
    const { supabase } = await Promise.resolve().then(() => __importStar(require('./db/supabase')));
    const { data: allLogs } = await supabase
        .from('bot_logs')
        .select('*')
        .in('action', ['ENTRY', 'EXIT'])
        .order('timestamp', { ascending: true });
    // AUTO-SYNC PnL FROM LOGS (Fix for balance mismatch)
    if (PAPER_TRADING && allLogs) {
        const exitLogs = allLogs.filter((l) => l.action === 'EXIT');
        if (exitLogs.length > 0) {
            const lastExit = exitLogs[exitLogs.length - 1];
            const lastPnL = lastExit.details?.paperPnL;
            if (lastPnL !== undefined && typeof lastPnL === 'number') {
                if (Math.abs(lastPnL - paperTradingPnL) > 0.01) {
                    logger_1.default.warn(`⚠️ PnL Mismatch detected! Saved: $${paperTradingPnL.toFixed(2)}, Logged: $${lastPnL.toFixed(2)}`);
                    logger_1.default.info(`🔄 Syncing PnL from last EXIT log...`);
                    paperTradingPnL = lastPnL;
                    paperTradingBalance = PAPER_CAPITAL + paperTradingPnL;
                    await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
                    logger_1.default.info(`✅ State synced: Balance=$${paperTradingBalance.toFixed(2)}, PnL=$${paperTradingPnL.toFixed(2)}`);
                }
            }
        }
    }
    if (allLogs) {
        const entryMap = new Map();
        const exitedPools = new Set();
        for (const log of allLogs) {
            if (log.action === 'ENTRY') {
                const pool = log.details?.pool;
                const amount = log.details?.amount;
                const score = log.details?.score;
                const type = log.details?.type;
                if (pool && amount) {
                    entryMap.set(pool, {
                        poolAddress: pool,
                        entryTime: new Date(log.timestamp).getTime(),
                        entryScore: score || 0,
                        entryPrice: 0, // No historical price data available
                        peakScore: score || 0,
                        amount,
                        entryTVL: 0,
                        entryVelocity: 0,
                        consecutiveCycles: 1,
                        consecutiveLowVolumeCycles: 0,
                        tokenType: type || 'unknown'
                    });
                }
            }
            else if (log.action === 'EXIT') {
                const pool = log.details?.pool;
                if (pool)
                    exitedPools.add(pool);
            }
        }
        // Remove exited positions
        for (const pool of exitedPools) {
            entryMap.delete(pool);
        }
        activePositions = Array.from(entryMap.values());
        logger_1.default.info(`✅ Recovered ${activePositions.length} active positions from database`);
    }
    const manageRotation = async (rankedPools) => {
        const now = Date.now();
        const remainingPositions = [];
        let exitSignalCount = 0;
        // 1. Check Exits with Advanced Triggers
        for (const pos of activePositions) {
            const pool = rankedPools.find(p => p.address === pos.poolAddress);
            if (!pool) {
                logger_1.default.warn(`Active pool ${pos.poolAddress} not found in ranked list. Skipping exit check this cycle.`);
                remainingPositions.push(pos);
                continue;
            }
            const holdTime = now - pos.entryTime;
            // Update peak score for trailing stop-loss
            if (pool.score > pos.peakScore) {
                pos.peakScore = pool.score;
            }
            // --- ACTIVE PROFIT TAKING (Scale Out Strategy) ---
            // Sell into strength to lock in gains
            if (pool.currentPrice > 0 && pos.entryPrice > 0) {
                const priceChangePct = (pool.currentPrice - pos.entryPrice) / pos.entryPrice;
                // Level 1: +15% gain -> Sell 25%
                if (priceChangePct >= 0.15 && !pos.tookProfit1) {
                    const sellAmount = pos.amount * 0.25;
                    const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
                    const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
                    const estimatedReturn = sellAmount * dailyYield * (holdTimeHours / 24);
                    if (PAPER_TRADING) {
                        paperTradingPnL += estimatedReturn;
                        paperTradingBalance += estimatedReturn;
                        await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
                    }
                    pos.amount -= sellAmount;
                    pos.tookProfit1 = true;
                    logger_1.default.info(`[PROFIT TAKING L1] ${pool.name} +${(priceChangePct * 100).toFixed(1)}% - Sold 25% ($${sellAmount.toFixed(0)})`);
                    logger_1.default.info(`[PAPER] P&L: +$${estimatedReturn.toFixed(2)} | Total: $${paperTradingPnL.toFixed(2)} | Remaining: $${pos.amount.toFixed(0)}`);
                    await (0, supabase_1.logAction)('EXIT', {
                        pool: pool.address,
                        reason: 'Profit Taking L1 (+15%)',
                        peakScore: pos.peakScore,
                        currentScore: pool.score,
                        paperTrading: PAPER_TRADING,
                        paperPnL: PAPER_TRADING ? paperTradingPnL : undefined
                    });
                }
                // Level 2: +30% gain -> Sell another 25%
                if (priceChangePct >= 0.30 && !pos.tookProfit2) {
                    const sellAmount = pos.amount * 0.25;
                    const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
                    const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
                    const estimatedReturn = sellAmount * dailyYield * (holdTimeHours / 24);
                    if (PAPER_TRADING) {
                        paperTradingPnL += estimatedReturn;
                        paperTradingBalance += estimatedReturn;
                        await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
                    }
                    pos.amount -= sellAmount;
                    pos.tookProfit2 = true;
                    logger_1.default.info(`[PROFIT TAKING L2] ${pool.name} +${(priceChangePct * 100).toFixed(1)}% - Sold 25% ($${sellAmount.toFixed(0)})`);
                    logger_1.default.info(`[PAPER] P&L: +$${estimatedReturn.toFixed(2)} | Total: $${paperTradingPnL.toFixed(2)} | Remaining: $${pos.amount.toFixed(0)}`);
                    await (0, supabase_1.logAction)('EXIT', {
                        pool: pool.address,
                        reason: 'Profit Taking L2 (+30%)',
                        peakScore: pos.peakScore,
                        currentScore: pool.score,
                        paperTrading: PAPER_TRADING,
                        paperPnL: PAPER_TRADING ? paperTradingPnL : undefined
                    });
                }
            }
            // --- EMERGENCY EXIT CONDITIONS (bypass 4-hour minimum) ---
            // Exit immediately if catastrophic deterioration occurs
            const tvlCrash = (pos.entryTVL - pool.liquidity) / pos.entryTVL;
            const velocityCrash = (pos.entryVelocity - pool.velocity) / pos.entryVelocity;
            const scoreCrash = (pos.entryScore - pool.score) / pos.entryScore;
            // TIGHTENED: Lowered from 50% to 30% for faster risk response
            const emergencyExit = (tvlCrash > 0.30 || // 30%+ TVL drop = liquidity crisis
                velocityCrash > 0.30 || // 30%+ velocity drop = volume dried up
                scoreCrash > 0.30 || // 30%+ score drop = massive deterioration
                pool.score < 40 // Current score dropped below 40 = exit immediately
            );
            if (emergencyExit) {
                const reason = tvlCrash > 0.30 ? "Emergency: TVL Crash (-30%)" :
                    velocityCrash > 0.30 ? "Emergency: Volume Crash (-30%)" :
                        pool.score < 40 ? "Emergency: Score Below 40" :
                            "Emergency: Score Crash (-30%)";
                if (PAPER_TRADING) {
                    const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
                    const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
                    const estimatedReturn = pos.amount * dailyYield * (holdTimeHours / 24);
                    paperTradingPnL += estimatedReturn;
                    paperTradingBalance += estimatedReturn;
                    await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
                    logger_1.default.warn(`[PAPER] ${reason} - Exiting ${pool.name} immediately (held ${(holdTimeHours * 60).toFixed(0)} min)`);
                    logger_1.default.info(`[PAPER] P&L: ${estimatedReturn >= 0 ? "+" : ""}$${estimatedReturn.toFixed(2)} | Total: $${paperTradingPnL.toFixed(2)}`);
                }
                await (0, supabase_1.logAction)('EXIT', {
                    pool: pool.address,
                    reason,
                    emergencyExit: true,
                    holdTimeMinutes: (now - pos.entryTime) / (1000 * 60),
                    tvlDrop: tvlCrash,
                    velocityDrop: velocityCrash,
                    scoreDrop: scoreCrash,
                    currentScore: pool.score,
                    paperTrading: PAPER_TRADING,
                    paperPnL: PAPER_TRADING ? paperTradingPnL : undefined
                });
                exitSignalCount++;
                continue;
            }
            // Min hold time check - BYPASS for low-quality positions
            // Low-scoring positions (<55) can exit anytime, high-quality positions need 6 hours for better returns
            const MIN_HOLD_TIME_HIGH_QUALITY = 6 * 60 * 60 * 1000; // 6 hours for scores 80+
            const bypassMinHold = pos.entryScore < 55;
            const requiredHoldTime = pos.entryScore >= 80 ? MIN_HOLD_TIME_HIGH_QUALITY : MIN_HOLD_TIME_MS;
            if (holdTime < requiredHoldTime && !bypassMinHold) {
                remainingPositions.push(pos);
                continue;
            }
            // --- EXIT TRIGGERS ---
            // 1. Dynamic Trailing Stop-Loss (adjusts based on volatility)
            const volatility = (0, volatility_1.calculateVolatility)(pool);
            let trailingStopPct = 0.10; // Default 10%
            if (volatility.classification === 'high') {
                trailingStopPct = 0.20; // 20% for high volatility (give more room)
            }
            else if (volatility.classification === 'medium') {
                trailingStopPct = 0.15; // 15% for medium volatility
            }
            // Low volatility stays at 10%
            const trailingStopTriggered = pool.score < (pos.peakScore * (1 - trailingStopPct));
            // 2. TVL Drop (from entry)
            const tvlDrop = (pos.entryTVL - pool.liquidity) / pos.entryTVL;
            const tvlDropTriggered = tvlDrop > 0.20; // 20% TVL drop
            // 3. Velocity Drop (from entry)
            const velocityDrop = (pos.entryVelocity - pool.velocity) / pos.entryVelocity;
            const velocityDropTriggered = velocityDrop > 0.25; // 25% velocity drop
            // 4. Volume-based exit (with profit protection and confirmation)
            const volumeExitTriggered = await (0, volume_1.checkVolumeExitTrigger)(pool);
            // PROFIT PROTECTION: If position is profitable, ignore volume exit
            let shouldApplyVolumeExit = volumeExitTriggered;
            if (volumeExitTriggered && PAPER_TRADING) {
                const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
                const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
                const estimatedReturn = pos.amount * dailyYield * (holdTimeHours / 24);
                if (estimatedReturn > 0) {
                    // Position is profitable - ignore volume exit, use trailing stop instead
                    shouldApplyVolumeExit = false;
                    logger_1.default.info(`[PROFIT PROTECTED] Ignoring volume exit for profitable position ${pool.name} (+$${estimatedReturn.toFixed(2)})`);
                }
            }
            // CONFIRMATION REQUIREMENT: Require 2 consecutive cycles of low volume
            if (shouldApplyVolumeExit) {
                pos.consecutiveLowVolumeCycles++;
                if (pos.consecutiveLowVolumeCycles < 2) {
                    // Not enough confirmation yet - keep position
                    shouldApplyVolumeExit = false;
                    logger_1.default.info(`[CONFIRMATION] Volume exit triggered for ${pool.name}, waiting for confirmation (${pos.consecutiveLowVolumeCycles}/2)`);
                }
            }
            else {
                // Reset counter if volume is good
                pos.consecutiveLowVolumeCycles = 0;
            }
            // MICROSTRUCTURE BRAIN: Structural exit evaluation
            let structuralExitTriggered = false;
            if (pool.binSnapshot && pool.binScores) {
                const history = binSnapshotHistory.get(pool.address) || [];
                const exitDecision = (0, structuralExit_1.evaluateExit)(pool.binSnapshot, history, pool.binScores);
                structuralExitTriggered = exitDecision.exit;
                if (structuralExitTriggered) {
                    logger_1.default.warn(`[DLMM] Structural exit triggered for ${pool.name}: ${exitDecision.reason}`);
                }
            }
            const shouldExit = trailingStopTriggered || tvlDropTriggered || velocityDropTriggered || shouldApplyVolumeExit || structuralExitTriggered;
            if (shouldExit) {
                const reason = trailingStopTriggered ? 'Trailing Stop' :
                    tvlDropTriggered ? 'TVL Drop' :
                        velocityDropTriggered ? 'Velocity Drop' :
                            structuralExitTriggered ? 'Structural Exit (DLMM)' : 'Volume Exit';
                // Calculate P&L for paper trading
                if (PAPER_TRADING) {
                    const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
                    const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
                    const estimatedReturn = pos.amount * dailyYield * (holdTimeHours / 24);
                    paperTradingPnL += estimatedReturn;
                    paperTradingBalance += estimatedReturn;
                    await (0, state_1.savePaperTradingState)(paperTradingBalance, paperTradingPnL);
                    logger_1.default.info(`[PAPER] Rotating OUT of ${pool.name}. Reason: ${reason}. Peak: ${pos.peakScore.toFixed(2)}, Current: ${pool.score.toFixed(2)}`);
                    logger_1.default.info(`[PAPER] P&L: +$${estimatedReturn.toFixed(2)} | Total P&L: $${paperTradingPnL.toFixed(2)} | Balance: $${paperTradingBalance.toFixed(2)}`);
                }
                else {
                    logger_1.default.info(`Rotating OUT of ${pool.name}. Reason: ${reason}. Peak: ${pos.peakScore.toFixed(2)}, Current: ${pool.score.toFixed(2)}`);
                }
                await (0, supabase_1.logAction)('EXIT', {
                    pool: pool.address,
                    reason,
                    peakScore: pos.peakScore,
                    currentScore: pool.score,
                    paperTrading: PAPER_TRADING,
                    paperPnL: PAPER_TRADING ? paperTradingPnL : undefined
                });
                exitSignalCount++;
            }
            else {
                remainingPositions.push(pos);
            }
        }
        // Correlation-Based Exit: If 3+ pools exiting, market crash likely
        if (exitSignalCount >= 3 && activePositions.length >= 3) {
            logger_1.default.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit. Exiting ALL positions.`);
            activePositions = [];
            await (0, supabase_1.logAction)('MARKET_CRASH_EXIT', { exitSignalCount });
            return; // Skip entry logic this cycle
        }
        activePositions = remainingPositions;
        // 2. Check Entries with Multi-Timeframe Confirmation & Diversification
        // 2. Check Entries with Dynamic Score-Weighted Allocation
        // Calculate available capital
        const totalCapital = PAPER_TRADING ? paperTradingBalance : parseFloat(process.env.TOTAL_CAPITAL || '10000');
        const deployedCapital = activePositions.reduce((sum, p) => sum + p.amount, 0);
        let availableCapital = totalCapital - deployedCapital;
        // Safety check: Ensure we don't spend more than we have
        if (availableCapital < 0)
            availableCapital = 0;
        // For position sizing caps, use STARTING capital (not current balance which includes profits)
        const startingCapital = parseFloat(process.env.PAPER_CAPITAL || '10000');
        // Filter candidates first to find "Valid Opportunities"
        const validCandidates = [];
        // Count current positions by type for diversification
        const typeCount = {
            'stable': activePositions.filter(p => p.tokenType === 'stable').length,
            'blue-chip': activePositions.filter(p => p.tokenType === 'blue-chip').length,
            'meme': activePositions.filter(p => p.tokenType === 'meme').length
        };
        for (const candidate of rankedPools) {
            if (activePositions.length + validCandidates.length >= 5)
                break; // Max 5 positions total
            // Check if already active
            if (activePositions.find(p => p.poolAddress === candidate.address))
                continue;
            // Diversification: Max 2 positions per token type
            const candidateType = categorizeToken(candidate);
            // if (typeCount[candidateType as keyof typeof typeCount] >= 2) continue; // (Commented out in original, keeping consistent)
            // Check for duplicate token pairs
            const activePools = activePositions.map(pos => rankedPools.find(p => p.address === pos.poolAddress)).filter((p) => p !== undefined);
            if ((0, arbitrage_1.isDuplicatePair)(candidate, activePools)) {
                logger_1.default.info(`Skipping ${candidate.name} - duplicate token pair`);
                continue;
            }
            // QUALITY FILTER: Minimum score threshold (balanced for market conditions)
            // Only enter quality pools with good yield potential
            const MIN_SCORE_THRESHOLD = 55;
            if (candidate.score < MIN_SCORE_THRESHOLD) {
                logger_1.default.info(`Skipping ${candidate.name} - score ${candidate.score.toFixed(1)} below threshold ${MIN_SCORE_THRESHOLD}`);
                continue;
            }
            // Check entry trigger
            const entrySignal = await (0, volume_1.checkVolumeEntryTrigger)(candidate);
            // MICROSTRUCTURE BRAIN: Structural entry evaluation
            let structuralEntrySignal = true; // Default to true if no bin scores available
            if (candidate.binScores) {
                const history = binSnapshotHistory.get(candidate.address) || [];
                const entryDecision = (0, structuralEntry_1.evaluateEntry)(candidate.binScores, history);
                structuralEntrySignal = entryDecision.enter;
                if (!structuralEntrySignal) {
                    logger_1.default.info(`⏳ [DLMM] Waiting on ${candidate.name} - Structural entry not favorable: ${entryDecision.reason}`);
                }
            }
            // Both volume AND structural signals must agree
            if (entrySignal && structuralEntrySignal) {
                validCandidates.push({ pool: candidate, type: candidateType });
                // Increment type count temporarily to prevent stacking same type in one cycle if we were enforcing it
                typeCount[candidateType]++;
            }
            else {
                if (!entrySignal) {
                    logger_1.default.info(`⏳ Waiting on ${candidate.name} (Score ${candidate.score.toFixed(1)}) - Entry triggers not met (Vol/Vel)`);
                }
            }
        }
        if (validCandidates.length > 0) {
            // Calculate Total Score of all valid candidates
            const totalScoreSum = validCandidates.reduce((sum, c) => sum + c.pool.score, 0);
            logger_1.default.info(`Found ${validCandidates.length} valid candidates. Total Score Sum: ${totalScoreSum.toFixed(2)}`);
            for (const { pool, type } of validCandidates) {
                // --- DYNAMIC ALLOCATION LOGIC ---
                // Weight = PoolScore / TotalScoreSum
                // Raw Allocation = AvailableCapital * Weight
                const weight = pool.score / totalScoreSum;
                let amount = availableCapital * weight;
                // --- ADJUSTMENTS ---
                // 1. Volatility Adjustment
                const volatilityMultiplier = (0, volatility_1.getVolatilityMultiplier)(pool);
                amount *= volatilityMultiplier;
                // 2. Time-of-Day Adjustment
                const { getTimeOfDayMultiplier } = require('./utils/timeOfDay');
                const timeMultiplier = getTimeOfDayMultiplier();
                amount *= timeMultiplier;
                // 3. Small Pool Safety
                if (pool.liquidity < 100000) {
                    amount *= 0.5;
                }
                // 4. Liquidity Cap: Max 5% of Pool TVL
                const maxAllowed = pool.liquidity * 0.05;
                if (amount > maxAllowed) {
                    amount = maxAllowed;
                }
                // 7. CRITICAL FIX: Final safety check - ensure we never allocate more than we have
                if (availableCapital < amount) {
                    logger_1.default.error(`❌ CRITICAL: Attempting to allocate $${amount.toFixed(0)} but only $${availableCapital.toFixed(0)} available!`);
                    amount = availableCapital;
                }
                // Skip if amount is too small (less than $10)
                if (amount < 10) {
                    logger_1.default.info(`⏭️  Skipping ${pool.name}: Allocation too small ($${amount.toFixed(2)})`);
                    continue;
                }
                // Deduct from available for next iteration
                availableCapital -= amount;
                // CRITICAL FIX: Safety check to prevent negative available capital
                if (availableCapital < 0) {
                    logger_1.default.error(`❌ CRITICAL: availableCapital went negative ($${availableCapital.toFixed(2)})! This should never happen.`);
                    availableCapital = 0;
                }
                // --- ALLOCATION TRACKING & WARNINGS ---
                const totalDeployed = activePositions.reduce((sum, p) => sum + p.amount, 0) + amount;
                const deploymentPct = (totalDeployed / totalCapital) * 100;
                const positionPct = (amount / totalCapital) * 100;
                const prefix = PAPER_TRADING ? '[PAPER] ' : '';
                logger_1.default.info(`${prefix}Rotating INTO ${pool.name}. Score: ${pool.score.toFixed(2)} (Weight: ${(weight * 100).toFixed(1)}%)`);
                logger_1.default.info(`💰 Allocation: $${amount.toFixed(0)} (${positionPct.toFixed(1)}% of total capital)`);
                logger_1.default.info(`📊 Total Deployed: $${totalDeployed.toFixed(0)} / $${totalCapital.toFixed(0)} (${deploymentPct.toFixed(1)}%)`);
                logger_1.default.info(`💵 Remaining Available: $${availableCapital.toFixed(0)} (${((availableCapital / totalCapital) * 100).toFixed(1)}%)`);
                // CRITICAL ERROR: Alert if deployment exceeds 100%
                if (deploymentPct > 100) {
                    logger_1.default.error(`❌ CRITICAL BUG: Total deployment ${deploymentPct.toFixed(1)}% exceeds 100%!`);
                    logger_1.default.error(`   Total Capital: $${totalCapital.toFixed(0)}`);
                    logger_1.default.error(`   Total Deployed: $${totalDeployed.toFixed(0)}`);
                    logger_1.default.error(`   This Position: $${amount.toFixed(0)}`);
                    // Don't add this position - we've exceeded 100%
                    continue;
                }
                // Warning if approaching 100%
                if (deploymentPct > 95) {
                    logger_1.default.warn(`⚠️  WARNING: Total deployment at ${deploymentPct.toFixed(1)}% - approaching full deployment`);
                }
                activePositions.push({
                    poolAddress: pool.address,
                    entryTime: now,
                    entryScore: pool.score,
                    entryPrice: pool.currentPrice, // Track entry price for profit taking
                    peakScore: pool.score,
                    amount: amount,
                    entryTVL: pool.liquidity,
                    entryVelocity: pool.velocity,
                    consecutiveCycles: 1,
                    consecutiveLowVolumeCycles: 0,
                    tokenType: type
                });
                await (0, supabase_1.logAction)('ENTRY', {
                    pool: pool.address,
                    poolName: pool.name,
                    score: pool.score,
                    amount,
                    type: type,
                    paperTrading: PAPER_TRADING,
                    paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
                });
            }
        }
    };
    while (true) {
        try {
            logger_1.default.info('--- Starting Scan Cycle ---');
            const startTime = Date.now();
            // 1. Scan & Normalize (using Meteora data only for speed)
            const rawPools = await (0, scanPools_1.scanPools)();
            let pools = await (0, normalizePools_1.normalizePools)(rawPools);
            // 2. Filter & Enrich
            const activeAddresses = new Set(activePositions.map(p => p.poolAddress));
            const candidates = pools.filter(p => {
                // ALWAYS keep active pools, even if they fail safety filters (so we can manage exits)
                if (activeAddresses.has(p.address)) {
                    return true;
                }
                const { passed, reason } = (0, safetyFilters_1.applySafetyFilters)(p);
                return passed;
            });
            logger_1.default.info(`Found ${candidates.length} candidates after safety filters.`);
            // 3. Deep Analysis (Dilution, Volume Triggers)
            // Sort by 24h volume first to get top candidates
            let topCandidates = candidates.sort((a, b) => b.volume24h - a.volume24h).slice(0, 15);
            // CRITICAL: Ensure active positions are ALWAYS included in analysis
            // If an active pool drops out of top 15, we must still track it for exit signals
            // activeAddresses is already defined above
            const missingActivePools = candidates.filter(p => activeAddresses.has(p.address) && !topCandidates.find(tc => tc.address === p.address));
            if (missingActivePools.length > 0) {
                logger_1.default.info(`Adding ${missingActivePools.length} active pools to analysis list to ensure monitoring`);
                topCandidates = [...topCandidates, ...missingActivePools];
            }
            // NOW fetch real Birdeye data for only these top 15 candidates (optimized for $99/month plan)
            const { enrichPoolsWithRealData } = await Promise.resolve().then(() => __importStar(require('./core/normalizePools')));
            const enrichedCandidates = await enrichPoolsWithRealData(topCandidates);
            for (const pool of enrichedCandidates) {
                pool.dilutionScore = await (0, dilution_1.calculateDilutionScore)(pool);
                pool.riskScore = (0, safetyFilters_1.calculateRiskScore)(pool);
                pool.score = (0, scorePool_1.scorePool)(pool);
                await (0, supabase_1.saveSnapshot)(pool);
                // MICROSTRUCTURE BRAIN: Fetch DLMM state and score bins
                try {
                    const binSnapshot = await (0, dlmmTelemetry_1.getDLMMState)(pool.address);
                    // Append to history
                    if (!binSnapshotHistory.has(pool.address)) {
                        binSnapshotHistory.set(pool.address, []);
                    }
                    const history = binSnapshotHistory.get(pool.address);
                    history.push(binSnapshot);
                    // Keep only last MAX_HISTORY_LENGTH snapshots
                    if (history.length > MAX_HISTORY_LENGTH) {
                        history.shift();
                    }
                    // Score bins using current snapshot and history
                    // MICROSTRUCTURE BRAIN: Kill switch check (before any trading decisions)
                    const allSnapshots = Array.from(binSnapshotHistory.values()).flat();
                    const killDecision = (0, killSwitch_1.evaluateKill)(allSnapshots, activePositions);
                    if (killDecision.killAll) {
                        logger_1.default.error(`🚨 KILL SWITCH ACTIVATED: ${killDecision.reason}`);
                        logger_1.default.error('🚨 Liquidating all positions and pausing trading for 10 minutes');
                        // Liquidate all positions
                        for (const pos of activePositions) {
                            await (0, supabase_1.logAction)('EXIT', {
                                pool: pos.poolAddress,
                                reason: `KILL SWITCH: ${killDecision.reason}`,
                                emergencyExit: true,
                                paperTrading: PAPER_TRADING,
                                paperPnL: PAPER_TRADING ? paperTradingPnL : undefined
                            });
                        }
                        activePositions = [];
                        killSwitchPauseUntil = Date.now() + (10 * 60 * 1000); // Pause for 10 minutes
                        await (0, supabase_1.logAction)('KILL_SWITCH', {
                            reason: killDecision.reason,
                            positionsLiquidated: activePositions.length,
                            pauseUntil: new Date(killSwitchPauseUntil).toISOString()
                        });
                        // Skip rotation this cycle
                        const duration = Date.now() - startTime;
                        logger_1.default.info(`Cycle completed in ${duration}ms. Sleeping...`);
                        await (0, supabase_1.logAction)('HEARTBEAT', {
                            duration,
                            candidates: candidates.length,
                            paperTrading: PAPER_TRADING,
                            paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
                        });
                        continue; // Skip to next cycle
                    }
                    // Check if kill switch pause is still active
                    if (killSwitchPauseUntil > Date.now()) {
                        const remainingSeconds = Math.ceil((killSwitchPauseUntil - Date.now()) / 1000);
                        logger_1.default.warn(`⏸️  Trading paused by kill switch. Resuming in ${remainingSeconds}s`);
                        const duration = Date.now() - startTime;
                        await (0, supabase_1.logAction)('HEARTBEAT', {
                            duration,
                            candidates: candidates.length,
                            paperTrading: PAPER_TRADING,
                            paperBalance: PAPER_TRADING ? paperTradingBalance : undefined,
                            killSwitchPaused: true
                        });
                        continue; // Skip to next cycle
                    }
                    // Sort by Score
                    const sortedPools = enrichedCandidates.sort((a, b) => b.score - a.score);
                    // Deduplicate: Remove duplicate token pairs, keep best pool per pair
                    const deduplicatedPools = (0, arbitrage_1.deduplicatePools)(sortedPools);
                    logger_1.default.info(`Deduplicated ${sortedPools.length} pools to ${deduplicatedPools.length} unique pairs`);
                    const topPools = deduplicatedPools.slice(0, 5);
                    logger_1.default.info('Top 5 Pools', { pools: topPools.map(p => `${p.name} (${p.score.toFixed(2)})`) });
                    // 4. Rotation Engine (with microstructure brain integration)
                    await manageRotation(sortedPools);
                    const duration = Date.now() - startTime;
                    logger_1.default.info(`Cycle completed in ${duration}ms. Sleeping...`);
                    // Log heartbeat to Supabase for dashboard status
                    await (0, supabase_1.logAction)('HEARTBEAT', {
                        duration,
                        candidates: candidates.length,
                        paperTrading: PAPER_TRADING,
                        paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
                    });
                }
                catch (error) {
                    logger_1.default.error('Error fetching DLMM state:', error);
                }
            }
            await new Promise(resolve => setTimeout(resolve, LOOP_INTERVAL_MS));
        }
        catch (error) {
            logger_1.default.error('❌ Error in main scan loop:', error);
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s before retry
        }
    }
    // Start
    runBot();
};
runBot().catch(console.error);
//# sourceMappingURL=index.js.map