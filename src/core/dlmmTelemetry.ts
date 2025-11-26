import { Pool } from './normalizePools';

export interface BinData {
    binId: number;
    priceX: number;
    priceY: number;
    liquidityX: number;
    liquidityY: number;
    supply: number;
}

export interface DLMMTelemetry {
    poolAddress: string;
    activeBin: number;
    bins: BinData[];
    totalLiquidity: number;
    binCount: number;
    timestamp: number;
}

export interface BinSnapshot {
    timestamp: number;
    activeBin: number;
    bins: {
        [binId: number]: {
            liquidity: number;
            swaps: number;
            refillTimeMs: number;
        };
    };
}

/**
 * EnrichedSnapshot - Extended snapshot with computed microstructure metrics.
 * Used for transition-based scoring in scorePool.ts
 */
export interface EnrichedSnapshot {
    timestamp: number;
    activeBin: number;
    
    // Computed metrics for transition scoring
    liquidity: number;      // Total liquidity across all bins
    velocity: number;       // Δ liquidity over time (computed from history)
    entropy: number;        // Shannon entropy of bin distribution
    binCount: number;       // Number of active bins with liquidity
    
    // Migration detection
    migrationDirection: 'in' | 'out' | 'stable';  // Liquidity moving toward/away from center
    
    // Raw bin data preserved for structural analysis
    bins: {
        [binId: number]: {
            liquidity: number;
            swaps: number;
            refillTimeMs: number;
        };
    };
}

/**
 * Calculate Shannon entropy of bin liquidity distribution.
 * H = -Σ(pᵢ * log(pᵢ)) where pᵢ = binLiquidity[i] / totalLiquidity
 * 
 * High entropy (>0.65) = evenly distributed liquidity = healthy price discovery
 * Low entropy (<0.45) = concentrated liquidity = potential manipulation risk
 */
