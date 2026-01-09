import { calculateVelocity } from '../utils/math';
import { batchFetchBirdeyeData } from '../utils/birdeye';
import logger from '../utils/logger';
import { NormalizedPool } from '../types/pools';

// RawPoolData interface (originally from deleted scanPools.ts)
// Uses snake_case to match Meteora API response format
export interface RawPoolData {
    address: string;
    name: string;
    mint_x: string;
    mint_y: string;
    liquidity: string | number;
    trade_volume_24h?: number;
    fees_24h?: number;
    apr?: number;
    bin_step?: number;
    base_fee_percentage?: string;
    current_price?: number;
}

/**
 * Pool - Extended interface for full microstructure analysis.
 * Extends NormalizedPool with additional fields required for:
 * - Multi-timeframe volume analysis
 * - Bin structure scoring
 * - Risk/safety evaluation
 * - Structural entry/exit signals
 * 
 * All downstream modules (scoring, volume, dilution, structural) use this type.
 */
export interface Pool extends NormalizedPool {
    // Token mints (aliases for tokenX/tokenY for backwards compatibility)
    mintX: string;
    mintY: string;
    
    // Multi-timeframe volume (required for velocity calculation)
    volume1h: number;
    volume4h: number;
    velocity: number;
    
    // DLMM bin structure
    binStep: number;
    baseFee: number;
    binCount: number;
    
    // Pool metadata
    createdAt: number; // Timestamp
    holderCount: number;
    topHolderPercent: number;
    isRenounced: boolean;
    
    // Computed scores (filled by scoring pipeline)
    riskScore: number;
    dilutionScore: number;
    score: number;
    
    // Price tracking (for profit taking)
    currentPrice: number;
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
        const liq = typeof raw.liquidity === 'string' ? parseFloat(raw.liquidity) : raw.liquidity;

        return {
            // NormalizedPool fields (canonical interface)
            address: raw.address,
            name: raw.name,
            tokenX: raw.mint_x,
            tokenY: raw.mint_y,
            liquidity: liq || 0,
            volume24h: vol24,
            apr: raw.apr || 0,
            fees24h: raw.fees_24h || 0,
            
            // Pool extension fields
            mintX: raw.mint_x,
            mintY: raw.mint_y,
            volume1h: vol1h,
            volume4h: vol4h,
            velocity: calculateVelocity(vol1h, vol4h, vol24),
            binStep: raw.bin_step || 0,
            baseFee: parseFloat(raw.base_fee_percentage || '0'),
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
