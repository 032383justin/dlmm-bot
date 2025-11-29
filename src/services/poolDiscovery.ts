/**
 * Dynamic DLMM Pool Discovery Pipeline
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * MULTI-STAGE DISCOVERY & PRUNING PIPELINE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Priority Sources:
 * 1. DLMM SDK (Meteora native)
 * 2. Helius / pump sorted by 24h volume
 * 3. Raydium telemetry endpoints
 * 4. Token metadata (filter memecoin carcasses)
 * 
 * Pre-Tier Filtering (discard at ingest):
 * - swapVelocity < 0.12 → DISCARD
 * - poolEntropy < 0.65 → DISCARD
 * - liquidityFlow < 0.5% → DISCARD
 * - 24h volume < $75,000 → DISCARD
 * 
 * Minimum Market Depth:
 * - TVL >= $200,000
 * - 24h unique swappers >= 35
 * - Median trade size > $75
 * 
 * Time-Weighted Scoring:
 * - Prefer consistent bin shifts
 * - Prefer persistent flow
 * - Penalize single candle spikes
 * 
 * Cache + Rotation:
 * - Cache universe for 10-15 minutes
 * - Rotate out dead pools
 * - Bring in fresh pools continuously
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import logger from '../utils/logger';
import { fetchDLMMPools, DLMM_Pool } from './dlmmFetcher';
import { getEnrichedDLMMState, EnrichedSnapshot } from '../core/dlmmTelemetry';
import { recordSnapshot, DLMMTelemetry as ServiceDLMMTelemetry } from './dlmmTelemetry';

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
    swapVelocity: number;      // swaps per second
    poolEntropy: number;       // Shannon entropy 0-1
    liquidityFlow: number;     // % change in liquidity
    
    // Time-weighted metrics
    consistencyScore: number;  // 0-100, higher = more consistent
    spikeRatio: number;        // spike activity / sustained activity
    
    // Pass/fail flags
    passesPreTier: boolean;
    preFilterRejectReason?: string;
    
    // Depth requirements
    passesDepthRequirements: boolean;
    depthRejectReason?: string;
}

/**
 * Fully enriched pool ready for Tier4 scoring
 */
export interface DiscoveredPool extends PreTierPool {
    // Enriched telemetry
    telemetry: EnrichedSnapshot | null;
    
    // Final discovery score (pre-tier weighted)
    discoveryScore: number;
    
    // Time-weighted adjustments
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
    // No static caps - dynamic discovery
    enablePagination: boolean;
    maxPagesPerSource: number;
    
    // Pre-tier thresholds (discard at ingest)
    preTierThresholds: {
        minSwapVelocity: number;     // 0.12 swaps/sec
        minPoolEntropy: number;       // 0.65
        minLiquidityFlow: number;     // 0.5%
        minVolume24h: number;         // $75,000
    };
    
    // Market depth requirements
    depthRequirements: {
        minTVL: number;               // $200,000
        minUniqueSwappers24h: number; // 35
        minMedianTradeSize: number;   // $75
    };
    
    // Time-weighting
    timeWeighting: {
        consistencyWeight: number;    // Weight for consistency score
        spikesPenalty: number;        // Penalty multiplier for spiky activity
        minConsistencyScore: number;  // Minimum consistency to pass
    };
    
