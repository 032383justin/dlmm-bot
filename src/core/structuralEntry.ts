import { Pool } from './normalizePools';
import { DLMMTelemetry } from './dlmmTelemetry';
import { BinScore, BinScores } from './binScoring';

export interface StructuralEntrySignal {
    shouldEnter: boolean;
    reason: string;
    confidence: number;
    binScore: BinScore;
}

export interface EntryDecision {
    enter: boolean;
    lowerBin: number;
    upperBin: number;
    reason: string;
}

export function evaluateEntry(scores: BinScores): EntryDecision {
    // TODO: Evaluate entry based on bin scores
    throw new Error('Not implemented');
}

export async function checkStructuralEntry(
    pool: Pool,
    telemetry: DLMMTelemetry,
    binScore: BinScore
): Promise<StructuralEntrySignal> {
    // TODO: Determine if pool structure is favorable for entry
    throw new Error('Not implemented');
}

export function detectBinImbalance(telemetry: DLMMTelemetry): boolean {
    // TODO: Detect favorable bin imbalance patterns
    throw new Error('Not implemented');
}

export function detectLiquidityConcentration(telemetry: DLMMTelemetry): boolean {
    // TODO: Detect strong liquidity concentration
    throw new Error('Not implemented');
}
