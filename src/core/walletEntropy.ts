/**
 * Wallet-Entropy Prediction Logic
 * 
 * 🔥 Objective:
 * Predict whether the next 30–120s will produce:
 * - exploitable oscillation (good), or
 * - coordinated sweeps/whale events (bad)
 * 
 * We don't care about: volume, price, candles, hype
 * Only wallet behavior.
 * 
 * 1. Why wallet entropy works:
 * 
 * Price is the result. Wallet entropy is the cause.
 * 
 * When entropy increases:
 * - randomness ↑
 * - independent participants ↑
 * - oscillation probability ↑
 * 
 * When entropy decreases:
 * - coordinated agents ↑
 * - bots/whales ↑
 * - directional sweeps ↑
 * - rug scenarios ↑
 * 
 * 2. Inputs (you already have them):
 * For each pool timeline segment (30–60s window):
 * - walletCount = unique wallets
 * - repeatActorCount = wallets with 2+ tx
 * - actorDistribution = histogram of tx per wallet
 * 
 * 3. Entropy Formula:
 * Kolmogorov / Shannon
 * Let p_i = tx_i / total_tx
 * entropy = - Σ (p_i * log(p_i))
 * 
 * Higher = varied agents
 * Lower = one apex predator
 * 
 * 4. Thresholds (battle-tested for DLMM):
 * entropy < 0.8      → highly coordinated (danger)
 * 0.8–1.4            → semi-bot dominated, avoid
 * 1.4–2.2            → retail chaos (safe oscillation)
 * > 2.2              → maximum chaos (fastest harvesting)
 * 
 * 5. Interpretation:
 * 
 * Low entropy = 1–2 actors control flow
 * - Expect sweeps, traps, fake refills
 * - → Do NOT enter
 * 
 * Mid entropy = organic micro-warfare, random wallets
 * - → Best oscillation conditions
 * 
 * Ultra-high entropy = everyone panic-clicks
 * - Great for quick harvest, not long holds
 * 
 * 10. Memory window:
 * Don't measure entropy over a single second.
 * Use: rolling window = 30–90s, slide = every snapshot
 * This prevents noise.
 */

import { SwapEvent } from '../services/swapParser';

/**
 * Calculate wallet entropy using Shannon entropy formula
 * 
 * entropy = - Σ (p_i * log(p_i))
 * where p_i = tx_i / total_tx
 * 
 * @param walletTxCounts - Map of wallet address to transaction count
 * @returns Entropy value (higher = more varied agents)
 */
export function walletEntropy(walletTxCounts: Record<string, number>): number {
    const counts = Object.values(walletTxCounts);
    if (counts.length === 0) return 0;

    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) return 0;

    let H = 0;
    for (const c of counts) {
        if (c > 0) {
            const p = c / total;
            H += -(p * Math.log(p));
        }
    }

    return H;
}

/**
 * Calculate wallet transaction counts from swap events
 * 
 * @param swapEvents - Array of swap events
 * @param timeWindowMs - Time window to consider (default 60s)
 * @returns Map of wallet to transaction count
 */
export function getWalletTxCounts(
    swapEvents: SwapEvent[],
    timeWindowMs: number = 60000
): Record<string, number> {
    const now = Date.now();
    const cutoff = now - timeWindowMs;

    const walletCounts: Record<string, number> = {};

    for (const swap of swapEvents) {
        if (swap.timestamp >= cutoff) {
            walletCounts[swap.wallet] = (walletCounts[swap.wallet] || 0) + 1;
        }
    }

    return walletCounts;
}

/**
 * Entropy interpretation
 */
export type EntropyLevel = 'DANGER' | 'AVOID' | 'SAFE' | 'CHAOS';

/**
 * Interpret entropy level
 * 
 * @param entropy - Entropy value
 * @returns Entropy level classification
 */
export function interpretEntropy(entropy: number): EntropyLevel {
    if (entropy < 0.8) return 'DANGER';   // Highly coordinated
    if (entropy < 1.4) return 'AVOID';    // Semi-bot dominated
    if (entropy < 2.2) return 'SAFE';     // Retail chaos (best)
    return 'CHAOS';                        // Maximum chaos
}

/**
 * Get entropy description
 */
