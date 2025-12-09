/**
 * DLMM Pool Universe Indexer
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * MEMORY-SAFE: Uses 3-stage funnel from poolDiscovery
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Flow:
 * 1. Call discoverPools() which returns max 12 pools
 * 2. Convert to EnrichedPool format
 * 3. Return immediately - no caching
 * 
 * MEMORY SAFETY:
 * - NO local cache
 * - NO telemetry history
 * - Returns only what poolDiscovery provides
 * - All objects GC eligible after return
 */

import logger from '../utils/logger';
import { 
    discoverPools, 
    DiscoveredPool, 
    DEFAULT_DISCOVERY_CONFIG,
    discoveredPoolToPool,
} from './poolDiscovery';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discovery parameters (simplified - limits handled by poolDiscovery)
 */
export interface DiscoveryParams {
    minTVL: number;
    minVolume24h: number;
    minTraders24h: number;
    maxPools?: number;  // IGNORED - poolDiscovery enforces MAX_FINAL=12
}

/**
 * Enriched pool ready for scoring pipeline
 */
export interface EnrichedPool {
    address: string;
    symbol: string;
    baseMint: string;
    quoteMint: string;
    tvl: number;
    volume24h: number;
    fees24h: number;
    price: number;
    priceImpact: number;
    traders24h: number;
    holders: number;
    
    // On-chain telemetry
    liquidity: number;
    entropy: number;
    binCount: number;
    velocity: number;
    activeBin: number;
    migrationDirection: 'in' | 'out' | 'stable';
    
    // Metadata
    lastUpdated: number;
    feeRate: number;
    
    // Computed scores for priority sorting
    velocityLiquidityRatio: number;
    turnover24h: number;
    feeEfficiency: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISCOVERY FUNCTION — MEMORY-SAFE PASSTHROUGH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discover and enrich DLMM pool universe.
 * 
 * MEMORY SAFETY:
 * - Delegates to poolDiscovery.discoverPools() 
 * - No local caching
 * - No history accumulation
 * - Returns max 12 pools per call
 * 
 * @param _params - Discovery parameters (IGNORED - limits are in poolDiscovery)
 * @returns EnrichedPool[] - Max 12 pools per cycle
 */
export async function discoverDLMMUniverses(_params: DiscoveryParams): Promise<EnrichedPool[]> {
    logger.info('[INDEXER] ► Memory-safe discovery invoked');
    
    // Get pools from 3-stage funnel (max 12)
    const discovered = await discoverPools(DEFAULT_DISCOVERY_CONFIG);
    
    if (!discovered || discovered.length === 0) {
        logger.warn('[INDEXER] No discovered pools');
        return [];
    }
    
    // Convert to EnrichedPool format
    const enriched: EnrichedPool[] = discovered.map((dp: DiscoveredPool) => ({
        address: dp.id,
        symbol: dp.symbol || `${dp.mintA.slice(0, 4)}/${dp.mintB.slice(0, 4)}`,
        baseMint: dp.mintA,
        quoteMint: dp.mintB,
        tvl: dp.tvl,
        volume24h: dp.volume24h,
        fees24h: dp.fees24h,
        price: dp.price,
        priceImpact: 0,
        traders24h: dp.uniqueSwappers24h,
        holders: 0,
        
        liquidity: dp.telemetry?.liquidity || dp.tvl,
        entropy: dp.poolEntropy,
        binCount: dp.telemetry?.binCount || 0,
        velocity: dp.swapVelocity,
        activeBin: dp.activeBin || dp.telemetry?.activeBin || 0,
        migrationDirection: dp.telemetry?.migrationDirection || 'stable',
        
        lastUpdated: Date.now(),
        feeRate: 0,
        
        // Calculate derived metrics
        velocityLiquidityRatio: dp.tvl > 0 ? dp.swapVelocity / dp.tvl : 0,
        turnover24h: dp.tvl > 0 ? dp.volume24h / dp.tvl : 0,
        feeEfficiency: dp.volume24h > 0 ? dp.fees24h / dp.volume24h : 0,
    }));
    
    logger.info(`[INDEXER] Returning ${enriched.length} pools (max 12)`);
    
    return enriched;
}

/**
 * Force refresh - NO-OP (no cache)
 */
export function invalidatePoolCache(): void {
    logger.info('[INDEXER] 🔄 No cache to invalidate (memory-safe mode)');
}

/**
 * Get cache status - always uncached
 */
export function getCacheStatus(): { cached: boolean; age: number; poolCount: number } {
    return { cached: false, age: 0, poolCount: 0 };
}

/**
 * Convert EnrichedPool to Pool type for compatibility with scoring pipeline
 */
export function enrichedPoolToPool(enriched: EnrichedPool): any {
    return {
        // Core identification
        address: enriched.address,
        name: enriched.symbol,
        tokenX: enriched.baseMint,
        tokenY: enriched.quoteMint,
        mintX: enriched.baseMint,
        mintY: enriched.quoteMint,
        
        // Telemetry
        liquidity: enriched.tvl,
        volume24h: enriched.volume24h,
        volume1h: enriched.volume24h / 24,
        volume4h: enriched.volume24h / 6,
        velocity: enriched.velocity,
        fees24h: enriched.fees24h,
        apr: enriched.tvl > 0 ? (enriched.fees24h * 365) / enriched.tvl * 100 : 0,
        
        // DLMM structure
        binStep: 0,
        baseFee: enriched.feeRate,
        binCount: enriched.binCount,
        
        // On-chain data
        entropy: enriched.entropy,
        migrationDirection: enriched.migrationDirection,
        onChainLiquidity: enriched.liquidity,
        activeBin: enriched.activeBin,
        
        // Metadata
        createdAt: 0,
        holderCount: enriched.holders,
        topHolderPercent: 0,
        isRenounced: true,
        
        // Scores
        riskScore: 0,
        dilutionScore: 0,
        score: 0,
        
        // Price
        currentPrice: enriched.price,
    };
}

// Re-export for compatibility
export { DiscoveredPool } from './poolDiscovery';
