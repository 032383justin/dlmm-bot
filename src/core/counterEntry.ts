/**
 * Counter-Entry Logic — Prevent Entry Ambushes
 * 
 * ⚔️ Why you need counter-entry logic:
 * Your entry logic can be perfect… but predators react to your entry window, not your trade.
 * 
 * You enter → They sweep the bins → LPs migrate → crowd collapses → you get farmed.
 * This is called: "Counter-entry predation."
 * 
 * 🧠 Core Philosophical Rule:
 * You don't enter because the past state is favorable.
 * You enter because the next 20–60 seconds are NOT hostile.
 * 
 * It's not about the score, it's about the ambush.
 * 
 * These checks run RIGHT BEFORE capital deploy.
 * You take your validated entry setup → You run 7 tests → If ANY fail → cancel entry immediately.
 * 
 * 👑 How pros think:
 * When a trade meets conditions, they don't ask: "Is the setup good?"
 * They ask: "Who will try to kill me if I enter?"
 * 
 * If you can answer that before entering, your bot becomes unlosable over time.
 */

import { BinSnapshot } from './dlmmTelemetry';
import { BinScores } from './binScoring';
import { PendingSwap, detectMempoolPredation } from './mempoolPredation';

/**
 * Evaluate counter-entry conditions before capital deployment
 * 
 * 🚨 Counter-Entry Conditions (ALL must be true):
 * 
 * 1️⃣ No directional bin sweeps in the last 20 seconds
 *    - maxBinsCrossed(last 20s) ≤ 3
 *    - Never enter right after violence
 * 
 * 2️⃣ LP liquidity on entry side is passive, not active
 *    - migration(last 60s) < 0.25
 *    - "LPs reacting" ≠ "LPs migrating to kill you"
 * 
 * 3️⃣ Pending mempool does not show directional bias
 *    - detectMempoolPredation(pendingSwaps) == false
 *    - Prevents bots from sniping you on entry
 * 
 * 4️⃣ Wallet diversity is > 2 unique actors in last 60s
 *    - uniqueWallets ≥ 3
 *    - You want chaos, not duels
 * 
 * 5️⃣ ActiveBin hasn't shifted more than ±1 in last 2 snapshots
 *    - abs(activeBinNow - activeBinPrev) <= 1
 *    - Small wiggles = incubation, Big moves = warfare
 * 
 * 6️⃣ No sudden liquidity "walls" ahead
 *    - If any bin has 3× density vs neighbors → ABORT
 *    - These are anti-entry ambush walls
 * 
 * 7️⃣ Network health stable
 *    - If RPC telemetry anomalies > 0 → abort
 *    - Never enter when Helius lagging, Solana congested, snapshots missing
 * 
 * @param history - Bin snapshot history
 * @param pendingSwaps - Pending swaps from mempool
 * @param scores - Bin microstructure scores
 * @param migration - LP migration rate
 * @param uniqueWallets - Unique wallet count in last 60s
 * @returns true if safe to enter, false if ambush detected
 */
export function evaluateCounterEntry(
    history: BinSnapshot[],
    pendingSwaps: PendingSwap[],
    scores: BinScores,
    migration: number,
    uniqueWallets: number
): boolean {
    if (history.length < 2) return false;

    const curr = history[history.length - 1];
    const prev = history[history.length - 2];

    // 1️⃣ No recent bin sweeps
    // If a sweep just happened → you missed the party
    if (scores.whaleImpact > 3) {
        return false; // Recent directional sweep detected
    }

    // 2️⃣ LP migration trap check
    // If LPs are actively setting traps, do not enter
    if (migration >= 0.25) {
        return false; // LP migration trap forming
    }

    // 3️⃣ Mempool predators check
    // Prevents bots from sniping you on entry
    if (detectMempoolPredation(pendingSwaps)) {
        return false; // Predatory bots detected in mempool
    }

    // 4️⃣ Crowd diversity check
    // If only 1–2 wallets → bot vs bot territory
    if (uniqueWallets < 3) {
        return false; // Insufficient crowd diversity
    }

    // 5️⃣ Active bin stability check
    // Small wiggles = incubation, Big moves = warfare
    if (Math.abs(curr.activeBin - prev.activeBin) > 1) {
        return false; // Active bin shifting too fast
    }

    // 6️⃣ Liquidity walls check
    // Look for anti-entry ambush walls
    if (detectLiquidityWalls(curr.bins, curr.activeBin)) {
        return false; // Fake liquidity wall detected
    }

    // 7️⃣ Telemetry health check
    // Never enter when network is unstable
    if (detectTelemetryAnomaly(history)) {
        return false; // Telemetry anomaly detected
    }

    // ✅ All counter-entry checks passed - safe to enter
    return true;
}

