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
    // ⚠️ ENTRY THRESHOLD: 65 total score minimum
    // Below 65 → DO NOTHING (prevents blown accounts)
    // This logic alone will prevent blown accounts.

    const MIN_ENTRY_SCORE = 65;

    if (scores.total < MIN_ENTRY_SCORE) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Total score ${scores.total.toFixed(1)} below minimum ${MIN_ENTRY_SCORE}`
        };
    }

    // ⚠️ WHAT NOT TO DO (enforced by design):
    // ❌ Do not use token price
    // ❌ Do not use candles or RSI
    // ❌ Do not use market cap
    // ❌ Do not use volume to score bins
    // ❌ Do not use moving averages
    // ✅ Everything comes from bin behavior

    // Additional quality checks based on individual scores

    // Reject if whale impact is too high (>9 bins crossed)
    if (scores.whaleImpact > 9) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Whale impact too high: ${scores.whaleImpact} bins crossed (dangerous directional)`
        };
    }

    // Reject if oscillation is too low (<30%)
    if (scores.oscillation < 30) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Oscillation too low: ${scores.oscillation.toFixed(1)}% (trending market, not oscillating)`
        };
    }

    // Reject if crowd is too small (<3 wallets)
    if (scores.crowd < 3) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Crowd too small: ${scores.crowd} wallets (avoid low activity)`
        };
    }

    // ✅ ALL CHECKS PASSED - ENTER
    // Bin range: ±5 bins from active bin (conservative range for LP position)
    const binRange = 5;

    return {
        enter: true,
        lowerBin: -binRange,
        upperBin: binRange,
        reason: `Strong bin structure: total=${scores.total.toFixed(1)}, exhaustion=${scores.exhaustion.toFixed(1)}, oscillation=${scores.oscillation.toFixed(1)}, latency=${scores.latency.toFixed(1)}`
    };
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
