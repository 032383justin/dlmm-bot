/**
 * poolAdapter.ts - Minimal adapter layer for DLMM pool configuration.
 * 
 * CRITICAL: This adapter ONLY resolves:
 * - address (pool ID)
 * - mintX / mintY (token mints)
 * - name
 * 
 * ALL telemetry (liquidity, velocity, volume, entropy, etc.) MUST come from
 * real on-chain data via getEnrichedDLMMState() in dlmmTelemetry.ts.
 * 
 * NO static mock values. NO fallback telemetry.
 */

import { Pool } from '../core/normalizePools';
import { NormalizedPool, DlmmPool } from '../types/pools';

/**
 * Configuration format for DLMM pools (input shape)
 */
export interface DLMMPoolConfig {
    name: string;
    poolId: string;
}

// Known token mint addresses on Solana mainnet
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_MINTS: Record<string, string> = {
    'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    'SOL': 'So11111111111111111111111111111111111111112',
    'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'JUP': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    'JITOSOL': 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
};

/**
 * Resolves a token symbol to its mint address.
 * Falls back to USDC for unknown tokens (common quote currency).
 */
function resolveTokenMint(symbol: string): string {
    const upperSymbol = symbol.toUpperCase().trim();
    return TOKEN_MINTS[upperSymbol] || USDC_MINT;
}

/**
 * adaptDLMMPools - Converts raw DLMM pool configs to Pool objects.
 * 
 * CRITICAL: Only sets minimal identification fields.
 * All telemetry fields are set to ZERO - they MUST be overwritten by
 * real on-chain data before the pool can be scored or traded.
 * 
 * @param configs - Array of DLMMPoolConfig from src/config/pools.ts
 * @returns Pool[] - Minimal pool objects (telemetry must be filled by DLMM state)
 */
export function adaptDLMMPools(configs: DLMMPoolConfig[]): Pool[] {
    return configs.map(config => {
        // Parse token pair from pool name (e.g., "BONK/USDC" -> ["BONK", "USDC"])
        const [tokenXSymbol, tokenYSymbol] = config.name.split('/').map(s => s.trim());
        
        // Resolve to actual Solana mint addresses
        const tokenX = resolveTokenMint(tokenXSymbol);
        const tokenY = resolveTokenMint(tokenYSymbol);

        return {
            // === CORE IDENTIFICATION (adapter provides) ===
            address: config.poolId,
            name: config.name,
            tokenX,
            tokenY,
            mintX: tokenX,
            mintY: tokenY,
            
            // === TELEMETRY FIELDS (MUST be overwritten by on-chain data) ===
            // Set to 0 - pool is INVALID until real telemetry is attached
            liquidity: 0,       // From on-chain DLMM state
            volume24h: 0,       // From Birdeye (secondary metric)
            volume1h: 0,        // From Birdeye (secondary metric)
            volume4h: 0,        // From Birdeye (secondary metric)
            velocity: 0,        // Computed from DLMM snapshots
            fees24h: 0,         // From Birdeye (secondary metric)
            apr: 0,             // Computed from fees/liquidity
            
            // === DLMM BIN STRUCTURE (from on-chain) ===
            binStep: 0,         // From DLMM account
            baseFee: 0,         // From DLMM account
            binCount: 0,        // From DLMM bin arrays
            
            // === POOL METADATA (from Birdeye/Helius) ===
            createdAt: 0,       // From Birdeye
            holderCount: 0,     // Not used for scoring
            topHolderPercent: 0,// Not used for scoring
            isRenounced: true,  // Default assumption
            
            // === COMPUTED SCORES (filled by scoring pipeline) ===
            riskScore: 0,
            dilutionScore: 0,
            score: 0,
            
            // === PRICE TRACKING ===
            currentPrice: 0,    // From Birdeye or on-chain
        };
    });
}

// Re-export types for convenience
export type { NormalizedPool, DlmmPool, Pool };