/**
 * Detect fake liquidity walls (anti-entry ambush traps)
 * 
 * Rule: If any bin in ±3 range has ≥3× the average local liquidity, abort.
 * 
 * Pattern:
 * - One or two bins with huge liquidity
 * - Designed to eat your entry and reverse
 * - Bots LOVE to do this
 * 
 * You think: "Oh wow, resistance level or support!"
 * Reality: It's a deadfall trap.
 * 
 * @param bins - Bin data from snapshot
 * @param activeBin - Current active bin
 * @param radius - Range to check (default 3)
 * @returns true if liquidity wall detected
 */
export function detectLiquidityWalls(
    bins: { [binId: number]: { liquidity: number } },
    activeBin: number,
    radius: number = 3
): boolean {
    // Get local bins around active
    const localBins: number[] = [];

    for (let offset = -radius; offset <= radius; offset++) {
        const binId = activeBin + offset;
        if (bins[binId]) {
            localBins.push(bins[binId].liquidity);
        }
    }

    if (localBins.length === 0) return false;

    // Calculate average local liquidity
    const avg = localBins.reduce((a, b) => a + b, 0) / localBins.length;

    // Check for walls (3× average)
    for (let offset = -radius; offset <= radius; offset++) {
        const binId = activeBin + offset;
        if (bins[binId] && bins[binId].liquidity >= avg * 3) {
            return true; // Liquidity wall detected
        }
    }

    return false;
}

/**
 * Detect telemetry anomalies (network/data issues)
 * 
 * If your snapshots are inconsistent, abort entry.
 * 
 * Examples:
 * - same snapshot repeated
 * - timestamp jump backward
 * - missing bins
 * - negative liquidity (AI bug)
 * 
 * A congested network is a whale playground.
 * 
 * @param history - Bin snapshot history
 * @returns true if anomaly detected
 */
export function detectTelemetryAnomaly(history: BinSnapshot[]): boolean {
    if (history.length < 2) return false;

    const curr = history[history.length - 1];
    const prev = history[history.length - 2];

    // Timestamp should always increase
    if (curr.timestamp <= prev.timestamp) {
        return true; // Timestamp anomaly
    }

    // Should have bins data
    if (Object.keys(curr.bins).length === 0) {
        return true; // Missing bins data
    }

    // Active bin should be valid
    if (curr.activeBin == null || curr.activeBin < 0) {
        return true; // Invalid active bin
    }

    // Check for negative liquidity (data corruption)
    for (const binId in curr.bins) {
        if (curr.bins[binId].liquidity < 0) {
            return true; // Negative liquidity detected
        }
    }

    return false; // No anomalies detected
}

/**
 * 🧠 WHY THE COUNTER-ENTRY CHECK WORKS:
 * 
 * You don't care about:
 * - price movement
 * - pump hype
 * - buy pressure
 * - volume spikes
 * - momentum
 * 
 * You care about:
 * - predators
 * - ambushes
 * - traps
 * 
 * You are an observer in a battlefield, not a gambler at a casino table.
 * The counter-entry layer is your shields up moment.
 */
