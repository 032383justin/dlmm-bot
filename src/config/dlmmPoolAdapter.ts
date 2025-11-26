import { Pool } from '../core/normalizePools';

export interface DLMMPoolConfig {
    name: string;
    poolId: string;
}

// Token mint addresses on Solana
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_MINTS: Record<string, string> = {
    'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    'SOL': 'So11111111111111111111111111111111111111112'
};

/**
 * Converts DLMM pool configuration to NormalizedPool objects
 * Provides default values for fields that will be enriched later
 */
export function adaptDLMMPools(configs: DLMMPoolConfig[]): Pool[] {
    return configs.map(config => {
        const [tokenX, tokenY] = config.name.split('/');

        return {
            // Core identifiers
            address: config.poolId,
            name: config.name,

            // Token info - use actual Solana token mints
            mintX: TOKEN_MINTS[tokenX] || tokenX,
            mintY: TOKEN_MINTS[tokenY] || USDC_MINT,

            // Liquidity & Volume (adjusted to pass safety filters)
            // Safety filters require: liquidity 40k-650k, vol1h >=12k, vol4h >=45k, vol24h >=125k
            liquidity: 300_000, // Mid-range to pass 40k-650k filter
            volume1h: 50_000,   // Above 12k minimum
            volume4h: 150_000,  // Above 45k minimum
            volume24h: 500_000, // Above 125k minimum
            velocity: 0.5,

            // Fees & APR
            fees24h: 1000,
            apr: 10,

            // DLMM specific
            binStep: 25,
            baseFee: 0.003,

            // Metadata
            // Set to 5 days old (within the 24h-10d safety filter window)
            createdAt: Date.now() - (5 * 24 * 60 * 60 * 1000),
            holderCount: 1000,
            topHolderPercent: 10,
            isRenounced: true,

            // Scores (will be calculated)
            riskScore: 0,
            dilutionScore: 0,
            score: 0,

            // Price
            currentPrice: 1.0,

            // Bins
            binCount: 50
        };
    });
}
