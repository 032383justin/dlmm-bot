import { STRATEGY_PARAMETERS } from '../config';
import { PoolScore } from '../scoring/scorePool';
// import { computeMomentum } from '../core/momentum';
// import { computeDilution } from '../core/dilution';

export interface AllocationDecision {
  poolId: string;
  score: number;
  amount: number;
}

const MIN_SCORE_THRESHOLD = 0.55;
const MAX_POOLS = 7;
const MAX_POOL_PERCENT = 0.2;
const MIN_POOL_PERCENT = 0.04;

const roundAmount = (value: number): number =>
  Math.round(value * 1e6) / 1e6;

export function getMaxCapitalPerPool(totalCapital: number): number {
  return totalCapital * MAX_POOL_PERCENT;
}

const clampAllocation = (
  totalCapital: number,
  amount: number,
): number => {
  const maxAmount = totalCapital * MAX_POOL_PERCENT;
  const minAmount = totalCapital * MIN_POOL_PERCENT;

  if (amount > maxAmount) {
    return maxAmount;
  }

  if (amount < minAmount) {
    return minAmount;
  }

  return amount;
};

const normalizeWeights = (weights: number[]): number[] => {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum === 0) {
    return weights.map(() => 0);
  }
  return weights.map((weight) => weight / sum);
};

const applyAdvancedWeighting = (pool: PoolScore): number => {
  // TODO: incorporate momentum, dilution, and safety signals when available.
  return Math.pow(pool.score, 1.5);
};

const redistributeRemainder = (
  totalCapital: number,
  allocations: number[],
): number[] => {
  const sum = allocations.reduce((acc, amount) => acc + amount, 0);
  if (sum === 0) {
    return allocations;
  }
  const scale = totalCapital / sum;
  return allocations.map((amount) => amount * scale);
};

export function allocateCapital(
  totalCapital: number,
  scoredPools: PoolScore[],
): AllocationDecision[] {
  if (totalCapital <= 0) {
    return [];
  }

  const eligible = scoredPools
    .filter((pool) => pool.score >= MIN_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_POOLS);

  if (eligible.length === 0) {
    return [];
  }

  const rawWeights = eligible.map((pool) =>
    applyAdvancedWeighting(pool),
  );
  const normalizedWeights = normalizeWeights(rawWeights);

  const preliminaryAllocations = normalizedWeights.map(
    (weight) => totalCapital * weight,
  );

  const cappedAllocations = preliminaryAllocations.map((amount) =>
    clampAllocation(totalCapital, amount),
  );

  const finalAllocations = redistributeRemainder(
    totalCapital,
    cappedAllocations,
  );

  return eligible.map((pool, index) => ({
    poolId: pool.id,
    score: pool.score,
    amount: roundAmount(finalAllocations[index]),
  }));
}
