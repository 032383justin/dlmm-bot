/**
 * Starvation + Entropy Fusion Logic (DLMM)
 * 
 * Minimal theory. Maximum signal accuracy. No fluff.
 * 
 * This is the most reliable entry-confirmation logic you will ever use for DLMM bots.
 * 
 * It solves the core failure case:
 * - Starvation alone → LP trap possible
 * - Entropy alone → random churn, no direction
 * 
 * 👉 Together → early chaos window becomes predictable and harvestable
 * 
 * 🔥 Concept:
 * You ONLY enter when two independent signals align:
 * 
 * A) Structural starvation (supply decay)
 *    - Liquidity is dying locally over time
 * 
 * B) High entropy (organic disorder)
 *    - Chaotic multi-wallet flow (not coordinated bots)
 * 
 * When those overlap, you get real oscillation, not noise or traps.
 * 
 * 5. Why it works (1 sentence):
 * Starvation = supply shock
 * Entropy = independent demand
 * This combination → oscillation ignition.
 * 
 * Not hype, not trend, not bots fighting — actual decentralized chaos.
 * 
 * 8. DO NOT DO:
 * - Do NOT trade starvation without entropy
 * - Do NOT enter on entropy spikes without starvation
 * - Do NOT double size based on entropy
 * - Do NOT DCA
 * 
 * That's how bots die.
 */

/**
 * 1. Starvation Condition (already defined):
 * - Multi-bin local decay ≥ 10–25%
 * - Consecutive snapshots
 * - Latency ≥ 1.25
 * - Migration < 0.30
 * 
 * This means:
 * - LPs are asleep
 * - Bins are drying
 * - System is vulnerable
 * 
 * 2. Entropy Condition:
 * - Shannon entropy on tx-per-wallet distribution
 * - High randomness, not bot dominance
 * 
 * Thresholds:
 * - 0.0–1.4   = coordinated → no entry
 * - 1.4–2.2   = organic chaos → safe window
 * - > 2.2     = panic burst → reduce size
 */

/**
 * 🎯 Fusion Rule (the money):
 * Only trade when BOTH are true:
 * - Starvation = true
 * - AND Entropy >= 1.4
 * 
 * This is exactly the window before memes spike and before whales arrive.
 * 
 * 3. Hard Exclusions:
 * Even if starvation + entropy both pass:
 * - If maxBinsCrossed > 5 → ABORT (predators)
 * - If migration ≥ 0.30 → ABORT (LP trap)
 * - If uniqueWallets < 3 → ABORT (duels)
 * 
 * @param starvation - Bin starvation detected
 * @param entropy - Wallet entropy value
 * @param maxBinsCrossed - Maximum bins crossed in recent swaps
 * @param migration - LP migration rate
 * @param uniqueWallets - Unique wallet count
 * @returns true if should enter
 */
export function shouldEnterFusion(
    starvation: boolean,
    entropy: number,
    maxBinsCrossed: number,
    migration: number,
    uniqueWallets: number
): boolean {
    // Require BOTH starvation and entropy
    if (!starvation) return false;
    if (entropy < 1.4) return false;

    // Hard exclusions
    if (maxBinsCrossed > 5) return false;  // Predators present
    if (migration >= 0.30) return false;   // LP trap forming
    if (uniqueWallets < 3) return false;   // Bot duels, not chaos

    return true;
}

/**
 * 6. Execution:
 * When shouldEnterFusion() returns true:
 * - Set bin range: activeBin ± 3
 * - Position size: base risk only (2% of capital)
 * - You scale after latency plateau, not now
 * 
 * @param starvation - Starvation detected
 * @param entropy - Entropy value
 * @param maxBinsCrossed - Max bins crossed
 * @param migration - Migration rate
 * @param uniqueWallets - Unique wallets
 * @param activeBin - Current active bin
 * @returns Entry decision with bin range
 */
