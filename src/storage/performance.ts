import { db } from './db';
import { PositionStatus } from '../execution/positionManager';

export interface PositionPerformance {
  poolId: string;
  entryAmount: number;
  currentAmount: number;
  roi: number;
  pnl: number;
  lastUpdated: string;
}

export async function recordPerformance(
  perf: PositionPerformance,
): Promise<void> {
  const { error } = await db.from('performance').insert(perf);

  if (error) {
    console.error('recordPerformance error:', error);
  }

  // TODO: ensure performance table schema matches expectations.
}

export function simulatePnL(
  position: PositionStatus,
  poolData: { tvl: number; volume24h: number },
): PositionPerformance {
  const safeTvl = Math.max(poolData.tvl, 1);
  const dailyYield = (poolData.volume24h / safeTvl) * 0.15;
  const currentAmount = position.amount * (1 + dailyYield);
  const pnl = currentAmount - position.amount;
  const roi = position.amount > 0 ? pnl / position.amount : 0;

  // TODO: fetch actual DLMM fees when available.
  // TODO: incorporate bin width influence on yield.
  // TODO: use real LP payouts for live mode.

  return {
    poolId: position.poolId,
    entryAmount: position.amount,
    currentAmount,
    roi,
    pnl,
    lastUpdated: new Date().toISOString(),
  };
}

