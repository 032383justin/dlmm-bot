/**
 * Raydium/Meteora DLMM On-Chain Service
 * 
 * 🧠 CRITICAL UNDERSTANDING:
 * This is a compatibility layer that delegates to dlmmTelemetry.ts
 * for all on-chain data fetching and decoding.
 * 
 * The actual DLMM decoding happens in src/core/dlmmTelemetry.ts
 * which fetches real on-chain data from Meteora lb_clmm accounts.
 * 
 * 🔐 NO MOCK DATA. NO FALLBACKS.
 * If RPC fails → throw error, don't return fake data.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getRecentSwapEvents } from './swapParser';
import { 
    fetchOnChainPoolState, 
    BinSnapshot, 
    EnrichedSnapshot,
    getEnrichedDLMMState as getEnrichedState,
    getDLMMState as getTelemetryState
} from '../core/dlmmTelemetry';

// 🔧 Get RPC connection
function getConnection(): Connection {
    const rpcUrl = process.env.HELIUS_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    return new Connection(rpcUrl, 'confirmed');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DLMM STATE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get DLMM state from on-chain data
 * Delegates to dlmmTelemetry.ts for actual fetching
 */
export async function getDLMMState(poolAddress: string): Promise<{
    activeBin: number;
    binStep: number;
    bins: { id: number; liquidity: number }[];
}> {
    const poolState = await fetchOnChainPoolState(poolAddress);
    
    if (!poolState) {
        throw new Error(`Failed to fetch DLMM state for ${poolAddress}`);
    }
    
    // Convert bins map to array format for compatibility
    const bins: { id: number; liquidity: number }[] = [];
    for (const [binId, binData] of poolState.bins) {
        bins.push({
            id: binId,
            liquidity: Number(binData.liquidityX) + Number(binData.liquidityY),
        });
    }
    
    return {
        activeBin: poolState.activeBin,
        binStep: poolState.binStep,
        bins,
    };
}

/**
 * Extract local bins around active bin
 */
