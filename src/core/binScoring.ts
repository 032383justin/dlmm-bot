import { DLMMTelemetry, BinSnapshot } from './dlmmTelemetry';

export interface BinScore {
    concentrationScore: number;
    balanceScore: number;
    depthScore: number;
    spreadScore: number;
    overallScore: number;
}

export interface BinScores {
    exhaustion: number;
    oscillation: number;
    latency: number;
    whaleImpact: number;
    crowd: number;
    total: number;
}

export function scoreBins(snapshot: BinSnapshot, history: BinSnapshot[]): BinScores {
    // 📌 1. EXHAUSTION SCORE
    // Measures how fast liquidity disappears from bins around active bin
    // Ideal range: 20%–60% | Below 10% = ignore | Above 70% = whales sweeping → risky
    const exhaustion = calculateExhaustionScore(snapshot, history);

    // 📌 2. OSCILLATION SCORE
    // Measures if bins come back after being eaten (refills / depletions)
    // Ideal: > 50% | Below 30% = trending market → do not trade
    const oscillation = calculateOscillationScore(history);

    // 📌 3. LATENCY SCORE
    // Measures how slow LPs refill the eaten bins
    // Ideal: > 1.5 → LPs are slow → easy money
    const latency = calculateLatencyScore(history);

    // 📌 4. WHALE IMPACT
    // Detects if whales are sweeping bins in a single direction
    // 2–5 = normal | 6–9 = dangerous | 10+ = do not enter
    const whaleImpact = calculateWhaleImpact(history);

    // 📌 5. CROWD SCORE
    // Count unique buyers/sellers (wallets) over time window
    // 0–3 wallets = avoid | 20+ = excellent
    const crowd = calculateCrowdScore(history);

    // 🧠 COMBINE SCORES
    // Normalize whale impact (invert: lower is better)
    const whaleImpactNormalized = Math.max(0, 100 - (whaleImpact * 10)); // Scale to 0-100
    const crowdNormalized = Math.min(100, (crowd / 20) * 100); // Scale to 0-100 (20+ wallets = 100)

    const total =
        0.35 * exhaustion +
        0.25 * oscillation +
        0.20 * latency +
        0.15 * whaleImpactNormalized +
        0.05 * crowdNormalized;

    return {
        exhaustion,
        oscillation,
        latency,
        whaleImpact,
        crowd,
        total
    };
}

// 📌 1. EXHAUSTION SCORE IMPLEMENTATION
function calculateExhaustionScore(snapshot: BinSnapshot, history: BinSnapshot[]): number {
    if (history.length < 2) return 0;

    const activeBin = snapshot.activeBin;
    const binRange = 3; // ± 3 bins around active bin

    // Get bins in range (activeBin ± 3)
    const binsInRange = Object.keys(snapshot.bins)
        .map(Number)
        .filter(binId => Math.abs(binId - activeBin) <= binRange);

    if (binsInRange.length === 0) return 0;

    // Compare current vs 90-180 seconds ago
    const timeWindow = 90 * 1000; // 90 seconds
    const oldSnapshot = history.find(h => snapshot.timestamp - h.timestamp >= timeWindow);

    if (!oldSnapshot) return 0;

    let totalInitialLiquidity = 0;
    let totalRemovedLiquidity = 0;

    for (const binId of binsInRange) {
        const currentLiq = snapshot.bins[binId]?.liquidity || 0;
        const initialLiq = oldSnapshot.bins[binId]?.liquidity || 0;

        totalInitialLiquidity += initialLiq;
        if (initialLiq > currentLiq) {
            totalRemovedLiquidity += (initialLiq - currentLiq);
        }
    }

    if (totalInitialLiquidity === 0) return 0;

    const exhaustionPct = (totalRemovedLiquidity / totalInitialLiquidity) * 100;

    // Normalize to 0-100 score (ideal 20-60%)
    if (exhaustionPct < 10) return 0; // Too low, ignore
    if (exhaustionPct > 70) return 0; // Too high, whales sweeping

    // Peak score at 40% exhaustion
    if (exhaustionPct <= 40) {
        return (exhaustionPct / 40) * 100;
    } else {
        return ((70 - exhaustionPct) / 30) * 100;
    }
}

