/**
 * Raydium DLMM On-Chain Decoder
 * 
 * 🧠 CRITICAL UNDERSTANDING:
 * You never decode DLMM from "price APIs".
 * You read the pool accounts on-chain.
 * 
 * 🔐 ENEMY #1: AI hallucination
 * ❌ Do not derive price data
 * ❌ Do not call Raydium REST APIs
 * ❌ Do not use Candles
 * ❌ Do not "guess bin ranges"
 * ❌ Do not strip decimals from liquidity
 * ❌ Do not convert BN to float until AFTER scoring
 * 
 * If you don't force this — it will hallucinate ruin.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { Program, Idl, BN, AnchorProvider } from '@coral-xyz/anchor';
import { getRecentSwapEvents } from './swapParser';

// 📦 STEP 1 — Raydium DLMM Program ID (HARDCODED)
// You MUST hardcode this constant. AI should NOT "search for it".
const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// 📋 STEP 3 — Raydium DLMM IDL
export const RAYDIUM_DLMM_IDL: Idl = {
    "version": "0.1.0",
    "name": "raydium_dlmm",
    "instructions": [],
    "accounts": [
        {
            "name": "pool",
            "type": {
                "kind": "struct",
                "fields": [
                    { "name": "activeBin", "type": "u32" },
                    { "name": "binStep", "type": "u16" },
                    { "name": "maxBinStep", "type": "u16" },
                    { "name": "baseFeeBps", "type": "u16" },
                    { "name": "protocolFeeBps", "type": "u16" },
                    { "name": "liquidity", "type": "u128" },
                    { "name": "bins", "type": { "vec": { "defined": "Bin" } } }
                ]
            }
        },
        {
            "name": "Bin",
            "type": {
                "kind": "struct",
                "fields": [
                    { "name": "binId", "type": "u32" },
                    { "name": "liquidity", "type": "u128" }
                ]
            }
        }
    ]
} as any;

// 🔧 Get RPC connection
function getConnection(): Connection {
    const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    return new Connection(rpcUrl, 'confirmed');
}

// 🧠 STEP 5 — Actual decode function
export async function getDLMMState(poolAddress: string) {
    const connection = getConnection();
    const poolPk = new PublicKey(poolAddress);
    const provider = new AnchorProvider(connection, {} as any, {});
    const program = new Program(RAYDIUM_DLMM_IDL, provider);

    // Fetch pool state from on-chain account
    const poolState = await (program.account as any).pool.fetch(poolPk);

    const activeBin = (poolState as any).activeBin;
    const binStep = (poolState as any).binStep;

    // Map all bins (Raydium gives vector of all bins ever used)
    const allBins = ((poolState as any).bins || []).map((b: any) => ({
        id: b.binId,
        liquidity: Number(b.liquidity.toString()) // Convert BN to number ONLY here
    }));

    return { activeBin, binStep, bins: allBins };
}

// 🔥 STEP 6 — Filter local bins (±3 or ±5)
// 📦 STEP 4 — Bin range extraction
// Raydium doesn't give "just the bins around active".
// It gives a vector of all bins ever used.
// We only care about: active - 5 → active + 5
// Not performance-intensive. And it keeps your Supabase costs sane.
export function extractLocalBins(
    bins: { id: number; liquidity: number }[],
    activeBin: number,
    radius: number = 3
) {
    // 🔐 DO NOT store full vector in DB
    // You will get 900+ bins on older pools. That will cripple Supabase.
    // Store only local bins around active.
    return bins.filter(b => b.id >= activeBin - radius && b.id <= activeBin + radius);
}

// 📦 STEP 7 — Add swaps in telemetry (STUB)
// This is where everyone screws up.
// You don't parse "price swaps". You parse bin crossing events.
// We look for: which bin IDs were crossed, swaps per minute, total liquidity removed
export async function getBinSwaps(poolAddress: string, since: number): Promise<Map<number, number>> {
    // TODO: get signatures, decode swap logs, count bins crossed
    // For now, return empty map (will be implemented when log format is provided)
    return new Map();
}

// 🔥 STEP 8 — Refill latency
// Latency = LP's inability to fix chaos.
// Two snapshots:
// T1: bin 17 liquidity = 800
// T2: bin 17 liquidity = 0
// T3: bin 17 back to 400
// Latency = T3 - T2
// Store per bin per cycle.
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

// 🔥 STEP 9 — Construct the actual telemetry result
// Return EXACT shape. If a field isn't known → return null or 0. Never "approximate".
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

// 🎯 Main function: Get complete bin snapshot with telemetry
export async function getBinSnapshot(
    poolAddress: string,
    previousSnapshot?: BinSnapshot
): Promise<BinSnapshot> {
    const timestamp = Date.now();

    // Get raw DLMM state from on-chain
    const { activeBin, bins: allBins } = await getDLMMState(poolAddress);

    // Filter to local bins only (activeBin ± 3)
    const localBins = extractLocalBins(allBins, activeBin, 3);

    // Get swap data (stub for now)
    const swapsMap = await getBinSwaps(poolAddress, timestamp - 60000); // Last 60 seconds

    // Build bin snapshot with exact structure
    const bins: BinSnapshot['bins'] = {};

    for (const bin of localBins) {
        const previousLiquidity = previousSnapshot?.bins[bin.id]?.liquidity || 0;

        bins[bin.id] = {
            liquidity: bin.liquidity, // Already converted from BN
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

    return {
        timestamp,
        activeBin,
        bins
    };
}

// 🎯 Legacy function wrappers for compatibility
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