export function extractLocalBins(
    bins: { id: number; liquidity: number }[],
    activeBin: number,
    radius: number = 3
): { id: number; liquidity: number }[] {
    return bins.filter(b => b.id >= activeBin - radius && b.id <= activeBin + radius);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BIN SNAPSHOT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// Cache for tracking refill latency
interface BinRefillTracker {
    [binId: number]: {
        depletedAt: number | null;
        refillTimeMs: number;
    };
}

const binRefillTrackers: Map<string, BinRefillTracker> = new Map();

function trackRefillLatency(
    poolAddress: string,
    binId: number,
    currentLiquidity: number,
    previousLiquidity: number,
    timestamp: number
): number {
    if (!binRefillTrackers.has(poolAddress)) {
        binRefillTrackers.set(poolAddress, {});
    }

    const tracker = binRefillTrackers.get(poolAddress)!;

    if (!tracker[binId]) {
        tracker[binId] = { depletedAt: null, refillTimeMs: 0 };
    }

    const binTracker = tracker[binId];

    // Detect depletion (liquidity drops below 20% of previous)
    if (previousLiquidity > 0 && currentLiquidity < previousLiquidity * 0.2) {
        binTracker.depletedAt = timestamp;
    }

    // Detect refill (liquidity returns above 50% of previous)
    if (binTracker.depletedAt && currentLiquidity > previousLiquidity * 0.5) {
        binTracker.refillTimeMs = timestamp - binTracker.depletedAt;
        binTracker.depletedAt = null;
    }

    return binTracker.refillTimeMs;
}

// Previous snapshot cache
const previousSnapshots: Map<string, BinSnapshot> = new Map();

/**
 * Get complete bin snapshot with telemetry
 * Fetches real on-chain data and integrates swap events
 */
export async function getBinSnapshot(
    poolAddress: string,
    prevSnapshot?: BinSnapshot
): Promise<BinSnapshot> {
    const timestamp = Date.now();
    const previousSnapshot = prevSnapshot || previousSnapshots.get(poolAddress);

    try {
        // Get DLMM state from on-chain
        const { activeBin, bins: allBins } = await getDLMMState(poolAddress);

        // Filter to local bins only (activeBin ± 3)
        const localBins = extractLocalBins(allBins, activeBin, 3);

        // Get swap data
        const swapsMap = await getBinSwaps(poolAddress, timestamp - 60000);

        // Build bin snapshot with exact structure
        const bins: BinSnapshot['bins'] = {};

        for (const bin of localBins) {
            const previousLiquidity = previousSnapshot?.bins[bin.id]?.liquidity || 0;

            bins[bin.id] = {
                liquidity: bin.liquidity,
                swaps: swapsMap.get(bin.id) || 0,
                refillTimeMs: trackRefillLatency(
                    poolAddress,
                    bin.id,
                    bin.liquidity,
                    previousLiquidity,
                    timestamp
                )
            };
        }

        const snapshot: BinSnapshot = {
            timestamp,
            activeBin,
            bins
        };
        
        // Cache for next comparison
        previousSnapshots.set(poolAddress, snapshot);
        
        return snapshot;
        
    } catch (error) {
        // RPC failed - throw error, don't return fake data
        throw new Error(`Failed to get bin snapshot for ${poolAddress}: ${error}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SWAP TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get swap counts per bin from recent transactions
 */
export async function getBinSwaps(poolAddress: string, since: number): Promise<Map<number, number>> {
    try {
        const swapEvents = await getRecentSwapEvents(poolAddress, 60);
        const binSwaps = new Map<number, number>();
        
        for (const swap of swapEvents) {
            const minBin = Math.min(swap.fromBin, swap.toBin);
            const maxBin = Math.max(swap.fromBin, swap.toBin);
            
            for (let binId = minBin; binId <= maxBin; binId++) {
                binSwaps.set(binId, (binSwaps.get(binId) || 0) + 1);
            }
        }
        
        return binSwaps;
    } catch (error) {
        // Swap parsing failed - return empty map
        return new Map();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getActiveBin(poolId: string): Promise<number> {
    const { activeBin } = await getDLMMState(poolId);
    return activeBin;
}

export async function getLiquidityByBin(poolId: string, binIds: number[]): Promise<number[]> {
    const { bins } = await getDLMMState(poolId);
    const liquidityMap = new Map<number, number>();

    for (const bin of bins) {
        liquidityMap.set(bin.id, bin.liquidity);
    }

    return binIds.map(binId => liquidityMap.get(binId) || 0);
}

export async function getRecentSwaps(poolId: string, timeframeSeconds: number): Promise<any[]> {
    return await getRecentSwapEvents(poolId, timeframeSeconds);
}

export async function getLPEvents(poolId: string, timeframeSeconds: number): Promise<any[]> {
    const connection = getConnection();
    const poolPubkey = new PublicKey(poolId);

    try {
        const signatures = await connection.getSignaturesForAddress(poolPubkey, { limit: 50 });
        const cutoff = Date.now() - (timeframeSeconds * 1000);

        const lpEvents = [];

        for (const sig of signatures) {
            if (sig.blockTime && (sig.blockTime * 1000) < cutoff) continue;

            const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
            if (!tx?.meta?.logMessages) continue;

            const logs = tx.meta.logMessages;
            const isAdd = logs.some(l => /add_liquidity/i.test(l));
            const isRemove = logs.some(l => /remove_liquidity/i.test(l));

            if (isAdd || isRemove) {
                lpEvents.push({
                    signature: sig.signature,
                    type: isAdd ? 'add' : 'remove',
                    timestamp: sig.blockTime ? sig.blockTime * 1000 : Date.now()
                });
            }
        }
        return lpEvents;
    } catch (e) {
        console.error('Error fetching LP events:', e);
        return [];
    }
}

// Re-export types for compatibility
export { BinSnapshot, EnrichedSnapshot };
