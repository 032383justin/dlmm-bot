import { STRATEGY_PARAMETERS } from '../config';
import { PoolNormalized } from '../core/scanPools';

export interface PoolScore {
  id: string;
  score: number;
  components: {
    volume: number;
    tvl: number;
    ratio: number;
    fee: number;
    age: number;
  };
}

type ExtendedPool = PoolNormalized &
  Partial<{
    volume1h: number;
    volume4h: number;
    tvlChange24h: number;
    volumeChange24h: number;
    binFlips1h: number;
    holderCount: number;
    holderGrowth24h: number;
    tokenSafetyScore: number;
    hasMintAuthority: boolean;
    hasFreezeAuthority: boolean;
  }>;

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
};

const normalize = (value: number, baseline: number): number => {
  const safeBaseline = baseline > 0 ? baseline : 1;
  return clamp01(value / safeBaseline);
};

const WEIGHTS = {
  volume: 0.22,
  tvl: 0.1,
  ratio: 0.15,
  momentum: 0.15,
  fee: 0.08,
  age: 0.05,
  dilution: 0.1,
  volatility: 0.05,
  holders: 0.05,
  holderGrowth: 0.03,
  safety: 0.02,
} as const;

const BASELINES = {
  volume24h: Math.max(STRATEGY_PARAMETERS.MIN_DAILY_VOLUME, 50_000),
  tvl: Math.max(STRATEGY_PARAMETERS.MIN_TVL, 100_000),
  ratio: Math.max(STRATEGY_PARAMETERS.MIN_VOLUME_TVL_RATIO, 0.15),
  age: Math.max(STRATEGY_PARAMETERS.MIN_POOL_AGE_DAYS, 7),
  holders: Math.max(STRATEGY_PARAMETERS.HOLDER_COUNT_MIN, 500),
};

const scoreDailyVolume = (pool: ExtendedPool): number =>
  normalize(pool.volume24h, BASELINES.volume24h);

const scoreTVL = (pool: ExtendedPool): number =>
  normalize(pool.tvl, BASELINES.tvl);

const scoreVolumeTVLRatio = (pool: ExtendedPool): number => {
  const ratio = pool.tvl > 0 ? pool.volume24h / pool.tvl : 0;
  return normalize(ratio, BASELINES.ratio);
};

const scoreMomentum = (pool: ExtendedPool): number => {
  const volume1h = pool.volume1h ?? 0;
  const volume4h = pool.volume4h ?? 0;

  if (volume1h <= 0 && volume4h <= 0) {
    return 0;
  }

  const annualized1h = volume1h * 24;
  const annualized4h = (volume4h > 0 ? volume4h / 4 : 0) * 24;
  const ratio =
    annualized4h > 0 ? annualized1h / annualized4h : volume1h > 0 ? 1.5 : 0;

  if (ratio >= 1.5) {
    return 0.9;
  }

  if (ratio >= 1.2) {
    return 0.7;
  }

  if (ratio >= 0.8) {
    return 0.5;
  }

  if (ratio >= 0.5) {
    return 0.3;
  }

  return 0.1;
};

const scoreFeeTier = (pool: ExtendedPool): number => {
  const fee = Math.max(0, pool.feeTier);

  if (fee <= 0.001) {
    return 1;
  }

  if (fee <= 0.003) {
    return 0.8;
  }

  if (fee <= 0.01) {
    return 0.6;
  }

  return 0.3;
};

const scoreAge = (pool: ExtendedPool): number => {
  if (pool.ageDays >= 30) {
    return 1;
  }

  if (pool.ageDays >= 14) {
    return 0.8;
  }

  if (pool.ageDays >= BASELINES.age) {
    return 0.6;
  }

  return normalize(pool.ageDays, BASELINES.age) * 0.5;
};

const scoreDilution = (pool: ExtendedPool): number => {
  const tvlGrowth = pool.tvlChange24h ?? 0;
  const volumeGrowth = pool.volumeChange24h ?? 0;
  const dilutionExitThreshold = STRATEGY_PARAMETERS.DILUTION_EXIT_PERCENT / 100;

  if (tvlGrowth > 0.5 && volumeGrowth < 0.2) {
    return 0.2;
  }

  if (tvlGrowth > 0.3 && volumeGrowth < 0.2) {
    return 0.6;
  }

  if (tvlGrowth > dilutionExitThreshold && volumeGrowth < 0.1) {
    return 0.5;
  }

  return 1;
};

const scoreVolatility = (pool: ExtendedPool): number => {
  const flips = pool.binFlips1h ?? 0;

  if (flips === 0) {
    return 0.5;
  }

  if (flips >= 3 && flips <= 7) {
    return 0.8;
  }

  if (flips < 3) {
    return 0.6;
  }

  if (flips <= 15) {
    return 0.5;
  }

  return 0.3;
};

const scoreHolderCount = (pool: ExtendedPool): number => {
  const holders = pool.holderCount ?? BASELINES.holders * 0.5;
  return normalize(holders, BASELINES.holders);
};

const scoreHolderGrowth = (pool: ExtendedPool): number => {
  const growth = pool.holderGrowth24h ?? STRATEGY_PARAMETERS.HOLDER_GROWTH_MIN;

  if (growth >= 0.2) {
    return 1;
  }

  if (growth >= 0.1) {
    return 0.8;
  }

  if (growth >= 0.05) {
    return 0.6;
  }

  if (growth >= 0) {
    return 0.4;
  }

  if (growth >= -0.05) {
    return 0.2;
  }

  return 0;
};

const scoreTokenSafety = (pool: ExtendedPool): number => {
  if (pool.hasMintAuthority || pool.hasFreezeAuthority) {
    return 0;
  }

  if (typeof pool.tokenSafetyScore === 'number') {
    return clamp01(pool.tokenSafetyScore);
  }

  return 0.7; // Placeholder default until richer metadata is wired in.
};

export function scorePool(pool: PoolNormalized): PoolScore {
  const extended = pool as ExtendedPool;

  const volumeScore = scoreDailyVolume(extended);
  const tvlScore = scoreTVL(extended);
  const ratioScore = scoreVolumeTVLRatio(extended);
  const momentumScore = scoreMomentum(extended);
  const feeScore = scoreFeeTier(extended);
  const ageScore = scoreAge(extended);
  const dilutionScore = scoreDilution(extended);
  const volatilityScore = scoreVolatility(extended);
  const holderCountScore = scoreHolderCount(extended);
  const holderGrowthScore = scoreHolderGrowth(extended);
  const safetyScore = scoreTokenSafety(extended);

  const weightedScore =
    volumeScore * WEIGHTS.volume +
    tvlScore * WEIGHTS.tvl +
    ratioScore * WEIGHTS.ratio +
    momentumScore * WEIGHTS.momentum +
    feeScore * WEIGHTS.fee +
    ageScore * WEIGHTS.age +
    dilutionScore * WEIGHTS.dilution +
    volatilityScore * WEIGHTS.volatility +
    holderCountScore * WEIGHTS.holders +
    holderGrowthScore * WEIGHTS.holderGrowth +
    safetyScore * WEIGHTS.safety;

  const finalScore = clamp01(weightedScore);

  return {
    id: pool.id,
    score: finalScore,
    components: {
      volume: volumeScore,
      tvl: tvlScore,
      ratio: ratioScore,
      fee: feeScore,
      age: ageScore,
    },
  };
}

export function scorePools(pools: PoolNormalized[]): PoolScore[] {
  return pools
    .map((pool) => scorePool(pool))
    .sort((a, b) => b.score - a.score);
}
