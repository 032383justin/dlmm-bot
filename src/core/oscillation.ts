/**
 * Oscillation Harvesting Logic — The Core Money-Making Engine
 * 
 * ⚡️ Goal:
 * Harvest value every time the bins oscillate, without betting on direction.
 * 
 * You are not "long" or "short."
 * You are not predicting movement.
 * You are pricing time + human stupidity.
 * 
 * 🔥 Oscillation Harvesting = 3 events:
 * 
 * 1️⃣ Bin Collapse Event — liquidity removed fast
 * 2️⃣ Bin Refill Delay — LP inertia
 * 3️⃣ Retail Panic Reversal — delayed buyers/sellers pile in
 * 
 * This cycle repeats 2–20 times per volatile period.
 * You farm it every single time.
 * 
 * 🚨 CRUCIAL RULE:
 * You do NOT harvest trades. You harvest shocks in microstructure.
 * 
 * 🧬 Harvesting = timed exit, not trend exit
 * 
 * Logical flow:
 * 1. Enter after structural or pre-oscillation trigger
 * 2. Track collapses per bin
 * 3. On 2nd–3rd collapse → exit immediately
 * 
 * Because:
 * - The first oscillation is free money
 * - The second is profitable
 * - The third has diminishing returns
 * - The fourth invites predators
 * 
 * Most bots die because they overstayed the buffet.
 * 
 * 🧨 THE BIGGEST TRAP:
 * Do NOT harvest oscillations endlessly.
 * Retail stupidity dries up fast.
 * Oscillation is a dying flame, not infinite fuel.
 * 
 * 👑 TRUE ALPHA:
 * Harvest early oscillations hardest.
 * Later cycles: whales awake, LPs reposition, sweep bots detect everything.
 * Risk returns > reward. You bank and walk away.
 * 
 * 🚫 Things to NEVER do:
 * - "Double entry" after exit
 * - "Wait for trend reversal"
 * - "LPs will refill, it'll be fine"
 * - "Just 1 more cycle"
 * 
 * Those are how traders get wiped. You are not a trader. You are a harvester.
 * 
 * 🧘 Pro Mindset:
 * You're a casino that:
 * - opens at chaos
 * - closes at structure
 * - never begs the crowd to come back
 * - never stays open during whale hour
 */

import { BinSnapshot } from './dlmmTelemetry';
import { BinScores } from './binScoring';

/**
 * Detect oscillation harvest opportunity
 * 
 * 🧠 What You Monitor Each Cycle:
 * - activeBin
 * - local bin liquidity
 * - swaps per bin
 * - time since refill
 * - wallet diversity
 * - whaleImpact
 * - migration
 * 
 * You don't need price, TA, candles, anything else.
 * 
 * 💎 Harvesting Conditions (ALL must be true):
 * 
 * 1️⃣ Collapse
 *    - At least 1 bin adjacent to active loses ≥ 40% liquidity in < 20 seconds
 *    - This means panic / aggressive nibbling
 * 
 * 2️⃣ Refill Delay
 *    - The collapsed bin stays below 20–40% for > 1 telemetry interval
 *    - latency > 1.5
 *    - This means LPs are behind the action
 * 
 * 3️⃣ Non-Whale Bounce
 *    - binsCrossed for this event < 6
 *    - maxBinsCrossed <= 5
 *    - If you see 8+ bin sweeps → that's not oscillation, that's domination
 * 
 * 4️⃣ No LP Trap
 *    - migration < 0.30
 *    - Ensures LPs aren't repositioning to trap you
 * 
 * You are NOT a fighter pilot. You are a scavenger.
 * 
 * @param history - Bin snapshot history
 * @param scores - Bin microstructure scores
 * @param migration - LP migration rate
 * @param maxBinsCrossed - Maximum bins crossed in recent swaps
 * @returns true if harvest opportunity detected
 */
