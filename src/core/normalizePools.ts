import { RawPoolData } from './scanPools';
import { calculateVelocity } from '../utils/math';
import { batchFetchBirdeyeData } from '../utils/birdeye';
import logger from '../utils/logger';

export interface Pool {
    address: string;
    name: string;
    mintX: string;
    mintY: string;
    liquidity: number; // TVL
    volume1h: number;
    volume4h: number;
    volume24h: number;
    velocity: number;
    fees24h: number;
    apr: number;
    binStep: number;
    baseFee: number;
    createdAt: number; // Timestamp
    holderCount: number; // Placeholder, needs RPC fetch
    topHolderPercent: number; // Placeholder
    isRenounced: boolean; // Placeholder
    riskScore: number;
    dilutionScore: number;
    score: number;
    currentPrice: number; // Added for profit taking
    // Additional fields for filters
    binCount: number; // Placeholder
}

export const normalizePools = async (rawPools: RawPoolData[]): Promise<Pool[]> => {
    // Filter for SOL pairs only (for testing)
    const solPools = rawPools.filter(raw =>
        raw.name.toUpperCase().includes('SOL') ||
        raw.name.toUpperCase().includes('-SOL')
    );

    // OPTIMIZATION: Don't fetch DexScreener data for ALL pools (too slow, rate limits)
    // Instead, do initial filtering with Meteora data, then enrich top candidates
    logger.info(`Processing ${solPools.length} SOL pools from Meteora...`);

    return solPools.map((raw) => {
        // Use Meteora data for initial pass
        const vol24 = raw.trade_volume_24h || 0;
        const vol1h = vol24 / 24; // Rough estimate for initial filtering
        const vol4h = vol24 / 6;  // Rough estimate for initial filtering

        return {
            address: raw.address,
            name: raw.name,
            mintX: raw.mint_x,
            mintY: raw.mint_y,
            liquidity: parseFloat(raw.liquidity) || 0,
            volume1h: vol1h,
            volume4h: vol4h,
            volume24h: vol24,
            velocity: calculateVelocity(vol1h, vol4h, vol24),
            fees24h: raw.fees_24h,
            apr: raw.apr,
            binStep: raw.bin_step,
            baseFee: parseFloat(raw.base_fee_percentage),
            createdAt: Date.now() - (3 * 24 * 60 * 60 * 1000), // Temporary - will be updated for top candidates
            holderCount: 0, // TODO: Fetch from Helius
            topHolderPercent: 0, // TODO: Fetch from Helius
            isRenounced: true, // TODO: Fetch from Helius
            riskScore: 0,
            dilutionScore: 0,
            score: 0,
            currentPrice: raw.current_price || 0,
            binCount: 0 // TODO: Fetch from Meteora detailed endpoint
        };
    });
};

/**
 * Enrich top candidate pools with real DexScreener data
 * Call this AFTER initial filtering to only fetch data for promising pools
 */
export const enrichPoolsWithRealData = async (pools: Pool[]): Promise<Pool[]> => {
    logger.info(`Enriching ${pools.length} top candidates with real Birdeye data...`);

    const poolAddresses = pools.map(p => p.address);
    const volumeDataMap = await batchFetchBirdeyeData(poolAddresses, 70); // 70ms delay = ~14 RPS (under 15 limit)

    return pools.map((pool) => {
        const realData = volumeDataMap.get(pool.address);

        if (realData) {
            // Only update with real data if it's non-zero (preserve adapter defaults otherwise)
            // Birdeye may not track all DLMM pools properly
            if (realData.volume1h > 0) pool.volume1h = realData.volume1h;
            if (realData.volume4h > 0) pool.volume4h = realData.volume4h;
            if (realData.volume24h > 0) pool.volume24h = realData.volume24h;
            if (realData.currentPrice > 0) pool.currentPrice = realData.currentPrice;
            if (realData.createdAt > 0) pool.createdAt = realData.createdAt;
            if (realData.liquidity > 0) pool.liquidity = realData.liquidity;
            pool.velocity = calculateVelocity(pool.volume1h, pool.volume4h, pool.volume24h);
        } else {
            logger.warn(`No Birdeye data for ${pool.name} - using adapter defaults`);
        }

        return pool;
    });
};
