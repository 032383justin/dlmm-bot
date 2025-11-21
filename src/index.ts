import { scanPools } from './core/scanPools';
import { savePaperTradingState, loadPaperTradingState } from './utils/state';
import { normalizePools, Pool } from './core/normalizePools';
import { applySafetyFilters, calculateRiskScore } from './core/safetyFilters';
import { checkVolumeEntryTrigger, checkVolumeExitTrigger } from './core/volume';
import { calculateDilutionScore } from './core/dilution';
import { scorePool } from './scoring/scorePool';
import { logAction, saveSnapshot } from './db/supabase';
import logger from './utils/logger';
import { getVolatilityMultiplier } from './utils/volatility';
import { deduplicatePools, isDuplicatePair } from './utils/arbitrage';
import { isHighlyCorrelated } from './utils/correlation';
import dotenv from 'dotenv';

dotenv.config();

const LOOP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_HOLD_TIME_MS = 4 * 60 * 60 * 1000; // 4 hours

// Paper Trading Mode
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const PAPER_CAPITAL = parseFloat(process.env.PAPER_CAPITAL || '10000');
let paperTradingBalance = PAPER_CAPITAL;
let paperTradingPnL = 0;

interface ActivePosition {
  poolAddress: string;
  entryTime: number;
  entryScore: number;
  peakScore: number; // For trailing stop-loss
  amount: number;
  entryTVL: number; // For tracking TVL drops
  entryVelocity: number; // For tracking velocity drops
  consecutiveCycles: number; // For multi-timeframe confirmation
  tokenType: string; // For diversification (meme, blue-chip, stable)
}

let activePositions: ActivePosition[] = [];

// Token categorization for diversification
const categorizeToken = (pool: Pool): string => {
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
    const savedState = await loadPaperTradingState();
    if (savedState) {
      paperTradingBalance = savedState.balance;
      paperTradingPnL = savedState.totalPnL;
      logger.info(`📊 Loaded saved state: Balance=$${paperTradingBalance.toFixed(2)}, Total P&L=$${paperTradingPnL.toFixed(2)}`);
    } else {
    }
  }
  if (PAPER_TRADING) {
    logger.info('🎮 PAPER TRADING MODE ENABLED 🎮');
    logger.info('No real money will be used. All trades are simulated.');
  } else {
    logger.info('Starting DLMM Rotation Bot...');
    logger.warn('⚠️  LIVE TRADING MODE - Real money at risk!');
  }

  while (true) {
    try {
      logger.info('--- Starting Scan Cycle ---');
      const startTime = Date.now();

      // 1. Scan & Normalize
      const rawPools = await scanPools();
      let pools = normalizePools(rawPools);

      // 2. Filter & Enrich
      const candidates = pools.filter(p => {
        const { passed, reason } = applySafetyFilters(p);
        return passed;
      });

      logger.info(`Found ${candidates.length} candidates after safety filters.`);

      // 3. Deep Analysis (Dilution, Volume Triggers)
      const topCandidates = candidates.sort((a, b) => b.volume24h - a.volume24h).slice(0, 50);

      for (const pool of topCandidates) {
        pool.dilutionScore = await calculateDilutionScore(pool);
        pool.riskScore = calculateRiskScore(pool);
        pool.score = scorePool(pool);
        await saveSnapshot(pool);
      }

      // Sort by Score
      const sortedPools = topCandidates.sort((a, b) => b.score - a.score);

      // Deduplicate: Remove duplicate token pairs, keep best pool per pair
      const deduplicatedPools = deduplicatePools(sortedPools);
      logger.info(`Deduplicated ${sortedPools.length} pools to ${deduplicatedPools.length} unique pairs`);

      const topPools = deduplicatedPools.slice(0, 5);

      logger.info('Top 5 Pools', { pools: topPools.map(p => `${p.name} (${p.score.toFixed(2)})`) });

      // 4. Rotation Engine
      await manageRotation(sortedPools);

      const duration = Date.now() - startTime;
      logger.info(`Cycle completed in ${duration}ms. Sleeping...`);
    } catch (error) {
      logger.error('Error in main loop:', error);
    }

    await new Promise(resolve => setTimeout(resolve, LOOP_INTERVAL_MS));
  }
};

