import dotenv from "dotenv";
dotenv.config();

const TEST_MODE = process.env.TEST_MODE === 'true';

import { scanPools } from './core/scanPools';
import { isPoolSafe } from './core/safetyFilters';
import { allocateCapital } from './execution/allocation';
import { scorePools } from './scoring/scorePool';
import { DEFAULT_CONFIG } from './config';
import { logMessage } from './storage/queries';
import { runEvery } from './utils/scheduler';
import { computeMomentum } from './core/momentum';
import { computeDilution } from './core/dilution';
import { checkGlobalRisk, checkPoolRisk } from './core/riskEngine';
import {
  getActivePositions,
  getCapitalState,
  addPosition,
  exitPositionRecord,
} from './storage/stateManager';
import { evaluateRotation, ActivePosition } from './execution/rotation';
import { simulatePnL, recordPerformance } from './storage/performance';

console.log('Bot scheduler started (5 min interval)');

async function runBot(): Promise<void> {
  try {
    console.log('Bot tick started.');
    console.log('Runtime config:', DEFAULT_CONFIG.ENV);

    const TOTAL_CAPITAL = 2500; // TODO: move to configuration.

    const state = await getCapitalState(TOTAL_CAPITAL);

    const globalRisk = checkGlobalRisk({
      totalCapital: TOTAL_CAPITAL,
      deployedCapital: state.deployedCapital,
      activePositions: state.activePositions.length,
      lastExitTimestamp: undefined, // TODO: wire real exit timestamps.
    });

    if (!globalRisk.safe) {
      console.log('Global risk prevented action:', globalRisk.reason);
      return;
    }

    const pools = await scanPools();

    const safePools = [];
    for (const pool of pools) {
      if (await isPoolSafe(pool)) {
        safePools.push(pool);
      }
    }

    const scored = scorePools(safePools);

    const riskFiltered = scored.filter((pool) => {
      const risk = checkPoolRisk(pool.score, 0.2); // TODO: real supply concentration metric.
      if (!risk.safe) {
        console.log('Pool filtered by risk engine:', pool.id, risk.reason);
        return false;
      }
      return true;
    });

    const activeForRotation: ActivePosition[] = state.activePositions.map(
      (position) => {
        const latestScore =
          riskFiltered.find((pool) => pool.id === position.poolId)?.score ??
          position.score ??
          0;
        return {
          poolId: position.poolId,
          score: latestScore,
          amount: position.amount,
          enteredAt: position.enteredAt,
        };
      },
    );

    const rotation = evaluateRotation(activeForRotation, riskFiltered);

    for (const decision of rotation) {
      if (decision.action === 'exit') {
        console.log('Exiting pool:', decision.poolId, decision.reason);
        await exitPositionRecord(decision.poolId);
        // TODO: integrate with positionManager exit logic.
      }
    }

    const refreshedState = await getCapitalState(TOTAL_CAPITAL);

    console.log('Simulating PnL for active positions...');
    for (const position of refreshedState.activePositions) {
      const pool = scored.find((p) => p.id === position.poolId);
      if (!pool) {
        continue;
      }

      const performance = simulatePnL(position, {
        tvl: pool.components.tvl ?? 0,
        volume24h: pool.components.volume ?? 0,
      });

      console.log(
        `PnL >> Pool: ${position.poolId}, ROI: ${(performance.roi * 100).toFixed(2)}%, PnL: ${performance.pnl.toFixed(4)}`,
      );

      await recordPerformance(performance);
    }
    console.log('PnL simulation complete.');

    const allocationDecisions = allocateCapital(
      refreshedState.availableCapital,
      riskFiltered,
    );

    console.log('Allocation decisions:', allocationDecisions);

    for (const decision of allocationDecisions) {
      if (decision.amount <= 0) {
        continue;
      }

      const targetPool = safePools.find(
        (pool) => pool.id === decision.poolId,
      );

      if (targetPool) {
        const approximateVolume1h = targetPool.volume24h / 24;
        const approximateVolume4h = targetPool.volume24h / 6;
        const momentumDiagnostics = computeMomentum({
          volume1h: approximateVolume1h,
          volume4h: approximateVolume4h,
        });
        const dilutionDiagnostics = computeDilution({
          tvlNow: targetPool.tvl,
          tvl1hAgo: targetPool.tvl, // TODO: replace with real 1h-ago TVL.
          volume1h: approximateVolume1h,
        });
        console.log('Diagnostics:', {
          poolId: targetPool.id,
          momentum: momentumDiagnostics,
          dilution: dilutionDiagnostics,
        });
      }

      console.log('Entering pool:', decision.poolId, 'amount:', decision.amount);
      await addPosition({
        poolId: decision.poolId,
        amount: decision.amount,
        isActive: true,
        enteredAt: new Date().toISOString(),
        score: decision.score,
      });
      // TODO: integrate with positionManager enter logic.
    }

    const activePositions = await getActivePositions();
    console.log('Active positions count:', activePositions.length);

    await logMessage(
      'info',
      `Processed ${allocationDecisions.length} allocation decisions.`,
    );

    console.log('Bot tick completed.');
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown bot runtime error';
    console.error('Bot runtime error:', error);
    await logMessage('error', message);
  }
}

if (TEST_MODE) {
  console.log('Running in TEST MODE (single run)...');
  runBot().then(() => {
    console.log('Test mode completed.');
    process.exit(0);
  });
} else {
  console.log('Scheduler active (production mode).');
  runEvery(5 * 60 * 1000, async () => {
    await runBot();
  });
}
