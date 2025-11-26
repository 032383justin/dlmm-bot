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
import dotenv from 'dotenv';

dotenv.config();



const LOOP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_HOLD_TIME_MS = 4 * 60 * 60 * 1000; // 4 hours

// Paper Trading Mode
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const PAPER_CAPITAL = parseFloat(process.env.PAPER_CAPITAL || '10000');
const RESET_STATE = process.env.RESET_STATE === 'true';
let paperTradingBalance = PAPER_CAPITAL;
let paperTradingPnL = 0;

let activePositions: ActivePosition[] = [];

// Microstructure brain state
// Using EnrichedSnapshot for transition-based scoring (includes liquidity, velocity, entropy)
const binSnapshotHistory: Map<string, EnrichedSnapshot[]> = new Map(); // poolId -> snapshots
const MAX_HISTORY_LENGTH = 30; // Keep last 30 snapshots per pool for robust transition detection
let killSwitchPauseUntil = 0; // Timestamp when trading can resume after kill switch

// Pool state tracking - prevents re-entry loops and bot thrashing
interface PoolState {
  holding: boolean;
  entryBinRange: [number, number];
  lastEntryScore: number;
  lastExitReason?: string;
}

const poolStates: { [poolId: string]: PoolState } = {}; // Global pool state tracker

// Bin history database throttle (save every 5-10 seconds per pool to minimize costs)
const lastBinHistorySave: Map<string, number> = new Map(); // poolId -> last save timestamp
const BIN_HISTORY_SAVE_INTERVAL = 7000; // 7 seconds between saves per pool