export function detectOscillationHarvest(
    history: BinSnapshot[],
    scores: BinScores,
    migration: number,
    maxBinsCrossed: number
): boolean {
    if (history.length < 2) return false;

    const curr = history[history.length - 1];
    const prev = history[history.length - 2];

    // 1️⃣ Bin collapse event
    // At least 1 bin adjacent to active loses ≥ 40% liquidity
    let collapsed = false;

    for (const binId in curr.bins) {
        const binIdNum = parseInt(binId);
        const currLiq = curr.bins[binId]?.liquidity || 0;
        const prevLiq = prev.bins[binId]?.liquidity || 0;

        if (prevLiq > 0) {
            const liquidityDrop = (prevLiq - currLiq) / prevLiq;

            // Check if bin is adjacent to active and lost ≥40% liquidity
            if (Math.abs(binIdNum - curr.activeBin) <= 1 && liquidityDrop >= 0.40) {
                collapsed = true;
                break;
            }
        }
    }

    if (!collapsed) return false;

    // 2️⃣ Refill delay
    // LPs are behind the action
    if (scores.latency < 1.5) return false;

    // 3️⃣ Not whale domination
    // If you see 8+ bin sweeps → that's domination, not oscillation
    if (maxBinsCrossed >= 6) return false;

    // 4️⃣ No LP trap forming
    // Ensures LPs aren't repositioning against you
    if (migration >= 0.30) return false;

    // ✅ Harvest opportunity detected
    return true;
}

/**
 * Track oscillation cycles for exit timing
 * 
 * Tracks how many collapse events have occurred since entry.
 * Exit after 2-3 cycles to avoid diminishing returns and predators.
 */
export class OscillationTracker {
    private collapseCount: Map<string, number> = new Map();
    private lastCollapseTime: Map<string, number> = new Map();

    /**
     * Record a collapse event for a pool
     */
    recordCollapse(poolId: string): void {
        const count = this.collapseCount.get(poolId) || 0;
        this.collapseCount.set(poolId, count + 1);
        this.lastCollapseTime.set(poolId, Date.now());
    }

    /**
     * Get collapse count for a pool
     */
    getCollapseCount(poolId: string): number {
        return this.collapseCount.get(poolId) || 0;
    }

    /**
     * Check if should exit based on collapse count
     * 
     * Exit after 2-3 collapses:
     * - First oscillation: free money
     * - Second: profitable
     * - Third: diminishing returns
     * - Fourth: invites predators
     */
    shouldExitOnCycle(poolId: string): boolean {
        const count = this.getCollapseCount(poolId);
        return count >= 2; // Exit after 2nd collapse
    }

    /**
     * Reset tracking for a pool (after exit)
     */
    reset(poolId: string): void {
        this.collapseCount.delete(poolId);
        this.lastCollapseTime.delete(poolId);
    }

    /**
     * Get time since last collapse
     */
    getTimeSinceLastCollapse(poolId: string): number {
        const lastTime = this.lastCollapseTime.get(poolId);
        if (!lastTime) return Infinity;
        return Date.now() - lastTime;
    }
}

/**
 * 📊 Example Harvest Cycle:
 * 
 * ActiveBin = 17
 * 
 * Cycle 1:
 * - Bin 16 collapses to 30%
 * - No LP refill
 * - Wallets nibble
 * - Latency high
 * → +1.3% realized
 * 
 * Cycle 2:
 * - Bin 17 collapses
 * - Refill slow
 * - maxBinsCrossed = 3
 * → +1.0% realized
 * 
 * Cycle 3:
 * - Bin 19 collapses
 * - LPs start migrating up
 * - Sweep 6 bins
 * - Whales enter
 * → EXIT
 * → DON'T TOUCH FOR 15–30 MIN
 * 
 * That's how pros survive.
 */

/**
 * 🐍 Harvester Behavior:
 * 
 * When bin collapses:
 * - You ENTER the local range (active ± 3)
 * - You don't wait for oscillation to "form"
 * - You're in before retail realizes it
 * - This gives you a home advantage
 * 
 * Then:
 * - When next bin collapses → you exit
 * - Not to "take profit"
 * - But because the structure is about to flip
 */
