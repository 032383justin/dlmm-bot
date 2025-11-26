import { Pool } from '../core/normalizePools';

export interface DLMMPoolConfig {
    name: string;
    poolId: string;
}

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

            // Token info
            mintX: '', // Will be enriched if needed
            mintY: '', // Will be enriched if needed

            // Liquidity & Volume (defaults - will be enriched)
            liquidity: 1_000_000, // Default value
            volume1h: 100_000,
            volume4h: 400_000,
            volume24h: 1_000_000,
            velocity: 0.5, // Moderate velocity default

            // Fees & APR
            fees24h: 1000,
            apr: 10,

            // DLMM specific
            binStep: 25, // Common bin step
            baseFee: 0.003, // 0.3% default

            // Metadata
            createdAt: Date.now() - (30 * 24 * 60 * 60 * 1000), // 30 days ago default
            holderCount: 1000, // Default
            topHolderPercent: 10, // Default
            isRenounced: true, // Assume renounced

            // Scores (will be calculated)
            riskScore: 0,
            dilutionScore: 0,
            score: 0,

            // Price
            currentPrice: 1.0, // Default

            // Bins
            binCount: 50 // Default
        };
    });
}
