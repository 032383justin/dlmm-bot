export type StrategyParameters = {
  MIN_POOL_AGE_DAYS: number;
  MIN_TVL: number;
  MIN_DAILY_VOLUME: number;
  MIN_VOLUME_TVL_RATIO: number;
  HOLDER_COUNT_MIN: number;
  HOLDER_GROWTH_MIN: number;
  BIN_WIDTH_STABLE: [number, number];
  BIN_WIDTH_VOLATILE: [number, number];
  DILUTION_EXIT_PERCENT: number;
};

export const STRATEGY_PARAMETERS: StrategyParameters = {
  MIN_POOL_AGE_DAYS: 0,
  MIN_TVL: 0,
  MIN_DAILY_VOLUME: 0,
  MIN_VOLUME_TVL_RATIO: 0,
  HOLDER_COUNT_MIN: 0,
  HOLDER_GROWTH_MIN: 0,
  BIN_WIDTH_STABLE: [0, 0],
  BIN_WIDTH_VOLATILE: [0, 0],
  DILUTION_EXIT_PERCENT: 0,
};

