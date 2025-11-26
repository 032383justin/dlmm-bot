/**
 * DLMM Swap Log Parser
 * 
 * 🚨 IMPORTANT:
 * We do not decode price. We decode bin movement.
 * Price is a side effect of liquidity distribution.
 * DLMM bins are the ground truth.
 * 
 * If you decode swaps → You know which bins died → You know where to enter/exit.
 */

import { Connection, PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from '@solana/web3.js';

// 📦 What we extract per swap (STEP 6)
export interface SwapEvent {
    wallet: string;
    fromBin: number;
    toBin: number;
    binsCrossed: number;
    liquidityUsed: number;
    timestamp: number;
    signature: string; // Extra field for tracking
}

// 🔧 Get RPC connection
function getConnection(): Connection {
    const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    return new Connection(rpcUrl, 'confirmed');
}

// 🧠 STEP 7 — Actual decoder function
// Simplified, robust pattern matching for swap events
export function decodeSwapEvent(logs: string[], wallet: string, timestamp: number): SwapEvent | null {
    let fromBin: number | null = null;
    let toBin: number | null = null;
    let liquidity = 0;

    for (const line of logs) {
        // Extract fromBin (activeBin or starting bin)
        if (/active|from/i.test(line)) {
            const num = line.match(/\d+/);
            if (num) fromBin = parseInt(num[0]);
        }

        // Extract toBin (target bin or crossed bin)
        if (/cross|to|bin moved/i.test(line)) {
            const num = line.match(/\d+/);
            if (num) toBin = parseInt(num[0]);
        }

        // Extract liquidity consumed
        if (/liquid/i.test(line)) {
            const num = line.match(/\d+/);
            if (num) liquidity = parseInt(num[0]);
        }
    }

    if (fromBin === null || toBin === null) return null;

    return {
        wallet,
        fromBin,
        toBin,
        binsCrossed: Math.abs(toBin - fromBin),
        liquidityUsed: liquidity,
        timestamp,
        signature: '' // Will be filled by caller
    };
}

// Legacy parseSwapLogs (kept for compatibility, uses decodeSwapEvent internally)
function parseSwapLogs(logs: string[]): { fromBin: number; toBin: number; liquidityUsed: number } | null {
    const result = decodeSwapEvent(logs, 'unknown', Date.now());
    if (!result) return null;
    return { fromBin: result.fromBin, toBin: result.toBin, liquidityUsed: result.liquidityUsed };
}

// 🎯 Parse a single transaction for swap events
export async function parseSwapTransaction(
    connection: Connection,
    signature: string,
    poolAddress: string
): Promise<SwapEvent | null> {
    try {
        const tx = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0
        });

        if (!tx || !tx.meta || !tx.meta.logMessages) {
            return null;
        }

        // Parse logs for bin movement
        const binMovement = parseSwapLogs(tx.meta.logMessages);
        if (!binMovement) {
            return null;
        }

        // Extract wallet (fee payer)
        const wallet = tx.transaction.message.accountKeys[0]?.pubkey.toString() || 'unknown';

        // Calculate bins crossed
        const binsCrossed = Math.abs(binMovement.toBin - binMovement.fromBin);

        // Timestamp (block time)
        const timestamp = tx.blockTime ? tx.blockTime * 1000 : Date.now();

        // Liquidity used from logs
        const liquidityUsed = binMovement.liquidityUsed;

        return {
            wallet,
            fromBin: binMovement.fromBin,
            toBin: binMovement.toBin,
            binsCrossed,
            liquidityUsed,
            timestamp,
            signature
        };
    } catch (error) {
        console.error(`Failed to parse swap transaction ${signature}:`, error);
        return null;
    }
}

// 🔍 Get recent swap events for a pool
export async function getRecentSwapEvents(
    poolAddress: string,
    timeframeSeconds: number = 300 // Default 5 minutes
): Promise<SwapEvent[]> {
    const connection = getConnection();
    const poolPubkey = new PublicKey(poolAddress);

    try {
        // Get recent signatures for the pool
        const signatures = await connection.getSignaturesForAddress(poolPubkey, {
            limit: 100 // Adjust based on activity
        });

        const cutoffTime = Date.now() - (timeframeSeconds * 1000);
        const recentSignatures = signatures.filter(sig => {
            return sig.blockTime && (sig.blockTime * 1000) >= cutoffTime;
        });

        // Parse each transaction
        const swapEvents: SwapEvent[] = [];
        for (const sig of recentSignatures) {
            const swapEvent = await parseSwapTransaction(connection, sig.signature, poolAddress);
            if (swapEvent) {
                swapEvents.push(swapEvent);
            }
        }

        return swapEvents;
    } catch (error) {
        console.error(`Failed to get swap events for pool ${poolAddress}:`, error);
        return [];
    }
}

// 📊 Aggregate swap metrics for bin scoring
export interface SwapMetrics {
    totalSwaps: number;
    uniqueWallets: Set<string>;
    maxBinsCrossed: number;
    avgBinsCrossed: number;
    swapsPerBin: Map<number, number>; // binId -> swap count
    directionality: number; // -1 to 1 (net direction)
}

export function aggregateSwapMetrics(swapEvents: SwapEvent[]): SwapMetrics {
    const uniqueWallets = new Set<string>();
    const swapsPerBin = new Map<number, number>();
    let maxBinsCrossed = 0;
    let totalBinsCrossed = 0;
    let netDirection = 0;

    for (const swap of swapEvents) {
        uniqueWallets.add(swap.wallet);
        maxBinsCrossed = Math.max(maxBinsCrossed, swap.binsCrossed);
        totalBinsCrossed += swap.binsCrossed;

        // Track direction (positive = upward, negative = downward)
        netDirection += (swap.toBin - swap.fromBin);

        // Count swaps per bin (all bins crossed)
        const minBin = Math.min(swap.fromBin, swap.toBin);
        const maxBin = Math.max(swap.fromBin, swap.toBin);

        for (let binId = minBin; binId <= maxBin; binId++) {
            swapsPerBin.set(binId, (swapsPerBin.get(binId) || 0) + 1);
        }
    }

    const avgBinsCrossed = swapEvents.length > 0 ? totalBinsCrossed / swapEvents.length : 0;

    // Normalize directionality to -1 to 1
    const directionality = swapEvents.length > 0
        ? Math.max(-1, Math.min(1, netDirection / (swapEvents.length * 10)))
        : 0;

    return {
        totalSwaps: swapEvents.length,
        uniqueWallets,
        maxBinsCrossed,
        avgBinsCrossed,
        swapsPerBin,
        directionality
    };
}

// 🎯 This lets us measure:
// - whale sweeps (maxBinsCrossed)
// - micro-oscillations (avgBinsCrossed)
// - directionality (net direction)
// - unique wallet flows (uniqueWallets.size)
//
// That's it. No price, no candles, no TA.
