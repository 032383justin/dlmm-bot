/**
 * DLMM Pool Fetcher Service
 * 
 * Production-grade DLMM pool discovery via Bitquery GraphQL API.
 * Replaces deprecated Raydium REST endpoints.
 * 
 * Sources:
 * 1. PRIMARY: Bitquery Meteora DLMM pools
 * 2. FALLBACK: Bitquery Solana DexPools
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
 * Normalized DLMM pool from any source
 */
export interface DLMM_Pool {
    id: string;           // poolAddress
    symbol: string;
    mintA: string;
    mintB: string;
    price: number;
    liquidity: number;
    volume24h: number;
    activeBin: number;
    binStep: number;
    feeRate: number;
    source: 'bitquery';
}

/**
 * Raw Bitquery Meteora pool response
 */
interface BitqueryMeteoraPool {
    poolAddress?: string;
    tokenA?: {
        mint?: string;
        symbol?: string;
    };
    tokenB?: {
        mint?: string;
        symbol?: string;
    };
    liquidity?: number;
    volume24h?: number;
    price?: number;
    binStep?: number;
    activeBin?: number;
    feeRate?: number;
}

/**
 * Raw Bitquery DexPool response
 */
interface BitqueryDexPool {
    poolAddress?: string;
    tokenA?: {
        mint?: string;
        symbol?: string;
    };
    tokenB?: {
        mint?: string;
        symbol?: string;
    };
    liquidity?: number;
    volume24h?: number;
    price?: number;
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

// Exponential backoff delays (ms)
const BACKOFF_DELAYS = [1000, 3000]; // 1s, 3s, then fail

// ═══════════════════════════════════════════════════════════════════════════════
// GRAPHQL QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

const METEORA_DLMM_QUERY = `
query DLMM_Pools {
  solana_meteora_pools(limit: 1000) {
    poolAddress
    tokenA { mint symbol }
    tokenB { mint symbol }
    liquidity
    volume24h
    price
    binStep
    activeBin
    feeRate
  }
}
`;

const DEX_POOLS_FALLBACK_QUERY = `
query DexPools {
  solana_dex_pools(limit: 1000) {
    poolAddress
    tokenA { mint symbol }
    tokenB { mint symbol }
    liquidity
    volume24h
    price
  }
}
`;

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sleep utility for backoff
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute Bitquery GraphQL request with exponential backoff
 */
async function executeBitqueryRequest(
    query: string,
    operationName: string
): Promise<any> {
    if (!BITQUERY_API_KEY) {
        logger.error(`[DISCOVERY] ❌ BITQUERY_API_KEY not configured`);
        return null;
    }

    let lastError: any = null;

    for (let attempt = 0; attempt <= BACKOFF_DELAYS.length; attempt++) {
        try {
            logger.info(`[DISCOVERY] 🔍 ${operationName} attempt ${attempt + 1}/${BACKOFF_DELAYS.length + 1}`);

            const response = await axios.post(
                BITQUERY_ENDPOINT,
                { query },
                {
                    ...REQUEST_CONFIG,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': BITQUERY_API_KEY,
                    },
                }
            );

            if (response?.data?.errors) {
                logger.error(`[DISCOVERY] ❌ GraphQL errors:`, {
                    errors: response.data.errors,
                });
                lastError = response.data.errors;
            } else if (response?.data?.data) {
                logger.info(`[DISCOVERY] ✅ ${operationName} succeeded`);
                return response.data.data;
            } else {
                logger.warn(`[DISCOVERY] ⚠️ Empty response from ${operationName}`);
                lastError = 'Empty response';
            }
        } catch (err: any) {
            lastError = err;
            logger.error(`[DISCOVERY] ❌ ${operationName} request failed`, {
                endpoint: BITQUERY_ENDPOINT,
                status: err?.response?.status,
                message: err?.message,
                attempt: attempt + 1,
            });
        }

        // Apply backoff if not last attempt
        if (attempt < BACKOFF_DELAYS.length) {
            const delay = BACKOFF_DELAYS[attempt];
            logger.info(`[DISCOVERY] ⏳ Waiting ${delay}ms before retry...`);
            await sleep(delay);
        }
    }