export function evaluateFusionEntry(
    starvation: boolean,
    entropy: number,
    maxBinsCrossed: number,
    migration: number,
    uniqueWallets: number,
    activeBin: number
): { enter: boolean; lowerBin: number; upperBin: number; reason: string } {
    const shouldEnter = shouldEnterFusion(
        starvation,
        entropy,
        maxBinsCrossed,
        migration,
        uniqueWallets
    );

    if (!shouldEnter) {
        // Build rejection reason
        const reasons: string[] = [];
        if (!starvation) reasons.push('No starvation');
        if (entropy < 1.4) reasons.push(`Entropy ${entropy.toFixed(2)} < 1.4 (coordinated)`);
        if (maxBinsCrossed > 5) reasons.push(`Predators: ${maxBinsCrossed} bins crossed`);
        if (migration >= 0.30) reasons.push(`LP trap: ${(migration * 100).toFixed(1)}% migration`);
        if (uniqueWallets < 3) reasons.push(`Only ${uniqueWallets} wallets (duels)`);

        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Fusion rejected: ${reasons.join(', ')}`
        };
    }

    // ✅ Fusion entry confirmed
    return {
        enter: true,
        lowerBin: activeBin - 3,
        upperBin: activeBin + 3,
        reason: 'Fusion confirmed: Starvation + High Entropy = Oscillation ignition'
    };
}

/**
 * 7. Exit:
 * Exit as soon as entropy collapses OR starvation reverses:
 * - if entropy < 1.2 → EXIT
 * - if latency drops ≥ 20% from peak → EXIT
 * - if migration ≥ 0.30 → EXIT
 * - if maxBinsCrossed ≥ 6 → EXIT
 * 
 * Oscillation is dying → get out.
 * 
 * @param entropy - Current entropy
 * @param latency - Current latency
 * @param peakLatency - Peak latency since entry
 * @param migration - Migration rate
 * @param maxBinsCrossed - Max bins crossed
 * @returns Exit decision
 */
export function shouldExitFusion(
    entropy: number,
    latency: number,
    peakLatency: number,
    migration: number,
    maxBinsCrossed: number
): { exit: boolean; reason: string } {
    // Entropy collapsed
    if (entropy < 1.2) {
        return { exit: true, reason: 'Entropy collapsed < 1.2 - chaos dying' };
    }

    // Latency collapsed (LPs woke up)
    const latencyDrop = (peakLatency - latency) / peakLatency;
    if (latencyDrop >= 0.20) {
        return { exit: true, reason: 'Latency dropped 20% - LPs woke up' };
    }

    // LP migration trap
    if (migration >= 0.30) {
        return { exit: true, reason: 'LP migration ≥30% - trap forming' };
    }

    // Whale sweep
    if (maxBinsCrossed >= 6) {
        return { exit: true, reason: 'Whale sweep detected - predators active' };
    }

    return { exit: false, reason: '' };
}

/**
 * Get fusion signal strength (0 to 1)
 * 
 * Combines starvation severity and entropy level
 * 
 * @param starvation - Starvation detected
 * @param starvationSeverity - Starvation severity (0-1)
 * @param entropy - Entropy value
 * @returns Signal strength (0-1)
 */
export function getFusionSignalStrength(
    starvation: boolean,
    starvationSeverity: number,
    entropy: number
): number {
    if (!starvation) return 0;
    if (entropy < 1.4) return 0;

    // Normalize entropy to 0-1 (1.4-2.2 range)
    const entropyNorm = Math.min(1.0, Math.max(0, (entropy - 1.4) / 0.8));

    // Combine starvation severity and entropy
    return (starvationSeverity + entropyNorm) / 2;
}

/**
 * Integration Example:
 * 
 * ```typescript
 * // Detect conditions
 * const starvation = detectBinStarvation(history);
 * const entropy = calculateRollingEntropy(swapEvents);
 * 
 * // Check fusion entry
 * const fusion = evaluateFusionEntry(
 *   starvation,
 *   entropy,
 *   maxBinsCrossed,
 *   migration,
 *   uniqueWallets,
 *   activeBin
 * );
 * 
 * if (fusion.enter) {
 *   // Enter position: activeBin ± 3
 *   // Base size only (2% of capital)
 *   executeEntry(fusion.lowerBin, fusion.upperBin);
 * }
 * 
 * // Monitor for exit
 * const exitSignal = shouldExitFusion(
 *   entropy,
 *   latency,
 *   peakLatency,
 *   migration,
 *   maxBinsCrossed
 * );
 * 
 * if (exitSignal.exit) {
 *   executeExit(exitSignal.reason);
 * }
 * ```
 */
