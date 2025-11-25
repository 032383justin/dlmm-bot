import { Pool } from './normalizePools';
import { DLMMTelemetry, BinSnapshot } from './dlmmTelemetry';
import { BinScore } from './binScoring';
import { ExitDecision } from './structuralExit';

export interface KillSwitchSignal {
    triggered: boolean;
    reason: string;
    severity: 'warning' | 'critical' | 'emergency';
}

export interface KillDecision {
    killAll: boolean;
    reason: string;
}

export function evaluateKill(snapshotHistory: BinSnapshot[], positions: any[]): KillDecision {
    // 🚨 KILL SWITCH: Detect catastrophic market-wide structural breakdown
    // When triggered: Close ALL positions immediately, stop scanning, pause 10-30 minutes
    // You do NOT: wait, scale down, hedge, DCA, "let AI decide" — You leave.

    // Convert array to Record format for helper functions
    const historyRecord: Record<string, BinSnapshot[]> = {};

    // Group snapshots by pool (if we have pool info in snapshots)
    // For now, treat all snapshots as one pool group for global detection
    historyRecord['global'] = snapshotHistory;

    // 1️⃣ Many pools exiting simultaneously
    // If 3+ pools trigger exit within 120 seconds → market-wide collapse
    if (detectMultipleExits(historyRecord, 3, 120)) {
        return { killAll: true, reason: "Multiple pool exit cascade" };
    }

    // 2️⃣ Oscillation dead everywhere
    // If global oscillation < 20 → trending market, not oscillating
    if (detectGlobalOscillation(historyRecord, 20)) {
        return { killAll: true, reason: "Global oscillation collapse" };
    }

    // 3️⃣ Whale regime
    // If 8+ bins crossed in 2+ pools → coordinated whale attack
    if (detectWhaleRegime(historyRecord, 8, 2)) {
        return { killAll: true, reason: "Global whale sweep" };
    }

    // 4️⃣ LP migration trap
    // If 30%+ liquidity left across pools → LP exodus
    if (detectGlobalLPMigration(historyRecord, 0.30)) {
        return { killAll: true, reason: "LP system migration trap" };
    }

    // 5️⃣ Telemetry anomalies
    // If 10+ snapshots missing in 300 seconds → data unreliable
    if (detectTelemetryAnomalies(historyRecord, 10, 300)) {
        return { killAll: true, reason: "Telemetry unreliable" };
    }

    // ✅ No catastrophic patterns detected
    return { killAll: false, reason: "" };
}

// 1️⃣ Detect multiple pool exits in short timeframe
function detectMultipleExits(
    historyRecord: Record<string, BinSnapshot[]>,
    minExits: number,
    timeWindowSeconds: number
): boolean {
    // Count pools with recent structural breakdown
    let exitCount = 0;
    const now = Date.now();
    const timeWindow = timeWindowSeconds * 1000;

    for (const poolId in historyRecord) {
        const history = historyRecord[poolId];
        if (history.length < 5) continue;

        const recentSnapshots = history.filter(s => now - s.timestamp <= timeWindow);

        // Check if oscillation collapsed recently
        let oscillationFailed = false;
        for (const snapshot of recentSnapshots) {
            // Simplified check: if bins are emptying rapidly
            let emptyBins = 0;
            for (const binId in snapshot.bins) {
                if ((snapshot.bins[binId]?.liquidity || 0) < 100) {
                    emptyBins++;
                }
            }
            if (emptyBins > Object.keys(snapshot.bins).length * 0.5) {
                oscillationFailed = true;
                break;
            }
        }

        if (oscillationFailed) exitCount++;
    }

    return exitCount >= minExits;
}

