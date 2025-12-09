/**
 * Dynamic DLMM Pool Discovery Pipeline
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * STRICT 3-STAGE FUNNEL — MEMORY-SAFE DISCOVERY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Stage 1 (No Telemetry):
 * - Combine raw pools from Meteora + Raydium
 * - Skip Helius entirely OR limit to 1 page
 * - Rank by (volume24h + tvl)
 * - Take top 50
 * 
 * Stage 2 (With Telemetry):
 * - Loop ONLY over Stage 1 output
 * - Hydrate telemetry and apply pre-tier filters
 * - Rank by swapVelocity
 * - Take top 30
 * 
 * Stage 3 (Optional Birdeye):
 * - After scoring, sort by discoveryScore
 * - Take top 12
 * 
 * MEMORY SAFETY:
 * - NO telemetry history
 * - NO pool history
 * - NO snapshot arrays
 * - NO cache rotation
 * - NO accumulation across cycles
 * - Return ONLY final filtered pools
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import logger from '../utils/logger';
import { fetchDLMMPools, DLMM_Pool } from './dlmmFetcher';
import { getEnrichedDLMMState, EnrichedSnapshot } from '../core/dlmmTelemetry';
import {
    ENRICHED_THRESHOLDS,
    MICROSTRUCTURE_ONLY_THRESHOLDS,
    UPSTREAM_FILTERS,
    BIRDEYE_CONFIG,
} from '../config/discovery';

// ═══════════════════════════════════════════════════════════════════════════════
// HARD CAPS — STRICT FUNNEL LIMITS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_RAW_UNIVERSE = 50;   // Stage 1: raw ranked pools
const MAX_TELEMETRY = 30;      // Stage 2: after telemetry + pre-tier
const MAX_FINAL = 12;          // Stage 3: final output

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Raw pool from any source
 */
export interface RawDiscoveredPool {
    id: string;
    source: 'dlmm_sdk' | 'helius' | 'raydium' | 'birdeye';
    mintA: string;
    mintB: string;
    tvl: number;
    volume24h: number;
    fees24h: number;
    activeBin: number;
    binStep: number;
    price: number;
    uniqueSwappers24h: number;
    medianTradeSize: number;
    symbol?: string;
    createdAt?: number;
}

/**
 * Pre-tier filtered pool with micro-signals
 */
export interface PreTierPool extends RawDiscoveredPool {
    // Pre-tier micro-signals
    swapVelocity: number;
    poolEntropy: number;
    liquidityFlow: number;
    
    // Simplified scoring (no history-based metrics)
    consistencyScore: number;
    spikeRatio: number;
    
    // Pass/fail flags
    passesPreTier: boolean;
    preFilterRejectReason?: string;
    
    // Depth requirements
    passesDepthRequirements: boolean;
    depthRejectReason?: string;
    
    // Enrichment flag
    hasRealEnrichment: boolean;
}

/**
 * Fully enriched pool ready for Tier4 scoring
 */
export interface DiscoveredPool extends PreTierPool {
    // Enriched telemetry
    telemetry: EnrichedSnapshot | null;
    
    // Final discovery score
    discoveryScore: number;
    
    // Time-weighted multiplier (fixed at 1.0 - no history)
    timeWeightMultiplier: number;
    
    // Pool health indicators
    isHealthy: boolean;
    healthReasons: string[];
    
    // Last update timestamp
    lastUpdated: number;
}

/**
 * Discovery configuration
 */
export interface DiscoveryConfig {
    // Pagination disabled
    enablePagination: boolean;
    maxPagesPerSource: number;
    
    // Pre-tier thresholds
    preTierThresholds: {
        minSwapVelocity: number;
        minPoolEntropy: number;
        minLiquidityFlow: number;
        minVolume24h: number;
    };
    
    // Market depth requirements
    depthRequirements: {
        minTVL: number;
        minUniqueSwappers24h: number;
        minMedianTradeSize: number;
    };
    
