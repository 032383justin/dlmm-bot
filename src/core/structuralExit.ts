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

export async function evaluateExit(snapshot: BinSnapshot, history: BinSnapshot[], scores: BinScores): Promise<ExitDecision> {
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
    // This is when oscillation stops and you get slaughtered.
    //
    // 🧠 What we detect:
    // - Liquidity removal in the bins you are farming
    // - Simultaneous liquidity increase in bins ahead of price (up OR down)
    // - Migration amount ≥ 30% of local depth
    //
    // Returns: 0.0-0.30 = noise, 0.30+ = trap, 0.50+ = nuclear exit, 0.70+ = rug conditions
    function detectLPMigration(snapshot: BinSnapshot, history: BinSnapshot[]): number {
        if (history.length < 2) return 0;

        // Use last 2 snapshots for comparison
        const prev = history[history.length - 2];
        const curr = snapshot;

        const active = curr.activeBin;

        // 📌 Define local bin window (activeBin ± 3)
        // Do NOT analyze entire pool — it muddies signals
        let removed = 0;  // Liquidity pulled from bins below/at active
        let added = 0;    // Liquidity added to bins ahead of active

        // ⚠️ The Trap Signature:
        // Liquidity removed in bins below price AND liquidity added in bins above price (or vice versa)
        // This is how predators create forced one-way flow

        for (const binId in curr.bins) {
            const binIdNum = parseInt(binId);
            const currLiq = curr.bins[binId]?.liquidity || 0;
            const prevLiq = prev.bins[binId]?.liquidity || 0;

            const diff = currLiq - prevLiq;

            // Track liquidity changes in local window (activeBin ± 3)
            if (Math.abs(binIdNum - active) <= 3) {
                if (binIdNum <= active) {
                    // Bins at or below active: track removals
                    if (diff < 0) removed += Math.abs(diff);
                } else {
                    // Bins above active: track additions
                    if (diff > 0) added += diff;
                }
            }
        }

        // 🔥 Migration Score Calculation
        // migration = added / (removed + added)
        // 0.0 → nothing interesting
        // 0.2 → normal rebalance
        // 0.3 → early trap (EXIT THRESHOLD)
        // 0.5 → serious trap
        // 0.7 → whales ate your soul

        if (removed + added === 0) return 0;

        const migration = added / (removed + added);

        // 🧠 The 30% Rule (never ignore)
        // If LP migration >= 0.30 → EXIT INSTANTLY
        entryBinScore: BinScore
): Promise < StructuralExitSignal > {
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
