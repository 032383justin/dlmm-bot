/**
 * DLMM Pool Universe Indexer
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * UPGRADED: Dynamic multi-source discovery with no static caps
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * NEW Flow:
 * 1. Multi-source discovery (DLMM SDK, Helius, Raydium)
 * 2. Pre-tier micro-signal filtering (discard at ingest)
 * 3. Market depth validation
 * 4. Time-weighted scoring
 * 5. Dynamic cache with rotation
 * 
 * Pre-Tier Thresholds (discard at ingest - NEVER reach Tier4):
 * - swapVelocity < 0.12 → DISCARD
 * - poolEntropy < 0.65 → DISCARD  
 * - liquidityFlow < 0.5% → DISCARD
 * - 24h volume < $75,000 → DISCARD
 * 
 * Market Depth Requirements:
 * - TVL >= $200,000
 * - 24h unique swappers >= 35
 * - Median trade size > $75
 * 
 * NO STATIC LIMITS. NO LIMIT 30. Dynamic discovery only.
 */

import axios from 'axios';
import logger from '../utils/logger';
import { getEnrichedDLMMState, EnrichedSnapshot } from '../core/dlmmTelemetry';
import { fetchDLMMPools, DLMM_Pool } from './dlmmFetcher';
import { 
    discoverPools, 
    DiscoveredPool, 
    DEFAULT_DISCOVERY_CONFIG,
    getDiscoveryCacheStatus,
    invalidateDiscoveryCache,
    discoveredPoolToPool,
} from './poolDiscovery';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discovery parameters for filtering pools
 */
export interface DiscoveryParams {
    minTVL: number;           // Minimum TVL in USDC ($200,000 per spec)
    minVolume24h: number;     // Minimum 24h volume ($75,000 per spec)
    minTraders24h: number;    // Minimum unique traders (35 per spec)
    // maxPools is DEPRECATED - NO STATIC LIMITS
    // Dynamic discovery handles universe size with pre-tier filtering
    maxPools?: number;        // IGNORED - kept for backwards compatibility only
}


/**
 * Birdeye enrichment data
 */
