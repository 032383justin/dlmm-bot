import { RawPoolData } from './scanPools';
import { calculateVelocity } from '../utils/math';
import { batchFetchVolumeData } from '../utils/dexscreener';
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

    logger.info(`Fetching real volume data for ${solPools.length} pools from DexScreener...`);

    // Fetch real volume data for all pools (with rate limiting)
    const poolAddresses = solPools.map(p => p.address);
    const volumeDataMap = await batchFetchVolumeData(poolAddresses, 100); // 100ms delay between requests

    return solPools.map((raw) => {
        const realData = volumeDataMap.get(raw.address);

        // Use real data if available, fallback to Meteora data
        const volume1h = realData?.volume1h ?? (raw.trade_volume_24h / 24);
        const volume4h = realData?.volume4h ?? (raw.trade_volume_24h / 6);
        const volume24h = realData?.volume24h ?? raw.trade_volume_24h;
        const currentPrice = realData?.currentPrice ?? raw.current_price ?? 0;
        const createdAt = realData?.createdAt ?? (Date.now() - (3 * 24 * 60 * 60 * 1000)); // Fallback to 3 days ago
        const liquidity = realData?.liquidity ?? parseFloat(raw.liquidity) ?? 0;

        // Log if using fallback data
        if (!realData) {
            logger.warn(`Using fallback data for ${raw.name} - DexScreener data unavailable`);
        }

        return {
            address: raw.address,
            name: raw.name,
            mintX: raw.mint_x,
            mintY: raw.mint_y,
            liquidity: liquidity,
            volume1h: volume1h,
            volume4h: volume4h,
            volume24h: volume24h,
            velocity: calculateVelocity(volume1h, volume4h, volume24h),
            fees24h: raw.fees_24h,
            apr: raw.apr,
            binStep: raw.bin_step,
            baseFee: parseFloat(raw.base_fee_percentage),
            createdAt: createdAt,
            holderCount: 0, // TODO: Fetch from Helius
            topHolderPercent: 0, // TODO: Fetch from Helius
            isRenounced: true, // TODO: Fetch from Helius
            riskScore: 0,
            dilutionScore: 0,
            score: 0,
            currentPrice: currentPrice,
            binCount: 0 // TODO: Fetch from Meteora detailed endpoint
        };
    });
};
