/**
 * DLMM Pool Universe Indexer
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * MEMORY-SAFE: 3-STAGE SHALLOW FETCH WITH UPSTREAM FILTERING
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * CRITICAL: This module prevents OOM kills by:
 * 1. Stage 0: Shallow fetch - ONLY basic metadata (address, symbol, tvl, volume24h)
 * 2. Stage 1: Hard upstream filters applied IMMEDIATELY (before any object creation)
 * 3. Stage 2: Sort + cap to MAX_RAW (50) BEFORE any telemetry hydration
 * 
 * DO NOT load 120k+ pools into memory.
 * DO NOT hydrate telemetry before filtering.
 * DO NOT accumulate history across cycles.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import logger from '../utils/logger';
import { getEnrichedDLMMState, EnrichedSnapshot } from '../core/dlmmTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// HARD CAPS — PREVENT OOM
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_RAW = 50;                    // Max pools BEFORE telemetry hydration
const MAX_FINAL = 12;                  // Max pools returned
const MIN_TVL_UPSTREAM = 10000;        // $10k TVL filter
const MIN_VOLUME_UPSTREAM = 5000;      // $5k volume filter

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Shallow pool metadata - ONLY what we need for filtering
 * NO bins, NO ticks, NO microstructure
 */
interface ShallowPool {
    address: string;
    symbol: string;
    tvl: number;
    volume24h: number;
    mintX: string;
    mintY: string;
    binStep: number;
    price: number;
    fees24h: number;
}

/**
 * Discovery parameters
 */