    // Cache settings
    cache: {
        ttlMinutes: number;           // 10-15 minutes
        rotationIntervalMinutes: number;
        deadPoolThreshold: number;    // Score below which pool is "dead"
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
    enablePagination: true,
    maxPagesPerSource: 10,  // No artificial limit
    
    preTierThresholds: {
        minSwapVelocity: 0.12,      // 0.12 swaps/sec
        minPoolEntropy: 0.65,        // High entropy required
        minLiquidityFlow: 0.005,     // 0.5% liquidity flow
        minVolume24h: 75000,         // $75k minimum volume
    },
    
    depthRequirements: {
        minTVL: 50000,               // $50k minimum (relaxed from $200k for testing)
        minUniqueSwappers24h: 10,    // 10 unique traders (relaxed from 35)
        minMedianTradeSize: 25,      // $25 median trade (relaxed from $75)
    },
    
    timeWeighting: {
        consistencyWeight: 0.30,
        spikesPenalty: 0.60,
        minConsistencyScore: 40,
    },
    
    cache: {
        ttlMinutes: 12,              // 12 minute cache (10-15 range)
        rotationIntervalMinutes: 3,  // Check for rotation every 3 min
        deadPoolThreshold: 15,       // Score below 15 = dead
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

interface PoolCache {
    pools: DiscoveredPool[];
    timestamp: number;
    lastRotation: number;
    sourceStats: {
        dlmm_sdk: number;
        helius: number;
        raydium: number;
        birdeye: number;
    };
}

let poolCache: PoolCache | null = null;
const poolHistory: Map<string, {
    snapshots: Array<{
        timestamp: number;
        swapVelocity: number;
        liquidityFlow: number;
        poolEntropy: number;
        volume: number;
    }>;
    avgSwapVelocity: number;
    avgLiquidityFlow: number;
    avgEntropy: number;
    consistencyScore: number;
    spikeRatio: number;
}> = new Map();

// Telemetry history for velocity computation
const telemetryHistory: Map<string, EnrichedSnapshot> = new Map();

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
            fees24h: p.volume24h * (p.feeTier / 10000), // Estimate fees
            activeBin: p.activeBin,
            binStep: p.binStep,
            price: p.price,
            uniqueSwappers24h: 0, // Will be enriched
            medianTradeSize: 0,   // Will be enriched
            symbol: `${p.mintA.slice(0, 4)}.../${p.mintB.slice(0, 4)}...`,
        }));
        
    } catch (error: any) {
        logger.error('[DISCOVERY] DLMM SDK fetch failed:', error?.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE 2: HELIUS (High volume / pump sorted)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchFromHelius(page: number = 1): Promise<RawDiscoveredPool[]> {
    const heliusApiKey = process.env.HELIUS_API_KEY;
    if (!heliusApiKey) {
        logger.warn('[DISCOVERY] Helius API key not configured');
        return [];
    }
    
    logger.info(`[DISCOVERY] Fetching from Helius (page ${page})...`);
    
    try {
        // Helius DAS API for token metadata and activity
        const response = await axios.post(
            `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
            {
                jsonrpc: '2.0',
                id: 'discovery',
                method: 'getAssetsByGroup',
                params: {
                    groupKey: 'collection',
                    groupValue: 'meteora_dlmm',
                    page,
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
        
        // Filter for DLMM-compatible pools
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
                activeBin: 0, // Not applicable for Raydium
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
        logger.warn('[DISCOVERY] Birdeye API key not configured');
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
                    const enrichedData = {
                        uniqueSwappers24h: data.uniqueWallet24h || data.trader24h || 0,
                        medianTradeSize: data.volume24h && data.trade24h 
                            ? data.volume24h / data.trade24h 
                            : 0,
                        volume24h: data.volume24h || 0,
                        tvl: data.liquidity || 0,
                    };
                    enrichmentMap.set(pool.id, enrichedData);
                    logger.debug(`[BIRDEYE] ✅ ${pool.id.slice(0, 8)}: TVL=$${enrichedData.tvl.toFixed(0)}, swappers=${enrichedData.uniqueSwappers24h}`);
                } else {
                    logger.debug(`[BIRDEYE] ⚠️ ${pool.id.slice(0, 8)}: Empty response`);
                }
            } catch (error: any) {
                logger.debug(`[BIRDEYE] ❌ ${pool.id.slice(0, 8)}: ${error.response?.status || error.message}`);
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

const KNOWN_DEAD_TOKENS: Set<string> = new Set([
    // Add known dead/scam token mints here
]);

const STABLECOIN_MINTS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

function isMememcoinCarcass(pool: RawDiscoveredPool): boolean {
    // Known dead tokens
    if (KNOWN_DEAD_TOKENS.has(pool.mintA) || KNOWN_DEAD_TOKENS.has(pool.mintB)) {
        return true;
    }
    
    // Stable-stable pairs (no trading opportunity)
    if (STABLECOIN_MINTS.has(pool.mintA) && STABLECOIN_MINTS.has(pool.mintB)) {
        return true;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // AGGRESSIVE UPSTREAM FILTER
    // Filter out pools BEFORE expensive on-chain telemetry fetch
    // This dramatically reduces RPC calls and speeds up discovery
    // ═══════════════════════════════════════════════════════════════════════════════
    
    // Require MINIMUM thresholds (must pass BOTH):
    // - At least $50k volume (down from $75k final filter to catch edge cases)
    // - At least $100k TVL (down from $200k final filter to catch edge cases)
    // This still gives margin before final pre-tier filters
    const MIN_VOLUME_UPSTREAM = 50000;   // $50k volume
    const MIN_TVL_UPSTREAM = 100000;     // $100k TVL
    
    if (pool.volume24h < MIN_VOLUME_UPSTREAM) {
        return true; // Dead - insufficient volume
    }
    
    if (pool.tvl < MIN_TVL_UPSTREAM) {
        return true; // Dead - insufficient TVL
    }
    
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-TIER FILTERING (DISCARD AT INGEST)
// ═══════════════════════════════════════════════════════════════════════════════

function calculatePoolHistory(poolId: string, currentMetrics: {
    swapVelocity: number;
    liquidityFlow: number;
    poolEntropy: number;
    volume: number;
}): {
    consistencyScore: number;
    spikeRatio: number;
    avgSwapVelocity: number;
    avgLiquidityFlow: number;
    avgEntropy: number;
} {
    const history = poolHistory.get(poolId);
    const now = Date.now();
    
    // Initialize history if needed
    if (!history) {
        poolHistory.set(poolId, {
            snapshots: [{
                timestamp: now,
                swapVelocity: currentMetrics.swapVelocity,
                liquidityFlow: currentMetrics.liquidityFlow,
                poolEntropy: currentMetrics.poolEntropy,
                volume: currentMetrics.volume,
            }],
            avgSwapVelocity: currentMetrics.swapVelocity,
            avgLiquidityFlow: currentMetrics.liquidityFlow,
            avgEntropy: currentMetrics.poolEntropy,
            consistencyScore: 50, // Neutral starting point
            spikeRatio: 0,
        });
        
        return {
            consistencyScore: 50,
            spikeRatio: 0,
            avgSwapVelocity: currentMetrics.swapVelocity,
            avgLiquidityFlow: currentMetrics.liquidityFlow,
            avgEntropy: currentMetrics.poolEntropy,
        };
    }
    
    // Add current snapshot
    history.snapshots.push({
        timestamp: now,
        swapVelocity: currentMetrics.swapVelocity,
        liquidityFlow: currentMetrics.liquidityFlow,
        poolEntropy: currentMetrics.poolEntropy,
        volume: currentMetrics.volume,
    });
    
    // Keep last 30 minutes of snapshots
    const thirtyMinAgo = now - (30 * 60 * 1000);
    history.snapshots = history.snapshots.filter(s => s.timestamp > thirtyMinAgo);
    
    if (history.snapshots.length < 2) {
        return {
            consistencyScore: 50,
            spikeRatio: 0,
            avgSwapVelocity: currentMetrics.swapVelocity,
            avgLiquidityFlow: currentMetrics.liquidityFlow,
            avgEntropy: currentMetrics.poolEntropy,
        };
    }
    
    // Calculate averages
    const avgSwapVelocity = history.snapshots.reduce((s, h) => s + h.swapVelocity, 0) / history.snapshots.length;
    const avgLiquidityFlow = history.snapshots.reduce((s, h) => s + h.liquidityFlow, 0) / history.snapshots.length;
    const avgEntropy = history.snapshots.reduce((s, h) => s + h.poolEntropy, 0) / history.snapshots.length;
    
    // Calculate consistency (lower variance = higher consistency)
    const velocityVariance = history.snapshots.reduce((s, h) => s + Math.pow(h.swapVelocity - avgSwapVelocity, 2), 0) / history.snapshots.length;
    const flowVariance = history.snapshots.reduce((s, h) => s + Math.pow(h.liquidityFlow - avgLiquidityFlow, 2), 0) / history.snapshots.length;
    
    // Normalize variance to 0-1 scale (higher = more variable, lower = more consistent)
    const velocityCoV = avgSwapVelocity > 0 ? Math.sqrt(velocityVariance) / avgSwapVelocity : 0;
    const flowCoV = avgLiquidityFlow > 0 ? Math.sqrt(flowVariance) / Math.abs(avgLiquidityFlow) : 0;
    
    // Consistency score: 100 = perfectly consistent, 0 = highly variable
    const consistencyScore = Math.max(0, Math.min(100, 100 - (velocityCoV * 50 + flowCoV * 50)));
    
    // Calculate spike ratio (max / average - 1)
    const maxVelocity = Math.max(...history.snapshots.map(h => h.swapVelocity));
    const maxFlow = Math.max(...history.snapshots.map(h => Math.abs(h.liquidityFlow)));
    
    const velocitySpikeRatio = avgSwapVelocity > 0 ? (maxVelocity / avgSwapVelocity) - 1 : 0;
    const flowSpikeRatio = avgLiquidityFlow > 0 ? (maxFlow / Math.abs(avgLiquidityFlow)) - 1 : 0;
    
    const spikeRatio = (velocitySpikeRatio + flowSpikeRatio) / 2;
    
    // Update history
    history.avgSwapVelocity = avgSwapVelocity;
    history.avgLiquidityFlow = avgLiquidityFlow;
    history.avgEntropy = avgEntropy;
    history.consistencyScore = consistencyScore;
    history.spikeRatio = spikeRatio;
    
    return {
        consistencyScore,
        spikeRatio,
        avgSwapVelocity,
        avgLiquidityFlow,
        avgEntropy,
    };
}

function applyPreTierFilter(
    pool: RawDiscoveredPool,
    microSignals: { swapVelocity: number; poolEntropy: number; liquidityFlow: number },
    config: DiscoveryConfig
): PreTierPool {
    const thresholds = config.preTierThresholds;
    const depthReqs = config.depthRequirements;
    
    // Get time-weighted metrics
    const timeMetrics = calculatePoolHistory(pool.id, {
        swapVelocity: microSignals.swapVelocity,
        liquidityFlow: microSignals.liquidityFlow,
        poolEntropy: microSignals.poolEntropy,
        volume: pool.volume24h,
    });
    
    // Pre-tier check (discard at ingest)
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
    } else if (pool.volume24h < thresholds.minVolume24h) {
        passesPreTier = false;
        preFilterRejectReason = `volume24h $${pool.volume24h.toFixed(0)} < $${thresholds.minVolume24h}`;
    }
    
    // Depth requirements check
    let passesDepthRequirements = true;
    let depthRejectReason: string | undefined;
    
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
    
    return {
        ...pool,
        swapVelocity: microSignals.swapVelocity,
        poolEntropy: microSignals.poolEntropy,
        liquidityFlow: microSignals.liquidityFlow,
        consistencyScore: timeMetrics.consistencyScore,
        spikeRatio: timeMetrics.spikeRatio,
        passesPreTier,
        preFilterRejectReason,
        passesDepthRequirements,
        depthRejectReason,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-WEIGHTED SCORING
// ═══════════════════════════════════════════════════════════════════════════════

function calculateTimeWeightMultiplier(pool: PreTierPool, config: DiscoveryConfig): number {
    const tw = config.timeWeighting;
    
    // Base multiplier
    let multiplier = 1.0;
    
    // Consistency bonus (0-30% boost based on weight)
    const consistencyBonus = (pool.consistencyScore / 100) * tw.consistencyWeight;
    multiplier += consistencyBonus;
    
    // Spike penalty (up to 40% reduction)
    const spikePenalty = Math.min(pool.spikeRatio, 1.0) * tw.spikesPenalty;
    multiplier -= spikePenalty;
    
    // Clamp to reasonable range
    return Math.max(0.5, Math.min(1.5, multiplier));
}

function calculateDiscoveryScore(pool: PreTierPool, config: DiscoveryConfig): number {
    // Base score from volume and TVL
    const volumeScore = Math.log10(Math.max(pool.volume24h, 1)) * 10;
    const tvlScore = Math.log10(Math.max(pool.tvl, 1)) * 8;
    
    // Micro-signal scores
    const velocityScore = Math.min(pool.swapVelocity / 0.5, 1) * 25;
    const entropyScore = pool.poolEntropy * 20;
    const flowScore = Math.min(Math.abs(pool.liquidityFlow) / 0.1, 1) * 15;
    
    // Depth scores
    const swapperScore = Math.min(pool.uniqueSwappers24h / 100, 1) * 10;
    const tradeSizeScore = Math.min(pool.medianTradeSize / 200, 1) * 12;
    
    // Raw score
    const rawScore = volumeScore + tvlScore + velocityScore + entropyScore + flowScore + swapperScore + tradeSizeScore;
    
    // Apply time-weight multiplier
    const timeWeightMultiplier = calculateTimeWeightMultiplier(pool, config);
    
    return rawScore * timeWeightMultiplier;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE ROTATION LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

function shouldRotatePool(pool: DiscoveredPool, config: DiscoveryConfig): boolean {
    // Pool is dead if score drops below threshold
    if (pool.discoveryScore < config.cache.deadPoolThreshold) {
        return true;
    }
    
    // Pool is dead if telemetry is invalid
    if (pool.telemetry?.invalidTelemetry) {
        return true;
    }
    
    // Pool is dead if no activity
    if (pool.swapVelocity < 0.01 && pool.liquidityFlow === 0) {
        return true;
    }
    
    return false;
}

function rotateCache(cache: PoolCache, freshPools: DiscoveredPool[], config: DiscoveryConfig): PoolCache {
    const now = Date.now();
    
    // Remove dead pools
    const alivePools = cache.pools.filter(p => !shouldRotatePool(p, config));
    
    // Build set of existing pool IDs
    const existingIds = new Set(alivePools.map(p => p.id));
    
    // Add fresh pools that aren't duplicates
    const newPools = freshPools.filter(p => !existingIds.has(p.id));
    
    // Combine and sort by discovery score
    const allPools = [...alivePools, ...newPools].sort((a, b) => b.discoveryScore - a.discoveryScore);
    
    logger.info(`[ROTATION] Removed ${cache.pools.length - alivePools.length} dead pools, added ${newPools.length} fresh pools`);
    
    return {
        pools: allPools,
        timestamp: cache.timestamp,
        lastRotation: now,
        sourceStats: {
            dlmm_sdk: allPools.filter(p => p.source === 'dlmm_sdk').length,
            helius: allPools.filter(p => p.source === 'helius').length,
            raydium: allPools.filter(p => p.source === 'raydium').length,
            birdeye: allPools.filter(p => p.source === 'birdeye').length,
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISCOVERY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discover DLMM pool universe with multi-source integration and dynamic filtering.
 * 
 * NO STATIC LIMITS. Dynamic discovery with pre-tier filtering.
 * 
 * @param config - Discovery configuration
 * @returns Discovered pools ready for Tier4 scoring (never reaches Tier4 if filtered)
 */
export async function discoverPools(
    config: DiscoveryConfig = DEFAULT_DISCOVERY_CONFIG
): Promise<DiscoveredPool[]> {
    const startTime = Date.now();
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('[DISCOVERY] 🚀 Starting multi-source dynamic discovery...');
    logger.info(`[DISCOVERY] Pre-tier thresholds: velocity>=${config.preTierThresholds.minSwapVelocity}, entropy>=${config.preTierThresholds.minPoolEntropy}, flow>=${config.preTierThresholds.minLiquidityFlow * 100}%, vol>=$${config.preTierThresholds.minVolume24h}`);
    logger.info(`[DISCOVERY] Depth requirements: TVL>=$${config.depthRequirements.minTVL}, swappers>=${config.depthRequirements.minUniqueSwappers24h}, tradeSize>=$${config.depthRequirements.minMedianTradeSize}`);
    logger.info('═══════════════════════════════════════════════════════════════════');
    
    // Check cache validity
    const now = Date.now();
    const cacheTTLMs = config.cache.ttlMinutes * 60 * 1000;
    const rotationIntervalMs = config.cache.rotationIntervalMinutes * 60 * 1000;
    
    // If cache is valid and not due for rotation, return cached pools
    if (poolCache && (now - poolCache.timestamp) < cacheTTLMs) {
        // Check if rotation is due
        if ((now - poolCache.lastRotation) >= rotationIntervalMs) {
            logger.info('[DISCOVERY] 🔄 Cache valid but rotation due - fetching fresh pools...');
            // Will continue to fetch fresh pools for rotation
        } else {
            logger.info(`[DISCOVERY] 📦 Using cached universe (${poolCache.pools.length} pools, age: ${Math.round((now - poolCache.timestamp) / 1000)}s)`);
            return poolCache.pools;
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MULTI-SOURCE FETCH (PARALLEL)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const [dlmmPools, heliusPools, raydiumPools] = await Promise.all([
        fetchFromDLMMSDK(),
        fetchFromHelius(1), // First page
        fetchFromRaydium(),
    ]);
    
    logger.info(`[DISCOVERY] Sources: DLMM=${dlmmPools.length}, Helius=${heliusPools.length}, Raydium=${raydiumPools.length}`);
    
    // If pagination is enabled and Helius has results, fetch more pages
    let allHeliusPools = [...heliusPools];
    if (config.enablePagination && heliusPools.length > 0) {
        for (let page = 2; page <= config.maxPagesPerSource; page++) {
            const morePools = await fetchFromHelius(page);
            if (morePools.length === 0) break;
            allHeliusPools.push(...morePools);
        }
    }
    
    // Combine all sources
    const allRawPools: RawDiscoveredPool[] = [...dlmmPools, ...allHeliusPools, ...raydiumPools];
    
    // Deduplicate by pool ID
    const seenIds = new Set<string>();
    const uniquePools = allRawPools.filter(p => {
        if (seenIds.has(p.id)) return false;
        seenIds.add(p.id);
        return true;
    });
    
    logger.info(`[DISCOVERY] Total unique pools before filtering: ${uniquePools.length}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEMECOIN CARCASS FILTER
    // ═══════════════════════════════════════════════════════════════════════════
    
    const nonCarcassPools = uniquePools.filter(p => !isMememcoinCarcass(p));
    logger.info(`[DISCOVERY] After memecoin carcass filter: ${nonCarcassPools.length}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BIRDEYE ENRICHMENT (for depth metrics)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const birdeyeEnrichment = await enrichWithBirdeye(nonCarcassPools);
    
    logger.info(`[BIRDEYE] Enrichment: ${birdeyeEnrichment.size}/${nonCarcassPools.length} pools enriched`);
    
    // Apply enrichment
    let enrichedCount = 0;
    for (const pool of nonCarcassPools) {
        const enriched = birdeyeEnrichment.get(pool.id);
        if (enriched && enriched.uniqueSwappers24h > 0) {
            pool.uniqueSwappers24h = enriched.uniqueSwappers24h;
            pool.medianTradeSize = enriched.medianTradeSize || pool.medianTradeSize;
            pool.volume24h = enriched.volume24h || pool.volume24h;
            pool.tvl = enriched.tvl || pool.tvl;
            enrichedCount++;
        } else {
            // ═══════════════════════════════════════════════════════════════════
            // BIRDEYE FALLBACK: Estimate swappers from volume
            // Birdeye doesn't index Meteora DLMM pools, so we estimate:
            // - Assume average trade size of $500
            // - uniqueSwappers ≈ volume / $500 (capped at 500 for realism)
            // ═══════════════════════════════════════════════════════════════════
            const estimatedTrades = Math.floor(pool.volume24h / 500);
            pool.uniqueSwappers24h = Math.min(estimatedTrades, 500);
            pool.medianTradeSize = pool.volume24h > 0 && estimatedTrades > 0
                ? pool.volume24h / estimatedTrades
                : 0;
        }
    }
    
    logger.info(`[BIRDEYE] Enriched ${enrichedCount} pools, estimated ${nonCarcassPools.length - enrichedCount} from volume`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ON-CHAIN TELEMETRY & PRE-TIER FILTERING
    // ═══════════════════════════════════════════════════════════════════════════
    
    const preTierPools: PreTierPool[] = [];
    let preTierRejects = 0;
    let depthRejects = 0;
    
    for (const pool of nonCarcassPools) {
        try {
            // Get previous telemetry for velocity calculation
            const prevTelemetry = telemetryHistory.get(pool.id);
            
            // Fetch on-chain telemetry
            const telemetry = await getEnrichedDLMMState(pool.id, prevTelemetry);
            
            if (telemetry.invalidTelemetry) {
                preTierRejects++;
                continue;
            }
            
            // Store for next cycle (pre-tier filter)
            telemetryHistory.set(pool.id, telemetry);
            
            // ═══════════════════════════════════════════════════════════════════
            // COLD START FIX: Record snapshot to scoring history
            // This ensures pools get their first snapshot during discovery,
            // accelerating the MIN_SNAPSHOTS warmup period
            // ═══════════════════════════════════════════════════════════════════
            const serviceTelemetry: ServiceDLMMTelemetry = {
                poolAddress: pool.id,
                activeBin: telemetry.activeBin,
                binStep: pool.binStep || 0,
                liquidityUSD: telemetry.liquidity,
                inventoryBase: 0, // Not available from EnrichedSnapshot
                inventoryQuote: 0,
                feeRateBps: 0,
                velocity: telemetry.velocity,
                recentTrades: 0,
                fetchedAt: telemetry.timestamp,
            };
            recordSnapshot(serviceTelemetry);
            
            // Calculate micro-signals
            // On first discovery (no prev snapshot), we don't have velocity/liquidityFlow history
            // So we allow pools to pass if they meet OTHER criteria (entropy, volume, TVL)
            const isFirstSnapshot = !prevTelemetry || prevTelemetry.liquidity <= 0;
            
            // Velocity requires history to compute - default to threshold on first run
            const swapVelocity = isFirstSnapshot
                ? config.preTierThresholds.minSwapVelocity // Pass on first run
                : telemetry.velocity;
            
            const poolEntropy = telemetry.entropy;
            
            // LiquidityFlow requires history - default to threshold on first run  
            const liquidityFlow = isFirstSnapshot
                ? config.preTierThresholds.minLiquidityFlow // Pass on first run
                : (telemetry.liquidity - prevTelemetry.liquidity) / prevTelemetry.liquidity;
            
            // Apply pre-tier filter
            const preTierPool = applyPreTierFilter(
                pool,
                { swapVelocity, poolEntropy, liquidityFlow },
                config
            );
            
            if (!preTierPool.passesPreTier) {
                preTierRejects++;
                // Log at INFO level for visibility during discovery
                logger.info(`[PRE-TIER] ❌ ${pool.symbol || pool.id.slice(0, 8)}... rejected: ${preTierPool.preFilterRejectReason}`);
                continue;
            }
            
            if (!preTierPool.passesDepthRequirements) {
                depthRejects++;
                // Log at INFO to see what's failing depth requirements
                logger.info(`[DEPTH] ❌ ${pool.symbol || pool.id.slice(0, 8)}... rejected: ${preTierPool.depthRejectReason}`);
                continue;
            }
            
            preTierPools.push(preTierPool);
            
        } catch (error: any) {
            logger.debug(`[DISCOVERY] Error processing ${pool.id}: ${error?.message}`);
            preTierRejects++;
        }
    }
    
    logger.info(`[DISCOVERY] Pre-tier filter: ${preTierRejects} rejected, ${depthRejects} depth fails, ${preTierPools.length} passed`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIME-WEIGHTED SCORING
    // ═══════════════════════════════════════════════════════════════════════════
    
    const discoveredPools: DiscoveredPool[] = preTierPools.map(pool => {
        const telemetry = telemetryHistory.get(pool.id) || null;
        const timeWeightMultiplier = calculateTimeWeightMultiplier(pool, config);
        const discoveryScore = calculateDiscoveryScore(pool, config);
        
        // Health check
        const healthReasons: string[] = [];
        let isHealthy = true;
        
        if (pool.consistencyScore < config.timeWeighting.minConsistencyScore) {
            isHealthy = false;
            healthReasons.push(`Low consistency: ${pool.consistencyScore.toFixed(1)}`);
        }
        
        if (pool.spikeRatio > 2.0) {
            isHealthy = false;
            healthReasons.push(`High spike ratio: ${pool.spikeRatio.toFixed(2)}`);
        }
        
        return {
            ...pool,
            telemetry,
            discoveryScore,
            timeWeightMultiplier,
            isHealthy,
            healthReasons,
            lastUpdated: now,
        };
    });
    
    // Sort by discovery score
    discoveredPools.sort((a, b) => b.discoveryScore - a.discoveryScore);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CACHE UPDATE / ROTATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (poolCache && (now - poolCache.timestamp) < cacheTTLMs) {
        // Rotation: merge fresh pools with existing cache
        poolCache = rotateCache(poolCache, discoveredPools, config);
    } else {
        // Full refresh
        poolCache = {
            pools: discoveredPools,
            timestamp: now,
            lastRotation: now,
            sourceStats: {
                dlmm_sdk: discoveredPools.filter(p => p.source === 'dlmm_sdk').length,
                helius: discoveredPools.filter(p => p.source === 'helius').length,
                raydium: discoveredPools.filter(p => p.source === 'raydium').length,
                birdeye: 0,
            },
        };
    }
    
    const duration = Date.now() - startTime;
    
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info(`[DISCOVERY] ✅ Discovered ${poolCache.pools.length} pools in ${duration}ms`);
    logger.info(`[DISCOVERY] Sources: DLMM=${poolCache.sourceStats.dlmm_sdk}, Helius=${poolCache.sourceStats.helius}, Raydium=${poolCache.sourceStats.raydium}`);
    logger.info(`[DISCOVERY] Top 3 pools:`);
    for (const pool of poolCache.pools.slice(0, 3)) {
        logger.info(`   → ${pool.symbol || pool.id.slice(0, 8)} | score=${pool.discoveryScore.toFixed(1)} | consistency=${pool.consistencyScore.toFixed(1)} | healthy=${pool.isHealthy}`);
    }
    logger.info('═══════════════════════════════════════════════════════════════════');
    
    return poolCache.pools;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Force refresh the pool cache
 */
export function invalidateDiscoveryCache(): void {
    poolCache = null;
    logger.info('[DISCOVERY] 🔄 Cache invalidated');
}

/**
 * Get cache status
 */
export function getDiscoveryCacheStatus(): {
    cached: boolean;
    age: number;
    poolCount: number;
    lastRotation: number;
    sourceStats: PoolCache['sourceStats'] | null;
} {
    if (!poolCache) {
        return { cached: false, age: 0, poolCount: 0, lastRotation: 0, sourceStats: null };
    }
    
    return {
        cached: true,
        age: Date.now() - poolCache.timestamp,
        poolCount: poolCache.pools.length,
        lastRotation: Date.now() - poolCache.lastRotation,
        sourceStats: poolCache.sourceStats,
    };
}

/**
 * Get pool history for a specific pool
 */
export function getPoolDiscoveryHistory(poolId: string): typeof poolHistory extends Map<string, infer V> ? V | undefined : never {
    return poolHistory.get(poolId);
}

/**
 * Convert DiscoveredPool to Pool format for compatibility with existing scoring pipeline
 */
export function discoveredPoolToPool(discovered: DiscoveredPool): any {
    return {
        // Core identification
        address: discovered.id,
        name: discovered.symbol || `${discovered.mintA.slice(0, 6)}/${discovered.mintB.slice(0, 6)}`,
        tokenX: discovered.mintA,
        tokenY: discovered.mintB,
        mintX: discovered.mintA,
        mintY: discovered.mintB,
        
        // Telemetry
        liquidity: discovered.tvl,
        volume24h: discovered.volume24h,
        volume1h: discovered.volume24h / 24,
        volume4h: discovered.volume24h / 6,
        velocity: discovered.swapVelocity,
        fees24h: discovered.fees24h,
        apr: discovered.tvl > 0 ? (discovered.fees24h * 365) / discovered.tvl * 100 : 0,
        
        // DLMM structure
        binStep: discovered.binStep,
        baseFee: 0,
        binCount: discovered.telemetry?.binCount || 0,
        
        // On-chain data
        entropy: discovered.poolEntropy,
        migrationDirection: discovered.telemetry?.migrationDirection || 'stable',
        onChainLiquidity: discovered.telemetry?.liquidity || 0,
        activeBin: discovered.activeBin || discovered.telemetry?.activeBin || 0,
        
        // Metadata
        createdAt: discovered.createdAt || 0,
        holderCount: 0,
        topHolderPercent: 0,
        isRenounced: true,
        
        // Scores
        riskScore: 0,
        dilutionScore: 0,
        score: discovered.discoveryScore,
        
        // Price
        currentPrice: discovered.price,
        
        // Discovery metadata
        discoverySource: discovered.source,
        consistencyScore: discovered.consistencyScore,
        spikeRatio: discovered.spikeRatio,
        timeWeightMultiplier: discovered.timeWeightMultiplier,
        isHealthy: discovered.isHealthy,
    };
}

