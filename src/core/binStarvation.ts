/**
 * Bin-Starvation Detection
 * 
 * Goal:
 * Detect when local bins are being drained faster than LPs can refill —
 * this predicts incoming oscillation or panic bursts before they show up.
 * 
 * 1. Core Idea:
 * Bin Starvation = sustained liquidity decay around the active bin with no replenishment.
 * 
 * Not a sweep, not a spike.
 * It's heat death in the immediate bin cluster.
 * 
 * This is the single strongest predictor of profitable oscillation.
 * 
 * 2. What You Monitor:
 * - activeBin
 * - bins near it (±3 to ±6)
 * - liquidity per bin
 * - refill latency
 * 
 * You look at Δliquidity over time, not price.
 * 
 * 3. Detection Logic:
 * Starvation = per-bin decay AND LP inactivity
 * 
 * Condition set:
 * - Bin liquidity ↓ in consecutive snapshots
 * - Decay magnitude ≥ 10–25%
 * - Latency ≥ 1.25
 * - No compensating migration
 * 
 * If all are true → bin starvation confirmed.
 * 
 * 5. What this gives you:
 * You are not reacting to:
 * - sweeps
 * - price candles
 * - hype bots
 * 
 * You are reacting to environmental decay.
 * 
 * 9. Thresholds that actually work:
 * - Decay per snapshot: 10%–25%
 * - Radius: ±3 bins (±6 max)
 * - Latency: ≥ 1.25
 * 
 * Below these → just noise.
 * 
 * 10. DO NOT DO (rookie mistakes):
 * - Do not trigger on absolute liquidity levels
 * - Do not read starvation from a single bin
 * - Do not treat sweeps as starvation
 * 
 * Sweep = aggression
 * Starvation = neglect
 * 
 * One is violence. The other is entropy.
 * You want entropy first.
 */

import { BinSnapshot } from './dlmmTelemetry';

/**
 * Detect bin starvation around active bin
 * 
 * 4. Code (drop-in function):
 * 
 * Checks for sustained liquidity decay in consecutive snapshots.
 * Requires at least 2 bins showing ≥10% decay in both recent periods.
 * 
 * @param history - Bin snapshot history (needs at least 3 snapshots)
 * @param radius - Bin range to check around active (default 3, max 6)
 * @returns true if bin starvation detected
 */
export function detectBinStarvation(
    history: BinSnapshot[],
    radius: number = 3
): boolean {
    if (history.length < 3) return false;

    const curr = history[history.length - 1];
    const prev = history[history.length - 2];
    const older = history[history.length - 3];

    const center = curr.activeBin;

    let starvingBins = 0;

    // Check each bin in the radius
    for (let i = -radius; i <= radius; i++) {
        const binId = center + i;

        // Get bin data from each snapshot
        const nowLiq = curr.bins[binId]?.liquidity || 0;
        const prevLiq = prev.bins[binId]?.liquidity || 0;
        const olderLiq = older.bins[binId]?.liquidity || 0;

        // Skip if bin doesn't exist in all snapshots
        if (nowLiq === 0 && prevLiq === 0 && olderLiq === 0) continue;

        // Calculate decay rates
        const d1 = prevLiq > 0 ? (prevLiq - nowLiq) / prevLiq : 0;
        const d2 = olderLiq > 0 ? (olderLiq - prevLiq) / olderLiq : 0;

        // Check for sustained decay (≥10% in both periods)
        if (d1 > 0.10 && d2 > 0.10) {
            starvingBins++;
        }
    }

    // Require at least 2 bins showing starvation
    return starvingBins >= 2;
}

/**
 * 6. Behavior Rules:
 * 
 * When detectBinStarvation == true:
 * 
 * A) If not in position → enter pre-oscillation range (activeBin ± 3)
 * B) If already in position → hold (you are about to get paid)
 * C) If whale sweep arrives → exit immediately (always override)
 * 
 * @param starvation - Starvation detected
 * @param inPosition - Currently holding position
 * @param whaleSweep - Whale sweep detected
 * @returns Action recommendation
 */
