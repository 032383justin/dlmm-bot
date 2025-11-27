import { scanPools } from './core/scanPools';
import { savePaperTradingState, loadPaperTradingState } from './utils/state';
import { normalizePools, Pool } from './core/normalizePools';
import { applySafetyFilters, calculateRiskScore } from './core/safetyFilters';
import { checkVolumeEntryTrigger, checkVolumeExitTrigger } from './core/volume';
import { calculateDilutionScore } from './core/dilution';
import { scorePool, logEntryRejection } from './scoring/scorePool';
import { logAction, saveSnapshot } from './db/supabase';
import { saveBinSnapshot } from './db/binHistory';
import logger from './utils/logger';
import { getVolatilityMultiplier, calculateVolatility } from './utils/volatility';
import { deduplicatePools, isDuplicatePair } from './utils/arbitrage';
import { isHighlyCorrelated } from './utils/correlation';
import { ActivePosition, TokenType } from './types';
// Microstructure brain imports
import { getDLMMState, BinSnapshot, EnrichedSnapshot, getEnrichedDLMMState } from './core/dlmmTelemetry';
// REMOVED: Static pool imports - now using dynamic discovery
// import { DLMM_POOLS } from './config/pools';
// import { adaptDLMMPools } from './config/dlmmPoolAdapter';
import { discoverDLMMUniverses, enrichedPoolToPool, EnrichedPool, getCacheStatus } from './services/dlmmIndexer';
import { scoreBins } from './core/binScoring';
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
let activePositions: ActivePosition[] = [];

// Microstructure brain state
const binSnapshotHistory: Map<string, EnrichedSnapshot[]> = new Map();
const MAX_HISTORY_LENGTH = 30;
let killSwitchPauseUntil = 0;

// Pool state tracking
interface PoolState {
  holding: boolean;
  entryBinRange: [number, number];
  lastEntryScore: number;
  lastExitReason?: string;
}
const poolStates: { [poolId: string]: PoolState } = {};

// Bin history database throttle
const lastBinHistorySave: Map<string, number> = new Map();
const BIN_HISTORY_SAVE_INTERVAL = 7000;

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
// INITIALIZATION (runs ONCE on startup)
// ═══════════════════════════════════════════════════════════════════════════════

