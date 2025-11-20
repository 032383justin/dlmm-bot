import { PoolScore } from '../scoring/scorePool';

export interface RotationDecision {
  poolId: string;
  action: 'enter' | 'exit' | 'hold';
  reason: string;
}

export interface ActivePosition {
  poolId: string;
  score: number;
  amount: number;
  enteredAt: string;
}

const EXIT_SCORE_DROP = 0.15;
const MIN_HOLD_TIME_MIN = 30;
const REPLACE_SCORE_MARGIN = 0.1;
const ENTRY_THRESHOLD = 0.6;
const MAX_NEW_POSITIONS = 5;

const minutesSince = (timestamp: string): number => {
  const entered = Date.parse(timestamp);
  if (Number.isNaN(entered)) {
    return Infinity;
  }
  return (Date.now() - entered) / 60_000;
};

const findPoolScore = (
  scoredPools: PoolScore[],
  poolId: string,
): PoolScore | undefined =>
  scoredPools.find((pool) => pool.id === poolId);

const shouldExitDueToScoreDrop = (
  currentScore: number,
  previousScore: number,
): boolean => currentScore < previousScore - EXIT_SCORE_DROP;

const evaluateActivePositions = (
  active: ActivePosition[],
  scoredPools: PoolScore[],
): RotationDecision[] => {
  const decisions: RotationDecision[] = [];

  for (const position of active) {
    const poolScore = findPoolScore(scoredPools, position.poolId);

    if (!poolScore) {
      decisions.push({
        poolId: position.poolId,
        action: 'exit',
        reason: 'Pool no longer in top set',
      });
      continue;
    }

    if (shouldExitDueToScoreDrop(poolScore.score, position.score)) {
      decisions.push({
        poolId: position.poolId,
        action: 'exit',
        reason: 'Score dropped below tolerance',
      });
      continue;
    }

    const holdTime = minutesSince(position.enteredAt);
    if (holdTime < MIN_HOLD_TIME_MIN) {
      decisions.push({
        poolId: position.poolId,
        action: 'hold',
        reason: 'Minimum hold time not reached',
      });
      continue;
    }

    decisions.push({
      poolId: position.poolId,
      action: 'hold',
      reason: 'Position healthy',
    });
  }

  return decisions;
};

const evaluateNewEntries = (
  active: ActivePosition[],
  scoredPools: PoolScore[],
): RotationDecision[] => {
  const activeIds = new Set(active.map((position) => position.poolId));
  const activeSorted = [...active].sort((a, b) => a.score - b.score);
  const weakestActive = activeSorted[0];

  const decisions: RotationDecision[] = [];

  scoredPools.slice(0, MAX_NEW_POSITIONS).forEach((pool) => {
    if (activeIds.has(pool.id)) {
      return;
    }

    if (pool.score < ENTRY_THRESHOLD) {
      return;
    }

    if (!weakestActive) {
      decisions.push({
        poolId: pool.id,
        action: 'enter',
        reason: 'High score pool available',
      });
      return;
    }

    const improvement = pool.score - weakestActive.score;
    if (improvement >= REPLACE_SCORE_MARGIN) {
      decisions.push(
        {
          poolId: weakestActive.poolId,
          action: 'exit',
          reason: 'Replaced by higher scoring pool',
        },
        {
          poolId: pool.id,
          action: 'enter',
          reason: 'Higher score replacement',
        },
      );
    } else {
      decisions.push({
        poolId: pool.id,
        action: 'enter',
        reason: 'High score pool available',
      });
    }
  });

  return decisions;
};

export function evaluateRotation(
  active: ActivePosition[],
  scoredPools: PoolScore[],
): RotationDecision[] {
  const activeEvaluations = evaluateActivePositions(active, scoredPools);
  const newEntries = evaluateNewEntries(active, scoredPools);

  // TODO: integrate with positionManager to enact enter/exit decisions.
  return [...activeEvaluations, ...newEntries];
}

