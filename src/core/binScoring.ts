import { DLMMTelemetry, BinSnapshot } from './dlmmTelemetry';

export interface BinScore {
    concentrationScore: number;
    balanceScore: number;
    depthScore: number;
    spreadScore: number;
    overallScore: number;
}

export interface BinScores {
    exhaustion: number;
    oscillation: number;
    latency: number;
    whaleImpact: number;
    crowd: number;
    total: number;
}

export function scoreBins(snapshot: BinSnapshot, history: BinSnapshot[]): BinScores {
    // TODO: Calculate bin scores based on snapshot and history
    throw new Error('Not implemented');
}

export function scoreBinDistribution(telemetry: DLMMTelemetry): BinScore {
    // TODO: Score bin distribution based on concentration, balance, depth, spread
    throw new Error('Not implemented');
}

export function calculateConcentrationScore(telemetry: DLMMTelemetry): number {
    // TODO: Measure liquidity concentration around active bin
    throw new Error('Not implemented');
}

export function calculateBalanceScore(telemetry: DLMMTelemetry): number {
    // TODO: Measure X/Y token balance in bins
    throw new Error('Not implemented');
}

export function calculateDepthScore(telemetry: DLMMTelemetry): number {
    // TODO: Measure liquidity depth across bins
    throw new Error('Not implemented');
}

export function calculateSpreadScore(telemetry: DLMMTelemetry): number {
    // TODO: Measure bin spread and distribution
    throw new Error('Not implemented');
}
