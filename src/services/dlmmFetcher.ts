/**
 * DLMM Pool Fetcher Service
 * 
 * Production-grade DLMM pool discovery via Bitquery GraphQL API.
 * Uses solana.dexV3Pools endpoint with local Meteora + binStep filtering.
 * 
 * GUARANTEES:
 * - NEVER throws
 * - NEVER crashes
 * - NEVER calls process.exit
 * - Always returns [] on failure
 */

import axios from 'axios';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalized DLMM pool from Bitquery
 */
export interface DLMM_Pool {
    id: string;           // pool address
    mintA: string;        // baseMint
    mintB: string;        // quoteMint
    protocol: string;     // protocol name
    liquidity: number;
    tvl: number;          // totalValueLockedUSD
    volume24h: number;    // volume24hUSD
    trades24h: number;
    activeBin: number;
    binStep: number;
    feeTier: number;
}

/**
 * Raw Bitquery dexV3Pools response item
 */
interface BitqueryDexV3Pool {
    poolAddress?: string;
    baseMint?: string;
    quoteMint?: string;
    protocol?: string;
    liquidity?: number | string;
    totalValueLockedUSD?: number | string;
    volume24hUSD?: number | string;
    feeTier?: number | string;
    binStep?: number | string;
    activeBin?: number | string;
    trades24h?: number | string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const BITQUERY_ENDPOINT = 'https://graphql.bitquery.io';

// Request configuration
const REQUEST_CONFIG = {
    timeout: 60000,
    maxContentLength: 50_000_000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// GRAPHQL QUERY - solana.dexV3Pools (WORKING SCHEMA)
// ═══════════════════════════════════════════════════════════════════════════════

const DEXV3_POOLS_QUERY = `
query DLMM_Pools {
  solana {
    dexV3Pools(
      limit: 300
    ) {
      poolAddress: address
      baseMint
      quoteMint
      protocol
      totalValueLockedUSD
      volume24hUSD
      liquidity
      trades24h
      feeTier
      binStep
      activeBin
    }
  }
}
`;

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FETCH FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch DLMM pools from Bitquery solana.dexV3Pools endpoint
 * 
 * Filters locally for:
 * - protocol contains "meteora" (case-insensitive)
 * - binStep > 0 (DLMM indicator)
 * 
 * GUARANTEES:
 * - NEVER throws
 * - NEVER crashes
 * - NEVER calls process.exit
 * - Always returns DLMM_Pool[] (possibly empty)
 */
export async function fetchDLMMPools(): Promise<DLMM_Pool[]> {
    logger.info('[DISCOVERY] 🔍 Fetching pools via Bitquery solana.dexV3Pools...');

    // Check for API key
    const apiKey = process.env.BITQUERY_API_KEY;
    if (!apiKey) {
        logger.error('[DISCOVERY] ❌ BITQUERY_API_KEY not configured in environment');
        return [];
    }

    try {
        const response = await axios.post(
            BITQUERY_ENDPOINT,
            { query: DEXV3_POOLS_QUERY },
            {
                ...REQUEST_CONFIG,
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': apiKey,
                },
            }
        );

        // Check for GraphQL errors
        if (response?.data?.errors) {
            logger.error('[DISCOVERY] Bitquery error', {
                status: response.status,
                message: JSON.stringify(response.data.errors),
            });
            return [];
        }

        // Extract pools from response (lowercase 'solana')
        const rawPools: BitqueryDexV3Pool[] = response?.data?.data?.solana?.dexV3Pools;

        if (!rawPools || !Array.isArray(rawPools)) {
            logger.warn('[DISCOVERY] ⚠️ No pools returned from Bitquery');
            return [];
        }

        logger.info(`[DISCOVERY] 🧠 Raw dexV3Pools count: ${rawPools.length}`);

        if (rawPools.length === 0) {
            logger.warn('[DISCOVERY] ⚠️ Bitquery returned empty pool array');
            return [];
        }

        // Filter for Meteora DLMM pools (protocol contains "meteora" AND binStep > 0)
        const dlmmPools = rawPools.filter(p =>
            p.protocol?.toLowerCase().includes('meteora') &&
            Number(p.binStep ?? 0) > 0
        );

        logger.info(`[DISCOVERY] 🎯 Filtered Meteora DLMM pools: ${dlmmPools.length}`);

        // Normalize pools
        const normalized: DLMM_Pool[] = [];

        for (const p of dlmmPools) {
            try {
                // Skip pools without required fields
                if (!p.poolAddress || !p.baseMint || !p.quoteMint) {
                    continue;
                }

                normalized.push({
                    id: p.poolAddress,
                    mintA: p.baseMint,
                    mintB: p.quoteMint,
                    protocol: p.protocol || 'Meteora',
                    liquidity: Number(p.liquidity ?? 0),
                    tvl: Number(p.totalValueLockedUSD ?? 0),
                    volume24h: Number(p.volume24hUSD ?? 0),
                    trades24h: Number(p.trades24h ?? 0),
                    activeBin: Number(p.activeBin ?? 0),
                    binStep: Number(p.binStep ?? 0),
                    feeTier: Number(p.feeTier ?? 0),
                });
            } catch (err) {
                // Skip malformed pool
                continue;
            }
        }

        logger.info(`[DISCOVERY] Found ${normalized.length} pools via Bitquery`);

        return normalized;

    } catch (err: any) {
        logger.error('[DISCOVERY] Bitquery error', {
            status: err?.response?.status || 'N/A',
            message: err?.message || 'Unknown error',
        });
        return [];
    }
}

/**
 * Legacy compatibility wrapper
 * Maps to the old fetchRaydiumDLMMPools signature
 */
export async function fetchRaydiumDLMMPools(): Promise<DLMM_Pool[]> {
    logger.warn('[DISCOVERY] ⚠️ fetchRaydiumDLMMPools called - redirecting to Bitquery');
    return fetchDLMMPools();
}