// 2️⃣ Detect global oscillation collapse
function detectGlobalOscillation(
    historyRecord: Record<string, BinSnapshot[]>,
    minOscillation: number
): boolean {
    // Check if oscillation is dead across all pools
    let totalPools = 0;
    let deadPools = 0;

    for (const poolId in historyRecord) {
        const history = historyRecord[poolId];
        if (history.length < 15) continue;

        totalPools++;

        // Simplified oscillation check: bins refilling after depletion
        const recentHistory = history.slice(-15);
        let refills = 0;
        let depletions = 0;

        for (let i = 1; i < recentHistory.length; i++) {
            const prev = recentHistory[i - 1];
            const curr = recentHistory[i];

            for (const binId in curr.bins) {
                const prevLiq = prev.bins[binId]?.liquidity || 0;
                const currLiq = curr.bins[binId]?.liquidity || 0;

                if (prevLiq > 0 && currLiq < prevLiq * 0.2) depletions++;
                if (prevLiq < currLiq * 0.5 && currLiq > 0) refills++;
            }
        }

        const oscillationRate = depletions > 0 ? (refills / depletions) * 100 : 0;
        if (oscillationRate < minOscillation) deadPools++;
    }

    // If 80%+ pools have dead oscillation → global collapse
    return totalPools > 0 && (deadPools / totalPools) >= 0.8;
}

// 3️⃣ Detect whale regime (coordinated large swaps)
function detectWhaleRegime(
    historyRecord: Record<string, BinSnapshot[]>,
    minBinsCrossed: number,
    minPools: number
): boolean {
    let affectedPools = 0;

    for (const poolId in historyRecord) {
        const history = historyRecord[poolId];
        if (history.length < 5) continue;

        // Check for large bin movements
        for (let i = 1; i < history.length; i++) {
            const binsCrossed = Math.abs(history[i].activeBin - history[i - 1].activeBin);
            if (binsCrossed >= minBinsCrossed) {
                affectedPools++;
                break;
            }
        }
    }

    return affectedPools >= minPools;
}

// 4️⃣ Detect global LP migration
function detectGlobalLPMigration(
    historyRecord: Record<string, BinSnapshot[]>,
    minMigrationRate: number
): boolean {
    let totalPools = 0;
    let migratingPools = 0;

    for (const poolId in historyRecord) {
        const history = historyRecord[poolId];
        if (history.length < 10) continue;

        totalPools++;

        // Compare liquidity now vs 10 snapshots ago
        const current = history[history.length - 1];
        const old = history[history.length - 10];

        let currentLiq = 0;
        let oldLiq = 0;

        for (const binId in current.bins) {
            currentLiq += current.bins[binId]?.liquidity || 0;
        }
        for (const binId in old.bins) {
            oldLiq += old.bins[binId]?.liquidity || 0;
        }

        if (oldLiq > 0) {
            const migrationRate = (oldLiq - currentLiq) / oldLiq;
            if (migrationRate >= minMigrationRate) migratingPools++;
        }
    }

    // If 50%+ pools losing liquidity → LP exodus
    return totalPools > 0 && (migratingPools / totalPools) >= 0.5;
}

// 5️⃣ Detect telemetry anomalies
function detectTelemetryAnomalies(
    historyRecord: Record<string, BinSnapshot[]>,
    minMissingSnapshots: number,
    timeWindowSeconds: number
): boolean {
    const now = Date.now();
    const timeWindow = timeWindowSeconds * 1000;

    for (const poolId in historyRecord) {
        const history = historyRecord[poolId];

        // Count expected vs actual snapshots in time window
        const recentSnapshots = history.filter(s => now - s.timestamp <= timeWindow);

        // Expect 1 snapshot every 5-10 seconds
        const expectedSnapshots = timeWindowSeconds / 7; // Conservative estimate
        const missingSnapshots = expectedSnapshots - recentSnapshots.length;

        if (missingSnapshots >= minMissingSnapshots) {
            return true; // Data feed is broken
        }
    }

    return false;
}

export function checkKillSwitch(
    pool: Pool,
    telemetry: DLMMTelemetry,
    binScore: BinScore
): KillSwitchSignal {
    // TODO: Check for catastrophic structural breakdown
    throw new Error('Not implemented');
}

export function detectBinCollapse(telemetry: DLMMTelemetry): boolean {
    // TODO: Detect bin structure collapse
    throw new Error('Not implemented');
}

export function detectLiquidityCrisis(telemetry: DLMMTelemetry): boolean {
    // TODO: Detect critical liquidity crisis
    throw new Error('Not implemented');
}

export function detectAnomalousActivity(
    currentTelemetry: DLMMTelemetry,
    historicalTelemetry: DLMMTelemetry[]
): boolean {
    // TODO: Detect anomalous bin activity patterns
    throw new Error('Not implemented');
}
