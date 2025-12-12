/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RPC CONFIGURATION — SINGLE SOURCE OF TRUTH
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * All Solana RPC connections MUST use this module.
 * 
 * PRIORITY ORDER:
 * 1. RPC_URL — if defined, use it directly
 * 2. HELIUS_API_KEY — if defined, construct Helius mainnet URL
 * 3. FAIL LOUDLY — exit immediately with clear error message
 * 
 * NO FALLBACKS: No hardcoded URLs. If neither env var is set, the bot exits.
 * 
 * Usage:
 *   import { getConnection, RPC_URL, getRpcEndpoint } from './config/rpc';
 *   const connection = getConnection();
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Connection } from '@solana/web3.js';

// ═══════════════════════════════════════════════════════════════════════════════
// RPC ENDPOINT RESOLUTION — PRIORITY ORDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the RPC endpoint following priority order:
 * 1. RPC_URL env var (direct)
 * 2. HELIUS_API_KEY (construct Helius URL)
 * 3. SOLANA_RPC_URL (legacy fallback for backwards compatibility)
 * 4. Fail loudly
 * 
 * @returns The resolved RPC URL
 * @throws Error if no RPC configuration is found
 */
export function getRpcEndpoint(): string {
    // Priority 1: RPC_URL takes precedence
    const rpcUrl = process.env.RPC_URL;
    if (rpcUrl && rpcUrl.trim() !== '') {
        return rpcUrl.trim();
    }
    
    // Priority 2: Construct from HELIUS_API_KEY
    const heliusApiKey = process.env.HELIUS_API_KEY;
    if (heliusApiKey && heliusApiKey.trim() !== '') {
        return `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey.trim()}`;
    }
    
    // Priority 3: Legacy SOLANA_RPC_URL (for backwards compatibility)
    const legacyRpcUrl = process.env.SOLANA_RPC_URL;
    if (legacyRpcUrl && legacyRpcUrl.trim() !== '') {
        return legacyRpcUrl.trim();
    }
    
    // No RPC configured — FAIL LOUDLY
    console.error('');
    console.error('════════════════════════════════════════════════════════════════');
    console.error('🚨 FATAL: No RPC endpoint configured — cannot start');
    console.error('════════════════════════════════════════════════════════════════');
    console.error('   No RPC_URL or HELIUS_API_KEY provided.');
    console.error('   Set one in your .env file:');
    console.error('');
    console.error('   Option 1 (recommended):');
    console.error('   RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY');
    console.error('');
    console.error('   Option 2:');
    console.error('   HELIUS_API_KEY=YOUR_KEY');
    console.error('');
    console.error('════════════════════════════════════════════════════════════════');
    process.exit(1);
}

// Resolve the RPC URL at module load
const RESOLVED_RPC_URL = getRpcEndpoint();

/**
 * The validated RPC URL (guaranteed to exist after module load)
 */
export const RPC_URL: string = RESOLVED_RPC_URL;

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════

let connectionInstance: Connection | null = null;
let rpcLogged: boolean = false;

/**
 * Get the singleton Solana RPC connection
 * Uses 'confirmed' commitment by default
 * Logs the RPC endpoint ONCE on first connection
 */
export function getConnection(): Connection {
    if (!connectionInstance) {
        connectionInstance = new Connection(RPC_URL, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
        });
        
        // Log RPC endpoint only once
        if (!rpcLogged) {
            // Mask the API key for security
            const maskedUrl = maskRpcUrl(RPC_URL);
            console.log(`[RPC] Connected to: ${maskedUrl}`);
            rpcLogged = true;
        }
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

/**
 * Log the RPC endpoint (for startup logging)
 * Only logs once
 */
export function logRpcEndpoint(): void {
    if (!rpcLogged) {
        const maskedUrl = maskRpcUrl(RPC_URL);
        console.log(`[RPC] Connected to: ${maskedUrl}`);
        rpcLogged = true;
    }
}

/**
 * Get the RPC source for logging
 */
export function getRpcSource(): string {
    if (process.env.RPC_URL && process.env.RPC_URL.trim() !== '') {
        return 'RPC_URL';
    }
    if (process.env.HELIUS_API_KEY && process.env.HELIUS_API_KEY.trim() !== '') {
        return 'HELIUS_API_KEY';
    }
    if (process.env.SOLANA_RPC_URL && process.env.SOLANA_RPC_URL.trim() !== '') {
        return 'SOLANA_RPC_URL (legacy)';
    }
    return 'UNKNOWN';
}

/**
 * Mask API key in URL for secure logging
 */
function maskRpcUrl(url: string): string {
    // Match api-key parameter and mask the value
    return url.replace(/(api-key=)([^&]+)/gi, '$1***');
}