export function calculateBinEntropy(bins: { [binId: number]: { liquidity: number } }): number {
    const binIds = Object.keys(bins).map(Number);
    if (binIds.length === 0) return 0;
    
    // Calculate total liquidity
    let totalLiquidity = 0;
    for (const binId of binIds) {
        totalLiquidity += bins[binId].liquidity;
    }
    
    if (totalLiquidity === 0) return 0;
    
    // Calculate Shannon entropy
    let entropy = 0;
    for (const binId of binIds) {
        const p = bins[binId].liquidity / totalLiquidity;
        if (p > 0) {
            entropy -= p * Math.log2(p);
        }
    }
    
    // Normalize to 0-1 range based on max possible entropy (log2(n) for n bins)
    const maxEntropy = Math.log2(binIds.length);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/**
 * Detect liquidity migration direction relative to active bin.
 * 'in' = liquidity moving toward center (bullish for LP)
 * 'out' = liquidity moving away from center (bearish for LP)
 * 'stable' = no significant migration
 */
export function detectMigrationDirection(
    bins: { [binId: number]: { liquidity: number } },
    activeBin: number,
    previousBins?: { [binId: number]: { liquidity: number } }
): 'in' | 'out' | 'stable' {
    if (!previousBins) return 'stable';
    
    const binIds = Object.keys(bins).map(Number);
    
    let centerLiquidityChange = 0;
    let outerLiquidityChange = 0;
    
    for (const binId of binIds) {
        const currentLiq = bins[binId]?.liquidity || 0;
        const prevLiq = previousBins[binId]?.liquidity || 0;
        const delta = currentLiq - prevLiq;
        
        // Center bins: within ±2 of active bin
        const distanceFromActive = Math.abs(binId - activeBin);
        if (distanceFromActive <= 2) {
            centerLiquidityChange += delta;
        } else {
            outerLiquidityChange += delta;
        }
    }
    
    // Significant threshold: 5% of total change
    const totalChange = Math.abs(centerLiquidityChange) + Math.abs(outerLiquidityChange);
    if (totalChange === 0) return 'stable';
    
    const centerRatio = centerLiquidityChange / totalChange;
    
    if (centerRatio > 0.2) return 'in';
    if (centerRatio < -0.2) return 'out';
    return 'stable';
}

/**
 * Compute velocity (rate of liquidity change) from two snapshots.
 */
export function computeVelocity(
    currentLiquidity: number,
    previousLiquidity: number,
    timeDeltaMs: number
): number {
    if (timeDeltaMs <= 0 || previousLiquidity === 0) return 0;
    
    // Velocity = absolute change per second, scaled
    const changePerSecond = Math.abs(currentLiquidity - previousLiquidity) / (timeDeltaMs / 1000);
    return changePerSecond;
}

export async function getDLMMState(poolId: string): Promise<BinSnapshot> {
    // 🧨 STEP 9 — Integrate swap events into telemetry
    // Import from raydium service which has the actual on-chain decoder
    const { getBinSnapshot } = await import('../services/raydium');
    const { getRecentSwapEvents } = await import('../services/swapParser');

    // Get base bin snapshot from on-chain data
    const snapshot = await getBinSnapshot(poolId);

    // Get recent swap events (last 60 seconds)
    const swapEvents = await getRecentSwapEvents(poolId, 60);

    // 🔥 STEP 8 — Track high sweeps and integrate into bins
    for (const swap of swapEvents) {
        // Increment swap count for all bins crossed
        const minBin = Math.min(swap.fromBin, swap.toBin);
        const maxBin = Math.max(swap.fromBin, swap.toBin);

        for (let binId = minBin; binId <= maxBin; binId++) {
            if (snapshot.bins[binId]) {
                // Increment swap counter
                snapshot.bins[binId].swaps++;

                // Reduce liquidity by amount consumed (if available)
                if (swap.liquidityUsed > 0) {
                    snapshot.bins[binId].liquidity -= swap.liquidityUsed;
                    // Ensure liquidity doesn't go negative
                    snapshot.bins[binId].liquidity = Math.max(0, snapshot.bins[binId].liquidity);
                }
            }
        }
    }

    // Refill times are already computed in getBinSnapshot()
    return snapshot;
}

/**
 * Get enriched DLMM state with computed microstructure metrics.
 * This is the main entry point for transition-based scoring.
 */
export async function getEnrichedDLMMState(
    poolId: string,
    previousSnapshot?: EnrichedSnapshot
): Promise<EnrichedSnapshot> {
    const timestamp = Date.now();
    
    // Get base bin snapshot
    const baseSnapshot = await getDLMMState(poolId);
    
    // Calculate total liquidity across all bins
    let totalLiquidity = 0;
    const binIds = Object.keys(baseSnapshot.bins).map(Number);
    for (const binId of binIds) {
        totalLiquidity += baseSnapshot.bins[binId].liquidity;
    }
    
    // Calculate entropy
    const entropy = calculateBinEntropy(baseSnapshot.bins);
    
    // Calculate velocity from previous snapshot
    let velocity = 0;
    if (previousSnapshot) {
        const timeDelta = timestamp - previousSnapshot.timestamp;
        velocity = computeVelocity(totalLiquidity, previousSnapshot.liquidity, timeDelta);
    }
    
    // Detect migration direction
    const migrationDirection = detectMigrationDirection(
        baseSnapshot.bins,
        baseSnapshot.activeBin,
        previousSnapshot?.bins
    );
    
    // Count active bins (bins with non-zero liquidity)
    const binCount = binIds.filter(id => baseSnapshot.bins[id].liquidity > 0).length;
    
    return {
        timestamp,
        activeBin: baseSnapshot.activeBin,
        liquidity: totalLiquidity,
        velocity,
        entropy,
        binCount,
        migrationDirection,
        bins: baseSnapshot.bins
    };
}

export async function fetchDLMMTelemetry(poolAddress: string): Promise<DLMMTelemetry | null> {
    // TODO: Fetch bin data from Meteora DLMM API
    throw new Error('Not implemented');
}

export async function analyzeBinDistribution(telemetry: DLMMTelemetry): Promise<any> {
    // TODO: Analyze bin distribution patterns
    throw new Error('Not implemented');
}