// 📌 2. OSCILLATION SCORE IMPLEMENTATION
function calculateOscillationScore(history: BinSnapshot[]): number {
    if (history.length < 15) return 0;

    const recentHistory = history.slice(-30); // Last 30 snapshots
    let depletions = 0;
    let refills = 0;

    // Track each bin's state changes
    const binStates: { [binId: number]: { depleted: boolean, depletedAt: number } } = {};

    for (let i = 1; i < recentHistory.length; i++) {
        const prev = recentHistory[i - 1];
        const curr = recentHistory[i];

        for (const binId in curr.bins) {
            const prevLiq = prev.bins[binId]?.liquidity || 0;
            const currLiq = curr.bins[binId]?.liquidity || 0;

            // Detect depletion (liquidity drops below 10% of previous)
            if (prevLiq > 0 && currLiq < prevLiq * 0.1) {
                if (!binStates[binId]?.depleted) {
                    depletions++;
                    binStates[binId] = { depleted: true, depletedAt: i };
                }
            }

            // Detect refill (liquidity returns within 1-3 cycles after depletion)
            if (binStates[binId]?.depleted && currLiq > prevLiq * 1.5) {
                const cyclesSinceDepletion = i - binStates[binId].depletedAt;
                if (cyclesSinceDepletion >= 1 && cyclesSinceDepletion <= 3) {
                    refills++;
                    binStates[binId].depleted = false;
                }
            }
        }
    }

    if (depletions === 0) return 0;

    const oscillationPct = (refills / depletions) * 100;

    // Normalize: > 50% is ideal, < 30% is bad
    if (oscillationPct < 30) return 0;
    return Math.min(100, oscillationPct);
}

// 📌 3. LATENCY SCORE IMPLEMENTATION
function calculateLatencyScore(history: BinSnapshot[]): number {
    if (history.length < 10) return 0;

    const refillTimes: number[] = [];
    const baselineRefillTime = 30 * 1000; // 30 seconds baseline

    // Track refill latency for each bin
    const binDepletionTimes: { [binId: number]: number } = {};

    for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1];
        const curr = history[i];

        for (const binId in curr.bins) {
            const prevLiq = prev.bins[binId]?.liquidity || 0;
            const currLiq = curr.bins[binId]?.liquidity || 0;

            // Detect depletion
            if (prevLiq > 0 && currLiq < prevLiq * 0.2) {
                binDepletionTimes[binId] = prev.timestamp;
            }

            // Detect refill
            if (binDepletionTimes[binId] && currLiq > prevLiq * 1.5) {
                const refillTime = curr.timestamp - binDepletionTimes[binId];
                refillTimes.push(refillTime);
                delete binDepletionTimes[binId];
            }
        }
    }

    if (refillTimes.length === 0) return 0;

    const avgRefillTime = refillTimes.reduce((sum, t) => sum + t, 0) / refillTimes.length;
    const latencyRatio = avgRefillTime / baselineRefillTime;

    // Ideal: > 1.5 (slow LPs = easy money)
    // Normalize to 0-100
    if (latencyRatio < 1.0) return 0;
    return Math.min(100, (latencyRatio / 3.0) * 100); // Cap at 3x baseline = 100 score
}

// 📌 4. WHALE IMPACT IMPLEMENTATION
function calculateWhaleImpact(history: BinSnapshot[]): number {
    if (history.length < 5) return 0;

    let maxBinsCrossed = 0;

    for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1];
        const curr = history[i];

        // Detect large bin movements (whale swaps)
        const binsCrossed = Math.abs(curr.activeBin - prev.activeBin);

        if (binsCrossed > maxBinsCrossed) {
            maxBinsCrossed = binsCrossed;
        }
    }

    // Interpretation:
    // 2–5 = normal volatility
    // 6–9 = dangerous directional
    // 10+ = do not enter
    return maxBinsCrossed;
}

// 📌 5. CROWD SCORE IMPLEMENTATION
function calculateCrowdScore(history: BinSnapshot[]): number {
    if (history.length === 0) return 0;

    // Use recent snapshots (last 60 seconds worth)
    const timeWindow = 60 * 1000;
    const latestTimestamp = history[history.length - 1].timestamp;
    const recentSnapshots = history.filter(h => latestTimestamp - h.timestamp <= timeWindow);

    if (recentSnapshots.length === 0) return 0;

    // Count unique swap events across bins (proxy for unique wallets)
    let totalSwaps = 0;

    for (const snapshot of recentSnapshots) {
        for (const binId in snapshot.bins) {
            totalSwaps += snapshot.bins[binId].swaps || 0;
        }
    }

    // Estimate unique wallets (rough proxy: swaps / 2)
    const estimatedWallets = Math.ceil(totalSwaps / 2);

    // Interpretation:
    // 0–3 wallets = avoid
    // 20+ = excellent
    return estimatedWallets;
}

export function scoreBinDistribution(telemetry: DLMMTelemetry): BinScore {
    // TODO: Score bin distribution based on concentration, balance, depth, spread
    throw new Error('Not implemented');
}

export function calculateConcentrationScore(telemetry: DLMMTelemetry): number {
    // TODO: Measure liquidity concentration around active bin
    throw new Error('Not implemented');
}

export function calculateBalanceScore(telemetry: DLMMTelemetry): number {
    // TODO: Measure X/Y token balance in bins
    throw new Error('Not implemented');
}

export function calculateDepthScore(telemetry: DLMMTelemetry): number {
    // TODO: Measure liquidity depth across bins
    throw new Error('Not implemented');
}

export function calculateSpreadScore(telemetry: DLMMTelemetry): number {
    // TODO: Measure bin spread and distribution
    throw new Error('Not implemented');
}
