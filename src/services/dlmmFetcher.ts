/**
 * DLMM Pool Fetcher Service
 * 
 * Production-grade DLMM pool discovery via Bitquery GraphQL API.
 * Uses solana_meteora_dlmm endpoint (official Meteora DLMM datasource).
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
    protocol: string;     // protocol/dex name
    tvl: number;          // total value locked USD
    volume24h: number;    // 24h volume USD
    trades24h: number;
    activeBin: number;
    binStep: number;
    feeTier: number;
}

/**
 * Raw Bitquery solana_meteora_dlmm response item
 */
interface BitqueryMeteoraDLMM {
    poolAddress?: string;
    baseMint?: string;
    quoteMint?: string;
    protocol?: string;
    tvlUsd?: number | string;
    volume24hUsd?: number | string;
    trades24h?: number | string;
    activeBin?: number | string;
    binStep?: number | string;
    feeTier?: number | string;
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
// GRAPHQL QUERY - solana_meteora_dlmm (OFFICIAL METEORA DLMM DATASOURCE)
// ═══════════════════════════════════════════════════════════════════════════════

const METEORA_DLMM_QUERY = `
query DLMM_Pools {
  solana_meteora_dlmm(
    network: solana
    limit: 300
  ) {
    poolAddress: pool
    baseMint: base_mint
    quoteMint: quote_mint
    protocol: dex
    tvlUsd: total_value_locked_usd
    volume24hUsd: volume_24h_usd
    trades24h: trades_24h
    activeBin: active_bin
    binStep: bin_step
    feeTier: fee_tier
  }
}
`;

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FETCH FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch DLMM pools from Bitquery solana_meteora_dlmm endpoint
 * 
 * This is the official Meteora DLMM datasource with:
 * - Live DLMM pools
 * - binStep + activeBin
 * - No deprecated fields
 * 
 * GUARANTEES:
 * - NEVER throws
 * - NEVER crashes
 * - NEVER calls process.exit
 * - Always returns DLMM_Pool[] (possibly empty)
 */
export async function fetchDLMMPools(): Promise<DLMM_Pool[]> {
    logger.info('[DISCOVERY] 🔍 Fetching pools via Bitquery solana_meteora_dlmm...');

    // Check for API key
    const apiKey = process.env.BITQUERY_API_KEY;
    if (!apiKey) {
        logger.error('[DISCOVERY] ❌ BITQUERY_API_KEY not configured in environment');
        return [];
    }

    try {
        const response = await axios.post(
            BITQUERY_ENDPOINT,
            { query: METEORA_DLMM_QUERY },
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
            logger.error('[DISCOVERY] Bitquery DLMM fetch FAILED', {
                error: JSON.stringify(response.data.errors),
                status: response.status,
            });
            return [];
        }

        // Extract pools from response
        const rawPools: BitqueryMeteoraDLMM[] = response?.data?.data?.solana_meteora_dlmm;

        if (!rawPools || !Array.isArray(rawPools)) {
            logger.warn('[DISCOVERY] DLMM fetch returned 0 pools');
            return [];
        }

        if (rawPools.length === 0) {
            logger.warn('[DISCOVERY] DLMM fetch returned 0 pools');
            return [];
        }

        // Normalize pools
        const normalized: DLMM_Pool[] = [];

        for (const p of rawPools) {
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
                    tvl: Number(p.tvlUsd ?? 0),
                    volume24h: Number(p.volume24hUsd ?? 0),
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

        logger.info(`[DISCOVERY] DLMM pools detected: ${normalized.length}`);

        return normalized;

    } catch (err: any) {
        logger.error('[DISCOVERY] Bitquery DLMM fetch FAILED', {
            error: err?.message || 'Unknown error',
            status: err?.response?.status || 'N/A',
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
