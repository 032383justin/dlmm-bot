import { db } from './db';
import { PositionStatus } from '../execution/positionManager';

export interface BotStateSnapshot {
  activePositions: PositionStatus[];
  deployedCapital: number;
  availableCapital: number;
}

export async function getActivePositions(): Promise<PositionStatus[]> {
  const { data, error } = await db
    .from('positions')
    .select('*')
    .eq('isActive', true);

  if (error) {
    console.error('getActivePositions error:', error);
    return [];
  }

  return data ?? [];
}

export async function addPosition(pos: PositionStatus): Promise<void> {
  const { error } = await db.from('positions').insert(pos);
  if (error) {
    console.error('addPosition error:', error);
  }
  // TODO: enforce position uniqueness constraints in DB.
}

export async function exitPositionRecord(poolId: string): Promise<void> {
  const { error } = await db
    .from('positions')
    .update({ isActive: false, exitAt: new Date().toISOString() })
    .eq('poolId', poolId);

  if (error) {
    console.error('exitPositionRecord error:', error);
  }
  // TODO: validate Supabase schema aligns with PositionStatus shape.
}

export async function getCapitalState(
  totalCapital: number,
): Promise<BotStateSnapshot> {
  const activePositions = await getActivePositions();
  const deployedCapital = activePositions.reduce(
    (sum, position) => sum + position.amount,
    0,
  );

  const availableCapital = totalCapital - deployedCapital;

  // TODO: persist capital state externally for auditing.

  return {
    activePositions,
    deployedCapital,
    availableCapital,
  };
}