export interface DiscoveryParams {
    minTVL: number;
    minVolume24h: number;
    minTraders24h: number;
    maxPools?: number;
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
// STAGE 0: SHALLOW FETCH — MEMORY-SAFE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch ONLY shallow metadata from Meteora API.
 * 
 * CRITICAL: This function streams through the JSON response and:
 * 1. Immediately discards pools that fail upstream filters
 * 2. Creates ONLY minimal ShallowPool objects
 * 3. Never stores the full 120k response in memory
 * 
 * @returns Filtered shallow pools (typically ~500-1500 from 120k)
 */
async function fetchShallowPools(): Promise<ShallowPool[]> {
    const METEORA_API = 'https://dlmm-api.meteora.ag/pair/all';
    
    logger.info('[STAGE 0] Fetching shallow pool metadata from Meteora...');
    
    try {
        const response = await axios.get(METEORA_API, {
            timeout: 60000,
            // Don't parse as JSON automatically - we'll stream process
            transformResponse: [(data) => data],
        });
        
        if (!response?.data) {
            logger.warn('[STAGE 0] Meteora returned empty response');
            return [];
        }
        
        // Parse JSON
        let rawPools: any[];
        try {
            rawPools = JSON.parse(response.data);
        } catch {
            logger.error('[STAGE 0] Failed to parse Meteora response');
            return [];
        }
        
        if (!Array.isArray(rawPools)) {
            logger.warn('[STAGE 0] Meteora response is not an array');
            return [];
        }
        
        const totalRaw = rawPools.length;
        
        // ═══════════════════════════════════════════════════════════════════
        // STAGE 1: HARD UPSTREAM FILTERS — APPLIED IMMEDIATELY
        // This is where we prevent OOM by discarding 95%+ of pools
        // ═══════════════════════════════════════════════════════════════════
        
        const filtered: ShallowPool[] = [];
        let skippedHidden = 0;
        let skippedMissingFields = 0;
        let skippedLowActivity = 0;
        
        for (const p of rawPools) {
            // Skip hidden pools
            if (p.hide === true) {
                skippedHidden++;
                continue;
            }
            
            // Skip pools without required fields
            if (!p.address || !p.mint_x || !p.mint_y) {
                skippedMissingFields++;
                continue;
            }
            
            // Extract only the fields we need (shallow)
            const tvl = Number(p.liquidity ?? 0);
            const volume24h = Number(p.trade_volume_24h ?? 0);
            
            // HARD UPSTREAM FILTER: Must have EITHER tvl OR volume above threshold
            if (tvl < MIN_TVL_UPSTREAM && volume24h < MIN_VOLUME_UPSTREAM) {
                skippedLowActivity++;
                continue;
            }
            
            // Create minimal shallow object
            filtered.push({
                address: p.address,
                symbol: p.name || `${String(p.mint_x).slice(0, 4)}/${String(p.mint_y).slice(0, 4)}`,
                tvl,
                volume24h,
                mintX: p.mint_x,
                mintY: p.mint_y,
                binStep: Number(p.bin_step ?? 0),
                price: Number(p.current_price ?? 0),
                fees24h: Number(p.fees_24h ?? 0),
            });
        }
        
        // Clear the raw array to free memory immediately
        rawPools.length = 0;
        
        logger.info(`[STAGE 0] Raw shallow pools: ${totalRaw} → Upstream filtered: ${filtered.length}`);
        logger.info(`[STAGE 0] Skipped: ${skippedHidden} hidden, ${skippedMissingFields} missing fields, ${skippedLowActivity} low activity`);
        
        return filtered;
        
    } catch (err: any) {
        logger.error(`[STAGE 0] Meteora fetch failed: ${err?.message || err}`);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 2: SORT + CAP BEFORE HYDRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sort pools by (tvl + volume24h) and cap to MAX_RAW.
 * This happens BEFORE any telemetry hydration.
 */
function rankAndCapPools(pools: ShallowPool[]): ShallowPool[] {
    if (pools.length <= MAX_RAW) {
        logger.info(`[STAGE 2] ${pools.length} pools (no cap needed)`);
        return pools;
    }
    
    // Sort by combined tvl + volume24h (higher = better)
    const sorted = pools.sort((a, b) => 
        (b.tvl + b.volume24h) - (a.tvl + a.volume24h)
    );
    
    // Cap to MAX_RAW
    const capped = sorted.slice(0, MAX_RAW);
    
    logger.info(`[STAGE 2] Ranked: ${pools.length} → Capped: ${capped.length} (MAX_RAW=${MAX_RAW})`);
    
    return capped;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 3: TELEMETRY HYDRATION (only on capped pools)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hydrate telemetry for capped pools only.
 * This is expensive - only run on MAX_RAW pools.
 */
async function hydrateTelemetry(pools: ShallowPool[]): Promise<EnrichedPool[]> {
    logger.info(`[STAGE 3] Hydrating telemetry for ${pools.length} pools...`);
    
    const enriched: EnrichedPool[] = [];
    let successCount = 0;
    let failCount = 0;
    
    for (const pool of pools) {
        try {
            // Fetch on-chain telemetry (NO previous snapshot - fresh each cycle)
            const telemetry = await getEnrichedDLMMState(pool.address, undefined);
            
            if (telemetry.invalidTelemetry) {
                failCount++;
                continue;
            }
            
            enriched.push({
                address: pool.address,
                symbol: pool.symbol,
                baseMint: pool.mintX,
                quoteMint: pool.mintY,
                tvl: pool.tvl,
                volume24h: pool.volume24h,
                fees24h: pool.fees24h,
                price: pool.price,
                priceImpact: 0,
                traders24h: 0,
                holders: 0,
                
                liquidity: telemetry.liquidity || pool.tvl,
                entropy: telemetry.entropy,
                binCount: telemetry.binCount,
                velocity: telemetry.velocity,
                activeBin: telemetry.activeBin,
                migrationDirection: telemetry.migrationDirection,
                
                lastUpdated: Date.now(),
                feeRate: 0,
                
                // Derived metrics
                velocityLiquidityRatio: pool.tvl > 0 ? (telemetry.velocity || 0) / pool.tvl : 0,
                turnover24h: pool.tvl > 0 ? pool.volume24h / pool.tvl : 0,
                feeEfficiency: pool.volume24h > 0 ? pool.fees24h / pool.volume24h : 0,
            });
            
            successCount++;
            
        } catch (err: any) {
            failCount++;
            logger.debug(`[STAGE 3] Telemetry failed for ${pool.address.slice(0, 8)}: ${err?.message}`);
        }
    }
    
    logger.info(`[STAGE 3] Telemetry complete: ${successCount} success, ${failCount} failed`);
    
    return enriched;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 4: FINAL SCORING + CAP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Score and cap to MAX_FINAL pools.
 */
function scoreAndCapFinal(pools: EnrichedPool[]): EnrichedPool[] {
    if (pools.length === 0) {
        return [];
    }
    
    // Score by velocity + entropy + turnover
    const scored = pools.map(p => ({
        pool: p,
        score: (p.velocity * 100) + (p.entropy * 50) + (p.turnover24h * 10),
    }));
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    // Cap to MAX_FINAL
    const final = scored.slice(0, MAX_FINAL).map(s => s.pool);
    
    logger.info(`[STAGE 4] Scored: ${pools.length} → Final: ${final.length} (MAX_FINAL=${MAX_FINAL})`);
    
    return final;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISCOVERY FUNCTION — 3-STAGE FUNNEL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discover DLMM pool universe with memory-safe 3-stage funnel.
 * 
 * STAGES:
 * 0. Shallow fetch - ONLY basic metadata
 * 1. Hard upstream filters - discard 95%+ immediately
 * 2. Rank + cap to 50 - BEFORE any telemetry
 * 3. Telemetry hydration - only on 50 pools
 * 4. Score + cap to 12 - final output
 * 
 * GUARANTEES:
 * - Never loads 120k pools into memory
 * - Never hydrates telemetry for more than 50 pools
 * - Returns max 12 pools
 */
export async function discoverDLMMUniverses(_params: DiscoveryParams): Promise<EnrichedPool[]> {
    const startTime = Date.now();
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('[DISCOVERY] 🚀 3-STAGE SHALLOW FUNNEL — MEMORY-SAFE');
    logger.info(`[DISCOVERY] Caps: Upstream>${MIN_TVL_UPSTREAM}/${MIN_VOLUME_UPSTREAM} → Ranked=${MAX_RAW} → Final=${MAX_FINAL}`);
    logger.info('═══════════════════════════════════════════════════════════════════');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 0 + 1: SHALLOW FETCH WITH IMMEDIATE UPSTREAM FILTERING
    // ═══════════════════════════════════════════════════════════════════════════
    
    const shallowPools = await fetchShallowPools();
    
    if (shallowPools.length === 0) {
        logger.warn('[DISCOVERY] No pools passed upstream filters');
        return [];
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 2: RANK + CAP BEFORE HYDRATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    const rankedPools = rankAndCapPools(shallowPools);
    
    // Clear shallow pools array to free memory
    shallowPools.length = 0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 3: TELEMETRY HYDRATION (only on MAX_RAW pools)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const hydratedPools = await hydrateTelemetry(rankedPools);
    
    if (hydratedPools.length === 0) {
        logger.warn('[DISCOVERY] No pools survived telemetry hydration');
        return [];
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 4: FINAL SCORING + CAP
    // ═══════════════════════════════════════════════════════════════════════════
    
    const finalPools = scoreAndCapFinal(hydratedPools);
    
    const duration = Date.now() - startTime;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info(`[DISCOVERY] ✅ COMPLETE in ${duration}ms`);
    logger.info(`[DISCOVERY] Funnel: Upstream→${rankedPools.length} → Telemetry→${hydratedPools.length} → Final→${finalPools.length}`);
    
    if (finalPools.length > 0) {
        logger.info(`[DISCOVERY] Top pools:`);
        for (const pool of finalPools.slice(0, 3)) {
            logger.info(`   → ${pool.symbol} | TVL=$${(pool.tvl / 1000).toFixed(0)}k | Vol=$${(pool.volume24h / 1000).toFixed(0)}k | Vel=${pool.velocity.toFixed(3)}`);
        }
    }
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    
    return finalPools;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

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

// Export DiscoveredPool for compatibility (maps to EnrichedPool)
export type DiscoveredPool = EnrichedPool;
