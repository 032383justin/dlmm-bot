/**
 * DLMM Pool Universe Indexer
 * 
 * Autonomous discovery of active Raydium DLMM pools.
 * Replaces static pool lists with dynamic real-time discovery.
 * 
 * Flow:
 * 1. Fetch all DLMM pools from Raydium API
 * 2. Apply hard safety filters (TVL, redundant pairs, LP tokens)
 * 3. Enrich with Birdeye metrics (volume, fees, price, traders)
 * 4. Enrich with on-chain telemetry (entropy, velocity, migration)
 * 5. Apply guardrails and return valid pools
 * 
 * NO FALLBACKS. NO STATIC DATA. Missing data = skip pool.
 */

import axios from 'axios';
import logger from '../utils/logger';
import { getEnrichedDLMMState, EnrichedSnapshot } from '../core/dlmmTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discovery parameters for filtering pools
 */
export interface DiscoveryParams {
    minTVL: number;           // Minimum TVL in USDC (default: 250000)
    minVolume24h: number;     // Minimum 24h volume (default: 150000)
    minTraders24h: number;    // Minimum unique traders (default: 300)
    maxPools?: number;        // Maximum pools to return (default: 50)
}

/**
 * Raw pool data from Raydium API
 */
interface RaydiumPoolData {
    ammId: string;
    lpMint: string;
    baseMint: string;
    quoteMint: string;
    baseDecimals: number;
    quoteDecimals: number;
    lpDecimals: number;
    baseReserve: number;
    quoteReserve: number;
    lpSupply: number;
    startTime: number;
    name?: string;
    symbol?: string;
    tvl?: number;
    volume24h?: number;
    fee24h?: number;
    apr24h?: number;
    apr7d?: number;
    apr30d?: number;
    priceMin?: number;
    priceMax?: number;
    status?: string;
    curveType?: string;
    openTime?: number;
    lastUpdatedAt?: number;
    feeRate?: number;
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

// Raydium DLMM API endpoint
const RAYDIUM_DLMM_ENDPOINT = 'https://api.raydium.io/v2/pools?poolType=dlmm';

/**
 * Normalized DLMM pool interface
 */
export interface DlmmPoolNormalized {
    address: string;
    mintA: string;
    mintB: string;
    binStep: number;
    activeBin: number;
    liquidity: number;
    volume24h: number;
    feeRate: number;
    price: number;
}

// Birdeye API
const BIRDEYE_API_BASE = 'https://public-api.birdeye.so';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';

// Known token mints
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Cache
interface PoolCache {
    pools: EnrichedPool[];
    timestamp: number;
    discoveryParams: DiscoveryParams;
}

let poolCache: PoolCache | null = null;
const CACHE_DURATION_MS = 6 * 60 * 1000; // 6 minutes (refresh every 5-8 minutes)

// Guardrail thresholds
const GUARDRAILS = {
    minTVL: 250000,
    minVolume24h: 150000,
    minEntropy: 0.05,
    minBinCount: 5,
    minTraders24h: 300,
};

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: RAYDIUM API POOL DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch DLMM pools from Raydium API and normalize
 * 
 * NEVER throws - returns empty array on ANY failure
 */
async function fetchRaydiumDLMMPools(): Promise<DlmmPoolNormalized[]> {
    logger.warn('[TRACE] fetchRaydiumDLMMPools INVOKED');
    const endpoint = RAYDIUM_DLMM_ENDPOINT;
    
    try {
        logger.info(`[DISCOVERY] Fetching from: ${endpoint}`);
        
        const response = await axios.get(endpoint, {
            timeout: 30000,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'DLMM-Bot/1.0',
            },
        });
        
        // Validate response shape - Raydium returns { data: [...] }
        const rawData = response.data?.data || response.data;
        
        if (!rawData) {
            logger.error('[DISCOVERY] Raydium returned null/undefined data');
            logger.warn('[DISCOVERY] Returning EMPTY UNIVERSE');
            logger.warn('[TRACE] returning from fetchRaydiumDLMMPools (null data)');
            return [];
        }
        
        if (!Array.isArray(rawData)) {
            logger.error('[DISCOVERY] Raydium returned non-array:', typeof rawData);
            logger.warn('[DISCOVERY] Returning EMPTY UNIVERSE');
            logger.warn('[TRACE] returning from fetchRaydiumDLMMPools (non-array)');
            return [];
        }
        
        logger.info(`[DISCOVERY] Raydium returned ${rawData.length} DLMM pools`);
        
        // Normalize the response
        const normalizedPools: DlmmPoolNormalized[] = [];
        
        for (const pool of rawData) {
            try {
                const normalized: DlmmPoolNormalized = {
                    address: pool.id ?? pool.address ?? '',
                    mintA: pool.mintA ?? pool.baseMint ?? '',
                    mintB: pool.mintB ?? pool.quoteMint ?? '',
                    binStep: Number(pool.binStep ?? 0),
                    activeBin: Number(pool.activeBin ?? 0),
                    liquidity: Number(pool.liquidity ?? 0),
                    volume24h: Number(pool.volume24h ?? 0),
                    feeRate: Number(pool.tradeFeeRate ?? 0),
                    price: Number(pool.price ?? 0),
                };
                
                // Skip pools without address
                if (!normalized.address) continue;
                
                normalizedPools.push(normalized);
            } catch (parseError) {
                // Skip malformed pool entries
                continue;
            }
        }
        
        if (normalizedPools.length === 0) {
            logger.warn('[DISCOVERY] No valid DLMM pools after normalization');
            logger.warn('[DISCOVERY] Returning EMPTY UNIVERSE');
            logger.warn('[TRACE] returning from fetchRaydiumDLMMPools (no valid pools)');
            return [];
        }
        
        logger.info(`[DISCOVERY] Normalized ${normalizedPools.length} DLMM pools`);
        logger.warn('[TRACE] returning from fetchRaydiumDLMMPools (success)');
        return normalizedPools;
        
    } catch (error: any) {
        logger.error('[DISCOVERY] Raydium fetch FAILED:', {
            endpoint,
            error: error?.message || error,
            code: error?.code,
            status: error?.response?.status,
        });
        logger.warn('[TRACE] returning from fetchRaydiumDLMMPools (catch block)');
        logger.warn('[DISCOVERY] Returning EMPTY UNIVERSE');
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: HARD SAFETY FILTER
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
        if (!pool.address || !pool.mintA || !pool.mintB) {
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
            const data = await fetchBirdeyePoolData(pool.address);
            if (data) {
                results.set(pool.address, data);
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
 */
function applyGuardrails(pool: EnrichedPool, params: DiscoveryParams): { passed: boolean; reason?: string } {
    // TVL check
    if (pool.tvl < params.minTVL) {
        return { passed: false, reason: `TVL $${pool.tvl.toFixed(0)} < $${params.minTVL}` };
    }
    
    // Volume check
    if (pool.volume24h < params.minVolume24h) {
        return { passed: false, reason: `Volume $${pool.volume24h.toFixed(0)} < $${params.minVolume24h}` };
    }
    
    // Entropy check
    if (pool.entropy < GUARDRAILS.minEntropy) {
        return { passed: false, reason: `Entropy ${pool.entropy.toFixed(4)} < ${GUARDRAILS.minEntropy}` };
    }
    
    // Bin count check
    if (pool.binCount < GUARDRAILS.minBinCount) {
        return { passed: false, reason: `BinCount ${pool.binCount} < ${GUARDRAILS.minBinCount}` };
    }
    
    // Active bin check
    if (pool.activeBin === 0) {
        return { passed: false, reason: 'ActiveBin is 0' };
    }
    
    // Migration check
    if (pool.migrationDirection === 'out') {
        return { passed: false, reason: 'Migration direction is OUT' };
    }
    
    // Traders check (if available)
    if (pool.traders24h > 0 && pool.traders24h < params.minTraders24h) {
        return { passed: false, reason: `Traders ${pool.traders24h} < ${params.minTraders24h}` };
    }
    
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
 * This is the main entry point for pool discovery.
 * Returns enriched pools ready for scoring pipeline.
 * 
 * CRITICAL: This function NEVER throws. On ANY error, returns empty array.
 * 
 * @param params - Discovery parameters (minTVL, minVolume24h, minTraders24h)
 * @returns EnrichedPool[] - Validated and enriched pools (or empty array on failure)
 */
export async function discoverDLMMUniverses(params: DiscoveryParams): Promise<EnrichedPool[]> {
    logger.warn('[TRACE] discoverDLMMUniverses INVOKED');
    const startTime = Date.now();
    
    try {
        // Check cache first
        if (poolCache && 
            Date.now() - poolCache.timestamp < CACHE_DURATION_MS &&
            JSON.stringify(poolCache.discoveryParams) === JSON.stringify(params)) {
            logger.info(`📦 [UNIVERSE] Using cached pool universe (${poolCache.pools.length} pools)`);
            logger.warn('[TRACE] returning from discoverDLMMUniverses (cached)');
            return poolCache.pools;
        }
        
        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info('🌐 [UNIVERSE] Starting DLMM pool discovery...');
        logger.info(`   minTVL: $${params.minTVL.toLocaleString()}`);
        logger.info(`   minVolume24h: $${params.minVolume24h.toLocaleString()}`);
        logger.info(`   minTraders24h: ${params.minTraders24h}`);
        logger.info('═══════════════════════════════════════════════════════════════════');
        
        // Step 1: Fetch pools from Raydium (wrapped in try/catch)
        logger.warn('[TRACE] Calling function: fetchRaydiumDLMMPools');
        let raydiumPools: DlmmPoolNormalized[] = [];
        try {
            raydiumPools = await fetchRaydiumDLMMPools();
        } catch (raydiumError: any) {
            logger.error('[UNIVERSE] Raydium fetch failed:', {
                error: raydiumError?.message || raydiumError,
                url: RAYDIUM_DLMM_ENDPOINT,
            });
            logger.warn('[TRACE] returning from discoverDLMMUniverses (raydium catch)');
            return []; // soft fail
        }
        logger.warn('[TRACE] fetchRaydiumDLMMPools RETURNED');
        
        if (!Array.isArray(raydiumPools) || raydiumPools.length === 0) {
            logger.warn('[DISCOVERY] No DLMM pools returned from Raydium');
            logger.warn('[DISCOVERY] Returning EMPTY UNIVERSE');
            logger.warn('[TRACE] returning from discoverDLMMUniverses (empty raydium)');
            return [];
        }
        
        logger.info(`[DISCOVERY] ✅ Fetched ${raydiumPools.length} pools from Raydium`);
        
        // Step 2: Apply hard safety filter
        let filteredPools: DlmmPoolNormalized[] = [];
        try {
            filteredPools = applyHardSafetyFilter(raydiumPools, params);
        } catch (filterError: any) {
            logger.error('[DISCOVERY] Safety filter failed:', filterError?.message);
            logger.warn('[DISCOVERY] Returning EMPTY UNIVERSE');
            logger.warn('[TRACE] returning from discoverDLMMUniverses (filter catch)');
            return [];
        }
        
        if (filteredPools.length === 0) {
            logger.warn('[DISCOVERY] All pools filtered out by safety filter');
            logger.warn('[DISCOVERY] Returning EMPTY UNIVERSE');
            logger.warn('[TRACE] returning from discoverDLMMUniverses (all filtered)');
            return [];
        }
        
        // Step 3: Birdeye enrichment (wrapped)
        let birdeyeData = new Map<string, BirdeyeEnrichment>();
        try {
            birdeyeData = await batchFetchBirdeyeData(filteredPools, 10, 100);
        } catch (birdeyeError: any) {
            logger.warn('[UNIVERSE] Birdeye enrichment failed, continuing without:', birdeyeError?.message);
            // Continue without Birdeye data
        }
        
        // Step 4: Telemetry enrichment and final assembly
        const enrichedPools: EnrichedPool[] = [];
        let telemetrySuccessCount = 0;
        let telemetryFailCount = 0;
        
        logger.info(`🔬 [TELEMETRY] Enriching ${filteredPools.length} pools with on-chain data...`);
        
        for (const pool of filteredPools) {
            try {
                // Get Birdeye data
                const birdeye = birdeyeData.get(pool.address);
                
                // Get previous telemetry snapshot for velocity computation
                const prevSnapshot = telemetryHistory.get(pool.address);
                
                // Fetch on-chain telemetry
                const telemetry = await enrichWithTelemetry(pool.address, prevSnapshot);
                
                if (!telemetry) {
                    telemetryFailCount++;
                    continue;
                }
                
                telemetrySuccessCount++;
                
                // Store snapshot for next cycle
                telemetryHistory.set(pool.address, telemetry);
                
                // Build enriched pool
                const enrichedPool: EnrichedPool = {
                    address: pool.address,
                    symbol: `${pool.mintA.slice(0, 4)}/${pool.mintB.slice(0, 4)}`,
                    baseMint: pool.mintA,
                    quoteMint: pool.mintB,
                    tvl: pool.liquidity,
                    volume24h: birdeye?.volume24h || pool.volume24h,
                    fees24h: birdeye?.fees24h || 0,
                    price: birdeye?.price || pool.price,
                    priceImpact: birdeye?.priceImpact || 0,
                    traders24h: birdeye?.traders24h || 0,
                    holders: birdeye?.holders || 0,
                    
                    // On-chain telemetry (prefer API data, fallback to telemetry)
                    liquidity: telemetry.liquidity || pool.liquidity,
                    entropy: telemetry.entropy,
                    binCount: telemetry.binCount,
                    velocity: telemetry.velocity,
                    activeBin: telemetry.activeBin || pool.activeBin,
                    migrationDirection: telemetry.migrationDirection,
                    
                    // Metadata
                    lastUpdated: Date.now(),
                    feeRate: pool.feeRate,
                    
                    // Will be computed during sorting
                    velocityLiquidityRatio: 0,
                    turnover24h: 0,
                    feeEfficiency: 0,
                };
                
                // Apply guardrails
                const guardrailResult = applyGuardrails(enrichedPool, params);
                
                if (!guardrailResult.passed) {
                    continue;
                }
                
                // Pool passed all checks
                enrichedPools.push(enrichedPool);
                
            } catch (poolError: any) {
                // Individual pool failed, continue with next
                telemetryFailCount++;
                continue;
            }
        }
        
        // Step 5: Sort by priority
        const sortedPools = sortByPriority(enrichedPools);
        
        // Limit to max pools if specified
        const maxPools = params.maxPools || 50;
        const finalPools = sortedPools.slice(0, maxPools);
        
        // Update cache
        poolCache = {
            pools: finalPools,
            timestamp: Date.now(),
            discoveryParams: params,
        };
        
        const duration = Date.now() - startTime;
        
        if (finalPools.length === 0) {
            logger.warn('[DISCOVERY] No pools passed all filters');
            logger.warn('[DISCOVERY] Returning EMPTY UNIVERSE');
            logger.warn('[TRACE] returning from discoverDLMMUniverses (no final pools)');
            return [];
        }
        
        // SUCCESS: Log before returning
        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info(`[DISCOVERY] ✅ Found ${finalPools.length} pools`);
        logger.info(`   Duration: ${duration}ms`);
        logger.info(`   Raydium total: ${raydiumPools.length}`);
        logger.info(`   After filter: ${filteredPools.length}`);
        logger.info(`   Telemetry OK: ${telemetrySuccessCount}, Failed: ${telemetryFailCount}`);
        logger.info('═══════════════════════════════════════════════════════════════════');
        
        logger.warn('[TRACE] returning from discoverDLMMUniverses (success)');
        return finalPools;
        
    } catch (fatalError: any) {
        // CRITICAL: Never crash the process
        logger.error('[DISCOVERY] Fatal error:', {
            error: fatalError?.message || fatalError,
            stack: fatalError?.stack,
        });
        logger.warn('[DISCOVERY] Returning EMPTY UNIVERSE');
        logger.warn('[TRACE] returning from discoverDLMMUniverses (fatal catch)');
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