// Token categorization for diversification
const categorizeToken = (pool: Pool): TokenType => {
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
      logger.warn('🔄 RESET MODE: Starting fresh with clean slate');
      paperTradingBalance = PAPER_CAPITAL;
      paperTradingPnL = 0;
      await savePaperTradingState(paperTradingBalance, paperTradingPnL);

      // Clear all active positions from database
      const { supabase } = await import('./db/supabase');
      const { data: existingEntries } = await supabase
        .from('bot_logs')
        .select('*')
        .eq('action', 'ENTRY');

      if (existingEntries && existingEntries.length > 0) {
        logger.info(`🗑️  Found ${existingEntries.length} existing ENTRY logs to clear`);
        // We don't actually delete them, just log that we're starting fresh
        // The rebuild logic will handle finding active positions
      }

      logger.info(`✅ Reset complete: Balance=$${paperTradingBalance.toFixed(2)}, Total P&L=$${paperTradingPnL.toFixed(2)}`);
      logger.warn('⚠️  IMPORTANT: Set RESET_STATE=false in .env to prevent resetting on next restart!');
    } else {
      const savedState = await loadPaperTradingState();
      if (savedState) {
        paperTradingBalance = savedState.balance;
        paperTradingPnL = savedState.totalPnL;

        // Auto-correct balance if it doesn't match Capital + PnL
        const expectedBalance = PAPER_CAPITAL + paperTradingPnL;
        if (Math.abs(paperTradingBalance - expectedBalance) > 0.01) {
          logger.warn(`⚠️ Balance mismatch detected! Saved: $${paperTradingBalance.toFixed(2)}, Expected: $${expectedBalance.toFixed(2)}`);
          logger.info(`🔄 Auto-correcting balance to $${expectedBalance.toFixed(2)}`);
          paperTradingBalance = expectedBalance;
          await savePaperTradingState(paperTradingBalance, paperTradingPnL);
        }

        logger.info(`📊 Loaded saved state: Balance=$${paperTradingBalance.toFixed(2)}, Total P&L=$${paperTradingPnL.toFixed(2)}`);
      } else {
        // No saved state - start fresh at initial capital
        // Don't recalculate from logs as they may contain stale data from before resets
        logger.warn('📊 No saved state found. Starting fresh at initial capital.');
        paperTradingBalance = PAPER_CAPITAL;
        paperTradingPnL = 0;
        await savePaperTradingState(paperTradingBalance, paperTradingPnL);
      }
    }
  }
  if (PAPER_TRADING) {
    logger.info('🎮 PAPER TRADING MODE ENABLED 🎮');
    logger.info('No real money will be used. All trades are simulated.');
  } else {
    logger.info('Starting DLMM Rotation Bot...');
    logger.warn('⚠️  LIVE TRADING MODE - Real money at risk!');
  }

  // Rebuild active positions from database on startup
  logger.info('🔄 Rebuilding active positions from database...');
  const { supabase } = await import('./db/supabase');
  const { data: allLogs } = await supabase
    .from('bot_logs')
    .select('*')
    .in('action', ['ENTRY', 'EXIT'])
    .order('timestamp', { ascending: true });

  // AUTO-SYNC PnL FROM LOGS (Fix for balance mismatch)
  if (PAPER_TRADING && allLogs) {
    const exitLogs = allLogs.filter((l: any) => l.action === 'EXIT');
    if (exitLogs.length > 0) {
      const lastExit = exitLogs[exitLogs.length - 1];
      const lastPnL = (lastExit.details as any)?.paperPnL;

      if (lastPnL !== undefined && typeof lastPnL === 'number') {
        if (Math.abs(lastPnL - paperTradingPnL) > 0.01) {
          logger.warn(`⚠️ PnL Mismatch detected! Saved: $${paperTradingPnL.toFixed(2)}, Logged: $${lastPnL.toFixed(2)}`);
          logger.info(`🔄 Syncing PnL from last EXIT log...`);
          paperTradingPnL = lastPnL;
          paperTradingBalance = PAPER_CAPITAL + paperTradingPnL;
          await savePaperTradingState(paperTradingBalance, paperTradingPnL);
          logger.info(`✅ State synced: Balance=$${paperTradingBalance.toFixed(2)}, PnL=$${paperTradingPnL.toFixed(2)}`);
        }
      }
    }
  }

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
      } else if (log.action === 'EXIT') {
        const pool = (log.details as any)?.pool;
        if (pool) exitedPools.add(pool);
      }
    }

    // Remove exited positions
    for (const pool of exitedPools) {
      entryMap.delete(pool);
    }

    activePositions = Array.from(entryMap.values());
    logger.info(`✅ Recovered ${activePositions.length} active positions from database`);
  }

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

        // Level 2: +30% gain -> Sell another 25%
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

      // --- EMERGENCY EXIT CONDITIONS (bypass 4-hour minimum) ---
      // Exit immediately if catastrophic deterioration occurs
      const tvlCrash = (pos.entryTVL - pool.liquidity) / pos.entryTVL;
      const velocityCrash = (pos.entryVelocity - pool.velocity) / pos.entryVelocity;
      const scoreCrash = (pos.entryScore - pool.score) / pos.entryScore;

      // TIGHTENED: Lowered from 50% to 30% for faster risk response
      const emergencyExit = (
        tvlCrash > 0.30 ||        // 30%+ TVL drop = liquidity crisis
        velocityCrash > 0.30 ||   // 30%+ velocity drop = volume dried up
        scoreCrash > 0.30 ||      // 30%+ score drop = massive deterioration
        pool.score < 40           // Current score dropped below 40 = exit immediately
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
      const volatility = calculateVolatility(pool);
      let trailingStopPct = 0.10; // Default 10%

      if (volatility.classification === 'high') {
        trailingStopPct = 0.20; // 20% for high volatility (give more room)
      } else if (volatility.classification === 'medium') {
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
      const volumeExitTriggered = await checkVolumeExitTrigger(pool);

      // PROFIT PROTECTION: If position is profitable, ignore volume exit
      let shouldApplyVolumeExit = volumeExitTriggered;
      if (volumeExitTriggered && PAPER_TRADING) {
        const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
        const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
        const estimatedReturn = pos.amount * dailyYield * (holdTimeHours / 24);

        if (estimatedReturn > 0) {
          // Position is profitable - ignore volume exit, use trailing stop instead
          shouldApplyVolumeExit = false;
          logger.info(`[PROFIT PROTECTED] Ignoring volume exit for profitable position ${pool.name} (+$${estimatedReturn.toFixed(2)})`);
        }
      }

      // CONFIRMATION REQUIREMENT: Require 2 consecutive cycles of low volume
      if (shouldApplyVolumeExit) {
        pos.consecutiveLowVolumeCycles++;
        if (pos.consecutiveLowVolumeCycles < 2) {
          // Not enough confirmation yet - keep position
          shouldApplyVolumeExit = false;
          logger.info(`[CONFIRMATION] Volume exit triggered for ${pool.name}, waiting for confirmation (${pos.consecutiveLowVolumeCycles}/2)`);
        }
      } else {
        // Reset counter if volume is good
        pos.consecutiveLowVolumeCycles = 0;
      }

      // MICROSTRUCTURE BRAIN: Structural exit evaluation
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

        // Calculate P&L for paper trading
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

    // Correlation-Based Exit: If 3+ pools exiting, market crash likely
    if (exitSignalCount >= 3 && activePositions.length >= 3) {
      logger.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit. Exiting ALL positions.`);
      activePositions = [];
      await logAction('MARKET_CRASH_EXIT', { exitSignalCount });
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
    if (availableCapital < 0) availableCapital = 0;

    // For position sizing caps, use STARTING capital (not current balance which includes profits)
    const startingCapital = parseFloat(process.env.PAPER_CAPITAL || '10000');

    // Filter candidates first to find "Valid Opportunities"
    // Entry mode tracks whether pool qualified via priority or candidate path
    type EntryMode = 'priority' | 'candidate';
    const validCandidates: { pool: Pool, type: TokenType, entryMode: EntryMode }[] = [];

    // Count current positions by type for diversification
    const typeCount = {
      'stable': activePositions.filter(p => p.tokenType === 'stable').length,
      'blue-chip': activePositions.filter(p => p.tokenType === 'blue-chip').length,
      'meme': activePositions.filter(p => p.tokenType === 'meme').length
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // ENTRY GATING PIPELINE
    // 1. Score Threshold → ranks candidates
    // 2. TRANSITION GATE → determines WHEN to fire (compression → expansion)
    // 3. Structural Entry → validates microstructure conditions
    // 4. Volume Trigger → required for candidate tier (unless expansion pulse)
    // ═══════════════════════════════════════════════════════════════════════════
    const PRIORITY_THRESHOLD = 60;
    const CANDIDATE_THRESHOLD = 48;

    for (const candidate of rankedPools) {
      if (activePositions.length + validCandidates.length >= 5) break; // Max 5 positions total

      // Check if already active
      if (activePositions.find(p => p.poolAddress === candidate.address)) continue;

      // Diversification: Max 2 positions per token type
      const candidateType = categorizeToken(candidate);
      // if (typeCount[candidateType as keyof typeof typeCount] >= 2) continue; // (Commented out in original, keeping consistent)

      // Check for duplicate token pairs
      const activePools = activePositions.map(pos => rankedPools.find(p => p.address === pos.poolAddress)).filter((p): p is Pool => p !== undefined);
      if (isDuplicatePair(candidate, activePools)) {
        logger.info(`Skipping ${candidate.name} - duplicate token pair`);
        continue;
      }

      // Determine entry tier based on score
      const isPriorityTier = candidate.score >= PRIORITY_THRESHOLD;
      const isCandidateTier = candidate.score >= CANDIDATE_THRESHOLD && candidate.score < PRIORITY_THRESHOLD;

      // Reject if below candidate threshold
      if (candidate.score < CANDIDATE_THRESHOLD) {
        logger.info(`Skipping ${candidate.name} - score ${candidate.score.toFixed(1)} below candidate threshold ${CANDIDATE_THRESHOLD}`);
        logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Score below candidate threshold');
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // BOOTSTRAP CHECK — First cycle = observe only, NO ENTRY ALLOWED
      // Entry is allowed ONLY after at least one previous snapshot exists
      // ═══════════════════════════════════════════════════════════════════════════
      if ((candidate as any).isBootstrapCycle === true) {
        logger.info(`🔍 [BOOTSTRAP] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - observe only, skipping entry`);
        logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Bootstrap cycle - observe only');
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // MIGRATION REJECTION — Stop entry when liquidity is exiting
      // migrationDirection == "out" OR liquiditySlope < -0.03 → IMMEDIATELY REJECT
      // ═══════════════════════════════════════════════════════════════════════════
      const migrationDir = (candidate as any).migrationDirection as string | undefined;
      const candidateLiqSlope = (candidate as any).liquiditySlope as number | undefined;
      
      if (migrationDir === 'out' || (candidateLiqSlope !== undefined && candidateLiqSlope < -0.03)) {
        logger.warn(`🚫 [MIGRATION REJECT] ${candidate.name} - liquidity exiting concentrated region`);
        logger.warn(`   migrationDirection=${migrationDir}, liquiditySlope=${candidateLiqSlope !== undefined ? (candidateLiqSlope * 100).toFixed(2) + '%' : 'N/A'}`);
        logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, 'Migration reject - liquidity exiting');
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // TRANSITION GATE — Must pass BEFORE structural entry
      // Ensures we only enter on favorable compression → expansion cycles
      // ═══════════════════════════════════════════════════════════════════════════
      const transitionGate = evaluateTransitionGate(candidate);
      
      if (!transitionGate.allowed) {
        // ═══════════════════════════════════════════════════════════════════════════
        // TRANSITION FAILURE → HARD REJECT
        // Do NOT evaluate structural conditions, do not size
        // ═══════════════════════════════════════════════════════════════════════════
        logger.warn(`🚫 [TRANSITION GATE] ${candidate.name} - vel/liq/ent slopes unfavorable`);
        if (process.env.VERBOSE_SCORING === 'true') {
          logger.info(`   velocitySlope: ${transitionGate.telemetry.velocitySlope !== null ? (transitionGate.telemetry.velocitySlope * 100).toFixed(2) + '%' : 'N/A'} (min 8%)`);
          logger.info(`   liquiditySlope: ${transitionGate.telemetry.liquiditySlope !== null ? (transitionGate.telemetry.liquiditySlope * 100).toFixed(2) + '%' : 'N/A'} (min 5%)`);
          logger.info(`   entropySlope: ${transitionGate.telemetry.entropySlope !== null ? (transitionGate.telemetry.entropySlope * 100).toFixed(2) + '%' : 'N/A'} (min 3%)`);
        }
        logEntryRejection(candidate, candidate.score, CANDIDATE_THRESHOLD, transitionGate.reason);
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // STRUCTURAL ENTRY — Microstructure validation (required for ALL entries)
      // ═══════════════════════════════════════════════════════════════════════════
      let structuralEntrySignal = true; // Default to true if no bin scores available
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

      // ═══════════════════════════════════════════════════════════════════════════
      // EXPANSION PULSE — Fast-track entry (bypass volume gating)
      // Detected breakout microstructure → front-run liquidity squeeze
      // Uses aggressive sizing mode
      // ═══════════════════════════════════════════════════════════════════════════
      if (transitionGate.expansionPulse) {
        if (structuralEntrySignal) {
          // Mark pool as expansion pulse for aggressive sizing
          (candidate as any).expansionPulse = true;
          validCandidates.push({ pool: candidate, type: candidateType, entryMode: 'priority' });
          typeCount[candidateType as keyof typeof typeCount]++;
          logger.info(`🔥 [EXPANSION PULSE] ${candidate.name} (Score ${candidate.score.toFixed(1)}) - breakout detected, fast-track entry`);
          logger.info(`   ${transitionGate.reason}`);
        } else {
          logEntryRejection(candidate, candidate.score, PRIORITY_THRESHOLD, `Expansion pulse but structural failed: ${structuralRejectionReason}`);
        }
        continue;
      }

      // ─────────────────────────────────────────────────────────────────────────
      // PRIORITY ENTRY PATH (score >= 60)
      // Transition gate passed, structural entry required, skip volume triggers
      // ─────────────────────────────────────────────────────────────────────────
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

      // ─────────────────────────────────────────────────────────────────────────
      // CANDIDATE ENTRY PATH (48 <= score < 60)
      // Transition gate passed, requires structural + volume triggers
      // ─────────────────────────────────────────────────────────────────────────
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
      // Calculate Total Score of all valid candidates
      const totalScoreSum = validCandidates.reduce((sum, c) => sum + c.pool.score, 0);

      const priorityCount = validCandidates.filter(c => c.entryMode === 'priority').length;
      const candidateCount = validCandidates.filter(c => c.entryMode === 'candidate').length;
      logger.info(`Found ${validCandidates.length} valid candidates (${priorityCount} priority, ${candidateCount} candidate). Total Score Sum: ${totalScoreSum.toFixed(2)}`);

      for (const { pool, type, entryMode } of validCandidates) {
        // --- DYNAMIC ALLOCATION LOGIC ---
        // Weight = PoolScore / TotalScoreSum
        // Raw Allocation = AvailableCapital * Weight

        const weight = pool.score / totalScoreSum;
        let amount = availableCapital * weight;

        // --- ADJUSTMENTS ---

        // 1. Volatility Adjustment
        const volatilityMultiplier = getVolatilityMultiplier(pool);
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
          logger.error(`❌ CRITICAL: Attempting to allocate $${amount.toFixed(0)} but only $${availableCapital.toFixed(0)} available!`);
          amount = availableCapital;
        }

        // Skip if amount is too small (less than $10)
        if (amount < 10) {
          logger.info(`⏭️  Skipping ${pool.name}: Allocation too small ($${amount.toFixed(2)})`);
          continue;
        }

        // Deduct from available for next iteration
        availableCapital -= amount;

        // CRITICAL FIX: Safety check to prevent negative available capital
        if (availableCapital < 0) {
          logger.error(`❌ CRITICAL: availableCapital went negative ($${availableCapital.toFixed(2)})! This should never happen.`);
          availableCapital = 0;
        }

        // --- ALLOCATION TRACKING & WARNINGS ---
        const totalDeployed = activePositions.reduce((sum, p) => sum + p.amount, 0) + amount;
        const deploymentPct = (totalDeployed / totalCapital) * 100;
        const positionPct = (amount / totalCapital) * 100;

        // Entry type logging based on entry mode
        const entryEmoji = entryMode === 'priority' ? '🚀 PRIORITY ENTRY' : '📈 CANDIDATE ENTRY';
        const prefix = PAPER_TRADING ? '[PAPER] ' : '';
        logger.info(`${prefix}${entryEmoji}: ${pool.name}. Score: ${pool.score.toFixed(2)} (Weight: ${(weight * 100).toFixed(1)}%)`);
        logger.info(`💰 Allocation: $${amount.toFixed(0)} (${positionPct.toFixed(1)}% of total capital)`);
        logger.info(`📊 Total Deployed: $${totalDeployed.toFixed(0)} / $${totalCapital.toFixed(0)} (${deploymentPct.toFixed(1)}%)`);
        logger.info(`💵 Remaining Available: $${availableCapital.toFixed(0)} (${((availableCapital / totalCapital) * 100).toFixed(1)}%)`);

        // CRITICAL ERROR: Alert if deployment exceeds 100%
        if (deploymentPct > 100) {
          logger.error(`❌ CRITICAL BUG: Total deployment ${deploymentPct.toFixed(1)}% exceeds 100%!`);
          logger.error(`   Total Capital: $${totalCapital.toFixed(0)}`);
          logger.error(`   Total Deployed: $${totalDeployed.toFixed(0)}`);
          logger.error(`   This Position: $${amount.toFixed(0)}`);
          // Don't add this position - we've exceeded 100%
          continue;
        }

        // Warning if approaching 100%
        if (deploymentPct > 95) {
          logger.warn(`⚠️  WARNING: Total deployment at ${deploymentPct.toFixed(1)}% - approaching full deployment`);
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // TRADE EXECUTION - Create position via trading module
        // ═══════════════════════════════════════════════════════════════════════════
        
        // Check for existing active trade on this pool (1 trade per pool limit)
        if (hasActiveTrade(pool.address)) {
          logger.warn(`⚠️ Already have open trade on ${pool.name}`);
          continue;
        }
        
        // Determine sizing mode based on expansion pulse (tracked during entry eval)
        const isExpansionEntry = entryMode === 'priority' && (pool as any).expansionPulse === true;
        const sizingMode = getSizingMode(isExpansionEntry);
        
        // Log expansion pulse for aggressive mode
        if (isExpansionEntry) {
          logger.info(`🔥 [EXPANSION PULSE] ${pool.name} - breakout detected`);
        }
        
        // Execute trade entry with capital guardrails
        // Pass both availableCapital and startingCapital for proper percentage calculations
        const tradeResult = await enterPosition(pool as any, sizingMode, availableCapital, startingCapital);
        
        if (tradeResult.success && tradeResult.trade) {
          // Use trade size instead of legacy amount calculation
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

  while (true) {
    try {
      logger.info('--- Starting Scan Cycle ---');
      const startTime = Date.now();

      // ═══════════════════════════════════════════════════════════════════════════
      // DYNAMIC POOL UNIVERSE DISCOVERY
      // Replaces static DLMM_POOLS with autonomous pool discovery
      // ═══════════════════════════════════════════════════════════════════════════
      
      // Discovery parameters
      const discoveryParams = {
        minTVL: 250000,        // $250k minimum TVL
        minVolume24h: 150000,  // $150k minimum 24h volume
        minTraders24h: 300,    // 300+ unique traders
        maxPools: 30,          // Limit to top 30 pools
      };
      
      // Discover pool universe (cached for 5-8 minutes)
      const cacheStatus = getCacheStatus();
      if (cacheStatus.cached) {
        logger.info(`📦 [UNIVERSE] Using cached universe (${cacheStatus.poolCount} pools, age: ${Math.round(cacheStatus.age / 1000)}s)`);
      }
      
      const poolUniverse = await discoverDLMMUniverses(discoveryParams);
      
      if (poolUniverse.length === 0) {
        logger.warn('⚠️ No valid pools discovered - skipping cycle');
        await new Promise(resolve => setTimeout(resolve, LOOP_INTERVAL_MS));
        continue;
      }
      
      // Convert EnrichedPool[] to Pool[] for compatibility with scoring pipeline
      const pools: Pool[] = poolUniverse.map(ep => enrichedPoolToPool(ep) as Pool);
      
      // Track active positions
      const activeAddresses = new Set(activePositions.map(p => p.poolAddress));
      
      // All discovered pools are already filtered and validated
      // No additional safety filter needed here - already applied in indexer
      let enrichedCandidates = pools;
      
      // CRITICAL: Ensure active positions are ALWAYS included in analysis
      // If an active pool is not in the discovered universe, we need to track it for exits
      const missingActivePools: Pool[] = [];
      for (const pos of activePositions) {
        const inUniverse = enrichedCandidates.find(p => p.address === pos.poolAddress);
        if (!inUniverse) {
          // Active pool not in universe - create minimal pool object for exit monitoring
          logger.info(`📍 Adding active position ${pos.poolAddress} to monitoring (not in current universe)`);
          missingActivePools.push({
            address: pos.poolAddress,
            name: 'Active Position',
            tokenX: '',
            tokenY: '',
            mintX: '',
            mintY: '',
            liquidity: 0,
            volume24h: 0,
            volume1h: 0,
            volume4h: 0,
            velocity: 0,
            fees24h: 0,
            apr: 0,
            binStep: 0,
            baseFee: 0,
            binCount: 0,
            createdAt: 0,
            holderCount: 0,
            topHolderPercent: 0,
            isRenounced: true,
            riskScore: 0,
            dilutionScore: 0,
            score: 0,
            currentPrice: 0,
          } as Pool);
        }
      }
      
      if (missingActivePools.length > 0) {
        enrichedCandidates = [...enrichedCandidates, ...missingActivePools];
      }
      
      logger.info(`📊 Processing ${enrichedCandidates.length} pools (${poolUniverse.length} discovered + ${missingActivePools.length} active)`);

      // ═══════════════════════════════════════════════════════════════════════════
      // TELEMETRY PROCESSING LOOP
      // Pools from indexer are already enriched with telemetry
      // Only need to fetch fresh data for active positions not in universe
      // ═══════════════════════════════════════════════════════════════════════════
      const poolsToRemove: string[] = [];
      
      for (const pool of enrichedCandidates) {
        pool.dilutionScore = await calculateDilutionScore(pool);
        pool.riskScore = calculateRiskScore(pool);
        
        // Check if this pool came from the indexer (already has telemetry)
        const hasIndexerTelemetry = (pool as any).entropy !== undefined && 
                                     (pool as any).entropy > 0 &&
                                     pool.binCount > 0;
        
        // ═══════════════════════════════════════════════════════════════════════════
        // TELEMETRY HANDLING
        // - Pools from indexer: already enriched, just update history
        // - Active positions not in universe: fetch fresh telemetry
        // ═══════════════════════════════════════════════════════════════════════════
        try {
          let enrichedSnapshot: EnrichedSnapshot;
          
          if (hasIndexerTelemetry) {
            // Pool from indexer - construct snapshot from existing data
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
            // Pool not from indexer (e.g., active position) - fetch fresh telemetry
            const existingHistory = binSnapshotHistory.get(pool.address) || [];
            const previousSnapshot = existingHistory[existingHistory.length - 1];
            
            enrichedSnapshot = await getEnrichedDLMMState(pool.address, previousSnapshot);
            
            // Validate telemetry for non-indexer pools
            if (enrichedSnapshot.invalidTelemetry) {
              logger.warn(`⚠️ [TELEMETRY] ${pool.name} - invalid on-chain telemetry`);
              poolsToRemove.push(pool.address);
              continue;
            }
            
            if (enrichedSnapshot.liquidity <= 0 || enrichedSnapshot.binCount <= 0) {
              logger.warn(`⚠️ [TELEMETRY] ${pool.name} - zero liquidity or bins`);
              poolsToRemove.push(pool.address);
              continue;
            }
            
            // Update pool with fetched telemetry
            (pool as any).onChainLiquidity = enrichedSnapshot.liquidity;
            pool.velocity = enrichedSnapshot.velocity;
            pool.binCount = enrichedSnapshot.binCount;
            (pool as any).entropy = enrichedSnapshot.entropy;
            (pool as any).migrationDirection = enrichedSnapshot.migrationDirection;
            (pool as any).activeBin = enrichedSnapshot.activeBin;
          }
          
          // ─────────────────────────────────────────────────────────────────────────
          // PART B: Save snapshot for transition scoring
          // ─────────────────────────────────────────────────────────────────────────
          if (!binSnapshotHistory.has(pool.address)) {
            binSnapshotHistory.set(pool.address, []);
          }
          const history = binSnapshotHistory.get(pool.address)!;
          history.push(enrichedSnapshot);
          
          // Keep only last MAX_HISTORY_LENGTH snapshots
          while (history.length > MAX_HISTORY_LENGTH) {
            history.shift();
          }
          
          // ─────────────────────────────────────────────────────────────────────────
          // BOOTSTRAP CHECK: First cycle = observe only
          // Entry is allowed ONLY after at least one previous snapshot exists
          // Think of cycle 1 as "observe only" - scoring allowed, NO ENTRY
          // ─────────────────────────────────────────────────────────────────────────
          const isFirstCycle = history.length < 2;
          (pool as any).isBootstrapCycle = isFirstCycle;
          
          if (isFirstCycle) {
            logger.info(`🔍 [BOOTSTRAP] ${pool.name} - first cycle, observe only (no entry allowed)`);
            // Set undefined slopes to indicate no transition data available
            (pool as any).prevVelocity = undefined;
            (pool as any).prevLiquidity = undefined;
            (pool as any).prevEntropy = undefined;
            (pool as any).velocitySlope = undefined;
            (pool as any).liquiditySlope = undefined;
            (pool as any).entropySlope = undefined;
          }
          
          // ─────────────────────────────────────────────────────────────────────────
          // PART C: Compute transition metrics from last 2 snapshots
          // Proper slope calculation: (curr - prev) / prev
          // Negative slopes are preserved - NO absolute values
          // ─────────────────────────────────────────────────────────────────────────
          if (history.length >= 2) {
            const prev = history[history.length - 2];
            const curr = history[history.length - 1];
            
            // Attach previous values for transition gate
            (pool as any).prevVelocity = prev.velocity;
            (pool as any).prevLiquidity = prev.liquidity;
            (pool as any).prevEntropy = prev.entropy;
            
            // Compute transition slopes (preserve negative values!)
            const velocitySlope = prev.velocity > 0 
              ? (curr.velocity - prev.velocity) / prev.velocity 
              : 0;
            const liquiditySlope = prev.liquidity > 0 
              ? (curr.liquidity - prev.liquidity) / prev.liquidity 
              : 0;
            const entropySlope = curr.entropy - prev.entropy;  // Direct difference, not ratio
            
            // Attach transition data to pool for scoring and entry gates
            (pool as any).velocitySlope = velocitySlope;
            (pool as any).liquiditySlope = liquiditySlope;
            (pool as any).entropySlope = entropySlope;
            
            // Log transition metrics in verbose mode
            if (process.env.VERBOSE_SCORING === 'true') {
              logger.info(`📊 [DLMM] ${pool.name} transitions: vel=${(velocitySlope * 100).toFixed(1)}%, liq=${(liquiditySlope * 100).toFixed(1)}%, ent=${entropySlope.toFixed(4)}`);
            }
          }
          
          // Attach bin snapshot and scores for structural entry/exit evaluation
          (pool as any).binSnapshot = enrichedSnapshot;
          
        } catch (dlmmError) {
          // Telemetry processing failed - skip pool
          logger.warn(`⚠️ [TELEMETRY] ${pool.name} - processing failed: ${dlmmError}`);
          poolsToRemove.push(pool.address);
          continue;
        }
        
        // Score pool with all attached transition data
        pool.score = scorePool(pool);
        await saveSnapshot(pool);
      }
      
      // ═══════════════════════════════════════════════════════════════════════════
      // Remove pools that failed telemetry validation
      // ═══════════════════════════════════════════════════════════════════════════
      const validCandidatesList = enrichedCandidates.filter(p => !poolsToRemove.includes(p.address));
      if (poolsToRemove.length > 0) {
        logger.info(`📋 Filtered ${poolsToRemove.length} pools with missing/invalid telemetry. ${validCandidatesList.length} valid pools remaining.`);
      }
      
      // Use validCandidatesList for all subsequent operations (kill switch, sorting, rotation)
      for (const pool of validCandidatesList) {
        // MICROSTRUCTURE BRAIN: Additional bin analysis and kill switch
        try {
          // Get the latest snapshot for kill switch evaluation
          const history = binSnapshotHistory.get(pool.address) || [];

          // Score bins using current snapshot and history

          // MICROSTRUCTURE BRAIN: Kill switch check (before any trading decisions)
          const allSnapshots = Array.from(binSnapshotHistory.values()).flat();
          const killDecision = evaluateKill(allSnapshots, activePositions);

          if (killDecision.killAll) {
            logger.error(`🚨 KILL SWITCH ACTIVATED: ${killDecision.reason}`);
            logger.error('🚨 Liquidating all positions and pausing trading for 10 minutes');

            // Liquidate all positions
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
            killSwitchPauseUntil = Date.now() + (10 * 60 * 1000); // Pause for 10 minutes

            await logAction('KILL_SWITCH', {
              reason: killDecision.reason,
              positionsLiquidated: activePositions.length,
              pauseUntil: new Date(killSwitchPauseUntil).toISOString()
            });

            // Skip rotation this cycle
            const duration = Date.now() - startTime;
            logger.info(`Cycle completed in ${duration}ms. Sleeping...`);
            await logAction('HEARTBEAT', {
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
            logger.warn(`⏸️  Trading paused by kill switch. Resuming in ${remainingSeconds}s`);
            const duration = Date.now() - startTime;
            await logAction('HEARTBEAT', {
              duration,
              candidates: candidates.length,
              paperTrading: PAPER_TRADING,
              paperBalance: PAPER_TRADING ? paperTradingBalance : undefined,
              killSwitchPaused: true
            });
            continue; // Skip to next cycle
          }

          // Sort by Score - use validCandidatesList to exclude pools with missing telemetry
          const sortedPools = validCandidatesList.sort((a, b) => b.score - a.score);

          // Deduplicate: Remove duplicate token pairs, keep best pool per pair
          const deduplicatedPools = deduplicatePools(sortedPools);
          logger.info(`Deduplicated ${sortedPools.length} pools to ${deduplicatedPools.length} unique pairs`);

          const topPools = deduplicatedPools.slice(0, 5);

          logger.info('Top 5 Pools', { pools: topPools.map(p => `${p.name} (${p.score.toFixed(2)})`) });

          // 4. Rotation Engine (with microstructure brain integration)
          await manageRotation(sortedPools);

          const duration = Date.now() - startTime;
          logger.info(`Cycle completed in ${duration}ms. Sleeping...`);

          // Log heartbeat to Supabase for dashboard status
          await logAction('HEARTBEAT', {
            duration,
            candidates: candidates.length,
            paperTrading: PAPER_TRADING,
            paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
          });
        } catch (error) {
          logger.error('Error fetching DLMM state:', error);
        }
      }

      await new Promise(resolve => setTimeout(resolve, LOOP_INTERVAL_MS));
    } catch (error) {
      logger.error('❌ Error in main scan loop:', error);
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s before retry
    }
  }
};

runBot().catch(console.error);
