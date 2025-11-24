import { scanPools } from './core/scanPools';
import { savePaperTradingState, loadPaperTradingState } from './utils/state';
import { normalizePools, Pool } from './core/normalizePools';
import { applySafetyFilters, calculateRiskScore } from './core/safetyFilters';
import { checkVolumeEntryTrigger, checkVolumeExitTrigger } from './core/volume';
import { calculateDilutionScore } from './core/dilution';
import { scorePool } from './scoring/scorePool';
import { logAction, saveSnapshot } from './db/supabase';
import logger from './utils/logger';
import { getVolatilityMultiplier, calculateVolatility } from './utils/volatility';
import { deduplicatePools, isDuplicatePair } from './utils/arbitrage';
import { isHighlyCorrelated } from './utils/correlation';
import { ActivePosition, TokenType } from './types';
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
        logger.info(`📊 Loaded saved state: Balance=$${paperTradingBalance.toFixed(2)}, Total P&L=$${paperTradingPnL.toFixed(2)}`);
      } else {
        // No saved state - recalculate from database logs
        logger.info('📊 No saved state found. Recalculating from database logs...');
        const { supabase } = await import('./db/supabase');
        const { data: logs } = await supabase
          .from('bot_logs')
          .select('*')
          .order('timestamp', { ascending: false })
          .limit(1000);

        if (logs && logs.length > 0) {
          // Find the most recent paperPnL value
          for (const log of logs) {
            const pnl = (log.details as any)?.paperPnL;
            if (pnl !== undefined && pnl !== null) {
              paperTradingPnL = pnl;
              paperTradingBalance = PAPER_CAPITAL + pnl;
              logger.info(`📊 Recalculated from logs: Balance=$${paperTradingBalance.toFixed(2)}, Total P&L=$${paperTradingPnL.toFixed(2)}`);
              // Save this state for next time
              await savePaperTradingState(paperTradingBalance, paperTradingPnL);
              break;
            }
          }
        }
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

      // Log heartbeat to Supabase for dashboard status
      await logAction('HEARTBEAT', {
        duration,
        candidates: candidates.length,
        paperTrading: PAPER_TRADING,
        paperBalance: PAPER_TRADING ? paperTradingBalance : undefined
      });
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

    const emergencyExit = (
      tvlCrash > 0.50 ||        // 50%+ TVL drop = liquidity crisis
      velocityCrash > 0.50 ||   // 50%+ velocity drop = volume dried up
      scoreCrash > 0.30         // 30%+ score drop = massive deterioration
    );

    if (emergencyExit) {
      const reason = tvlCrash > 0.50 ? "Emergency: TVL Crash" :
        velocityCrash > 0.50 ? "Emergency: Volume Crash" :
          "Emergency: Score Crash";

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
        paperTrading: PAPER_TRADING,
        paperPnL: PAPER_TRADING ? paperTradingPnL : undefined
      });
      exitSignalCount++;
      continue;
    }
    // Min hold time check
    if (holdTime < MIN_HOLD_TIME_MS) {
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

    const shouldExit = trailingStopTriggered || tvlDropTriggered || velocityDropTriggered || shouldApplyVolumeExit;

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
  const validCandidates: { pool: Pool, type: TokenType }[] = [];

  // Count current positions by type for diversification
  const typeCount = {
    'stable': activePositions.filter(p => p.tokenType === 'stable').length,
    'blue-chip': activePositions.filter(p => p.tokenType === 'blue-chip').length,
    'meme': activePositions.filter(p => p.tokenType === 'meme').length
  };

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

    // QUALITY FILTER: Minimum score threshold
    // Don't enter pools with terrible scores, even if volume/velocity signals are present
    const MIN_SCORE_THRESHOLD = 50;
    if (candidate.score < MIN_SCORE_THRESHOLD) {
      logger.info(`Skipping ${candidate.name} - score ${candidate.score.toFixed(1)} below threshold ${MIN_SCORE_THRESHOLD}`);
      continue;
    }

    // Check entry trigger
    const entrySignal = await checkVolumeEntryTrigger(candidate);
    if (entrySignal) {
      validCandidates.push({ pool: candidate, type: candidateType });
      // Increment type count temporarily to prevent stacking same type in one cycle if we were enforcing it
      typeCount[candidateType as keyof typeof typeCount]++;
    }
  }

  if (validCandidates.length > 0) {
    // Calculate Total Score of all valid candidates
    const totalScoreSum = validCandidates.reduce((sum, c) => sum + c.pool.score, 0);

    logger.info(`Found ${validCandidates.length} valid candidates. Total Score Sum: ${totalScoreSum.toFixed(2)}`);

    for (const { pool, type } of validCandidates) {
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

      // --- FINAL SAFETY CAPS (AFTER ALL MULTIPLIERS) ---

      // 5. Max Portfolio Weight: 30% of Current Total Capital
      // For compounding: this allows profits to be reinvested, but caps each position at 30%
      const maxPortfolioWeight = totalCapital * 0.30;
      if (amount > maxPortfolioWeight) {
        logger.warn(`⚠️  CAPPING ${pool.name}: Calculated $${amount.toFixed(0)} exceeds 30% of total capital ($${totalCapital.toFixed(0)}). Reducing to $${maxPortfolioWeight.toFixed(0)}`);
        amount = maxPortfolioWeight;
      }

      // 6. CRITICAL FIX: Re-cap against CURRENT availableCapital after ALL multipliers
      // This prevents the bug where multipliers increase allocation beyond what's available
      if (amount > availableCapital) {
        logger.warn(`⚠️  RECAPPING ${pool.name}: Post-multiplier amount $${amount.toFixed(0)} exceeds available $${availableCapital.toFixed(0)}`);
        amount = availableCapital;
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

      const prefix = PAPER_TRADING ? '[PAPER] ' : '';
      logger.info(`${prefix}Rotating INTO ${pool.name}. Score: ${pool.score.toFixed(2)} (Weight: ${(weight * 100).toFixed(1)}%)`);
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

      await logAction('ENTRY', {
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

// Start
runBot();