const manageRotation = async (rankedPools: Pool[]) => {
  const now = Date.now();
  const remainingPositions: ActivePosition[] = [];
  let exitSignalCount = 0;

  // 1. Check Exits with Advanced Triggers
  for (const pos of activePositions) {
    const pool = rankedPools.find(p => p.address === pos.poolAddress);

    if (!pool) {
      logger.warn(`Active pool ${pos.poolAddress} not found in ranked list. Exiting.`);
      await logAction('EXIT', { reason: 'Pool dropped from ranking', pool: pos.poolAddress });
      exitSignalCount++;
      continue;
    }

    const holdTime = now - pos.entryTime;

    // Update peak score for trailing stop-loss
    if (pool.score > pos.peakScore) {
      pos.peakScore = pool.score;
    }

    // Min hold time check
    if (holdTime < MIN_HOLD_TIME_MS) {
      remainingPositions.push(pos);
      continue;
    }

    // --- EXIT TRIGGERS ---

    // 1. Trailing Stop-Loss (10% from peak)
    const trailingStopPct = 0.10;
    const trailingStopTriggered = pool.score < (pos.peakScore * (1 - trailingStopPct));

    // 2. TVL Drop (from entry)
    const tvlDrop = (pos.entryTVL - pool.liquidity) / pos.entryTVL;
    const tvlDropTriggered = tvlDrop > 0.20; // 20% TVL drop

    // 3. Velocity Drop (from entry)
    const velocityDrop = (pos.entryVelocity - pool.velocity) / pos.entryVelocity;
    const velocityDropTriggered = velocityDrop > 0.25; // 25% velocity drop

    // 4. Volume-based exit (existing)
    const volumeExitTriggered = await checkVolumeExitTrigger(pool);

    const shouldExit = trailingStopTriggered || tvlDropTriggered || velocityDropTriggered || volumeExitTriggered;

    if (shouldExit) {
      const reason = trailingStopTriggered ? 'Trailing Stop' :
        tvlDropTriggered ? 'TVL Drop' :
          velocityDropTriggered ? 'Velocity Drop' : 'Volume Exit';

      // Calculate P&L for paper trading
      if (PAPER_TRADING) {
        const holdTimeHours = (now - pos.entryTime) / (1000 * 60 * 60);
        const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) : 0;
        const estimatedReturn = pos.amount * dailyYield * (holdTimeHours / 24);
        paperTradingPnL += estimatedReturn;
        paperTradingBalance += estimatedReturn;

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
  const targetAllocations = [0.40, 0.25, 0.20, 0.10, 0.05];

  // Count current positions by type for diversification
  const typeCount = {
    'stable': activePositions.filter(p => p.tokenType === 'stable').length,
    'blue-chip': activePositions.filter(p => p.tokenType === 'blue-chip').length,
    'meme': activePositions.filter(p => p.tokenType === 'meme').length
  };

  for (let i = 0; i < 5; i++) {
    if (activePositions.length >= 5) break;

    const candidate = rankedPools[i];
    if (!candidate) break;

    // Check if already active
    if (activePositions.find(p => p.poolAddress === candidate.address)) continue;

    // Diversification: Max 2 positions per token type
    const candidateType = categorizeToken(candidate);
    if (typeCount[candidateType as keyof typeof typeCount] >= 2) {
      logger.info(`Skipping ${candidate.name} - already have 2 ${candidateType} positions`);
      continue;
    }

    // Check for duplicate token pairs
    const activePools = activePositions.map(pos => rankedPools.find(p => p.address === pos.poolAddress)).filter((p): p is Pool => p !== undefined);
    if (isDuplicatePair(candidate, activePools)) {
      logger.info(`Skipping ${candidate.name} - duplicate token pair already in portfolio`);
      continue;
    }

    // Correlation Analysis: Skip if highly correlated with existing positions
    if (isHighlyCorrelated(candidate, activePools, 0.7)) {
      logger.info(`Skipping ${candidate.name} - highly correlated with existing positions`);
      continue;
    }

    // Multi-Timeframe Confirmation: Check if pool has been in top 10 for 2+ cycles
    // For now, we'll use a simpler check - just verify entry signal
    const entrySignal = await checkVolumeEntryTrigger(candidate);

    if (entrySignal) {
      // Use current balance for compounding (paper trading balance grows with profits)
      const totalCapital = PAPER_TRADING ? paperTradingBalance : parseFloat(process.env.TOTAL_CAPITAL || '10000');
      const targetPct = targetAllocations[activePositions.length];
      let amount = totalCapital * targetPct;

2      // Volatility-Adjusted Position Sizing
      const volatilityMultiplier = getVolatilityMultiplier(candidate);
      amount *= volatilityMultiplier;

      if (volatilityMultiplier < 1.0) {
        logger.info(`Reducing position size for ${candidate.name} due to volatility (${(volatilityMultiplier * 100).toFixed(0)}% of normal)`);
      }

      // Dynamic Position Sizing based on TVL (additional safety)
      if (candidate.liquidity < 100000) {
        amount *= 0.5; // Half size for small pools
        logger.info(`Further reducing position size for ${candidate.name} due to low TVL`);
      }

      // Liquidity Cap: Max 5% of Pool TVL
      const maxAllowed = candidate.liquidity * 0.05;

      if (amount > maxAllowed) {
        logger.warn(`Capping allocation for ${candidate.name}. Target: $${amount.toFixed(0)}, Max Allowed (5% TVL): $${maxAllowed.toFixed(0)}`);
        amount = maxAllowed;
      }

      const prefix = PAPER_TRADING ? '[PAPER] ' : '';
      logger.info(`${prefix}Rotating INTO ${candidate.name}. Score: ${candidate.score.toFixed(2)}. Allocating: $${amount.toFixed(0)}`);

      activePositions.push({
        poolAddress: candidate.address,
        entryTime: now,
        entryScore: candidate.score,
        peakScore: candidate.score,
        amount: amount,
        entryTVL: candidate.liquidity,
        entryVelocity: candidate.velocity,
        consecutiveCycles: 1,
        tokenType: candidateType
      });

      await logAction('ENTRY', {
        pool: candidate.address,
        score: candidate.score,
        amount,
        type: candidateType,
        paperTrading: PAPER_TRADING,
        paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
      });

      // Update type count
      typeCount[candidateType as keyof typeof typeCount]++;
    }
  }
};

// Start
runBot();