export function getStarvationAction(
    starvation: boolean,
    inPosition: boolean,
    whaleSweep: boolean
): 'ENTER' | 'HOLD' | 'EXIT' | 'NONE' {
    // Always exit on whale sweep
    if (whaleSweep) return 'EXIT';

    if (starvation) {
        if (inPosition) {
            return 'HOLD'; // You are about to get paid
        } else {
            return 'ENTER'; // Enter pre-oscillation range
        }
    }

    return 'NONE';
}

/**
 * 7. Combine with migration:
 * 
 * Starvation + LP migration = trap
 * if starvation && migration >= 0.25 → DO NOT ENTER
 * 
 * LPs are preparing to crush bots.
 * 
 * @param starvation - Starvation detected
 * @param migration - LP migration rate
 * @returns true if safe to enter
 */
export function isSafeStarvationEntry(
    starvation: boolean,
    migration: number
): boolean {
    if (!starvation) return false;

    // Starvation + migration = trap
    if (migration >= 0.25) return false;

    return true;
}

/**
 * 8. Cycle-based Variant:
 * 
 * Starvation across 2–4 cycles → strongest signal.
 * Don't respond on a single snapshot.
 * 
 * @param history - Bin snapshot history
 * @param minCycles - Minimum cycles to confirm (default 2)
 * @param radius - Bin range to check
 * @returns true if sustained starvation detected
 */
export function detectSustainedStarvation(
    history: BinSnapshot[],
    minCycles: number = 2,
    radius: number = 3
): boolean {
    if (history.length < minCycles * 3) return false;

    let consecutiveStarvation = 0;

    // Check each possible 3-snapshot window
    for (let i = history.length - 3; i >= minCycles * 3 - 3; i -= 3) {
        const window = history.slice(i, i + 3);
        if (detectBinStarvation(window, radius)) {
            consecutiveStarvation++;
        } else {
            break; // Reset on non-starvation
        }
    }

    return consecutiveStarvation >= minCycles;
}

/**
 * Get starvation severity level
 * 
 * @param history - Bin snapshot history
 * @param radius - Bin range to check
 * @returns Severity: 0 (none) to 1 (extreme)
 */
export function getStarvationSeverity(
    history: BinSnapshot[],
    radius: number = 3
): number {
    if (history.length < 3) return 0;

    const curr = history[history.length - 1];
    const prev = history[history.length - 2];
    const older = history[history.length - 3];

    const center = curr.activeBin;
    const totalBins = radius * 2 + 1;

    let starvingBins = 0;
    let totalDecay = 0;

    for (let i = -radius; i <= radius; i++) {
        const binId = center + i;

        const nowLiq = curr.bins[binId]?.liquidity || 0;
        const prevLiq = prev.bins[binId]?.liquidity || 0;
        const olderLiq = older.bins[binId]?.liquidity || 0;

        if (nowLiq === 0 && prevLiq === 0 && olderLiq === 0) continue;

        const d1 = prevLiq > 0 ? (prevLiq - nowLiq) / prevLiq : 0;
        const d2 = olderLiq > 0 ? (olderLiq - prevLiq) / olderLiq : 0;

        if (d1 > 0.10 && d2 > 0.10) {
            starvingBins++;
            totalDecay += (d1 + d2) / 2;
        }
    }

    // Severity = (starving bins / total bins) * average decay
    const binRatio = starvingBins / totalBins;
    const avgDecay = starvingBins > 0 ? totalDecay / starvingBins : 0;

    return Math.min(1.0, binRatio * avgDecay * 2);
}

/**
 * Distinguish between starvation and sweep
 * 
 * Sweep = aggression (sudden, large, directional)
 * Starvation = neglect (gradual, sustained, environmental)
 * 
 * @param history - Bin snapshot history
 * @param maxBinsCrossed - Max bins crossed in recent swaps
 * @returns 'STARVATION' | 'SWEEP' | 'BOTH' | 'NONE'
 */
export function classifyLiquidityEvent(
    history: BinSnapshot[],
    maxBinsCrossed: number
): 'STARVATION' | 'SWEEP' | 'BOTH' | 'NONE' {
    const starvation = detectBinStarvation(history);
    const sweep = maxBinsCrossed >= 6;

    if (starvation && sweep) return 'BOTH';
    if (starvation) return 'STARVATION';
    if (sweep) return 'SWEEP';
    return 'NONE';
}
