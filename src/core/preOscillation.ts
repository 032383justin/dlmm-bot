/**
 * Pre-Oscillation Entry Detection — Front-Run the Chaos
 * 
 * ⚠️ What You're Hunting:
 * Pre-oscillation means the market is ABOUT TO behave like a casino, but hasn't yet.
 * 
 * You're not chasing madness. You're front-running it.
 * 
 * You're entering when:
 * - Liquidity is positioned vulnerably
 * - LPs are asleep
 * - Whales haven't arrived yet
 * - Crowds haven't noticed
 * - Refill is slow
 * - Small wallets nibble
 * 
 * This window is tiny — but it is free money.
 * 
 * 🔥 If you do this correctly:
 * - You enter BEFORE chaos
 * - You farm the entire oscillation cycle
 * - Your exits are easier
 * - Your risk is lower
 * - Your daily ROI spikes
 * 
 * If you do it wrong:
 * - You enter into trend
 * - You're first into the slaughter
 * - LPs reposition and trap you
 * - You get wiped
 * 
 * 🚨 DO NOT ADD THESE TRIGGERS:
 * - APR
 * - Volume
 * - Candle volatility
 * - Token price movement
 * - Influencer tweets
 * - Birdeye trending
 * - Social sentiment
 * 
 * Those signals are late. You are catching the seed, not the flower.
 * 
 * 💡 INSANE BONUS ALPHA:
 * Pre-oscillation is what Raydium market makers do manually.
 * They don't trade hype.
 * They wait for sleepy bins + curious wallets + slow LPs.
 * They take easy money from the first fools,
 * then scale into the actual chaos.
 * 
 * This is how pros front-run idiocy.
 */

import { BinScores } from './binScoring';
import { EntryDecision } from './structuralEntry';

/**
 * Evaluate pre-oscillation entry opportunity
 * 
 * 🧬 Pre-Oscillation Signal Conditions (ALL must be true):
 * 
 * 1️⃣ Exhaustion starting (10-30%)
 *    - Local liquidity is thinning… but not collapsing
 *    - Too low = boring, Too high = whales already coming
 * 
 * 2️⃣ Refill latency elevated (≥1.25)
 *    - LPs are slow to react
 *    - Not full failure (1.5+), just above baseline
 *    - LPs are sleepy, retail will wake them up soon
 * 
 * 3️⃣ Wallet sprouts (≥3 in last 60s)
 *    - Random wallets probing the bin range
 *    - Not whales, not bots, not mega sweeps
 *    - Just degen "curiosity nibbling"
 *    - THE signal for micro-casino formation
 * 
 * 4️⃣ No directional sweeps (≤3 bins)
 *    - We are not fighting predators
 *    - 4+ = bots hunting, 6+ = whales, 8+ = death
 *    - NEVER enter in their presence
 * 
 * 5️⃣ LP migration not active (<0.2)
 *    - No trap is forming yet
 *    - If LPs are moving liquidity ahead of price → abort
 *    - This is how 99% of bots die
 * 
 * 6️⃣ Active bin barely moves (oscillation ≤20)
 *    - Oscillation seeds BEFORE oscillation appears
 *    - No crowd yet, no bot war, no whale waves
 *    - Small trades, LP inertia, bin starvation
 * 
 * 💡 Why This Works:
 * Humans don't rush into volatility.
 * They rush into opportunities that look like volatility.
 * 
 * When bins start thinning + LPs respond slowly + early wallets poke around
 * → Retail shows up like flies to sugar. You're already inside.
 * 
 * ⚔️ ENTRY RANGE: Always activeBin ± 3 (keep it tight)
 * 
 * 🧊 Position Size: Never more than base size (2% of capital)
 * You scale AFTER oscillation confirms.
 * 
 * 💀 When RSI traders and hype bots enter?
 * You're already in position. They feed you liquidity.
 * 
 * @param scores - Bin microstructure scores
 * @param migration - LP migration rate
 * @param walletCount - Unique wallets in last 60s
 * @param maxBinsCrossed - Maximum bins crossed in recent swaps
 * @param activeBin - Current active bin
 * @returns Entry decision with bin range
 */
export function evaluatePreOscillationEntry(
    scores: BinScores,
    migration: number,
    walletCount: number,
    maxBinsCrossed: number,
    activeBin: number
): EntryDecision {
    // 1️⃣ Exhaustion starting (10-30%)
    const cond1 = scores.exhaustion >= 10 && scores.exhaustion <= 30;

    // 2️⃣ Refill latency elevated (≥1.25)
    const cond2 = scores.latency >= 1.25;

    // 3️⃣ Wallet sprouts (≥3 in last 60s)
    const cond3 = walletCount >= 3;

    // 4️⃣ No directional sweeps (≤3 bins)
    const cond4 = maxBinsCrossed <= 3;

    // 5️⃣ LP migration not active (<0.2)
    const cond5 = migration < 0.20;

    // 6️⃣ Active bin barely moves (oscillation ≤20)
    const cond6 = scores.oscillation <= 20;

    // ALL conditions must be true
    const ok = cond1 && cond2 && cond3 && cond4 && cond5 && cond6;

    if (!ok) {
        // Build detailed reason for rejection
        const reasons: string[] = [];
        if (!cond1) reasons.push(`Exhaustion ${scores.exhaustion.toFixed(1)} not in 10-30 range`);
        if (!cond2) reasons.push(`Latency ${scores.latency.toFixed(2)} < 1.25`);
        if (!cond3) reasons.push(`Only ${walletCount} wallets (need ≥3)`);
        if (!cond4) reasons.push(`Max bins crossed ${maxBinsCrossed} > 3 (predators present)`);
        if (!cond5) reasons.push(`LP migration ${(migration * 100).toFixed(1)}% ≥ 20% (trap forming)`);
        if (!cond6) reasons.push(`Oscillation ${scores.oscillation.toFixed(1)} > 20 (already active)`);

        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `No pre-oscillation setup: ${reasons.join(', ')}`
        };
    }

    // ✅ Pre-oscillation window detected
    // Enter tight range around active bin
    return {
        enter: true,
        lowerBin: activeBin - 3,
        upperBin: activeBin + 3,
        reason: "Pre-oscillation window detected: sleepy LPs + curious wallets + thin bins"
    };
}

/**
 * Check if pool is in pre-oscillation state (simplified check)
 * 
 * @param scores - Bin scores
 * @param migration - LP migration rate
 * @param walletCount - Unique wallet count
 * @param maxBinsCrossed - Max bins crossed
 * @returns true if in pre-oscillation state
 */
export function isPreOscillation(
    scores: BinScores,
    migration: number,
    walletCount: number,
    maxBinsCrossed: number
): boolean {
    return (
        scores.exhaustion >= 10 && scores.exhaustion <= 30 &&
        scores.latency >= 1.25 &&
        walletCount >= 3 &&
        maxBinsCrossed <= 3 &&
        migration < 0.20 &&
        scores.oscillation <= 20
    );
}

/**
 * 🔥 What happens next (the magic):
 * 
 * Once you enter:
 * 1. Retail arrives
 * 2. Volume appears
 * 3. Bots start to fight
 * 4. Oscillation ignites
 * 5. LPs start waking up
 * 6. Chaos peaks
 * 
 * You're already holding the best seat in the casino.
 */
