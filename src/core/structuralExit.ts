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
    // 🧠 CORE PRINCIPLE: Exit when the microstructure that fed you stops feeding you.
    // NOT when the token price moves.
    // You don't wait. You don't hope. You don't argue with whales.
    // You leave the second the battlefield changes.

    // ⚠️ DO NOT ADD THESE EXIT TRIGGERS:
    // ❌ price % drop
    // ❌ MACD / RSI
    // ❌ candle patterns
    // ❌ moving averages
    // ❌ "gut feeling"
    // ❌ sentiment
    // ❌ influencer tweets
    // They are lagging or manipulable. DLMM microstructure is raw truth.

    // 🚨 EXIT CONDITIONS - ANY ONE TRIGGERS EXIT

    // Condition 1 — Oscillation fails
    // The rhythm that fed you is gone. Market is trending, not oscillating.
    if (scores.oscillation < 35) {
        return { exit: true, reason: "Oscillation breakdown" };
    }

    // Condition 2 — LPs become efficient
    // Your edge was slow LPs. Now they're fast. No opportunity.
    if (scores.latency < 1.0) {
        return { exit: true, reason: "LP refill too fast" };
    }

    // Condition 3 — Whale sweep
    // Directional slaughter. Not symmetrical chaos. Get out.
    if (scores.whaleImpact > 40) {
        return { exit: true, reason: "Whale directional sweep" };
    }

    // Condition 4 — LP migration trap
    // LPs are leaving. Bins won't refill. You're stuck.
    const lpMigrationRate = detectLPMigration(snapshot, history);
    if (lpMigrationRate > 0.30) {
        return { exit: true, reason: "LP migration trap" };
    }

    // Condition 5 — Crowd collapse
    // Wallets disappeared. No one to oscillate with.
    const crowdCollapseRate = detectCrowdCollapse(history);
    if (crowdCollapseRate > 0.40) {
        return { exit: true, reason: "Crowd disappeared" };
        // Compare recent crowd vs older crowd
        const recentSnapshots = history.slice(-5);
        const olderSnapshots = history.slice(-10, -5);

        let recentSwaps = 0;
        let olderSwaps = 0;

        for (const snapshot of recentSnapshots) {
            for (const binId in snapshot.bins) {
                recentSwaps += snapshot.bins[binId].swaps || 0;
            }
        }

        for (const snapshot of olderSnapshots) {
            for (const binId in snapshot.bins) {
                olderSwaps += snapshot.bins[binId].swaps || 0;
            }
        }

        if (olderSwaps === 0) return 0;

        // Return % drop in activity
        const activityDrop = (olderSwaps - recentSwaps) / olderSwaps;
        return Math.max(0, activityDrop);
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
