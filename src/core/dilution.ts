export interface DilutionInput {
  tvlNow: number;
  tvl1hAgo: number;
  volume1h: number;
}

export interface DilutionResult {
  ratio: number;
  penalty: number;
  isUnsafe: boolean;
}

const clampNonNegative = (value: number): number => (value > 0 ? value : 0);

const calculatePenalty = (ratio: number): number => {
  if (ratio <= 0.2) {
    return 0;
  }

  if (ratio <= 0.5) {
    return 0.2;
  }

  if (ratio <= 1) {
    return 0.4;
  }

  if (ratio <= 2) {
    return 0.6;
  }

  return 1;
};

export function computeDilution(input: DilutionInput): DilutionResult {
  try {
    const tvlDelta = clampNonNegative(input.tvlNow - input.tvl1hAgo);
    const safeVolume = Math.max(input.volume1h, 1);
    const ratio = tvlDelta > 0 ? tvlDelta / safeVolume : 0;

    const penalty = calculatePenalty(ratio);
    const isUnsafe = penalty >= 0.6;

    return {
      ratio,
      penalty,
      isUnsafe,
    };
  } catch (error) {
    console.error('Failed to compute dilution metrics', error);
    return {
      ratio: 0,
      penalty: 0,
      isUnsafe: false,
    };
  }
}