export function getEntropyDescription(level: EntropyLevel): string {
    switch (level) {
        case 'DANGER':
            return 'Highly coordinated: 1-2 actors control flow. Expect sweeps, traps, fake refills. DO NOT ENTER.';
        case 'AVOID':
            return 'Semi-bot dominated: Too coordinated for safe oscillation. AVOID.';
        case 'SAFE':
            return 'Retail chaos: Organic micro-warfare, random wallets. BEST oscillation conditions.';
        case 'CHAOS':
            return 'Maximum chaos: Everyone panic-clicks. Great for quick harvest, not long holds.';
    }
}

/**
 * Check if safe to enter based on entropy
 * 
 * 7. Usage in entry logic:
 * 
 * const H = walletEntropy(walletTxCounts);
 * if (H < 1.4) return false;      // too coordinated
 * if (H > 2.2) size *= 0.5;       // reduce size, exit faster
 * 
 * @param entropy - Entropy value
 * @returns true if safe to enter
 */
export function isSafeEntropyLevel(entropy: number): boolean {
    return entropy >= 1.4; // Must be at least SAFE level
}

/**
 * Calculate position size multiplier based on entropy
 * 
 * Ultra-high entropy = reduce size, exit faster
 * 
 * @param entropy - Entropy value
 * @returns Position size multiplier (0.5 to 1.0)
 */
export function getEntropySizeMultiplier(entropy: number): number {
    if (entropy > 2.2) return 0.5;  // Maximum chaos - reduce size
    return 1.0;                      // Normal size
}

/**
 * 8. Advanced filter (required):
 * 
 * If high entropy AND latency > 1.6
 * → Pre-oscillation → enter
 * 
 * If high entropy AND latency collapsing
 * → Exit immediately
 * 
 * Entropy ≠ excuse to stay in a dying market.
 * 
 * @param entropy - Entropy value
 * @param latency - LP refill latency
 * @param latencyTrend - 'rising' | 'stable' | 'falling'
 * @returns Entry recommendation
 */
export function evaluateEntropyWithLatency(
    entropy: number,
    latency: number,
    latencyTrend: 'rising' | 'stable' | 'falling'
): { enter: boolean; reason: string } {
    // High entropy + rising latency = pre-oscillation
    if (entropy >= 1.6 && latency > 1.6 && latencyTrend === 'rising') {
        return {
            enter: true,
            reason: 'High entropy + rising latency = pre-oscillation forming'
        };
    }

    // High entropy + latency collapsing = exit
    if (entropy >= 1.6 && latencyTrend === 'falling') {
        return {
            enter: false,
            reason: 'Latency collapsing - exit immediately despite high entropy'
        };
    }

    // Low entropy = coordinated
    if (entropy < 1.4) {
        return {
            enter: false,
            reason: 'Too coordinated - expect sweeps and traps'
        };
    }

    // Safe entropy range
    return {
        enter: true,
        reason: 'Safe entropy level for oscillation'
    };
}

/**
 * 9. Pairing with migration:
 * 
 * Key rule:
 * if (entropy > 1.6 AND migration < 0.25) → enter bin ±3
 * 
 * LPs asleep + chaos = money
 * 
 * If migration spikes:
 * exit → cooldown
 * 
 * LPs awake = trap
 * 
 * @param entropy - Entropy value
 * @param migration - LP migration rate
 * @returns Entry decision
 */
export function evaluateEntropyWithMigration(
    entropy: number,
    migration: number
): { enter: boolean; reason: string } {
    // Perfect conditions: high entropy + LPs asleep
    if (entropy > 1.6 && migration < 0.25) {
        return {
            enter: true,
            reason: 'LPs asleep + chaos = money'
        };
    }

    // Migration spike = trap
    if (migration >= 0.25) {
        return {
            enter: false,
            reason: 'LP migration spike - LPs awake = trap'
        };
    }

    // Low entropy
    if (entropy < 1.4) {
        return {
            enter: false,
            reason: 'Too coordinated for safe entry'
        };
    }

    return {
        enter: true,
        reason: 'Acceptable entropy and migration levels'
    };
}

/**
 * Calculate rolling entropy over time window
 * 
 * 10. Memory window:
 * Don't measure entropy over a single second.
 * Use: rolling window = 30–90s, slide = every snapshot
 * This prevents noise.
 * 
 * @param swapEvents - All swap events
 * @param windowMs - Rolling window size (default 60s)
 * @returns Current entropy value
 */
export function calculateRollingEntropy(
    swapEvents: SwapEvent[],
    windowMs: number = 60000
): number {
    const walletCounts = getWalletTxCounts(swapEvents, windowMs);
    return walletEntropy(walletCounts);
}