    // Time-weighting (simplified - no history)
    timeWeighting: {
        consistencyWeight: number;
        spikesPenalty: number;
        minConsistencyScore: number;
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
    enablePagination: false,  // DISABLED - no pagination
    maxPagesPerSource: 1,     // Max 1 page per source
    
    preTierThresholds: {
        minSwapVelocity: ENRICHED_THRESHOLDS.swapVelocity,
        minPoolEntropy: ENRICHED_THRESHOLDS.poolEntropy,
        minLiquidityFlow: ENRICHED_THRESHOLDS.liquidityFlow,
        minVolume24h: ENRICHED_THRESHOLDS.volume24h,
    },
    
    depthRequirements: {
        minTVL: ENRICHED_THRESHOLDS.tvl,
        minUniqueSwappers24h: ENRICHED_THRESHOLDS.uniqueSwappers24h,
        minMedianTradeSize: ENRICHED_THRESHOLDS.medianTradeSize,
    },
    
    timeWeighting: {
        consistencyWeight: 0.30,
        spikesPenalty: 0.60,
        minConsistencyScore: 40,
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 1: DLMM SDK (Meteora Native)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchFromDLMMSDK(): Promise<RawDiscoveredPool[]> {
    logger.info('[DISCOVERY] Fetching from DLMM SDK (Meteora)...');
    
    try {
        const pools = await fetchDLMMPools();
        
        return pools.map((p: DLMM_Pool): RawDiscoveredPool => ({
            id: p.id,
            source: 'dlmm_sdk',
            mintA: p.mintA,
            mintB: p.mintB,
            tvl: p.tvl,
            volume24h: p.volume24h,
            fees24h: p.volume24h * (p.feeTier / 10000),
            activeBin: p.activeBin,
            binStep: p.binStep,
            price: p.price,
            uniqueSwappers24h: 0,
            medianTradeSize: 0,
            symbol: `${p.mintA.slice(0, 4)}.../${p.mintB.slice(0, 4)}...`,
        }));
        
    } catch (error: any) {
        logger.error('[DISCOVERY] DLMM SDK fetch failed:', error?.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 2: HELIUS (OPTIONAL - 1 page only)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchFromHelius(): Promise<RawDiscoveredPool[]> {
    const heliusApiKey = process.env.HELIUS_API_KEY;
    if (!heliusApiKey) {
        logger.info('[DISCOVERY] Helius API key not configured - skipping');
        return [];
    }
    
    logger.info('[DISCOVERY] Fetching from Helius (1 page only)...');
    
    try {
        const response = await axios.post(
            `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
            {
                jsonrpc: '2.0',
                id: 'discovery',
                method: 'getAssetsByGroup',
                params: {
                    groupKey: 'collection',
                    groupValue: 'meteora_dlmm',
                    page: 1,  // 1 PAGE ONLY
                    limit: 100,
                    sortBy: { sortBy: 'volume', sortDirection: 'desc' },
                },
            },
            { timeout: 30000 }
        );
        
        if (!response.data?.result?.items) {
            return [];
        }
        
        return response.data.result.items.map((item: any): RawDiscoveredPool => ({
            id: item.id,
            source: 'helius',
            mintA: item.content?.metadata?.mint_a || '',
            mintB: item.content?.metadata?.mint_b || '',
            tvl: item.content?.metadata?.tvl || 0,
            volume24h: item.content?.metadata?.volume_24h || 0,
            fees24h: item.content?.metadata?.fees_24h || 0,
            activeBin: item.content?.metadata?.active_bin || 0,
            binStep: item.content?.metadata?.bin_step || 0,
            price: item.content?.metadata?.price || 0,
            uniqueSwappers24h: item.content?.metadata?.unique_wallets || 0,
            medianTradeSize: item.content?.metadata?.median_trade || 0,
            symbol: item.content?.metadata?.symbol || '',
        }));
        
    } catch (error: any) {
        logger.warn('[DISCOVERY] Helius fetch failed:', error?.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 3: RAYDIUM TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchFromRaydium(): Promise<RawDiscoveredPool[]> {
    logger.info('[DISCOVERY] Fetching from Raydium telemetry...');
    
    try {
        const response = await axios.get(
            'https://api.raydium.io/v2/main/pairs',
            { timeout: 30000 }
        );
        
        if (!response.data) {
            return [];
        }
        
        return response.data
            .filter((p: any) => p.ammType === 'clmm' || p.ammType === 'concentrated')
            .map((p: any): RawDiscoveredPool => ({
                id: p.ammId || p.id,
                source: 'raydium',
                mintA: p.baseMint || p.mintA,
                mintB: p.quoteMint || p.mintB,
                tvl: p.tvl || p.liquidity || 0,
                volume24h: p.volume24h || p.volume || 0,
                fees24h: p.fees24h || 0,
                activeBin: 0,
                binStep: 0,
                price: p.price || 0,
                uniqueSwappers24h: p.txns24h || 0,
                medianTradeSize: p.volume24h && p.txns24h ? p.volume24h / p.txns24h : 0,
                symbol: p.name || `${p.baseMint?.slice(0, 4) || ''}/${p.quoteMint?.slice(0, 4) || ''}`,
            }));
        
    } catch (error: any) {
        logger.warn('[DISCOVERY] Raydium fetch failed:', error?.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 4: BIRDEYE ENRICHMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function enrichWithBirdeye(pools: RawDiscoveredPool[]): Promise<Map<string, {
    uniqueSwappers24h: number;
    medianTradeSize: number;
    volume24h: number;
    tvl: number;
}>> {
    const birdeyeApiKey = process.env.BIRDEYE_API_KEY;
    if (!birdeyeApiKey) {
        logger.info(BIRDEYE_CONFIG.notConfiguredMessage);
        return new Map();
    }
    
    const enrichmentMap = new Map<string, {
        uniqueSwappers24h: number;
        medianTradeSize: number;
        volume24h: number;
        tvl: number;
    }>();
    
    // Batch in groups of 10
    const batchSize = 10;
    for (let i = 0; i < pools.length; i += batchSize) {
        const batch = pools.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (pool) => {
            try {
                const response = await axios.get(
                    `https://public-api.birdeye.so/defi/v3/pair/overview/single`,
                    {
                        params: { address: pool.id },
                        headers: { 'X-API-KEY': birdeyeApiKey },
                        timeout: 5000,
                    }
                );
                
                if (response.data?.success && response.data?.data) {
                    const data = response.data.data;
                    enrichmentMap.set(pool.id, {
                        uniqueSwappers24h: data.uniqueWallet24h || data.trader24h || 0,
                        medianTradeSize: data.volume24h && data.trade24h 
                            ? data.volume24h / data.trade24h 
                            : 0,
                        volume24h: data.volume24h || 0,
                        tvl: data.liquidity || 0,
                    });
                }
            } catch {
                // Silently skip failed enrichments
            }
        }));
        
        // Rate limit
        if (i + batchSize < pools.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    return enrichmentMap;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMECOIN CARCASS FILTER
// ═══════════════════════════════════════════════════════════════════════════════

const STABLECOIN_MINTS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

function isMememcoinCarcass(pool: RawDiscoveredPool): boolean {
    // Stable-stable pairs (no trading opportunity)
    if (STABLECOIN_MINTS.has(pool.mintA) && STABLECOIN_MINTS.has(pool.mintB)) {
        return true;
    }
    
    // Very low activity filter
    const MIN_VOLUME_UPSTREAM = UPSTREAM_FILTERS.minVolumeForFetch;
    const MIN_TVL_UPSTREAM = UPSTREAM_FILTERS.minTvlForFetch;
    
    if (pool.volume24h < MIN_VOLUME_UPSTREAM && pool.tvl < MIN_TVL_UPSTREAM) {
        return true;
    }
    
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-TIER FILTERING (NO HISTORY - SINGLE CYCLE ONLY)
// ═══════════════════════════════════════════════════════════════════════════════

function applyPreTierFilter(
    pool: RawDiscoveredPool,
    microSignals: { swapVelocity: number; poolEntropy: number; liquidityFlow: number },
    config: DiscoveryConfig,
    hasRealEnrichment: boolean
): PreTierPool {
    const poolHasEnrichment = hasRealEnrichment;
    
    // Get appropriate thresholds based on enrichment status
    const thresholds = poolHasEnrichment ? {
        minSwapVelocity: ENRICHED_THRESHOLDS.swapVelocity,
        minPoolEntropy: ENRICHED_THRESHOLDS.poolEntropy,
        minLiquidityFlow: ENRICHED_THRESHOLDS.liquidityFlow,
        minVolume24h: ENRICHED_THRESHOLDS.volume24h,
    } : {
        minSwapVelocity: MICROSTRUCTURE_ONLY_THRESHOLDS.swapVelocity,
        minPoolEntropy: MICROSTRUCTURE_ONLY_THRESHOLDS.poolEntropy,
        minLiquidityFlow: MICROSTRUCTURE_ONLY_THRESHOLDS.liquidityFlow,
        minVolume24h: 0,
    };
    
    const depthReqs = config.depthRequirements;
    
    // Pre-tier check
    let passesPreTier = true;
    let preFilterRejectReason: string | undefined;
    
    if (microSignals.swapVelocity < thresholds.minSwapVelocity) {
        passesPreTier = false;
        preFilterRejectReason = `swapVelocity ${microSignals.swapVelocity.toFixed(3)} < ${thresholds.minSwapVelocity}`;
    } else if (microSignals.poolEntropy < thresholds.minPoolEntropy) {
        passesPreTier = false;
        preFilterRejectReason = `poolEntropy ${microSignals.poolEntropy.toFixed(3)} < ${thresholds.minPoolEntropy}`;
    } else if (Math.abs(microSignals.liquidityFlow) < thresholds.minLiquidityFlow) {
        passesPreTier = false;
        preFilterRejectReason = `liquidityFlow ${(microSignals.liquidityFlow * 100).toFixed(2)}% < ${thresholds.minLiquidityFlow * 100}%`;
    } else if (poolHasEnrichment && pool.volume24h < thresholds.minVolume24h) {
        passesPreTier = false;
        preFilterRejectReason = `volume24h $${pool.volume24h.toFixed(0)} < $${thresholds.minVolume24h}`;
    }
    
    // Depth requirements (only when enrichment available)
    let passesDepthRequirements = true;
    let depthRejectReason: string | undefined;
    
    if (poolHasEnrichment) {
        if (pool.tvl < depthReqs.minTVL) {
            passesDepthRequirements = false;
            depthRejectReason = `TVL $${pool.tvl.toFixed(0)} < $${depthReqs.minTVL}`;
        } else if (pool.uniqueSwappers24h < depthReqs.minUniqueSwappers24h) {
            passesDepthRequirements = false;
            depthRejectReason = `uniqueSwappers ${pool.uniqueSwappers24h} < ${depthReqs.minUniqueSwappers24h}`;
        } else if (pool.medianTradeSize < depthReqs.minMedianTradeSize) {
            passesDepthRequirements = false;
            depthRejectReason = `medianTradeSize $${pool.medianTradeSize.toFixed(0)} < $${depthReqs.minMedianTradeSize}`;
        }
    }
    
    return {
        ...pool,
        swapVelocity: microSignals.swapVelocity,
        poolEntropy: microSignals.poolEntropy,
        liquidityFlow: microSignals.liquidityFlow,
        consistencyScore: 50,  // Fixed - no history
        spikeRatio: 0,         // Fixed - no history
        passesPreTier,
        preFilterRejectReason,
        passesDepthRequirements,
        depthRejectReason,
        hasRealEnrichment: poolHasEnrichment,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY SCORING (NO HISTORY)
// ═══════════════════════════════════════════════════════════════════════════════

function calculateDiscoveryScore(pool: PreTierPool): number {
    const poolHasEnrichment = pool.hasRealEnrichment;
    
    // Base score from volume and TVL
    const volumeScore = Math.log10(Math.max(pool.volume24h, 1)) * 10;
    const tvlScore = Math.log10(Math.max(pool.tvl, 1)) * 8;
    
    // Micro-signal scores
    const velocityScore = Math.min(pool.swapVelocity / 0.5, 1) * 25;
    const entropyScore = pool.poolEntropy * 20;
    const flowScore = Math.min(Math.abs(pool.liquidityFlow) / 0.1, 1) * 15;
    
    // Depth scores
    let swapperScore = 0;
    let tradeSizeScore = 0;
    if (poolHasEnrichment) {
        swapperScore = Math.min(pool.uniqueSwappers24h / 100, 1) * 10;
        tradeSizeScore = Math.min(pool.medianTradeSize / 200, 1) * 12;
    } else {
        swapperScore = 5;
        tradeSizeScore = 6;
    }
    
    let rawScore = volumeScore + tvlScore + velocityScore + entropyScore + flowScore + swapperScore + tradeSizeScore;
    
    // Soft TVL penalty for microstructure-only mode
    if (!poolHasEnrichment && pool.tvl > 0 && pool.tvl < MICROSTRUCTURE_ONLY_THRESHOLDS.softTvlThreshold) {
        rawScore *= MICROSTRUCTURE_ONLY_THRESHOLDS.softTvlPenalty;
    }
    
    return rawScore;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISCOVERY FUNCTION — 3-STAGE FUNNEL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discover DLMM pool universe with strict 3-stage funnel.
 * 
 * MEMORY SAFETY:
 * - No telemetry history stored
 * - No pool history stored
 * - No cache accumulation
 * - Returns max 12 pools per cycle
 * - All objects GC eligible after return
 */
export async function discoverPools(
    config: DiscoveryConfig = DEFAULT_DISCOVERY_CONFIG
): Promise<DiscoveredPool[]> {
    const startTime = Date.now();
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('[DISCOVERY] 🚀 3-STAGE FUNNEL — MEMORY-SAFE DISCOVERY');
    logger.info(`[DISCOVERY] Limits: Stage1=${MAX_RAW_UNIVERSE}, Stage2=${MAX_TELEMETRY}, Stage3=${MAX_FINAL}`);
    logger.info('═══════════════════════════════════════════════════════════════════');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 1: MULTI-SOURCE FETCH + RANK (NO TELEMETRY)
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[STAGE 1] Fetching raw pools (no telemetry)...');
    
    const [dlmmPools, heliusPools, raydiumPools] = await Promise.all([
        fetchFromDLMMSDK(),
        fetchFromHelius(),  // 1 page only
        fetchFromRaydium(),
    ]);
    
    logger.info(`[STAGE 1] Sources: DLMM=${dlmmPools.length}, Helius=${heliusPools.length}, Raydium=${raydiumPools.length}`);
    
    // Combine and deduplicate
    const allRawPools: RawDiscoveredPool[] = [...dlmmPools, ...heliusPools, ...raydiumPools];
    const seenIds = new Set<string>();
    const uniquePools = allRawPools.filter(p => {
        if (seenIds.has(p.id)) return false;
        seenIds.add(p.id);
        return true;
    });
    
    // Filter carcasses
    const nonCarcassPools = uniquePools.filter(p => !isMememcoinCarcass(p));
    
    logger.info(`[STAGE 1] After carcass filter: ${nonCarcassPools.length} pools`);
    
    // STAGE 1 OUTPUT: Rank by (volume24h + tvl), take top 50
    const rawRanked = nonCarcassPools
        .sort((a, b) => (b.volume24h + b.tvl) - (a.volume24h + a.tvl))
        .slice(0, MAX_RAW_UNIVERSE);
    
    logger.info(`[STAGE 1] ✅ Output: ${rawRanked.length} pools (capped at ${MAX_RAW_UNIVERSE})`);
    
    if (rawRanked.length === 0) {
        logger.warn('[DISCOVERY] No pools passed Stage 1');
        return [];
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // OPTIONAL: BIRDEYE ENRICHMENT (on Stage 1 output only)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const birdeyeEnrichment = await enrichWithBirdeye(rawRanked);
    const realEnrichedPoolIds = new Set<string>();
    
    // Apply enrichment
    for (const pool of rawRanked) {
        const enriched = birdeyeEnrichment.get(pool.id);
        if (enriched && enriched.uniqueSwappers24h > 0) {
            pool.uniqueSwappers24h = enriched.uniqueSwappers24h;
            pool.medianTradeSize = enriched.medianTradeSize || pool.medianTradeSize;
            pool.volume24h = enriched.volume24h || pool.volume24h;
            pool.tvl = enriched.tvl || pool.tvl;
            realEnrichedPoolIds.add(pool.id);
        } else {
            // Estimate for non-enriched pools
            const estimatedTrades = Math.floor(pool.volume24h / 500);
            pool.uniqueSwappers24h = Math.min(estimatedTrades, 500);
            pool.medianTradeSize = pool.volume24h > 0 && estimatedTrades > 0
                ? pool.volume24h / estimatedTrades
                : 0;
        }
    }
    
    logger.info(`[BIRDEYE] Enriched: ${realEnrichedPoolIds.size}/${rawRanked.length} pools`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 2: TELEMETRY + PRE-TIER FILTER (on Stage 1 output only)
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[STAGE 2] Hydrating telemetry and applying pre-tier filters...');
    
    const preTierPools: PreTierPool[] = [];
    let telemetryErrors = 0;
    
    for (const pool of rawRanked) {
        try {
            const hasRealEnrichment = realEnrichedPoolIds.has(pool.id);
            
            // Fetch on-chain telemetry (NO previous snapshot - fresh each cycle)
            const telemetry = await getEnrichedDLMMState(pool.id, undefined);
            
            if (telemetry.invalidTelemetry) {
                telemetryErrors++;
                continue;
            }
            
            // Calculate micro-signals from fresh telemetry
            const swapVelocity = telemetry.velocity || MICROSTRUCTURE_ONLY_THRESHOLDS.swapVelocity;
            const poolEntropy = telemetry.entropy;
            const liquidityFlow = MICROSTRUCTURE_ONLY_THRESHOLDS.liquidityFlow; // Default - no history
            
            // Apply pre-tier filter
            const preTierPool = applyPreTierFilter(
                pool,
                { swapVelocity, poolEntropy, liquidityFlow },
                config,
                hasRealEnrichment
            );
            
            // Store telemetry reference for later
            (preTierPool as any)._telemetry = telemetry;
            
            if (!preTierPool.passesPreTier || !preTierPool.passesDepthRequirements) {
                continue;
            }
            
            preTierPools.push(preTierPool);
            
        } catch (error: any) {
            logger.debug(`[STAGE 2] Error processing ${pool.id}: ${error?.message}`);
            telemetryErrors++;
        }
    }
    
    logger.info(`[STAGE 2] After pre-tier: ${preTierPools.length} pools (${telemetryErrors} telemetry errors)`);
    
    // STAGE 2 OUTPUT: Rank by swapVelocity, take top 30
    const telemetryRanked = preTierPools
        .sort((a, b) => b.swapVelocity - a.swapVelocity)
        .slice(0, MAX_TELEMETRY);
    
    logger.info(`[STAGE 2] ✅ Output: ${telemetryRanked.length} pools (capped at ${MAX_TELEMETRY})`);
    
    if (telemetryRanked.length === 0) {
        logger.warn('[DISCOVERY] No pools passed Stage 2');
        return [];
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 3: SCORING + FINAL OUTPUT
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[STAGE 3] Scoring and final selection...');
    
    const now = Date.now();
    const discoveredPools: DiscoveredPool[] = telemetryRanked.map(pool => {
        const telemetry = (pool as any)._telemetry || null;
        delete (pool as any)._telemetry;  // Clean up temp reference
        
        const discoveryScore = calculateDiscoveryScore(pool);
        
        return {
            ...pool,
            telemetry,
            discoveryScore,
            timeWeightMultiplier: 1.0,  // Fixed - no history
            isHealthy: true,
            healthReasons: [],
            lastUpdated: now,
        };
    });
    
    // STAGE 3 OUTPUT: Rank by discoveryScore, take top 12
    const finalPools = discoveredPools
        .sort((a, b) => b.discoveryScore - a.discoveryScore)
        .slice(0, MAX_FINAL);
    
    const duration = Date.now() - startTime;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DISCOVERY SUMMARY
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info(`[DISCOVERY] ✅ 3-STAGE FUNNEL COMPLETE in ${duration}ms`);
    logger.info('───────────────────────────────────────────────────────────────────');
    logger.info(`[DISCOVERY] Stage 1: ${uniquePools.length} raw → ${rawRanked.length} ranked`);
    logger.info(`[DISCOVERY] Stage 2: ${rawRanked.length} → ${telemetryRanked.length} after telemetry`);
    logger.info(`[DISCOVERY] Stage 3: ${telemetryRanked.length} → ${finalPools.length} final output`);
    logger.info('───────────────────────────────────────────────────────────────────');
    
    if (finalPools.length > 0) {
        logger.info(`[DISCOVERY] Top 3 pools:`);
        for (const pool of finalPools.slice(0, 3)) {
            const mode = pool.hasRealEnrichment ? 'enriched' : 'micro-only';
            logger.info(`   → ${pool.symbol || pool.id.slice(0, 8)} | score=${pool.discoveryScore.toFixed(1)} | velocity=${pool.swapVelocity.toFixed(3)} | mode=${mode}`);
        }
    }
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    
    return finalPools;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY EXPORTS (SIMPLIFIED - NO CACHE)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Force refresh - NO-OP (no cache to invalidate)
 */
export function invalidateDiscoveryCache(): void {
    logger.info('[DISCOVERY] 🔄 No cache to invalidate (memory-safe mode)');
}

/**
 * Get cache status - always uncached
 */
export function getDiscoveryCacheStatus(): {
    cached: boolean;
    age: number;
    poolCount: number;
    lastRotation: number;
    sourceStats: null;
} {
    return { cached: false, age: 0, poolCount: 0, lastRotation: 0, sourceStats: null };
}

/**
 * Get pool history - NO-OP (no history stored)
 */
export function getPoolDiscoveryHistory(_poolId: string): undefined {
    return undefined;
}

/**
 * Convert DiscoveredPool to Pool format for compatibility
 */
export function discoveredPoolToPool(discovered: DiscoveredPool): any {
    return {
        address: discovered.id,
        name: discovered.symbol || `${discovered.mintA.slice(0, 6)}/${discovered.mintB.slice(0, 6)}`,
        tokenX: discovered.mintA,
        tokenY: discovered.mintB,
        mintX: discovered.mintA,
        mintY: discovered.mintB,
        
        liquidity: discovered.tvl,
        volume24h: discovered.volume24h,
        volume1h: discovered.volume24h / 24,
        volume4h: discovered.volume24h / 6,
        velocity: discovered.swapVelocity,
        fees24h: discovered.fees24h,
        apr: discovered.tvl > 0 ? (discovered.fees24h * 365) / discovered.tvl * 100 : 0,
        
        binStep: discovered.binStep,
        baseFee: 0,
        binCount: discovered.telemetry?.binCount || 0,
        
        entropy: discovered.poolEntropy,
        migrationDirection: discovered.telemetry?.migrationDirection || 'stable',
        onChainLiquidity: discovered.telemetry?.liquidity || 0,
        activeBin: discovered.activeBin || discovered.telemetry?.activeBin || 0,
        
        createdAt: discovered.createdAt || 0,
        holderCount: 0,
        topHolderPercent: 0,
        isRenounced: true,
        
        riskScore: 0,
        dilutionScore: 0,
        score: discovered.discoveryScore,
        
        currentPrice: discovered.price,
        
        discoverySource: discovered.source,
        consistencyScore: discovered.consistencyScore,
        spikeRatio: discovered.spikeRatio,
        timeWeightMultiplier: discovered.timeWeightMultiplier,
        isHealthy: discovered.isHealthy,
    };
}
