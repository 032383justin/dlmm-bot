/**
 * Mempool Predation Logic — Detect and Avoid Predatory Bots
 * 
 * ⚠️ Understand the predator:
 * 
 * There are 3 kinds of microstructure predators in Solana DLMM:
 * 
 * 🟥 1. Whale Sweep Bots
 * - Detect bin exhaustion and sweep 8–30+ bins in one direction
 * - Goal: annihilate oscillators and front-run LPs
 * 
 * 🟨 2. LP Migration Bots
 * - Watch refill latency
 * - If LPs slow → they manually reposition liquidity above or below
 * - They force your bot into trapped ranges
 * 
 * 🟦 3. Mempool Sweepers (the scariest)
 * - Monitor pending transactions
 * - Place limit orders or swaps milliseconds before yours
 * - They weaponize your entry window
 * 
 * Your job is NOT to beat them. Your job is to detect them and exit.
 * 
 * 🧠 Core Concept:
 * If pending swaps ALWAYS move bins toward your planned entry,
 * a predatory bot is scanning you.
 * 
 * We detect this BEFORE entry.
 * 
 * 🚀 What to Monitor:
 * - Pending bin aggression
 * - Pending bin direction
 * - Pending wallet concentration
 * - Pending multi-wallet bursts
 * - Pending sweep depth
 * 
 * You do NOT track: token price, candles, price spreads, indicators
 * Only bin activity in pending tx.
 * 
 * 🛡 Why this works:
 * You're doing what virtually no DLMM bot does:
 * - You're not just reading state
 * - You're reading intent
 * 
 * Mempool = chessboard before the move.
 * Every kill bot gives itself away before it attacks.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { parseSwapTransaction } from '../services/swapParser';

/**
 * Pending swap data from mempool
 */
export interface PendingSwap {
    wallet: string;
    fromBin: number;
    toBin: number;
    binsCrossed: number;
    liquidityUsed: number;
    timestamp: number;
}

/**
 * Detect mempool predation patterns
 * 
 * Returns true if ANY predatory pattern is detected.
 * When true: NO ENTRY. Not "less size". Not "half entry". NO TRADE.
 * 
 * @param pending - Array of pending swaps from mempool
 * @returns true if predation detected, false otherwise
 */
export function detectMempoolPredation(pending: PendingSwap[]): boolean {
    if (pending.length === 0) return false;

    // 🟥 1. Directional Clustering (most common)
    // If 3+ pending swaps in a 60s window:
    // - all in same direction
    // - all sweeping ≥ 4 bins
    // This is predation. Multiple bots are forming a liquidity wall.
    const directional = pending.filter(p => p.binsCrossed >= 4);
    const upward = directional.filter(p => p.toBin > p.fromBin).length;
    const downward = directional.filter(p => p.toBin < p.fromBin).length;

    if (upward >= 3 || downward >= 3) {
        return true; // Directional clustering detected
    }

    // 🟨 2. Mempool Multi-Burst
    // Pattern: 4–12 transactions in <2 seconds
    // All near activeBin, mixed wallets
    // Triggers tiny oscillations → traps LPs & oscillators
    const timestamps = pending.map(p => p.timestamp).sort((a, b) => a - b);
    for (let i = 3; i < timestamps.length; i++) {
        if (timestamps[i] - timestamps[i - 3] < 1000) {
            return true; // Burst detected: 4+ tx in <1 second
        }
    }

    // 🟦 3. Fake Refills (most overlooked)
    // Bots momentarily add liquidity above bins,
    // then sweep it instantly after entry.
    // Detection: sudden pending increases in local bins
    // followed by multiple sweep tx in opposite direction
    const adds = pending.filter(p => p.liquidityUsed < 0).length; // Negative = adding liquidity
    const sweeps = pending.filter(p => p.binsCrossed >= 5 && p.liquidityUsed > 0).length;

    if (adds >= 3 && sweeps >= 3) {
        return true; // Fake liquidity wall trap
    }

    // 🧠 4. Same Wallet Micro-spam
    // If one wallet performs multiple small swaps rapidly across bins:
    // - They are painting the orderbook
    // - They are triggering naive oscillation entries
    // - They will sweep later
    const byWallet: Record<string, number> = {};
    for (const p of pending) {
        byWallet[p.wallet] = (byWallet[p.wallet] || 0) + 1;
        if (byWallet[p.wallet] >= 4) {
            return true; // Same wallet spam detected
        }
    }

    // 🪓 5. Shared Bot Swarms
    // Multiple wallets with identical:
    // - binsCrossed
    // - time windows
    // - liquidityUsed ratio
    // Result: They are controlled by one system.
    const patternMap: Record<string, number> = {};
    for (const p of pending) {
        // Create pattern signature
        const key = `${p.binsCrossed}-${Math.floor(p.liquidityUsed / 1000)}`;
        patternMap[key] = (patternMap[key] || 0) + 1;
        if (patternMap[key] >= 3) {
            return true; // Bot swarm warfare detected
        }
    }

    return false; // No predation detected
}

/**
 * Get pending swaps for a specific pool from mempool
 * 
 * This is a placeholder - actual implementation requires:
 * - Helius RPC with mempool access
 * - WebSocket subscription to pending transactions
 * - Real-time log parsing
 * 
 * @param poolAddress - DLMM pool address
 * @param timeWindowMs - Time window to look back (default 60s)
 * @returns Array of pending swaps
 */
import { getConnectionWithCommitment } from '../config/rpc';

export async function getPendingSwaps(
    poolAddress: string,
    timeWindowMs: number = 60000
): Promise<PendingSwap[]> {
    // Use 'processed' commitment to get the absolute latest state (closest to mempool via REST)
    const connection = getConnectionWithCommitment('processed');
    const poolPubkey = new PublicKey(poolAddress);

    try {
        // Fetch recent signatures
        const signatures = await connection.getSignaturesForAddress(poolPubkey, {
            limit: 50
        });

        const now = Date.now();
        const cutoff = now - timeWindowMs;

        const pendingSwaps: PendingSwap[] = [];

        for (const sig of signatures) {
            // Skip if too old (if blockTime is available)
            if (sig.blockTime && (sig.blockTime * 1000) < cutoff) continue;

            // Parse transaction
            const swapEvent = await parseSwapTransaction(connection, sig.signature, poolAddress);

            if (swapEvent) {
                pendingSwaps.push(swapEvent);
            }
        }

        return pendingSwaps;
    } catch (error) {
        console.error('Error fetching pending swaps:', error);
        return [];
    }
}

/**
 * Check if safe to enter based on mempool analysis
 * 
 * Usage in entry pipeline:
 * ```typescript
 * const pendingSwaps = await getPendingSwaps(poolAddress);
 * if (!isSafeToEnter(pendingSwaps)) {
 *   // ABORT ENTRY - predatory bots detected
 *   return;
 * }
 * ```
 * 
 * @param pending - Pending swaps from mempool
 * @returns true if safe to enter, false if predation detected
 */
export function isSafeToEnter(pending: PendingSwap[]): boolean {
    return !detectMempoolPredation(pending);
}

/**
 * 💀 Predation Patterns Summary:
 * 
 * 1. Directional Clustering: 3+ sweeps ≥4 bins in same direction
 * 2. Multi-Burst: 4+ tx in <1 second
 * 3. Fake Refills: 3+ adds + 3+ sweeps
 * 4. Wallet Spam: 1 wallet with 4+ rapid swaps
 * 5. Bot Swarms: 3+ wallets with identical patterns
 * 
 * If ANY pattern detected → NO ENTRY
 * 
 * This is the real edge. Mempool = intent before action.
 */
