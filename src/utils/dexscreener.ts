import axios from 'axios';
import logger from '../utils/logger';

interface DexScreenerPair {
    chainId: string;
    dexId: string;
    url: string;
    pairAddress: string;
    baseToken: {
        address: string;
        name: string;
        symbol: string;
    };
    quoteToken: {
        address: string;
        name: string;
        symbol: string;
    };
    priceNative: string;
    priceUsd: string;
    volume: {
        h1: number;
        h4: number;
        h24: number;
    };
    priceChange: {
        h1: number;
        h4: number;
        h24: number;
    };
    liquidity: {
        usd: number;
        base: number;
        quote: number;
    };
    fdv: number;
    pairCreatedAt: number;
}

interface DexScreenerResponse {
    schemaVersion: string;
    pairs: DexScreenerPair[] | null;
}

// Cache to avoid hitting rate limits
const volumeCache = new Map<string, { data: DexScreenerPair; timestamp: number }>();
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

/**
 * Fetch real volume data from DexScreener for a pool
 * Returns 1h, 4h, 24h volume + price + creation time
 */
export async function fetchRealVolumeData(poolAddress: string): Promise<{
    volume1h: number;
    volume4h: number;
    volume24h: number;
    currentPrice: number;
    createdAt: number;
    liquidity: number;
} | null> {
    try {
        // Check cache first
        const cached = volumeCache.get(poolAddress);
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
            const pair = cached.data;
            return {
                volume1h: pair.volume.h1 || 0,
                volume4h: pair.volume.h4 || 0,
                volume24h: pair.volume.h24 || 0,
                currentPrice: parseFloat(pair.priceUsd) || 0,
                createdAt: pair.pairCreatedAt || 0,
                liquidity: pair.liquidity.usd || 0
            };
        }

        // Fetch from DexScreener
        const response = await axios.get<DexScreenerResponse>(
            `https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`,
            {
                timeout: 5000,
                headers: {
                    'Accept': 'application/json'
                }
            }
        );

        if (!response.data.pairs || response.data.pairs.length === 0) {
            logger.warn(`No DexScreener data found for pool ${poolAddress}`);
            return null;
        }

        // Use first pair (should be the exact match)
        const pair = response.data.pairs[0];

        // Cache the result
        volumeCache.set(poolAddress, {
            data: pair,
            timestamp: Date.now()
        });

        return {
            volume1h: pair.volume.h1 || 0,
            volume4h: pair.volume.h4 || 0,
            volume24h: pair.volume.h24 || 0,
            currentPrice: parseFloat(pair.priceUsd) || 0,
            createdAt: pair.pairCreatedAt || 0,
            liquidity: pair.liquidity.usd || 0
        };
    } catch (error: any) {
        if (error.response?.status === 429) {
            logger.warn(`DexScreener rate limit hit for ${poolAddress}`);
        } else {
            logger.error(`Error fetching DexScreener data for ${poolAddress}:`, error.message);
        }
        return null;
    }
}

/**
 * Batch fetch volume data for multiple pools
 * Implements rate limiting to avoid hitting API limits
 */
export async function batchFetchVolumeData(
    poolAddresses: string[],
    delayMs: number = 100
): Promise<Map<string, NonNullable<Awaited<ReturnType<typeof fetchRealVolumeData>>>>> {
    const results = new Map();

    for (let i = 0; i < poolAddresses.length; i++) {
        const address = poolAddresses[i];
        const data = await fetchRealVolumeData(address);

        if (data) {
            results.set(address, data);
        }

        // Rate limiting: wait between requests
        if (i < poolAddresses.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    logger.info(`Fetched real volume data for ${results.size}/${poolAddresses.length} pools from DexScreener`);
    return results;
}

/**
 * Clear the cache (useful for testing or manual refresh)
 */
export function clearVolumeCache(): void {
    volumeCache.clear();
    logger.info('DexScreener volume cache cleared');
}
