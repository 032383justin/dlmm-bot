export interface MomentumInput {
  volume1h: number;
  volume4h: number;
}

export interface MomentumResult {
  ratio: number;
  score: number;
  trendingUp: boolean;
}

const calculateScore = (ratio: number): number => {
  if (ratio >= 2) {
    return 1;
  }

  if (ratio >= 1.5) {
    return 0.8;
  }

  if (ratio >= 1.2) {
    return 0.6;
  }

  if (ratio >= 1) {
    return 0.4;
  }

  if (ratio >= 0.7) {
    return 0.2;
  }

  return 0;
};

export function computeMomentum(input: MomentumInput): MomentumResult {
  try {
    const { volume1h, volume4h } = input;
    const baseline = Math.max(volume4h / 4, 1);
    const ratio = volume1h / baseline;

    const score = calculateScore(ratio);
    const trendingUp = ratio >= 1;

    return {
      ratio,
      score,
      trendingUp,
    };
  } catch (error) {
    console.error('Failed to compute momentum metrics', error);
    return {
      ratio: 0,
      score: 0,
      trendingUp: false,
    };
  }
}

