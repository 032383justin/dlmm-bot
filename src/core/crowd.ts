/**
 * Crowd Collapse Detection Logic
 * 
 * 🧠 Core Principle:
 * Oscillation exists ONLY when retail + bots are fighting.
 * When the crowd disappears, the market trends.
 * Trending kills DLMM strategies.
 * 
 * Retail creates chaos. Whales create direction.
 * You farm chaos — not direction.
 * 
 * So when the crowd evaporates, you EXIT. Immediately.
 */

import { SwapEvent } from '../services/swapParser';

/**
 * Detect crowd collapse by measuring unique wallet participation
 * 
 * 🔥 What to measure:
 * - NOT price, NOT candles, NOT volume
 * - Unique wallets interacting with bins
 * - Last 60 seconds vs previous 60 seconds
 * 
 * 🪓 What counts as "crowd":
 * - ONLY swaps that cross bins inside activeBin ±3
 * - If a trade crosses 40 bins — that's a whale sweep, not retail
 * - Retail = noise = oscillation fuel
 * 
 * 📉 Crowd Collapse Formula:
 * collapse = (prevUniqueCount - currentUniqueCount) / prevUniqueCount
 * 
 * Examples:
 * - 19 wallets → 14 wallets = 26% collapse
 * - 12 wallets → 6 wallets = 50% collapse (EXIT)
 * - 7 wallets → 2 wallets = 71% collapse (EXIT)
 * 
 * If collapse ≥ 40% → EXIT
 * That means the casino just closed.
 * 
 * ⚠️ DO NOT DO THIS:
 * - Do not detect crowd using volume or price
 * - Do not track wallet balances
 * - Do not track token quantities
 * - Do not average collapse over time
 * - Do not smooth with moving averages
 * 
 * You measure presence, not behavior.
 * 
 * @param currentSnapshots - Swap events from last 60 seconds
 * @param previousSnapshots - Swap events from previous 60 seconds
 * @returns Collapse rate (0.0 to 1.0), where ≥0.40 means EXIT
 */
export function detectCrowdCollapse(
    currentSnapshots: SwapEvent[],
    previousSnapshots: SwapEvent[]
): number {
    // Extract unique wallets from each period
    const prevWallets = new Set(previousSnapshots.map(s => s.wallet));
    const currWallets = new Set(currentSnapshots.map(s => s.wallet));

    const prevCount = prevWallets.size;
    const currCount = currWallets.size;

    // If no previous crowd, can't measure collapse
    if (prevCount === 0) return 0;

    // Calculate collapse rate
    const collapse = (prevCount - currCount) / prevCount;

    return Math.max(0, collapse); // Ensure non-negative
}

/**
 * Filter swap events to only include retail activity (local bin range)
 * 
 * 🪓 What counts as "crowd":
 * - ONLY swaps that cross bins inside activeBin ±3
 * - Excludes whale sweeps (>8 bins crossed)
 * 
 * @param swaps - All swap events
 * @param activeBin - Current active bin
 * @param maxBinsCrossed - Maximum bins to consider retail (default 8)
 * @returns Filtered swap events representing retail activity
 */
export function filterRetailSwaps(
    swaps: SwapEvent[],
    activeBin: number,
    maxBinsCrossed: number = 8
): SwapEvent[] {
    return swaps.filter(swap => {
        // Exclude whale sweeps (>8 bins)
        if (swap.binsCrossed > maxBinsCrossed) return false;

        // Only include swaps in local range (activeBin ±3)
        const minBin = Math.min(swap.fromBin, swap.toBin);
        const maxBin = Math.max(swap.fromBin, swap.toBin);

        // Check if swap overlaps with activeBin ±3
        const localRangeMin = activeBin - 3;
        const localRangeMax = activeBin + 3;

        return (minBin <= localRangeMax && maxBin >= localRangeMin);
    });
}

/**
 * Get unique wallet count from swap events
 * 
 * @param swaps - Swap events
 * @returns Number of unique wallets
 */
export function getUniqueWalletCount(swaps: SwapEvent[]): number {
    const wallets = new Set(swaps.map(s => s.wallet));
    return wallets.size;
}

/**
 * ⚔️ Why 40% works:
 * 
 * Think of crowds as:
 * - weirdos
 * - degen retail
 * - bot armies
 * - NFT bros
 * - "I will get rich" types
 * 
 * They provide random bids and asks.
 * They create oscillation.
 * They are predictably dumb.
 * 
 * When they vanish, volatility becomes engineered by whales.
 * You don't fight whales. You leave.
 * 
 * 🪓 Why this protects you:
 * 
 * Oscillation Trading = Casino
 * Crowd = Gamblers
 * 
 * If the gamblers go home:
 * - Liquidity dries up
 * - Whales take over
 * - Bots with oscillation strategies get slaughtered
 * - LPs reposition ahead of price
 * - Death spiral
 * 
 * You leave before that happens.
 */
