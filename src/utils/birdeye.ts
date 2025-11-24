import axios from 'axios';
import logger from '../utils/logger';

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const BIRDEYE_BASE_URL = 'https://public-api.birdeye.so';

interface BirdeyeTokenOverview {
    success: boolean;
    data: {
        address: string;
        decimals: number;
        symbol: string;
        name: string;
        liquidity: number;
        price: number;
        priceChange24h: number;
        volume24h: number;
        volume1h: number;
        volume4h: number;
        mc: number; // market cap
        holder: number;
        supply: number;
        extensions?: {
            coingeckoId?: string;
        };
    };
}

interface BirdeyePairOverview {
    success: boolean;
    data: {
        address: string;
        name: string;
        liquidity: number;
        price: number;
        volume24h: number;
        volume1h: number;
        volume4h: number;
        priceChange24h: number;
        createdAt: number;
    };
}

// Cache to avoid hitting rate limits
const birdeyeCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes (increased from 2)

/**
 * Fetch real volume and price data from Birdeye for a pool
 * Returns 1h, 4h, 24h volume + price + creation time
 */
export async function fetchBirdeyeData(poolAddress: string): Promise<{
    volume1h: number;
    volume4h: number;
    volume24h: number;
    currentPrice: number;
    createdAt: number;
    liquidity: number;
} | null> {
    try {
        // Check cache first
        const cached = birdeyeCache.get(poolAddress);
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
            return cached.data;
        }

        // Fetch from Birdeye
        const response = await axios.get<BirdeyePairOverview>(
            `${BIRDEYE_BASE_URL}/defi/v3/pair/overview/single`,
            {
                params: {
                    address: poolAddress
                },
                headers: {
                    'X-API-KEY': BIRDEYE_API_KEY,
                    'Accept': 'application/json'
                },
                timeout: 5000
            }
        );

        if (!response.data.success || !response.data.data) {
            logger.warn(`No Birdeye data found for pool ${poolAddress}`);
            return null;
        }

        const data = response.data.data;

        const result = {
            volume1h: data.volume1h || 0,
            volume4h: data.volume4h || 0,
            volume24h: data.volume24h || 0,
            currentPrice: data.price || 0,
            createdAt: data.createdAt ? data.createdAt * 1000 : 0, // Convert to ms
            liquidity: data.liquidity || 0
        };

        // Cache the result
        birdeyeCache.set(poolAddress, {
            data: result,
            timestamp: Date.now()
        });

        return result;
    } catch (error: any) {
        if (error.response?.status === 429) {
            logger.warn(`Birdeye rate limit hit for ${poolAddress}`);
        } else if (error.response?.status === 401) {
            logger.error('Birdeye API key is invalid or missing');
        } else {
            logger.error(`Error fetching Birdeye data for ${poolAddress}:`, error.message);
        }
        return null;
    }
}

/**
 * Batch fetch volume data for multiple pools
 * Implements rate limiting to stay within Birdeye limits (15 RPS)
 */
export async function batchFetchBirdeyeData(
    poolAddresses: string[],
    delayMs: number = 70 // 70ms = ~14 requests/second (under 15 RPS limit)
): Promise<Map<string, NonNullable<Awaited<ReturnType<typeof fetchBirdeyeData>>>>> {
    const results = new Map();

    logger.info(`Fetching Birdeye data for ${poolAddresses.length} pools...`);

    for (let i = 0; i < poolAddresses.length; i++) {
        const address = poolAddresses[i];
        const data = await fetchBirdeyeData(address);

        if (data) {
            results.set(address, data);
        }

        // Rate limiting: wait between requests (except for last one)
        if (i < poolAddresses.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    logger.info(`Fetched Birdeye data for ${results.size}/${poolAddresses.length} pools`);
    return results;
}

/**
 * Clear the cache (useful for testing or manual refresh)
 */
export function clearBirdeyeCache(): void {
    birdeyeCache.clear();
    logger.info('Birdeye cache cleared');
}