async function initializeBot(): Promise<void> {
  if (BOT_INITIALIZED) {
    logger.debug('[INIT] initializeBot skipped — already initialized');
    return;
  }

  BOT_INITIALIZED = true;
  logger.info('[INIT] 🚀 INITIALIZING BOT...');

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

const manageRotation = async (rankedPools: Pool[]) => {
  const now = Date.now();
  const remainingPositions: ActivePosition[] = [];
  let exitSignalCount = 0;

  // 1. Check Exits with Advanced Triggers
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
          await savePaperTradingState(paperTradingBalance, paperTradingPnL);
        }

        pos.amount -= sellAmount;
        pos.tookProfit1 = true;

        logger.info(`[PROFIT TAKING L1] ${pool.name} +${(priceChangePct * 100).toFixed(1)}% - Sold 25% ($${sellAmount.toFixed(0)})`);
        logger.info(`[PAPER] P&L: +$${estimatedReturn.toFixed(2)} | Total: $${paperTradingPnL.toFixed(2)} | Remaining: $${pos.amount.toFixed(0)}`);

        await logAction('EXIT', {
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
          await savePaperTradingState(paperTradingBalance, paperTradingPnL);
        }

        pos.amount -= sellAmount;
        pos.tookProfit2 = true;

        logger.info(`[PROFIT TAKING L2] ${pool.name} +${(priceChangePct * 100).toFixed(1)}% - Sold 25% ($${sellAmount.toFixed(0)})`);
        logger.info(`[PAPER] P&L: +$${estimatedReturn.toFixed(2)} | Total: $${paperTradingPnL.toFixed(2)} | Remaining: $${pos.amount.toFixed(0)}`);

        await logAction('EXIT', {
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

    const emergencyExit = (
      tvlCrash > 0.30 ||
      velocityCrash > 0.30 ||
      scoreCrash > 0.30 ||
      pool.score < 40
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
        await savePaperTradingState(paperTradingBalance, paperTradingPnL);

        logger.warn(`[PAPER] ${reason} - Exiting ${pool.name} immediately (held ${(holdTimeHours * 60).toFixed(0)} min)`);
        logger.info(`[PAPER] P&L: ${estimatedReturn >= 0 ? "+" : ""}$${estimatedReturn.toFixed(2)} | Total: $${paperTradingPnL.toFixed(2)}`);
      }

      await logAction('EXIT', {
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
    const volatility = calculateVolatility(pool);
    let trailingStopPct = 0.10;

    if (volatility.classification === 'high') {
      trailingStopPct = 0.20;
    } else if (volatility.classification === 'medium') {
      trailingStopPct = 0.15;
    }

    const trailingStopTriggered = pool.score < (pos.peakScore * (1 - trailingStopPct));
    const tvlDrop = (pos.entryTVL - pool.liquidity) / pos.entryTVL;
    const tvlDropTriggered = tvlDrop > 0.20;
    const velocityDrop = (pos.entryVelocity - pool.velocity) / pos.entryVelocity;
    const velocityDropTriggered = velocityDrop > 0.25;
    const volumeExitTriggered = await checkVolumeExitTrigger(pool);

    let shouldApplyVolumeExit = volumeExitTriggered;
    if (volumeExitTriggered && PAPER_TRADING) {
      const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
      const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
      const estimatedReturn = pos.amount * dailyYield * (holdTimeHours / 24);

      if (estimatedReturn > 0) {
        shouldApplyVolumeExit = false;
        logger.info(`[PROFIT PROTECTED] Ignoring volume exit for profitable position ${pool.name} (+$${estimatedReturn.toFixed(2)})`);
      }
    }

    if (shouldApplyVolumeExit) {
      pos.consecutiveLowVolumeCycles++;
      if (pos.consecutiveLowVolumeCycles < 2) {
        shouldApplyVolumeExit = false;
        logger.info(`[CONFIRMATION] Volume exit triggered for ${pool.name}, waiting for confirmation (${pos.consecutiveLowVolumeCycles}/2)`);
      }
    } else {
      pos.consecutiveLowVolumeCycles = 0;
    }

    let structuralExitTriggered = false;
    if ((pool as any).binSnapshot && (pool as any).binScores) {
      const history = binSnapshotHistory.get(pool.address) || [];
      const exitDecision = evaluateExit((pool as any).binSnapshot, history, (pool as any).binScores);
      structuralExitTriggered = exitDecision.exit;

      if (structuralExitTriggered) {
        logger.warn(`[DLMM] Structural exit triggered for ${pool.name}: ${exitDecision.reason}`);
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
        await savePaperTradingState(paperTradingBalance, paperTradingPnL);

        logger.info(`[PAPER] Rotating OUT of ${pool.name}. Reason: ${reason}. Peak: ${pos.peakScore.toFixed(2)}, Current: ${pool.score.toFixed(2)}`);
        logger.info(`[PAPER] P&L: +$${estimatedReturn.toFixed(2)} | Total P&L: $${paperTradingPnL.toFixed(2)} | Balance: $${paperTradingBalance.toFixed(2)}`);
      } else {
        logger.info(`Rotating OUT of ${pool.name}. Reason: ${reason}. Peak: ${pos.peakScore.toFixed(2)}, Current: ${pool.score.toFixed(2)}`);
      }

      await logAction('EXIT', {
        pool: pool.address,
        reason,
        peakScore: pos.peakScore,
        currentScore: pool.score,
        paperTrading: PAPER_TRADING,
        paperPnL: PAPER_TRADING ? paperTradingPnL : undefined
      });
      exitSignalCount++;
    } else {
      remainingPositions.push(pos);
    }
  }

  // Market crash detection
  if (exitSignalCount >= 3 && activePositions.length >= 3) {
    logger.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit. Exiting ALL positions.`);
    activePositions = [];
    await logAction('MARKET_CRASH_EXIT', { exitSignalCount });
    return;
  }

  activePositions = remainingPositions;

  // 2. Check Entries
  const totalCapital = PAPER_TRADING ? paperTradingBalance : parseFloat(process.env.TOTAL_CAPITAL || '10000');
  const deployedCapital = activePositions.reduce((sum, p) => sum + p.amount, 0);
  let availableCapital = totalCapital - deployedCapital;
  if (availableCapital < 0) availableCapital = 0;

  const startingCapital = parseFloat(process.env.PAPER_CAPITAL || '10000');

  type EntryMode = 'priority' | 'candidate';
  const validCandidates: { pool: Pool, type: TokenType, entryMode: EntryMode }[] = [];

  const typeCount = {
    'stable': activePositions.filter(p => p.tokenType === 'stable').length,
    'blue-chip': activePositions.filter(p => p.tokenType === 'blue-chip').length,
    'meme': activePositions.filter(p => p.tokenType === 'meme').length
  };

  const PRIORITY_THRESHOLD = 40;
  const CANDIDATE_THRESHOLD = 24;

  for (const candidate of rankedPools) {
    if (activePositions.length + validCandidates.length >= 5) break;
    if (activePositions.find(p => p.poolAddress === candidate.address)) continue;

    const candidateType = categorizeToken(candidate);
    const activePools = activePositions.map(pos => rankedPools.find(p => p.address === pos.poolAddress)).filter((p): p is Pool => p !== undefined);
    
    if (isDuplicatePair(candidate, activePools)) {
      logger.info(`Skipping ${candidate.name} - duplicate token pair`);
      continue;
    }

    const isPriorityTier = candidate.score >= PRIORITY_THRESHOLD;
    const isCandidateTier = candidate.score >= CANDIDATE_THRESHOLD && candidate.score < PRIORITY_THRESHOLD;

    if (candidate.score < CANDIDATE_THRESHOLD) {
      logger.info(`Skipping ${candidate.name} - score ${candidate.score.toFixed(1)} below candidate threshold ${CANDIDATE_THRESHOLD}`);
      logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Score below candidate threshold');
      continue;
    }

    if ((candidate as any).isBootstrapCycle === true) {
      logger.info(`🔍 [BOOTSTRAP] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - observe only, skipping entry`);
      logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Bootstrap cycle - observe only');
      continue;
    }

    const migrationDir = (candidate as any).migrationDirection as string | undefined;
    const candidateLiqSlope = (candidate as any).liquiditySlope as number | undefined;
    
    if (migrationDir === 'out' || (candidateLiqSlope !== undefined && candidateLiqSlope < -0.03)) {
      logger.warn(`🚫 [MIGRATION REJECT] ${candidate.name} - liquidity exiting concentrated region`);
      logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Migration reject - liquidity exiting');
      continue;
    }

    const transitionGate = evaluateTransitionGate(candidate);
    
    if (!transitionGate.allowed) {
      logger.warn(`🚫 [TRANSITION GATE] ${candidate.name} - vel/liq/ent slopes unfavorable`);
      logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, transitionGate.reason);
      continue;
    }

    let structuralEntrySignal = true;
    let structuralRejectionReason = '';
    if ((candidate as any).binScores) {
      const history = binSnapshotHistory.get(candidate.address) || [];
      const entryDecision = evaluateEntry((candidate as any).binScores, history);
      structuralEntrySignal = entryDecision.enter;
      structuralRejectionReason = entryDecision.reason;

      if (!structuralEntrySignal) {
        logger.info(`⏳ [DLMM] Waiting on ${candidate.name} - Structural entry not favorable: ${entryDecision.reason}`);
      }
    }

    if (transitionGate.expansionPulse) {
      if (structuralEntrySignal) {
        (candidate as any).expansionPulse = true;
        validCandidates.push({ pool: candidate, type: candidateType, entryMode: 'priority' });
        typeCount[candidateType as keyof typeof typeCount]++;
        logger.info(`🔥 [EXPANSION PULSE] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - breakout detected, fast-track entry`);
      } else {
        logEntryRejection(candidate, candidate.score, PRIORITY_THRESHOLD, `Expansion pulse but structural failed: ${structuralRejectionReason}`);
      }
      continue;
    }

    if (isPriorityTier) {
      if (structuralEntrySignal) {
        validCandidates.push({ pool: candidate, type: candidateType, entryMode: 'priority' });
        typeCount[candidateType as keyof typeof typeCount]++;
        logger.info(`🚀 [PRIORITY] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - transition + structural pass`);
      } else {
        logEntryRejection(candidate, candidate.score, PRIORITY_THRESHOLD, `Structural: ${structuralRejectionReason}`);
      }
      continue;
    }

    if (isCandidateTier) {
      const volumeEntrySignal = await checkVolumeEntryTrigger(candidate);

      if (structuralEntrySignal && volumeEntrySignal) {
        validCandidates.push({ pool: candidate, type: candidateType, entryMode: 'candidate' });
        typeCount[candidateType as keyof typeof typeCount]++;
        logger.info(`📈 [CANDIDATE] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - transition + structural + volume pass`);
      } else {
        if (!structuralEntrySignal) {
          logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, `Structural: ${structuralRejectionReason}`);
        } else if (!volumeEntrySignal) {
          logger.info(`⏳ Waiting on ${candidate.name} (Score ${candidate.score.toFixed(1)}) - Volume/velocity triggers not met`);
          logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Volume/velocity entry triggers not met');
        }
      }
    }
  }

  if (validCandidates.length > 0) {
    const totalScoreSum = validCandidates.reduce((sum, c) => sum + c.pool.score, 0);
    const priorityCount = validCandidates.filter(c => c.entryMode === 'priority').length;
    const candidateCount = validCandidates.filter(c => c.entryMode === 'candidate').length;
    logger.info(`Found ${validCandidates.length} valid candidates (${priorityCount} priority, ${candidateCount} candidate). Total Score Sum: ${totalScoreSum.toFixed(2)}`);

    for (const { pool, type, entryMode } of validCandidates) {
      const weight = pool.score / totalScoreSum;
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
      
      const isExpansionEntry = entryMode === 'priority' && (pool as any).expansionPulse === true;
      const sizingMode = getSizingMode(isExpansionEntry);
      
      if (isExpansionEntry) {
        logger.info(`🔥 [EXPANSION PULSE] ${pool.name} - breakout detected`);
      }
      
      const tradeResult = await enterPosition(pool as any, sizingMode, availableCapital, startingCapital);
      
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

        await logAction('ENTRY', {
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
    logger.info('--- Starting Scan Cycle ---');

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
    logger.warn('[TRACE] Calling function: discoverDLMMUniverses');
    let poolUniverse: EnrichedPool[] = [];
    try {
      poolUniverse = await discoverDLMMUniverses(discoveryParams);
    } catch (discoveryError: any) {
      logger.error('[DISCOVERY] Raydium fetch failed:', {
        error: discoveryError?.message || discoveryError,
        params: discoveryParams,
      });
      logger.warn('[TRACE] returning from scanCycle (discovery error)');
      return; // soft fail, wait for next interval
    }
    logger.warn('[TRACE] discoverDLMMUniverses RETURNED');
    
    // Validate return shape
    if (!Array.isArray(poolUniverse) || poolUniverse.length === 0) {
      logger.warn('[DISCOVERY] No pools returned. Sleeping + retry next cycle.');
      logger.warn('[TRACE] returning from scanCycle (empty universe)');
      return;
    }
    
    logger.info(`[DISCOVERY] ✅ Fetched ${poolUniverse.length} pools`);
    
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

    // Telemetry processing with graceful degradation
    let validPoolCount = 0;
    let fallbackPoolCount = 0;
    
    for (const pool of enrichedCandidates) {
      pool.dilutionScore = await calculateDilutionScore(pool);
      pool.riskScore = calculateRiskScore(pool);
      
      const hasIndexerTelemetry = (pool as any).entropy !== undefined && 
                                   (pool as any).entropy > 0 &&
                                   pool.binCount > 0;
      
      let useFallback = false;
      
      try {
        let enrichedSnapshot: EnrichedSnapshot;
        
        if (hasIndexerTelemetry) {
          enrichedSnapshot = {
            timestamp: Date.now(),
            activeBin: (pool as any).activeBin || 0,
            liquidity: (pool as any).onChainLiquidity || pool.liquidity,
            velocity: pool.velocity,
            entropy: (pool as any).entropy,
            binCount: pool.binCount,
            migrationDirection: (pool as any).migrationDirection || 'stable',
            bins: {},
            invalidTelemetry: false,
          };
        } else {
          const existingHistory = binSnapshotHistory.get(pool.address) || [];
          const previousSnapshot = existingHistory[existingHistory.length - 1];
          
          enrichedSnapshot = await getEnrichedDLMMState(pool.address, previousSnapshot);
          
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
            (pool as any).lowConfidence = true;
          } else {
            (pool as any).onChainLiquidity = enrichedSnapshot.liquidity;
            pool.velocity = enrichedSnapshot.velocity;
            pool.binCount = enrichedSnapshot.binCount;
            (pool as any).entropy = enrichedSnapshot.entropy;
            (pool as any).migrationDirection = enrichedSnapshot.migrationDirection;
            (pool as any).activeBin = enrichedSnapshot.activeBin;
          }
        }
        
        if (!binSnapshotHistory.has(pool.address)) {
          binSnapshotHistory.set(pool.address, []);
        }
        const history = binSnapshotHistory.get(pool.address)!;
        history.push(enrichedSnapshot);
        
        while (history.length > MAX_HISTORY_LENGTH) {
          history.shift();
        }
        
        const isFirstCycle = history.length < 2;
        (pool as any).isBootstrapCycle = isFirstCycle || useFallback;
        
        if (isFirstCycle) {
          (pool as any).prevVelocity = undefined;
          (pool as any).prevLiquidity = undefined;
          (pool as any).prevEntropy = undefined;
          (pool as any).velocitySlope = undefined;
          (pool as any).liquiditySlope = undefined;
          (pool as any).entropySlope = undefined;
        }
        
        if (history.length >= 2 && !useFallback) {
          const prev = history[history.length - 2];
          const curr = history[history.length - 1];
          
          (pool as any).prevVelocity = prev.velocity;
          (pool as any).prevLiquidity = prev.liquidity;
          (pool as any).prevEntropy = prev.entropy;
          
          const velocitySlope = prev.velocity > 0 ? (curr.velocity - prev.velocity) / prev.velocity : 0;
          const liquiditySlope = prev.liquidity > 0 ? (curr.liquidity - prev.liquidity) / prev.liquidity : 0;
          const entropySlope = curr.entropy - prev.entropy;
          
          (pool as any).velocitySlope = velocitySlope;
          (pool as any).liquiditySlope = liquiditySlope;
          (pool as any).entropySlope = entropySlope;
        }
        
        (pool as any).binSnapshot = enrichedSnapshot;
        
        if (useFallback) {
          fallbackPoolCount++;
        } else {
          validPoolCount++;
        }
        
      } catch (dlmmError) {
        // Graceful degradation: continue with API-only data
        (pool as any).lowConfidence = true;
        (pool as any).isBootstrapCycle = true;
        fallbackPoolCount++;
      }
      
      pool.score = scorePool(pool);
      await saveSnapshot(pool);
    }
    
    // All pools processed - no filtering, just logging
    const validCandidatesList = enrichedCandidates;
    
    if (fallbackPoolCount > 0) {
      logger.info(`📊 Processed ${validPoolCount} full telemetry, ${fallbackPoolCount} fallback mode`);
    }

    // Kill switch check (ONCE per cycle, not per pool)
    const allSnapshots = Array.from(binSnapshotHistory.values()).flat();
    const killDecision = evaluateKill(allSnapshots, activePositions);

    if (killDecision.killAll) {
      logger.error(`🚨 KILL SWITCH ACTIVATED: ${killDecision.reason}`);
      logger.error('🚨 Liquidating all positions and pausing trading for 10 minutes');

      for (const pos of activePositions) {
        await logAction('EXIT', {
          pool: pos.poolAddress,
          reason: `KILL SWITCH: ${killDecision.reason}`,
          emergencyExit: true,
          paperTrading: PAPER_TRADING,
          paperPnL: PAPER_TRADING ? paperTradingPnL : undefined
        });
      }

      activePositions = [];
      killSwitchPauseUntil = Date.now() + (10 * 60 * 1000);

      await logAction('KILL_SWITCH', {
        reason: killDecision.reason,
        positionsLiquidated: activePositions.length,
        pauseUntil: new Date(killSwitchPauseUntil).toISOString()
      });

      const duration = Date.now() - startTime;
      logger.info(`Cycle completed in ${duration}ms. Sleeping...`);
      await logAction('HEARTBEAT', {
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
      logger.warn(`⏸️  Trading paused by kill switch. Resuming in ${remainingSeconds}s`);
      const duration = Date.now() - startTime;
      await logAction('HEARTBEAT', {
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
    const deduplicatedPools = deduplicatePools(sortedPools);
    logger.info(`Deduplicated ${sortedPools.length} pools to ${deduplicatedPools.length} unique pairs`);

    const topPools = deduplicatedPools.slice(0, 5);
    logger.info('Top 5 Pools', { pools: topPools.map(p => `${p.name} (${p.score.toFixed(2)})`) });

    // ExecutionEngine: Evaluate universe for paper trading positions
    if (deduplicatedPools.length === 0) {
      logger.info('[EXEC] No pools available, sleeping...');
      return;
    }
    
    // Convert to ScoredPool format for engine
    const scoredPoolsForEngine: ScoredPool[] = deduplicatedPools.map(p => ({
      address: p.address,
      score: p.score,
      liquidityUSD: p.liquidity,
      volume24h: p.volume24h,
      binCount: p.binCount || 1,
      activeBin: (p as any).activeBin || 0,
      tokenA: { symbol: p.name.split('-')[0] || 'TOKEN', decimals: 9 },
      tokenB: { symbol: p.name.split('-')[1] || 'TOKEN', decimals: 9 },
    }));
    
    // Find highest scoring pool
    const bestPool = scoredPoolsForEngine.reduce((best, pool) => 
      pool.score > best.score ? pool : best
    , scoredPoolsForEngine[0]);
    
    logger.info(`[EXEC] Selected pool: ${bestPool.tokenA.symbol}/${bestPool.tokenB.symbol} (score: ${bestPool.score.toFixed(2)})`);
    
    // Check if score meets minimum threshold
    if (bestPool.score >= EXECUTION_MIN_SCORE) {
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
      logger.info(`[EXEC] Best pool score ${bestPool.score.toFixed(2)} below minimum ${EXECUTION_MIN_SCORE}, skipping`);
      executionEngine.update();
    }

    // Rotation engine
    await manageRotation(sortedPools);

    const duration = Date.now() - startTime;
    logger.info(`Cycle completed in ${duration}ms. Sleeping...`);

    await logAction('HEARTBEAT', {
      duration,
      candidates: validCandidatesList.length,
      paperTrading: PAPER_TRADING,
      paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
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
}

// Start the bot
main().catch(console.error);