    logger.error(`[DISCOVERY] 🔥 ${operationName} FAILED after all retries`, {
        lastError: lastError?.message || lastError,
    });
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize Meteora pools to standard format
 */
export function normalizeMeteoraPools(pools: BitqueryMeteoraPool[]): DLMM_Pool[] {
    if (!Array.isArray(pools)) {
        logger.warn('[DISCOVERY] ⚠️ normalizeMeteoraPools received non-array');
        return [];
    }

    const normalized: DLMM_Pool[] = [];

    for (const p of pools) {
        try {
            if (!p.poolAddress || !p.tokenA?.mint || !p.tokenB?.mint) {
                continue;
            }

            const symbolA = p.tokenA?.symbol || 'UNKNOWN';
            const symbolB = p.tokenB?.symbol || 'UNKNOWN';

            normalized.push({
                id: p.poolAddress,
                symbol: `${symbolA}/${symbolB}`,
                mintA: p.tokenA.mint,
                mintB: p.tokenB.mint,
                price: Number(p.price ?? 0),
                liquidity: Number(p.liquidity ?? 0),
                volume24h: Number(p.volume24h ?? 0),
                activeBin: Number(p.activeBin ?? 0),
                binStep: Number(p.binStep ?? 0),
                feeRate: Number(p.feeRate ?? 0),
                source: 'bitquery',
            });
        } catch (err) {
            // Skip malformed pool
            continue;
        }
    }

    return normalized;
}

/**
 * Normalize DexPools to standard format
 */
export function normalizeDexPools(pools: BitqueryDexPool[]): DLMM_Pool[] {
    if (!Array.isArray(pools)) {
        logger.warn('[DISCOVERY] ⚠️ normalizeDexPools received non-array');
        return [];
    }

    const normalized: DLMM_Pool[] = [];

    for (const p of pools) {
        try {
            if (!p.poolAddress || !p.tokenA?.mint || !p.tokenB?.mint) {
                continue;
            }

            const symbolA = p.tokenA?.symbol || 'UNKNOWN';
            const symbolB = p.tokenB?.symbol || 'UNKNOWN';

            normalized.push({
                id: p.poolAddress,
                symbol: `${symbolA}/${symbolB}`,
                mintA: p.tokenA.mint,
                mintB: p.tokenB.mint,
                price: Number(p.price ?? 0),
                liquidity: Number(p.liquidity ?? 0),
                volume24h: Number(p.volume24h ?? 0),
                activeBin: 0,  // Not available in DexPools
                binStep: 0,    // Not available in DexPools
                feeRate: 0,    // Not available in DexPools
                source: 'bitquery',
            });
        } catch (err) {
            // Skip malformed pool
            continue;
        }
    }

    return normalized;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMARY FETCHER - METEORA DLMM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch DLMM pools from Bitquery Meteora endpoint (PRIMARY)
 * 
 * GUARANTEES:
 * - Never throws
 * - Returns [] on any failure
 */
export async function fetchDLMMFromBitqueryPrimary(): Promise<DLMM_Pool[]> {
    logger.info('[DISCOVERY] 🚀 PRIMARY Bitquery Meteora DLMM request...');

    try {
        const data = await executeBitqueryRequest(
            METEORA_DLMM_QUERY,
            'Meteora DLMM Primary'
        );

        if (!data) {
            logger.error('[DISCOVERY] ❌ Primary returned null');
            return [];
        }

        // Extract pools from response
        const rawPools = data.solana_meteora_pools || [];
        
        logger.info(`[DISCOVERY] 🧠 Raw Meteora pools: ${rawPools.length}`);

        const normalized = normalizeMeteoraPools(rawPools);

        logger.info(`[DISCOVERY] 🟢 Found ${normalized.length} pools (primary)`);

        return normalized;
    } catch (err: any) {
        logger.error('[DISCOVERY] 🔥 fetchDLMMFromBitqueryPrimary FAILED', {
            endpoint: BITQUERY_ENDPOINT,
            message: err?.message,
        });
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FALLBACK FETCHER - DEX POOLS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch pools from Bitquery DexPools endpoint (FALLBACK)
 * 
 * GUARANTEES:
 * - Never throws
 * - Returns [] on any failure
 */
export async function fetchDLMMFromBitqueryFallback(): Promise<DLMM_Pool[]> {
    logger.warn('[DISCOVERY] ⚠️ FALLBACK Bitquery DexPools request...');

    try {
        const data = await executeBitqueryRequest(
            DEX_POOLS_FALLBACK_QUERY,
            'DexPools Fallback'
        );

        if (!data) {
            logger.error('[DISCOVERY] ❌ Fallback returned null');
            return [];
        }

        // Extract pools from response
        const rawPools = data.solana_dex_pools || [];
        
        logger.info(`[DISCOVERY] 🧠 Raw DexPools: ${rawPools.length}`);

        const normalized = normalizeDexPools(rawPools);

        logger.info(`[DISCOVERY] 🟢 Found ${normalized.length} pools (fallback)`);

        return normalized;
    } catch (err: any) {
        logger.error('[DISCOVERY] 🔥 fetchDLMMFromBitqueryFallback FAILED', {
            endpoint: BITQUERY_ENDPOINT,
            message: err?.message,
        });
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FETCH FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch DLMM pools with primary + fallback strategy
 * 
 * Flow:
 * 1. Try PRIMARY (Meteora DLMM)
 * 2. If empty/failed → try FALLBACK (DexPools)
 * 3. If still empty → return []
 * 
 * GUARANTEES:
 * - NEVER throws
 * - NEVER crashes
 * - NEVER calls process.exit
 * - Always returns DLMM_Pool[] (possibly empty)
 */
export async function fetchDLMMPools(): Promise<DLMM_Pool[]> {
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('[DISCOVERY] 🌐 Starting DLMM pool fetch (Bitquery)...');
    logger.info('═══════════════════════════════════════════════════════════════════');

    try {
        // Step 1: Try primary source
        let pools = await fetchDLMMFromBitqueryPrimary();

        if (pools.length > 0) {
            logger.info(`[DISCOVERY] ✅ Primary source returned ${pools.length} pools`);
            return pools;
        }

        // Step 2: Primary failed/empty, try fallback
        logger.warn('[DISCOVERY] ⚠️ Primary returned 0 pools, trying fallback...');
        pools = await fetchDLMMFromBitqueryFallback();

        if (pools.length > 0) {
            logger.info(`[DISCOVERY] ✅ Fallback source returned ${pools.length} pools`);
            return pools;
        }

        // Step 3: Both failed
        logger.warn('[DISCOVERY] ⚠️ EMPTY universe — retry next cycle');
        return [];

    } catch (err: any) {
        // ABSOLUTE FAIL-SAFE: Never crash
        logger.error('[DISCOVERY] 🔥 fetchDLMMPools FATAL ERROR', {
            message: err?.message,
            stack: err?.stack,
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

