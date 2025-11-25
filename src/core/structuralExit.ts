import { Pool } from './normalizePools';
import { DLMMTelemetry, BinSnapshot } from './dlmmTelemetry';
import { BinScore, BinScores } from './binScoring';

export interface StructuralExitSignal {
    shouldExit: boolean;
    reason: string;
    urgency: 'low' | 'medium' | 'high' | 'critical';
    binScore: BinScore;
}

export interface ExitDecision {
    exit: boolean;
    reason: string;
}

export function evaluateExit(snapshot: BinSnapshot, history: BinSnapshot[], scores: BinScores): ExitDecision {
    // TODO: Evaluate exit based on snapshot, history, and scores
    throw new Error('Not implemented');
}

export async function checkStructuralExit(
    pool: Pool,
    telemetry: DLMMTelemetry,
    binScore: BinScore,
    entryBinScore: BinScore
): Promise<StructuralExitSignal> {
    // TODO: Determine if pool structure has deteriorated
    throw new Error('Not implemented');
}

export function detectBinDeterioration(
    currentScore: BinScore,
    entryScore: BinScore
): boolean {
    // TODO: Detect significant bin score deterioration
    throw new Error('Not implemented');
}

export function detectLiquidityDrain(
    currentTelemetry: DLMMTelemetry,
    entryTelemetry: DLMMTelemetry
): boolean {
    // TODO: Detect rapid liquidity drainage
    throw new Error('Not implemented');
}
