/**
 * Latency-Based Cycle Prediction (DLMM)
 * 
 * Goal:
 * Predict the next oscillation cycle before it forms using LP refill delay patterns.
 * 
 * Key Signals:
 * 
 * 1. Latency rising (incubation)
 *    - latency(n) > latency(n-1)
 *    - latency(n) >= 1.25
 *    - LPs are falling behind → oscillation forming
 * 
 * 2. Latency plateau (active chaos)
 *    - latency ~ 1.7–2.4
 *    - Perfect window for entry/harvest
 * 
 * 3. Latency collapse (cycle ending)
 *    - latency drop >= 20% within 1–2 snapshots
 *    - LPs woke up → cycle dies → DO NOT trade
 * 
 * Cycles in Telemetry:
 * You have snapshots of liquidity + timestamp.
 * Extract latency series: L = [l1, l2, l3, ... ln]
 * 
 * Use this to detect phases:
 * - Uptrend latency → pre-oscillation
 * - Plateau latency → oscillation
 * - Downtrend latency → end of cycle
 * 
 * Thresholds:
 * PRE:     1.25–1.60
 * ACTIVE:  1.60–2.30
 * END:     <1.30 (after plateau)
 * 
 * Simple State Machine:
 * PRE → ACTIVE → END → COOLDOWN
 * 
 * You do not re-enter until COOLDOWN expires.
 */

import { BinSnapshot } from './dlmmTelemetry';

/**
 * Cycle state based on latency patterns
 */
export type CycleState = 'NONE' | 'PRE' | 'ACTIVE' | 'END';

/**
 * Predict cycle state using latency patterns
 * 
 * Entry Rule (prediction):
 * If:
 * - latency rising for ≥2 samples
 * - AND current latency >= 1.25
 * - AND migration < 0.25
 * - AND maxBinsCrossed ≤ 3
 * → Enter local bins
 * 
 * Exit Rule:
 * If:
 * - latency decreases ≥ 20% from peak
 * - OR migration ≥ 0.30
 * - OR maxBinsCrossed ≥ 6
 * → Exit immediately
 * 
 * @param history - Bin snapshot history (needs at least 4 snapshots)
 * @returns Cycle state: NONE, PRE, ACTIVE, or END
 */
export function predictCycleLatency(history: BinSnapshot[]): CycleState {
    if (history.length < 4) return 'NONE';

    // Extract latency series from last 4 snapshots
    const latencies = history.slice(-4).map(h => {
        // Calculate latency from snapshot if not already present
        // This is a placeholder - actual latency should come from bin scoring
        return calculateLatencyFromSnapshot(h);
    });

    const L = latencies;

    // Check for rising latency (incubation phase)
    const rising = L[3] > L[2] && L[2] > L[1] && L[1] > L[0];

    // Check for plateau (active chaos)
    const plateau = L[3] >= 1.6 && L[3] <= 2.3;

    // Check for drop (cycle ending)
    const peak = Math.max(...L);
    const drop = L[3] <= (peak * 0.8); // 20% drop from peak

    // State detection
    if (rising && L[3] >= 1.25) {
        return 'PRE'; // Pre-oscillation: LPs falling behind
    }

    if (plateau) {
        return 'ACTIVE'; // Active oscillation: perfect harvest window
    }

    if (drop && peak >= 1.6) {
        return 'END'; // Cycle ending: LPs woke up
    }

    return 'NONE'; // No clear cycle state
}

/**
 * Calculate latency from bin snapshot
 * 
 * Latency = average refill time across local bins
 * Higher latency = slower LP response = opportunity
 * 
 * @param snapshot - Bin snapshot
 * @returns Latency value
 */
function calculateLatencyFromSnapshot(snapshot: BinSnapshot): number {
    const refillTimes: number[] = [];

    // Collect refill times from bins
    for (const binId in snapshot.bins) {
        const bin = snapshot.bins[binId];
        if (bin.refillTimeMs && bin.refillTimeMs > 0) {
            refillTimes.push(bin.refillTimeMs);
        }
    }

    if (refillTimes.length === 0) return 0;

    // Average refill time in seconds
    const avgRefillMs = refillTimes.reduce((a, b) => a + b, 0) / refillTimes.length;
    return avgRefillMs / 1000; // Convert to seconds
}

/**
 * Check if safe to enter based on cycle state
 * 
 * Only enter during PRE → ACTIVE transition
 * 
 * @param cycleState - Current cycle state
 * @param migration - LP migration rate
 * @param maxBinsCrossed - Max bins crossed
 * @returns true if safe to enter
 */
export function shouldEnterOnCycle(
    cycleState: CycleState,
    migration: number,
    maxBinsCrossed: number
): boolean {
    // Only enter in PRE or early ACTIVE state
    if (cycleState !== 'PRE' && cycleState !== 'ACTIVE') {
        return false;
    }

    // Check safety conditions
    if (migration >= 0.25) return false; // LP trap forming
    if (maxBinsCrossed > 3) return false; // Whale activity

    return true;
}

/**
 * Check if should exit based on cycle state
 * 
 * Exit when ACTIVE → END transition detected
 * 
 * @param cycleState - Current cycle state
 * @param history - Bin snapshot history
 * @param migration - LP migration rate
 * @param maxBinsCrossed - Max bins crossed
 * @returns true if should exit
 */
export function shouldExitOnCycle(
    cycleState: CycleState,
    history: BinSnapshot[],
    migration: number,
    maxBinsCrossed: number
): boolean {
    // Exit if cycle is ending
    if (cycleState === 'END') return true;

    // Exit if migration trap forming
    if (migration >= 0.30) return true;

    // Exit if whale sweep detected
    if (maxBinsCrossed >= 6) return true;

    // Check for latency collapse (20% drop from peak)
    if (history.length >= 4) {
        const latencies = history.slice(-4).map(h => calculateLatencyFromSnapshot(h));
        const peak = Math.max(...latencies);
        const current = latencies[latencies.length - 1];

        if (current <= peak * 0.8 && peak >= 1.6) {
            return true; // Latency collapsed - LPs woke up
        }
    }

    return false;
}

/**
 * Get cycle state description for logging
 */
export function getCycleStateDescription(state: CycleState): string {
    switch (state) {
        case 'PRE':
            return 'Pre-oscillation: LPs falling behind, oscillation forming';
        case 'ACTIVE':
            return 'Active oscillation: Perfect harvest window';
        case 'END':
            return 'Cycle ending: LPs woke up, exit now';
        case 'NONE':
            return 'No clear cycle state';
        default:
            return 'Unknown state';
    }
}

/**
 * Integration Example:
 * 
 * ```typescript
 * const cycleState = predictCycleLatency(binHistory);
 * 
 * if (shouldEnterOnCycle(cycleState, migration, maxBinsCrossed)) {
 *   // Enter position during PRE → ACTIVE transition
 *   executeEntry();
 * }
 * 
 * if (shouldExitOnCycle(cycleState, binHistory, migration, maxBinsCrossed)) {
 *   // Exit when ACTIVE → END detected
 *   executeExit("Cycle ending - latency collapsed");
 * }
 * ```
 */
