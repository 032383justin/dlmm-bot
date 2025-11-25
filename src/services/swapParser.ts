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

// 🧠 STEP 1 — Parse swap program logs
// Raydium DLMM swap instructions emit log strings like:
// "Program log: swap: bin moved from X to Y"
// Or legacy formats:
// "Instruction: Swap"
// "activeBin: 177"
// "cross to: 173"
// 
// Different pools format differently. Parser must match substrings, not strict equality.
function parseSwapLogs(logs: string[]): { fromBin: number; toBin: number } | null {
    let fromBin: number | null = null;
    let toBin: number | null = null;

    for (let i = 0; i < logs.length; i++) {
        const log = logs[i];

        // Format 1: "Program log: swap: bin moved from X to Y"
        const movedMatch = log.match(/bin moved from (\d+) to (\d+)/i);
        if (movedMatch) {
            fromBin = parseInt(movedMatch[1]);
            toBin = parseInt(movedMatch[2]);
            break;
        }

        // Format 2: "swap: from X to Y"
        const swapMatch = log.match(/swap.*from (\d+) to (\d+)/i);
        if (swapMatch) {
            fromBin = parseInt(swapMatch[1]);
            toBin = parseInt(swapMatch[2]);
            break;
        }

        // Format 3: Legacy format with separate lines
        // "activeBin: 177" followed by "cross to: 173"
        const activeBinMatch = log.match(/activeBin[:\s]+(\d+)/i);
        if (activeBinMatch) {
            fromBin = parseInt(activeBinMatch[1]);

            // Look ahead for "cross to" in next few lines
            for (let j = i + 1; j < Math.min(i + 5, logs.length); j++) {
                const crossMatch = logs[j].match(/cross to[:\s]+(\d+)/i);
                if (crossMatch) {
                    toBin = parseInt(crossMatch[1]);
                    break;
                }
            }

            if (toBin !== null) break;
        }

        // Format 4: "bin: X -> Y"
        const arrowMatch = log.match(/bin[:\s]+(\d+)\s*->\s*(\d+)/i);
        if (arrowMatch) {
            fromBin = parseInt(arrowMatch[1]);
            toBin = parseInt(arrowMatch[2]);
            break;
        }
    }

    if (fromBin !== null && toBin !== null) {
        return { fromBin, toBin };
    }

    return null;
}

// 🎯 Parse a single transaction for swap events
async function parseSwapTransaction(
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

        // TODO: Calculate liquidityUsed from bin data
        // This requires fetching bin liquidity at the time of swap
        const liquidityUsed = 0;

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