interface BirdeyeEnrichment {
    volume24h: number;
    fees24h: number;
    price: number;
    priceImpact: number;
    traders24h: number;
    holders: number;
    changes24h: number;
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
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalized DLMM pool interface
 */
export interface DlmmPoolNormalized {
    id: string;
    mintA: string;
    mintB: string;
    price: number;
    volume24h: number;
    liquidity: number;
    activeBin: number;
    binStep: number;
    feeRate: number;
    symbol: string;
}

// Birdeye API
const BIRDEYE_API_BASE = 'https://public-api.birdeye.so';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';

// Known token mints
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Cache - NOW USES DYNAMIC DISCOVERY CACHE
interface PoolCache {
    pools: EnrichedPool[];
    timestamp: number;
    discoveryParams: DiscoveryParams;
}

let poolCache: PoolCache | null = null;
const CACHE_DURATION_MS = 12 * 60 * 1000; // 12 minutes (10-15 minute range per spec)

// ═══════════════════════════════════════════════════════════════════════════════
// RELAXED GUARDRAILS - Most filtering happens upstream in poolDiscovery.ts
// These are SOFT fallback guardrails, NOT hard blocks
// Pools that pass pre-tier can fail here only on critical issues
// ═══════════════════════════════════════════════════════════════════════════════
import {
    ENRICHED_THRESHOLDS,
    MICROSTRUCTURE_ONLY_THRESHOLDS,
} from '../config/discovery';

const GUARDRAILS = {
    // RELAXED: These are soft minimums, not hard blocks
    // Real filtering is done by conditional pre-tier in poolDiscovery.ts
    minTVL: 50000,            // $50k minimum (relaxed from $200k - soft guard)
    minVolume24h: 10000,      // $10k minimum (relaxed from $75k - soft guard)
    minEntropy: 0.35,         // 0.35 minimum (relaxed from 0.65 - soft guard)
    minBinCount: 3,           // Minimum 3 bins (relaxed from 5)
    minTraders24h: 5,         // 5 unique swappers (relaxed from 35 - soft guard)
};

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: HARD SAFETY FILTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply hard safety filters before enrichment
 */
function applyHardSafetyFilter(pools: DlmmPoolNormalized[], params: DiscoveryParams): DlmmPoolNormalized[] {
    const filtered: DlmmPoolNormalized[] = [];
    
    for (const pool of pools) {
        // 1. TVL/Liquidity check
        if (pool.liquidity < params.minTVL) {
            continue;
        }
        
        // 2. Redundant pair check (SOL/SOL)
        if (pool.mintA === WRAPPED_SOL && pool.mintB === WRAPPED_SOL) {
            continue;
        }
        
        // 3. Basic sanity checks
        if (!pool.id || !pool.mintA || !pool.mintB) {
            continue;
        }
        
        filtered.push(pool);
    }
    
    logger.info(`🔍 [UNIVERSE] ${filtered.length} pools passed hard safety filter (from ${pools.length})`);
    
    return filtered;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: BIRDEYE ENRICHMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch Birdeye data for a single pool
 */
async function fetchBirdeyePoolData(poolAddress: string): Promise<BirdeyeEnrichment | null> {
    if (!BIRDEYE_API_KEY) {
        logger.warn('[BIRDEYE] No API key configured');
        return null;
    }
    
    try {
        // Fetch pair overview
        const response = await axios.get(`${BIRDEYE_API_BASE}/defi/v3/pair/overview/single`, {
            params: { address: poolAddress },
            headers: {
                'X-API-KEY': BIRDEYE_API_KEY,
                'Accept': 'application/json',
            },
            timeout: 5000,
        });
        
        if (!response.data?.success || !response.data?.data) {
            return null;
        }
        
        const data = response.data.data;
        
        return {
            volume24h: data.volume24h || 0,
            fees24h: data.fee24h || 0,
            price: data.price || 0,
            priceImpact: data.priceImpact || 0,
            traders24h: data.uniqueWallet24h || data.trader24h || 0,
            holders: data.holder || 0,
            changes24h: data.priceChange24h || 0,
        };
        
    } catch (error) {
        return null;
    }
}

/**
 * Batch fetch Birdeye data with rate limiting
 */
async function batchFetchBirdeyeData(
    pools: DlmmPoolNormalized[],
    batchSize: number = 10,
    delayMs: number = 100
): Promise<Map<string, BirdeyeEnrichment>> {
    const results = new Map<string, BirdeyeEnrichment>();
    
    logger.info(`📊 [BIRDEYE] Enriching ${pools.length} pools in batches of ${batchSize}...`);
    
    for (let i = 0; i < pools.length; i += batchSize) {
        const batch = pools.slice(i, i + batchSize);
        
        // Fetch batch in parallel
        const batchPromises = batch.map(async (pool) => {
            const data = await fetchBirdeyePoolData(pool.id);
            if (data) {
                results.set(pool.id, data);
            }
        });
        
        await Promise.all(batchPromises);
        
        // Rate limit between batches
        if (i + batchSize < pools.length) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    
    logger.info(`📊 [BIRDEYE] Enriched ${results.size}/${pools.length} pools`);
    
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: ON-CHAIN TELEMETRY ENRICHMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Enrich pool with on-chain DLMM telemetry
 */
async function enrichWithTelemetry(
    poolAddress: string,
    previousSnapshot?: EnrichedSnapshot
): Promise<EnrichedSnapshot | null> {
    try {
        const snapshot = await getEnrichedDLMMState(poolAddress, previousSnapshot);
        
        // Check for invalid telemetry
        if (snapshot.invalidTelemetry) {
            return null;
        }
        
        // Validate required fields
        if (snapshot.liquidity <= 0 || snapshot.binCount <= 0 || snapshot.activeBin === 0) {
            return null;
        }
        
        return snapshot;
        
    } catch (error) {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GUARDRAILS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply guardrails to enriched pool
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONDITIONAL GUARDRAILS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Guardrails are applied CONDITIONALLY based on enrichment status:
 * - Pools WITH enrichment: Full guardrails apply
 * - Pools WITHOUT enrichment: Only critical microstructure guardrails apply
 *   (TVL, Volume, Traders checks are SKIPPED)
 */
function applyGuardrails(pool: EnrichedPool, params: DiscoveryParams, hasRealEnrichment: boolean): { passed: boolean; reason?: string } {
    // Use the EXPLICIT enrichment flag passed in (not derived from pool values)
    const poolHasEnrichment = hasRealEnrichment;
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // CRITICAL GUARDRAILS (always apply)
    // These are fundamental validity checks, not market depth filters
    // ═══════════════════════════════════════════════════════════════════════════════
    
    // Bin count check - must have valid bin structure
    if (pool.binCount < GUARDRAILS.minBinCount) {
        return { passed: false, reason: `BinCount ${pool.binCount} < ${GUARDRAILS.minBinCount}` };
    }
    
    // Active bin check - must have an active bin
    if (pool.activeBin === 0) {
        return { passed: false, reason: 'ActiveBin is 0' };
    }
    
    // Entropy check (use relaxed threshold for microstructure-only)
    const entropyThreshold = poolHasEnrichment 
        ? ENRICHED_THRESHOLDS.poolEntropy 
        : MICROSTRUCTURE_ONLY_THRESHOLDS.poolEntropy;
    if (pool.entropy < entropyThreshold) {
        return { passed: false, reason: `Entropy ${pool.entropy.toFixed(4)} < ${entropyThreshold}` };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // CONDITIONAL GUARDRAILS (only when enrichment available)
    // Skip these for microstructure-only pools to avoid over-filtering
    // ═══════════════════════════════════════════════════════════════════════════════
    
    if (poolHasEnrichment) {
        // TVL check
        if (pool.tvl < params.minTVL) {
            return { passed: false, reason: `TVL $${pool.tvl.toFixed(0)} < $${params.minTVL}` };
        }
        
        // Volume check
        if (pool.volume24h < params.minVolume24h) {
            return { passed: false, reason: `Volume $${pool.volume24h.toFixed(0)} < $${params.minVolume24h}` };
        }
        
        // Migration check - only block on "out" if enrichment confirms it
        if (pool.migrationDirection === 'out') {
            return { passed: false, reason: 'Migration direction is OUT' };
        }
        
        // Traders check
        if (pool.traders24h < params.minTraders24h) {
            return { passed: false, reason: `Traders ${pool.traders24h} < ${params.minTraders24h}` };
        }
    }
    
    // Pool passes guardrails
    return { passed: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIORITY SORTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate priority scores and sort pools
 */
function sortByPriority(pools: EnrichedPool[]): EnrichedPool[] {
    // Calculate derived metrics
    for (const pool of pools) {
        // Velocity/Liquidity ratio (higher = more active relative to size)
        pool.velocityLiquidityRatio = pool.liquidity > 0 
            ? pool.velocity / pool.liquidity 
            : 0;
        
        // 24h turnover (volume/tvl)
        pool.turnover24h = pool.tvl > 0 
            ? pool.volume24h / pool.tvl 
            : 0;
        
        // Fee efficiency (fees/volume)
        pool.feeEfficiency = pool.volume24h > 0 
            ? pool.fees24h / pool.volume24h 
            : 0;
    }
    
    // Multi-factor sorting
    return pools.sort((a, b) => {
        // Composite score based on priority order:
        // 1. Velocity/Liquidity ratio (40%)
        // 2. Entropy stability (20%)
        // 3. 24h turnover (20%)
        // 4. Fee efficiency (20%)
        
        const scoreA = (
            (a.velocityLiquidityRatio * 0.4) +
            (a.entropy * 0.2) +
            (Math.min(a.turnover24h, 10) / 10 * 0.2) +
            (Math.min(a.feeEfficiency, 0.01) / 0.01 * 0.2)
        );
        
        const scoreB = (
            (b.velocityLiquidityRatio * 0.4) +
            (b.entropy * 0.2) +
            (Math.min(b.turnover24h, 10) / 10 * 0.2) +
            (Math.min(b.feeEfficiency, 0.01) / 0.01 * 0.2)
        );
        
        return scoreB - scoreA;
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISCOVERY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

// Telemetry snapshot history for velocity computation
const telemetryHistory: Map<string, EnrichedSnapshot> = new Map();

/**
 * Discover and enrich DLMM pool universe
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * UPGRADED: Uses new multi-source dynamic discovery pipeline
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * NO STATIC LIMITS. NO LIMIT 30. NO maxPools cap.
 * 
 * Pre-tier filtering happens upstream in poolDiscovery.ts:
 * - Pools with swapVelocity < 0.12 NEVER reach this function
 * - Pools with poolEntropy < 0.65 NEVER reach this function
 * - Pools with liquidityFlow < 0.5% NEVER reach this function
 * - Pools with 24h volume < $75k NEVER reach this function
 * 
 * CRITICAL: This function NEVER throws. On ANY error, returns empty array.
 * 
 * @param params - Discovery parameters (minTVL, minVolume24h, minTraders24h) - NOW MOSTLY IGNORED
 * @returns EnrichedPool[] - Validated and enriched pools (or empty array on failure)
 */
export async function discoverDLMMUniverses(params: DiscoveryParams): Promise<EnrichedPool[]> {
    logger.info('[DISCOVERY] 🚀 discoverDLMMUniverses invoked (UPGRADED PIPELINE)');
    const startTime = Date.now();
    
    try {
        // ═══════════════════════════════════════════════════════════════════════
        // NEW: Use dynamic multi-source discovery pipeline
        // NO STATIC CAPS, NO LIMIT 30, FULL UNIVERSE SCAN
        // ═══════════════════════════════════════════════════════════════════════
        
        const cacheStatus = getDiscoveryCacheStatus();
        if (cacheStatus.cached) {
            logger.info(`📦 [UNIVERSE] Using cached pool universe (${cacheStatus.poolCount} pools, age: ${Math.round(cacheStatus.age / 1000)}s)`);
        }
        
        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info('🌐 [UNIVERSE] Starting DYNAMIC multi-source discovery...');
        logger.info('   PRE-TIER FILTERS ACTIVE (pools filtered BEFORE this point):');
        logger.info(`     - swapVelocity >= 0.12`);
        logger.info(`     - poolEntropy >= 0.65`);
        logger.info(`     - liquidityFlow >= 0.5%`);
        logger.info(`     - volume24h >= $75,000`);
        logger.info('   MARKET DEPTH REQUIREMENTS:');
        logger.info(`     - TVL >= $200,000`);
        logger.info(`     - uniqueSwappers24h >= 35`);
        logger.info(`     - medianTradeSize >= $75`);
        logger.info('   NO STATIC LIMITS. NO LIMIT 30. DYNAMIC DISCOVERY ONLY.');
        logger.info('═══════════════════════════════════════════════════════════════════');
        
        // Fetch from new discovery pipeline (pre-tier filtered)
        const discoveredPools = await discoverPools(DEFAULT_DISCOVERY_CONFIG);
        
        if (!Array.isArray(discoveredPools) || discoveredPools.length === 0) {
            logger.warn('[DISCOVERY] ⚠️ EMPTY universe — retry next cycle');
            return [];
        }
        
        logger.info(`[DISCOVERY] ✅ Dynamic discovery returned ${discoveredPools.length} pre-filtered pools`);
        
        // ═══════════════════════════════════════════════════════════════════════
        // CONVERT TO ENRICHED POOL FORMAT
        // Pre-tier filtering already done upstream - these are quality pools
        // ═══════════════════════════════════════════════════════════════════════
        
        const enrichedPools: EnrichedPool[] = [];
        let convertedCount = 0;
        let skippedCount = 0;
        
        for (const discovered of discoveredPools) {
            try {
                // Skip unhealthy pools (time-weighted detection)
                if (!discovered.isHealthy) {
                    skippedCount++;
                    continue;
                }
                
                // Get previous telemetry for this pool
                const prevSnapshot = telemetryHistory.get(discovered.id);
                
                // Use existing telemetry from discovery if available
                const telemetry = discovered.telemetry || await enrichWithTelemetry(discovered.id, prevSnapshot);
                
                if (!telemetry || telemetry.invalidTelemetry) {
                    skippedCount++;
                    continue;
                }
                
                // Store for next cycle
                telemetryHistory.set(discovered.id, telemetry);
                
                // Build enriched pool
                const enrichedPool: EnrichedPool = {
                    address: discovered.id,
                    symbol: discovered.symbol || `${discovered.mintA.slice(0, 6)}/${discovered.mintB.slice(0, 6)}`,
                    baseMint: discovered.mintA,
                    quoteMint: discovered.mintB,
                    tvl: discovered.tvl,
                    volume24h: discovered.volume24h,
                    fees24h: discovered.fees24h,
                    price: discovered.price,
                    priceImpact: 0,
                    traders24h: discovered.uniqueSwappers24h,
                    holders: 0,
                    
                    // On-chain telemetry
                    liquidity: telemetry.liquidity || discovered.tvl,
                    entropy: discovered.poolEntropy,
                    binCount: telemetry.binCount,
                    velocity: discovered.swapVelocity,
                    activeBin: discovered.activeBin || telemetry.activeBin,
                    migrationDirection: telemetry.migrationDirection,
                    
                    // Metadata
                    lastUpdated: Date.now(),
                    feeRate: 0,
                    
                    // Will be computed during sorting
                    velocityLiquidityRatio: 0,
                    turnover24h: 0,
                    feeEfficiency: 0,
                };
                
                // Apply final guardrails (most filtering done upstream)
                // Use the hasRealEnrichment flag from the discovered pool
                const guardrailResult = applyGuardrails(enrichedPool, params, discovered.hasRealEnrichment || false);
                
                if (!guardrailResult.passed) {
                    skippedCount++;
                    continue;
                }
                
                enrichedPools.push(enrichedPool);
                convertedCount++;
                
            } catch (poolError: any) {
                skippedCount++;
                continue;
            }
        }
        
        // Sort by priority (no maxPools limit)
        const sortedPools = sortByPriority(enrichedPools);
        
        // NO STATIC LIMIT - Return ALL valid pools
        // maxPools is IGNORED - dynamic discovery handles universe size
        const finalPools = sortedPools;
        
        // Update cache
        poolCache = {
            pools: finalPools,
            timestamp: Date.now(),
            discoveryParams: params,
        };
        
        const duration = Date.now() - startTime;
        
        if (finalPools.length === 0) {
            logger.warn('[DISCOVERY] No pools passed all filters');
            return [];
        }
        
        // SUCCESS: Log before returning
        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info(`[DISCOVERY] ✅ Found ${finalPools.length} pools (NO STATIC CAP)`);
        logger.info(`   Duration: ${duration}ms`);
        logger.info(`   Pre-filtered (discovery): ${discoveredPools.length}`);
        logger.info(`   Final (after guardrails): ${finalPools.length}`);
        logger.info(`   Converted: ${convertedCount}, Skipped: ${skippedCount}`);
        logger.info('═══════════════════════════════════════════════════════════════════');
        
        return finalPools;
        
    } catch (fatalError: any) {
        // CRITICAL: Never crash the process
        logger.error('[DISCOVERY] 🔥 Fatal error:', {
            error: fatalError?.message || fatalError,
            stack: fatalError?.stack,
        });
        return []; // Always return empty array, never throw
    }
}

/**
 * Force refresh the pool cache
 */
export function invalidatePoolCache(): void {
    poolCache = null;
    logger.info('🔄 [UNIVERSE] Pool cache invalidated');
}

/**
 * Get cache status
 */
export function getCacheStatus(): { cached: boolean; age: number; poolCount: number } {
    if (!poolCache) {
        return { cached: false, age: 0, poolCount: 0 };
    }
    
    return {
        cached: true,
        age: Date.now() - poolCache.timestamp,
        poolCount: poolCache.pools.length,
    };
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
        liquidity: enriched.tvl, // Use TVL for USD-based filters
        volume24h: enriched.volume24h,
        volume1h: enriched.volume24h / 24, // Estimate
        volume4h: enriched.volume24h / 6,  // Estimate
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
        createdAt: 0, // Not available from API
        holderCount: enriched.holders,
        topHolderPercent: 0,
        isRenounced: true,
        
        // Computed scores (filled by scoring pipeline)
        riskScore: 0,
        dilutionScore: 0,
        score: 0,
        
        // Price
        currentPrice: enriched.price,
    };
}

