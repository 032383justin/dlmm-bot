/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RPC CONFIGURATION — SINGLE SOURCE OF TRUTH
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * All Solana RPC connections MUST use this module.
 * The environment variable SOLANA_RPC_URL must be set.
 * 
 * NO FALLBACKS: If SOLANA_RPC_URL is missing, the bot exits immediately.
 * 
 * Usage:
 *   import { getConnection, RPC_URL } from './config/rpc';
 *   const connection = getConnection();
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Connection } from '@solana/web3.js';

// ═══════════════════════════════════════════════════════════════════════════════
// RPC URL VALIDATION — FAIL FAST IF MISSING
// ═══════════════════════════════════════════════════════════════════════════════

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL as string;

if (!SOLANA_RPC_URL || SOLANA_RPC_URL.trim() === '') {
    console.error('');
    console.error('════════════════════════════════════════════════════════════════');
    console.error('🚨 FATAL: Missing SOLANA_RPC_URL — cannot start');
    console.error('════════════════════════════════════════════════════════════════');
    console.error('   The environment variable SOLANA_RPC_URL is required.');
    console.error('   Set it in your .env file:');
    console.error('');
    console.error('   SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY');
    console.error('');
    console.error('════════════════════════════════════════════════════════════════');
    process.exit(1);
}

/**
 * The validated RPC URL (guaranteed to exist)
 */
export const RPC_URL: string = SOLANA_RPC_URL;

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════

let connectionInstance: Connection | null = null;

/**
 * Get the singleton Solana RPC connection
 * Uses 'confirmed' commitment by default
 */
export function getConnection(): Connection {
    if (!connectionInstance) {
        connectionInstance = new Connection(RPC_URL, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
        });
        console.log(`[RPC] Connected to: ${RPC_URL.slice(0, 50)}...`);
    }
    return connectionInstance;
}

/**
 * Get a new connection with custom commitment
 * Use sparingly - prefer getConnection() for most cases
 */
export function getConnectionWithCommitment(commitment: 'processed' | 'confirmed' | 'finalized'): Connection {
    return new Connection(RPC_URL, {
        commitment,
        confirmTransactionInitialTimeout: 60000,
    });
}

/**
 * Reset the connection (for error recovery)
 */
export function resetConnection(): void {
    connectionInstance = null;
}

