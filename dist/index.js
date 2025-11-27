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
// REMOVED: Static pool imports - now using dynamic discovery
// import { DLMM_POOLS } from './config/pools';
// import { adaptDLMMPools } from './config/dlmmPoolAdapter';
const dlmmIndexer_1 = require("./services/dlmmIndexer");
const structuralEntry_1 = require("./core/structuralEntry");
const trading_1 = require("./core/trading");
const structuralExit_1 = require("./core/structuralExit");
const killSwitch_1 = require("./core/killSwitch");
const ExecutionEngine_1 = require("./engine/ExecutionEngine");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// Initialization guard - MUST BE AT TOP - prevents re-initialization
let BOT_INITIALIZED = false;
// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const LOOP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_HOLD_TIME_MS = 4 * 60 * 60 * 1000; // 4 hours
const EXECUTION_MIN_SCORE = 24; // Minimum score to open execution engine position
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
// Microstructure brain state
const binSnapshotHistory = new Map();
const MAX_HISTORY_LENGTH = 30;
let killSwitchPauseUntil = 0;
const poolStates = {};
// Bin history database throttle
const lastBinHistorySave = new Map();
const BIN_HISTORY_SAVE_INTERVAL = 7000;
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
// INITIALIZATION (runs ONCE on startup)
// ═══════════════════════════════════════════════════════════════════════════════
async function initializeBot() {
    if (BOT_INITIALIZED) {
        logger_1.default.debug('[INIT] initializeBot skipped — already initialized');
        return;
    }
    BOT_INITIALIZED = true;
    logger_1.default.info('[INIT] 🚀 INITIALIZING BOT...');
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
    // 1. Check Exits with Advanced Triggers
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
        // ACTIVE PROFIT TAKING
        if (pool.currentPrice > 0 && pos.entryPrice > 0) {
            const priceChangePct = (pool.currentPrice - pos.entryPrice) / pos.entryPrice;
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
        // EMERGENCY EXIT
        const tvlCrash = (pos.entryTVL - pool.liquidity) / pos.entryTVL;
        const velocityCrash = (pos.entryVelocity - pool.velocity) / pos.entryVelocity;
        const scoreCrash = (pos.entryScore - pool.score) / pos.entryScore;
        const emergencyExit = (tvlCrash > 0.30 ||
            velocityCrash > 0.30 ||
            scoreCrash > 0.30 ||
            pool.score < 40);
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
        // Min hold time check
        const MIN_HOLD_TIME_HIGH_QUALITY = 6 * 60 * 60 * 1000;
        const bypassMinHold = pos.entryScore < 55;
        const requiredHoldTime = pos.entryScore >= 80 ? MIN_HOLD_TIME_HIGH_QUALITY : MIN_HOLD_TIME_MS;
        if (holdTime < requiredHoldTime && !bypassMinHold) {
            remainingPositions.push(pos);
            continue;
        }
        // EXIT TRIGGERS
        const volatility = (0, volatility_1.calculateVolatility)(pool);
        let trailingStopPct = 0.10;
        if (volatility.classification === 'high') {
            trailingStopPct = 0.20;
        }
        else if (volatility.classification === 'medium') {
            trailingStopPct = 0.15;
        }
        const trailingStopTriggered = pool.score < (pos.peakScore * (1 - trailingStopPct));
        const tvlDrop = (pos.entryTVL - pool.liquidity) / pos.entryTVL;
        const tvlDropTriggered = tvlDrop > 0.20;
        const velocityDrop = (pos.entryVelocity - pool.velocity) / pos.entryVelocity;
        const velocityDropTriggered = velocityDrop > 0.25;
        const volumeExitTriggered = await (0, volume_1.checkVolumeExitTrigger)(pool);
        let shouldApplyVolumeExit = volumeExitTriggered;
        if (volumeExitTriggered && PAPER_TRADING) {
            const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
            const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
            const estimatedReturn = pos.amount * dailyYield * (holdTimeHours / 24);
            if (estimatedReturn > 0) {
                shouldApplyVolumeExit = false;
                logger_1.default.info(`[PROFIT PROTECTED] Ignoring volume exit for profitable position ${pool.name} (+$${estimatedReturn.toFixed(2)})`);
            }
        }
        if (shouldApplyVolumeExit) {
            pos.consecutiveLowVolumeCycles++;
            if (pos.consecutiveLowVolumeCycles < 2) {
                shouldApplyVolumeExit = false;
                logger_1.default.info(`[CONFIRMATION] Volume exit triggered for ${pool.name}, waiting for confirmation (${pos.consecutiveLowVolumeCycles}/2)`);
            }
        }
        else {
            pos.consecutiveLowVolumeCycles = 0;
        }
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
    // Market crash detection
    if (exitSignalCount >= 3 && activePositions.length >= 3) {
        logger_1.default.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit. Exiting ALL positions.`);
        activePositions = [];
        await (0, supabase_1.logAction)('MARKET_CRASH_EXIT', { exitSignalCount });
        return;
    }
    activePositions = remainingPositions;
    // 2. Check Entries
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
        'meme': activePositions.filter(p => p.tokenType === 'meme').length
    };
    const PRIORITY_THRESHOLD = 40;
    const CANDIDATE_THRESHOLD = 24;
    for (const candidate of rankedPools) {
        if (activePositions.length + validCandidates.length >= 5)
            break;
        if (activePositions.find(p => p.poolAddress === candidate.address))
            continue;
        const candidateType = categorizeToken(candidate);
        const activePools = activePositions.map(pos => rankedPools.find(p => p.address === pos.poolAddress)).filter((p) => p !== undefined);
        if ((0, arbitrage_1.isDuplicatePair)(candidate, activePools)) {
            logger_1.default.info(`Skipping ${candidate.name} - duplicate token pair`);
            continue;
        }
        const isPriorityTier = candidate.score >= PRIORITY_THRESHOLD;
        const isCandidateTier = candidate.score >= CANDIDATE_THRESHOLD && candidate.score < PRIORITY_THRESHOLD;
        if (candidate.score < CANDIDATE_THRESHOLD) {
            logger_1.default.info(`Skipping ${candidate.name} - score ${candidate.score.toFixed(1)} below candidate threshold ${CANDIDATE_THRESHOLD}`);
            (0, scorePool_1.logEntryRejection)(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Score below candidate threshold');
            continue;
        }
        if (candidate.isBootstrapCycle === true) {
            logger_1.default.info(`🔍 [BOOTSTRAP] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - observe only, skipping entry`);
            (0, scorePool_1.logEntryRejection)(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Bootstrap cycle - observe only');
            continue;
        }
        const migrationDir = candidate.migrationDirection;
        const candidateLiqSlope = candidate.liquiditySlope;
        if (migrationDir === 'out' || (candidateLiqSlope !== undefined && candidateLiqSlope < -0.03)) {
            logger_1.default.warn(`🚫 [MIGRATION REJECT] ${candidate.name} - liquidity exiting concentrated region`);
            (0, scorePool_1.logEntryRejection)(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Migration reject - liquidity exiting');
            continue;
        }
        const transitionGate = (0, structuralEntry_1.evaluateTransitionGate)(candidate);
        if (!transitionGate.allowed) {
            logger_1.default.warn(`🚫 [TRANSITION GATE] ${candidate.name} - vel/liq/ent slopes unfavorable`);
            (0, scorePool_1.logEntryRejection)(candidate, candidate.score, CANDIDATE_THRESHOLD, transitionGate.reason);
            continue;
        }
        let structuralEntrySignal = true;
        let structuralRejectionReason = '';
        if (candidate.binScores) {
            const history = binSnapshotHistory.get(candidate.address) || [];
            const entryDecision = (0, structuralEntry_1.evaluateEntry)(candidate.binScores, history);
            structuralEntrySignal = entryDecision.enter;
            structuralRejectionReason = entryDecision.reason;
            if (!structuralEntrySignal) {
                logger_1.default.info(`⏳ [DLMM] Waiting on ${candidate.name} - Structural entry not favorable: ${entryDecision.reason}`);
            }
        }
        if (transitionGate.expansionPulse) {
            if (structuralEntrySignal) {
                candidate.expansionPulse = true;
                validCandidates.push({ pool: candidate, type: candidateType, entryMode: 'priority' });
                typeCount[candidateType]++;
                logger_1.default.info(`🔥 [EXPANSION PULSE] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - breakout detected, fast-track entry`);
            }
            else {
                (0, scorePool_1.logEntryRejection)(candidate, candidate.score, PRIORITY_THRESHOLD, `Expansion pulse but structural failed: ${structuralRejectionReason}`);
            }
            continue;
        }
        if (isPriorityTier) {
            if (structuralEntrySignal) {
                validCandidates.push({ pool: candidate, type: candidateType, entryMode: 'priority' });
                typeCount[candidateType]++;
                logger_1.default.info(`🚀 [PRIORITY] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - transition + structural pass`);
            }
            else {
                (0, scorePool_1.logEntryRejection)(candidate, candidate.score, PRIORITY_THRESHOLD, `Structural: ${structuralRejectionReason}`);
            }
            continue;
        }
        if (isCandidateTier) {
            const volumeEntrySignal = await (0, volume_1.checkVolumeEntryTrigger)(candidate);
            if (structuralEntrySignal && volumeEntrySignal) {
                validCandidates.push({ pool: candidate, type: candidateType, entryMode: 'candidate' });
                typeCount[candidateType]++;
                logger_1.default.info(`📈 [CANDIDATE] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - transition + structural + volume pass`);
            }
            else {
                if (!structuralEntrySignal) {
                    (0, scorePool_1.logEntryRejection)(candidate, candidate.score, CANDIDATE_THRESHOLD, `Structural: ${structuralRejectionReason}`);
                }
                else if (!volumeEntrySignal) {
                    logger_1.default.info(`⏳ Waiting on ${candidate.name} (Score ${candidate.score.toFixed(1)}) - Volume/velocity triggers not met`);
                    (0, scorePool_1.logEntryRejection)(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Volume/velocity entry triggers not met');
                }
            }
        }
    }
    if (validCandidates.length > 0) {
        const totalScoreSum = validCandidates.reduce((sum, c) => sum + c.pool.score, 0);
        const priorityCount = validCandidates.filter(c => c.entryMode === 'priority').length;
        const candidateCount = validCandidates.filter(c => c.entryMode === 'candidate').length;
        logger_1.default.info(`Found ${validCandidates.length} valid candidates (${priorityCount} priority, ${candidateCount} candidate). Total Score Sum: ${totalScoreSum.toFixed(2)}`);
        for (const { pool, type, entryMode } of validCandidates) {
            const weight = pool.score / totalScoreSum;
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
            const isExpansionEntry = entryMode === 'priority' && pool.expansionPulse === true;
            const sizingMode = (0, trading_1.getSizingMode)(isExpansionEntry);
            if (isExpansionEntry) {
                logger_1.default.info(`🔥 [EXPANSION PULSE] ${pool.name} - breakout detected`);
            }
            const tradeResult = await (0, trading_1.enterPosition)(pool, sizingMode, availableCapital, startingCapital);
            if (tradeResult.success && tradeResult.trade) {
                const tradeSize = tradeResult.trade.size;
                activePositions.push({
                    poolAddress: pool.address,
                    entryTime: now,
                    entryScore: pool.score,
                    entryPrice: pool.currentPrice,
                    peakScore: pool.score,
                    amount: tradeSize,
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
                    amount: tradeSize,
                    type: type,
                    entryMode: entryMode,
                    sizingMode: sizingMode,
                    tradeId: tradeResult.trade.id,
                    paperTrading: PAPER_TRADING,
                    paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
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
        logger_1.default.info('--- Starting Scan Cycle ---');
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
        logger_1.default.warn('[TRACE] Calling function: discoverDLMMUniverses');
        let poolUniverse = [];
        try {
            poolUniverse = await (0, dlmmIndexer_1.discoverDLMMUniverses)(discoveryParams);
        }
        catch (discoveryError) {
            logger_1.default.error('[DISCOVERY] Raydium fetch failed:', {
                error: discoveryError?.message || discoveryError,
                params: discoveryParams,
            });
            logger_1.default.warn('[TRACE] returning from scanCycle (discovery error)');
            return; // soft fail, wait for next interval
        }
        logger_1.default.warn('[TRACE] discoverDLMMUniverses RETURNED');
        // Validate return shape
        if (!Array.isArray(poolUniverse) || poolUniverse.length === 0) {
            logger_1.default.warn('[DISCOVERY] No pools returned. Sleeping + retry next cycle.');
            logger_1.default.warn('[TRACE] returning from scanCycle (empty universe)');
            return;
        }
        logger_1.default.info(`[DISCOVERY] ✅ Fetched ${poolUniverse.length} pools`);
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
        // Telemetry processing with graceful degradation
        let validPoolCount = 0;
        let fallbackPoolCount = 0;
        for (const pool of enrichedCandidates) {
            pool.dilutionScore = await (0, dilution_1.calculateDilutionScore)(pool);
            pool.riskScore = (0, safetyFilters_1.calculateRiskScore)(pool);
            const hasIndexerTelemetry = pool.entropy !== undefined &&
                pool.entropy > 0 &&
                pool.binCount > 0;
            let useFallback = false;
            try {
                let enrichedSnapshot;
                if (hasIndexerTelemetry) {
                    enrichedSnapshot = {
                        timestamp: Date.now(),
                        activeBin: pool.activeBin || 0,
                        liquidity: pool.onChainLiquidity || pool.liquidity,
                        velocity: pool.velocity,
                        entropy: pool.entropy,
                        binCount: pool.binCount,
                        migrationDirection: pool.migrationDirection || 'stable',
                        bins: {},
                        invalidTelemetry: false,
                    };
                }
                else {
                    const existingHistory = binSnapshotHistory.get(pool.address) || [];
                    const previousSnapshot = existingHistory[existingHistory.length - 1];
                    enrichedSnapshot = await (0, dlmmTelemetry_1.getEnrichedDLMMState)(pool.address, previousSnapshot);
                    // Graceful degradation: use fallback instead of skipping
                    if (enrichedSnapshot.invalidTelemetry || enrichedSnapshot.liquidity <= 0 || enrichedSnapshot.binCount <= 0) {
                        useFallback = true;
                        // Create fallback snapshot from API data
                        enrichedSnapshot = {
                            timestamp: Date.now(),
                            activeBin: 0,
                            liquidity: pool.liquidity,
                            velocity: pool.volume24h > 0 ? pool.volume24h / Math.max(pool.liquidity, 1) : 0,
                            entropy: 0.5, // neutral entropy
                            binCount: 1,
                            migrationDirection: 'stable',
                            bins: {},
                            invalidTelemetry: false,
                        };
                        pool.lowConfidence = true;
                    }
                    else {
                        pool.onChainLiquidity = enrichedSnapshot.liquidity;
                        pool.velocity = enrichedSnapshot.velocity;
                        pool.binCount = enrichedSnapshot.binCount;
                        pool.entropy = enrichedSnapshot.entropy;
                        pool.migrationDirection = enrichedSnapshot.migrationDirection;
                        pool.activeBin = enrichedSnapshot.activeBin;
                    }
                }
                if (!binSnapshotHistory.has(pool.address)) {
                    binSnapshotHistory.set(pool.address, []);
                }
                const history = binSnapshotHistory.get(pool.address);
                history.push(enrichedSnapshot);
                while (history.length > MAX_HISTORY_LENGTH) {
                    history.shift();
                }
                const isFirstCycle = history.length < 2;
                pool.isBootstrapCycle = isFirstCycle && useFallback;
                if (isFirstCycle) {
                    pool.prevVelocity = undefined;
                    pool.prevLiquidity = undefined;
                    pool.prevEntropy = undefined;
                    pool.velocitySlope = undefined;
                    pool.liquiditySlope = undefined;
                    pool.entropySlope = undefined;
                }
                if (history.length >= 2 && !useFallback) {
                    const prev = history[history.length - 2];
                    const curr = history[history.length - 1];
                    pool.prevVelocity = prev.velocity;
                    pool.prevLiquidity = prev.liquidity;
                    pool.prevEntropy = prev.entropy;
                    const velocitySlope = prev.velocity > 0 ? (curr.velocity - prev.velocity) / prev.velocity : 0;
                    const liquiditySlope = prev.liquidity > 0 ? (curr.liquidity - prev.liquidity) / prev.liquidity : 0;
                    const entropySlope = curr.entropy - prev.entropy;
                    pool.velocitySlope = velocitySlope;
                    pool.liquiditySlope = liquiditySlope;
                    pool.entropySlope = entropySlope;
                }
                pool.binSnapshot = enrichedSnapshot;
                if (useFallback) {
                    fallbackPoolCount++;
                }
                else {
                    validPoolCount++;
                }
            }
            catch (dlmmError) {
                // Graceful degradation: continue with API-only data
                pool.lowConfidence = true;
                pool.isBootstrapCycle = true;
                fallbackPoolCount++;
            }
            pool.score = (0, scorePool_1.scorePool)(pool);
            await (0, supabase_1.saveSnapshot)(pool);
        }
        // All pools processed - no filtering, just logging
        const validCandidatesList = enrichedCandidates;
        if (fallbackPoolCount > 0) {
            logger_1.default.info(`📊 Processed ${validPoolCount} full telemetry, ${fallbackPoolCount} fallback mode`);
        }
        // Kill switch check (ONCE per cycle, not per pool)
        const allSnapshots = Array.from(binSnapshotHistory.values()).flat();
        const killDecision = (0, killSwitch_1.evaluateKill)(allSnapshots, activePositions);
        if (killDecision.killAll) {
            logger_1.default.error(`🚨 KILL SWITCH ACTIVATED: ${killDecision.reason}`);
            logger_1.default.error('🚨 Liquidating all positions and pausing trading for 10 minutes');
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
            killSwitchPauseUntil = Date.now() + (10 * 60 * 1000);
            await (0, supabase_1.logAction)('KILL_SWITCH', {
                reason: killDecision.reason,
                positionsLiquidated: activePositions.length,
                pauseUntil: new Date(killSwitchPauseUntil).toISOString()
            });
            const duration = Date.now() - startTime;
            logger_1.default.info(`Cycle completed in ${duration}ms. Sleeping...`);
            await (0, supabase_1.logAction)('HEARTBEAT', {
                duration,
                candidates: validCandidatesList.length,
                paperTrading: PAPER_TRADING,
                paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
            });
            return;
        }
        // Check kill switch pause
        if (killSwitchPauseUntil > Date.now()) {
            const remainingSeconds = Math.ceil((killSwitchPauseUntil - Date.now()) / 1000);
            logger_1.default.warn(`⏸️  Trading paused by kill switch. Resuming in ${remainingSeconds}s`);
            const duration = Date.now() - startTime;
            await (0, supabase_1.logAction)('HEARTBEAT', {
                duration,
                candidates: validCandidatesList.length,
                paperTrading: PAPER_TRADING,
                paperBalance: PAPER_TRADING ? paperTradingBalance : undefined,
                killSwitchPaused: true
            });
            return;
        }
        // Sort and deduplicate
        const sortedPools = validCandidatesList.sort((a, b) => b.score - a.score);
        const deduplicatedPools = (0, arbitrage_1.deduplicatePools)(sortedPools);
        logger_1.default.info(`Deduplicated ${sortedPools.length} pools to ${deduplicatedPools.length} unique pairs`);
        const topPools = deduplicatedPools.slice(0, 5);
        logger_1.default.info('Top 5 Pools', { pools: topPools.map(p => `${p.name} (${p.score.toFixed(2)})`) });
        // ExecutionEngine: Evaluate universe for paper trading positions
        if (deduplicatedPools.length === 0) {
            logger_1.default.info('[EXEC] No pools available, sleeping...');
            return;
        }
        // Convert to ScoredPool format for engine
        const scoredPoolsForEngine = deduplicatedPools.map(p => ({
            address: p.address,
            score: p.score,
            liquidityUSD: p.liquidity,
            volume24h: p.volume24h,
            binCount: p.binCount || 1,
            activeBin: p.activeBin || 0,
            tokenA: { symbol: p.name.split('-')[0] || 'TOKEN', decimals: 9 },
            tokenB: { symbol: p.name.split('-')[1] || 'TOKEN', decimals: 9 },
        }));
        // Find highest scoring pool
        const bestPool = scoredPoolsForEngine.reduce((best, pool) => pool.score > best.score ? pool : best, scoredPoolsForEngine[0]);
        logger_1.default.info(`[EXEC] Selected pool: ${bestPool.tokenA.symbol}/${bestPool.tokenB.symbol} (score: ${bestPool.score.toFixed(2)})`);
        // Check if score meets minimum threshold
        if (bestPool.score >= EXECUTION_MIN_SCORE) {
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
            logger_1.default.info(`[EXEC] Best pool score ${bestPool.score.toFixed(2)} below minimum ${EXECUTION_MIN_SCORE}, skipping`);
            executionEngine.update();
        }
        // Rotation engine
        await manageRotation(sortedPools);
        const duration = Date.now() - startTime;
        logger_1.default.info(`Cycle completed in ${duration}ms. Sleeping...`);
        await (0, supabase_1.logAction)('HEARTBEAT', {
            duration,
            candidates: validCandidatesList.length,
            paperTrading: PAPER_TRADING,
            paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
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
}
// Start the bot
main().catch(console.error);
//# sourceMappingURL=index.js.map