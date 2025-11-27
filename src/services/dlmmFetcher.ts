/**
 * DLMM Pool Fetcher Service
 * 
 * Production-grade DLMM pool discovery via Bitquery GraphQL API.
 * Uses Solana.dexV3Pools endpoint with Meteora protocol filter.
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
    liquidity: number;
    tvl: number;          // totalValueLockedUSD
    volume24h: number;    // volume24hUSD
    trades24h: number;
    activeBin: number;
    binStep: number;
    feeTier: number;
    protocol: 'Meteora';
}

/**
 * Raw Bitquery dexV3Pools response item
 */
interface BitqueryDexV3Pool {
    address?: string;
    baseMint?: string;
    quoteMint?: string;
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
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY || '';

// Request configuration
const REQUEST_CONFIG = {
    timeout: 60000,
    maxContentLength: 50_000_000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// GRAPHQL QUERY - Solana.dexV3Pools (CURRENT, NOT DEPRECATED)
// ═══════════════════════════════════════════════════════════════════════════════

const METEORA_DEXV3_QUERY = `
query DLMM_Pools {
  Solana {
    dexV3Pools(
      limit: 500
      where: {
        protocol: {is: "Meteora"}
      }
    ) {
      address
      baseMint
      quoteMint
      liquidity
      totalValueLockedUSD
      volume24hUSD
      feeTier
      binStep
      activeBin
      trades24h
    }
  }
}
`;

// ═══════════════════════════════════════════════════════════════════════════════
// NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize dexV3Pools response to standard DLMM_Pool format
 */
function normalizeDexV3Pools(pools: BitqueryDexV3Pool[]): DLMM_Pool[] {
    if (!Array.isArray(pools)) {
        logger.warn('[DISCOVERY] ⚠️ normalizeDexV3Pools received non-array');
        return [];
    }

    const normalized: DLMM_Pool[] = [];

    for (const p of pools) {
        try {
            // Skip pools without required fields
            if (!p.address || !p.baseMint || !p.quoteMint) {
                continue;
            }

            normalized.push({
                id: p.address,
                mintA: p.baseMint,
                mintB: p.quoteMint,
                liquidity: Number(p.liquidity ?? 0),
                tvl: Number(p.totalValueLockedUSD ?? 0),
                volume24h: Number(p.volume24hUSD ?? 0),
                trades24h: Number(p.trades24h ?? 0),
                activeBin: Number(p.activeBin ?? 0),
                binStep: Number(p.binStep ?? 0),
                feeTier: Number(p.feeTier ?? 0),
                protocol: 'Meteora',
            });
        } catch (err) {
            // Skip malformed pool
            continue;
        }
    }

    return normalized;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FETCH FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch DLMM pools from Bitquery Solana.dexV3Pools endpoint
 * 
 * GUARANTEES:
 * - NEVER throws
 * - NEVER crashes
 * - NEVER calls process.exit
 * - Always returns DLMM_Pool[] (possibly empty)
 */
export async function fetchDLMMPools(): Promise<DLMM_Pool[]> {
    logger.info('[DISCOVERY] 🔍 Fetching Meteora DLMM pools via Bitquery dexV3Pools...');

    // Check for API key
    if (!BITQUERY_API_KEY) {
        logger.error('[DISCOVERY] ❌ BITQUERY_API_KEY not configured in environment');
        return [];
    }

    try {
        const response = await axios.post(
            BITQUERY_ENDPOINT,
            { query: METEORA_DEXV3_QUERY },
            {
                ...REQUEST_CONFIG,
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': BITQUERY_API_KEY,
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

        // Extract pools from response
        const rawPools = response?.data?.data?.Solana?.dexV3Pools;

        if (!rawPools || !Array.isArray(rawPools)) {
            logger.warn('[DISCOVERY] ⚠️ No pools returned from Bitquery');
            return [];
        }

        if (rawPools.length === 0) {
            logger.warn('[DISCOVERY] ⚠️ Bitquery returned empty pool array');
            return [];
        }

        // Normalize pools
        const normalized = normalizeDexV3Pools(rawPools);

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
