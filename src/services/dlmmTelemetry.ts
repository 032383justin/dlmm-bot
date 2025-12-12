/**
 * DLMM Live On-Chain Telemetry Service
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: ALL TELEMETRY MUST COME FROM METEORA DLMM SDK WITH PROPER METADATA
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * DO NOT use Birdeye, Bitquery, or any external API for DLMM state.
 * Those only provide volume/TVL/prices - NOT bin distribution or pool reserves.
 * 
 * DLMM alpha exists inside short-term bin-level volatility.
 * You cannot score microstructure without real on-chain pool state.
 * 
 * MANDATORY FLOW:
 * 1. Fetch ALL pool metadata from https://dlmm-api.meteora.ag/pair/all
 * 2. Index metadata by pool address
 * 3. Pass metadata to DLMM.create(connection, poolPubkey, { cluster: 'mainnet-beta' })
 * 4. If no metadata found → SKIP pool
 * 
 * Each pool is hydrated using:
 *   const dlmm = await DLMM.create(connection, poolPubkey, { cluster: 'mainnet-beta' });
 *   await dlmm.refetchStates();          // Refresh on-chain data
 *   const activeBin = await dlmm.getActiveBin(); // Get active bin + price
 *   const bins = await dlmm.getBinsBetweenLowerAndUpperBound(...); // Get bin liquidity
 * 
 * Batch size: 10 pools
 * Retries: 2 (total 3 attempts with exponential backoff)
 * Failed pools are SKIPPED (not marked invalid)
 * 
 * RULE: Use liquidityUSD everywhere. NEVER use totalLiquidity.
 */

import DLMM from '@meteora-ag/dlmm';
import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import logger from '../utils/logger';
import { 
    fetchTokenDecimals, 
    getCachedMetadata 
} from '../engine/valueNormalization';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Raw Meteora API pool metadata from https://dlmm-api.meteora.ag/pair/all
 */
export interface MeteoraPoolMetadata {
    address: string;
    name: string;
    mint_x: string;
    mint_y: string;
    reserve_x: string;
    reserve_y: string;
    reserve_x_amount: number;
    reserve_y_amount: number;
    bin_step: number;
    base_fee_percentage: string;
    max_fee_percentage: string;
    protocol_fee_percentage: string;
    liquidity: string;
    reward_mint_x: string;
    reward_mint_y: string;
    fees_24h: number;
    today_fees: number;
    trade_volume_24h: number;
    cumulative_trade_volume: string;
    cumulative_fee_volume: string;
    current_price: number;
    apr: number;
    apy: number;
    farm_apr: number;
    farm_apy: number;
    hide: boolean;
}

/**
 * Core DLMM telemetry from on-chain state (fully hydrated via SDK)
 * 
 * RULE: This is the ONLY telemetry interface. No alternatives.
 */
export interface DLMMTelemetry {
    poolAddress: string;
    activeBin: number;
    binStep: number;
    liquidityUSD: number;       // Total liquidity in USD (NEVER use totalLiquidity)
    inventoryBase: number;      // Token X reserves (normalized)
    inventoryQuote: number;     // Token Y reserves (normalized)
    feeRateBps: number;         // Fee rate in basis points
    velocity: number;           // Bin movement velocity (bins/sec)
    recentTrades: number;       // Estimated trade count from bin changes
    fetchedAt: number;          // Timestamp when fetched
}

/**
 * Core DLMM pool state (compatibility interface for downstream)
 */
export interface DLMMState {
    poolId: string;
    tokenX: string;
    tokenY: string;
    activeBin: number;
    binStep: number;
    liquidityX: number;
    liquidityY: number;
    liquidityUSD: number;       // NEVER use totalLiquidity
    feeTier: number;
    timestamp: number;
}

/**
 * Swap event for history tracking
 */
export interface SwapTick {
    poolId: string;
    signature: string;
    amountIn: number;
    amountOut: number;
    binBefore: number;
    binAfter: number;
    feePaid: number;
    timestamp: number;
    direction: 'buy' | 'sell';
}

/**
 * Computed microstructure metrics for a pool
 */
export interface MicrostructureMetrics {
    poolId: string;
    
    // Core metrics (normalized 0-100)
    binVelocity: number;
    liquidityFlow: number;
    swapVelocity: number;
    feeIntensity: number;
    
    // Raw values
    rawBinDelta: number;
    rawLiquidityDelta: number;
    rawSwapCount: number;
    rawFeesGenerated: number;
    
    // Pool entropy
    poolEntropy: number;
    
    // Computed score
    poolScore: number;
    
    // Gating status
    isMarketAlive: boolean;
    gatingReasons: string[];
    
    // Window info
    windowStartMs: number;
    windowEndMs: number;
    snapshotCount: number;
    
    timestamp: number;
}

/**
 * Position state for bin-focused tracking
 */
export interface BinFocusedPosition {
    poolId: string;
    entryBin: number;
    entryTime: number;
    entryFeeIntensity: number;
    entrySwapVelocity: number;
    entry3mFeeIntensity: number;
    entry3mSwapVelocity: number;
    
    // Tier 4 additions (optional)
    entryTier4Score?: number;
    entryRegime?: string;
    entryMigrationDirection?: string;
    entryVelocitySlope?: number;
    entryLiquiditySlope?: number;
    entryEntropySlope?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// Meteora API endpoint for pool metadata
const METEORA_API_ENDPOINT = 'https://dlmm-api.meteora.ag/pair/all';

// RPC Configuration - uses centralized config (no fallback)
import { RPC_URL, getConnection as getRpcConnection } from '../config/rpc';

// Batch processing
const BATCH_SIZE = 10;              // Batch pools in groups of 10
const MAX_RETRIES = 3;              // Total attempts: 1 initial + 2 retries
const INITIAL_BACKOFF_MS = 1000;    // Start with 1 second backoff

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY-SAFE HISTORY CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
// CRITICAL: Keep history VERY small to prevent OOM
// Only need 3 snapshots for velocity calculation
const MAX_HISTORY_LENGTH = 3;          // Reduced from 20 - minimum for velocity
const SNAPSHOT_INTERVAL_MS = 8000;
const MAX_TRACKED_POOLS = 15;          // Never track more than 15 pools

// Bin range for fetching (±20 bins around active)
const BIN_FETCH_RANGE = 20;

// Metadata cache TTL (5 minutes)
const METADATA_CACHE_TTL = 5 * 60 * 1000;

// Scoring weights
const SCORING_WEIGHTS = {
    binVelocity: 0.30,
    liquidityFlow: 0.30,
    swapVelocity: 0.25,
    feeIntensity: 0.15,
};

// Gating thresholds
const GATING_THRESHOLDS = {
    minBinVelocity: 0.03,
    minSwapVelocity: 0.10,
    minPoolEntropy: 0.65,
    minLiquidityFlow: 0.005,
};

// Exit thresholds
const EXIT_THRESHOLDS = {
    feeIntensityCollapse: 0.35,
    minSwapVelocity: 0.05,
    maxBinOffset: 2,
};

// Token price cache
const TOKEN_PRICE_CACHE: Map<string, { price: number; timestamp: number }> = new Map();
const PRICE_CACHE_TTL = 60000; // 1 minute

// Known stablecoins (price = 1 USD)
const STABLECOINS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/**
 * Known token decimals (local fallback cache)
 * 
 * @deprecated Prefer using fetchTokenDecimals() from valueNormalization module
 * for on-chain verified decimals. This map is only used as a fallback when
 * on-chain fetch is not available.
 */
const TOKEN_DECIMALS: Map<string, number> = new Map([
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6], // USDC
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6], // USDT
    ['So11111111111111111111111111111111111111112', 9],   // SOL
]);

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Connection instance (singleton)
let connection: Connection | null = null;

// Rolling history buffer: poolId -> DLMMTelemetry[]
const poolHistory: Map<string, DLMMTelemetry[]> = new Map();

// Swap tick buffer: poolId -> SwapTick[]
const swapHistory: Map<string, SwapTick[]> = new Map();

// Last snapshot time per pool
const lastSnapshotTime: Map<string, number> = new Map();

// Active positions for exit monitoring
const activePositions: Map<string, BinFocusedPosition> = new Map();

// DLMM pool client cache (reuse SDK instances)
const dlmmClientCache: Map<string, DLMM> = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// METEORA METADATA CACHE
// ═══════════════════════════════════════════════════════════════════════════════

// Pool metadata indexed by address
let poolMetadataCache: Map<string, MeteoraPoolMetadata> = new Map();
let metadataCacheTimestamp: number = 0;

/**
 * Fetch all pool metadata from Meteora API and index by address.
 * This MUST be called BEFORE hydration.
 * 
 * Returns: Map<poolAddress, MeteoraPoolMetadata>
 */
export async function fetchAllMeteoraPoolMetadata(): Promise<Map<string, MeteoraPoolMetadata>> {
    const now = Date.now();
    
    // Return cached if still valid
    if (poolMetadataCache.size > 0 && (now - metadataCacheTimestamp) < METADATA_CACHE_TTL) {
        logger.debug(`[METEORA-API] Using cached metadata (${poolMetadataCache.size} pools, age: ${Math.round((now - metadataCacheTimestamp) / 1000)}s)`);
        return poolMetadataCache;
    }
    
    logger.info(`[METEORA-API] Fetching pool metadata from ${METEORA_API_ENDPOINT}...`);
    
    try {
        const response = await axios.get<MeteoraPoolMetadata[]>(METEORA_API_ENDPOINT, {
            timeout: 30000,
        });
        
        if (!response.data || !Array.isArray(response.data)) {
            logger.error('[METEORA-API] Invalid response - expected array');
            return poolMetadataCache; // Return stale cache
        }
        
        const rawPools = response.data;
        
        // Index by address
        const newCache = new Map<string, MeteoraPoolMetadata>();
        
        for (const pool of rawPools) {
            if (pool.address && !pool.hide) {
                newCache.set(pool.address, pool);
            }
        }
        
        poolMetadataCache = newCache;
        metadataCacheTimestamp = now;
        
        logger.info(`[METEORA-API] ✓ Indexed ${newCache.size} pools from Meteora API`);
        
        return poolMetadataCache;
        
    } catch (error: any) {
        logger.error(`[METEORA-API] Failed to fetch metadata: ${error.message || error}`);
        return poolMetadataCache; // Return stale cache
    }
}

/**
 * Get metadata for a specific pool address.
 * Returns null if not found → pool should be SKIPPED.
 */
export function getPoolMetadata(poolAddress: string): MeteoraPoolMetadata | null {
    return poolMetadataCache.get(poolAddress) || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function getConnection(): Connection {
    if (!connection) {
        connection = getRpcConnection();
        logger.info(`[DLMM-SDK] Connected to RPC: ${RPC_URL.slice(0, 50)}...`);
    }
    return connection;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN PRICE FETCHING (Jupiter Price API)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get token price in USD (with caching)
 */
async function getTokenPriceUSD(mintAddress: string): Promise<number> {
    if (STABLECOINS.has(mintAddress)) {
        return 1.0;
    }
    
    const cached = TOKEN_PRICE_CACHE.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
        return cached.price;
    }
    
    try {
        const response = await axios.get(
            `https://price.jup.ag/v4/price?ids=${mintAddress}`,
            { timeout: 5000 }
        );
        
        const price = response.data?.data?.[mintAddress]?.price || 0;
        
        if (price > 0) {
            TOKEN_PRICE_CACHE.set(mintAddress, { price, timestamp: Date.now() });
            return price;
        }
    } catch {
        // Silently fail, use cached if available
    }
    
    return cached?.price || 0;
}

/**
 * Get token decimals from cache or on-chain.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PRIORITY ORDER:
 * 1. Check valueNormalization cache (on-chain verified)
 * 2. Check local TOKEN_DECIMALS map (known tokens)
 * 3. Return null to signal need for async fetch
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * For synchronous usage, falls back to known tokens.
 * For USD normalization, use fetchTokenDecimals() directly.
 */
function getTokenDecimals(mintAddress: string): number {
    // Check valueNormalization cache first (on-chain verified)
    const cached = getCachedMetadata(mintAddress);
    if (cached) {
        return cached.decimals;
    }
    
    // Check local cache for known tokens
    const known = TOKEN_DECIMALS.get(mintAddress);
    if (known !== undefined) return known;
    
    // Fallback: log warning and use common defaults
    // This should be avoided - prefer async fetchTokenDecimals()
    logger.warn(`[DECIMALS] No cached decimals for ${mintAddress.slice(0, 8)}... - using fallback`);
    return STABLECOINS.has(mintAddress) ? 6 : 9;
}

/**
 * Get token decimals asynchronously with on-chain verification.
 * 
 * This is the preferred method for USD normalization.
 * Falls back to local cache if on-chain fetch fails.
 * 
 * @param mintAddress - Token mint address
 * @returns Verified decimals from on-chain SPL metadata
 */
async function getTokenDecimalsAsync(mintAddress: string): Promise<number> {
    try {
        const metadata = await fetchTokenDecimals(mintAddress);
        return metadata.decimals;
    } catch (error: any) {
        // Fall back to local cache
        logger.warn(`[DECIMALS] On-chain fetch failed for ${mintAddress.slice(0, 8)}...: ${error.message}`);
        return getTokenDecimals(mintAddress);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL DLMM SDK POOL HYDRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fully hydrate a single pool using Meteora DLMM SDK.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: Requires metadata from fetchAllMeteoraPoolMetadata() first!
 * If no metadata → SKIP pool (return null)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Calls:
 *   - DLMM.create(connection, poolPubkey, { cluster: 'mainnet-beta' })
 *   - await dlmm.refetchStates()
 *   - await dlmm.getActiveBin()
 *   - await dlmm.getBinsBetweenLowerAndUpperBound(...)
 * 
 * @param poolAddress - Pool address
 * @param metadata - Pool metadata from Meteora API (REQUIRED)
 * @returns Telemetry or null if hydration fails
 */
async function hydratePoolWithSDK(
    poolAddress: string,
    metadata: MeteoraPoolMetadata
): Promise<DLMMTelemetry | null> {
    const conn = getConnection();
    const fetchedAt = Date.now();
    
    try {
        const poolPubkey = new PublicKey(poolAddress);
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 1: Create or retrieve cached DLMM instance WITH CONFIG
        // MUST pass cluster config to get proper initialization
        // ═══════════════════════════════════════════════════════════════════════
        let dlmm = dlmmClientCache.get(poolAddress);
        
        if (!dlmm) {
            logger.debug(`[DLMM-SDK] Creating DLMM instance for ${poolAddress.slice(0, 8)}... (${metadata.name})`);
            
            // Create with cluster config - this ensures proper account loading
            dlmm = await DLMM.create(conn, poolPubkey, {
                cluster: 'mainnet-beta',
            });
            
            dlmmClientCache.set(poolAddress, dlmm);
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 2: Refresh on-chain state (getPoolState equivalent)
        // ═══════════════════════════════════════════════════════════════════════
        await dlmm.refetchStates();
        
        // Extract core pool parameters
        const lbPair = dlmm.lbPair;
        const activeBinId = lbPair.activeId;
        const binStep = lbPair.binStep;
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 3: Get active bin and price (getPrice equivalent)
        // ═══════════════════════════════════════════════════════════════════════
        const activeBinData = await dlmm.getActiveBin();
        const pricePerToken = activeBinData?.pricePerToken 
            ? Number(activeBinData.pricePerToken) 
            : 0;
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 4: Get bins around active bin (getBins equivalent)
        // ═══════════════════════════════════════════════════════════════════════
        let binCount = 0;
        try {
            const binsResult = await dlmm.getBinsBetweenLowerAndUpperBound(
                activeBinId - BIN_FETCH_RANGE,
                activeBinId + BIN_FETCH_RANGE
            );
            
            const bins = binsResult?.bins || binsResult || [];
            binCount = Array.isArray(bins) ? bins.length : 0;
        } catch (binErr) {
            logger.debug(`[DLMM-SDK] getBins failed for ${poolAddress.slice(0, 8)}...: ${binErr}`);
            // Continue - bins not strictly required
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 5: Extract reserves from SDK (NOT from metadata - SDK has latest)
        // ═══════════════════════════════════════════════════════════════════════
        const tokenXMint = lbPair.tokenXMint.toString();
        const tokenYMint = lbPair.tokenYMint.toString();
        
        // Get reserves from SDK (on-chain state)
        const reserveX = Number(lbPair.reserveX || 0);
        const reserveY = Number(lbPair.reserveY || 0);
        
        // Fallback: use metadata reserves if SDK returns 0
        const finalReserveX = reserveX > 0 ? reserveX : Number(metadata.reserve_x_amount || 0);
        const finalReserveY = reserveY > 0 ? reserveY : Number(metadata.reserve_y_amount || 0);
        
        const decimalsX = getTokenDecimals(tokenXMint);
        const decimalsY = getTokenDecimals(tokenYMint);
        
        const inventoryBase = finalReserveX / Math.pow(10, decimalsX);
        const inventoryQuote = finalReserveY / Math.pow(10, decimalsY);
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 6: Get token prices for USD valuation
        // ═══════════════════════════════════════════════════════════════════════
        const priceX = await getTokenPriceUSD(tokenXMint);
        const priceY = await getTokenPriceUSD(tokenYMint);
        
        // Calculate total liquidity in USD
        let liquidityUSD = (inventoryBase * priceX) + (inventoryQuote * priceY);
        
        // Fallback: use metadata liquidity if calculated is 0
        if (liquidityUSD <= 0) {
            liquidityUSD = Number(metadata.liquidity || 0);
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 7: Extract fee rate
        // ═══════════════════════════════════════════════════════════════════════
        // baseFactor is in basis points (e.g., 30 = 0.30%)
        let feeRateBps = lbPair.parameters?.baseFactor || 0;
        
        // Fallback: use metadata fee if SDK returns 0
        if (feeRateBps === 0) {
            feeRateBps = Math.round(parseFloat(metadata.base_fee_percentage || '0') * 100);
        }
        if (feeRateBps === 0) {
            feeRateBps = 30; // Default 0.30%
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 8: Calculate velocity from history
        // ═══════════════════════════════════════════════════════════════════════
        const history = poolHistory.get(poolAddress) || [];
        let velocity = 0;
        
        if (history.length > 0) {
            const prevSnapshot = history[history.length - 1];
            const timeDelta = (fetchedAt - prevSnapshot.fetchedAt) / 1000; // seconds
            
            if (timeDelta > 0) {
                velocity = Math.abs(activeBinId - prevSnapshot.activeBin) / timeDelta;
            }
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 9: Estimate recent trades from bin movement
        // ═══════════════════════════════════════════════════════════════════════
        let recentTrades = 0;
        if (history.length >= 2) {
            for (let i = 1; i < Math.min(history.length, 5); i++) {
                const curr = history[history.length - i];
                const prev = history[history.length - i - 1];
                if (prev && curr.activeBin !== prev.activeBin) {
                    recentTrades++;
                }
            }
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // VALIDATION: Skip pools missing critical data
        // DISABLE microstructure scoring for these pools
        // ═══════════════════════════════════════════════════════════════════════
        if (liquidityUSD <= 0) {
            logger.debug(`[DLMM-SDK] SKIP ${poolAddress.slice(0, 8)}... (${metadata.name}): liquidityUSD = 0`);
            return null;
        }
        
        if (binCount === 0 && finalReserveX === 0 && finalReserveY === 0) {
            logger.debug(`[DLMM-SDK] SKIP ${poolAddress.slice(0, 8)}... (${metadata.name}): No bins or reserves`);
            return null;
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // STEP 10: Return fully hydrated telemetry
        // ═══════════════════════════════════════════════════════════════════════
        const telemetry: DLMMTelemetry = {
            poolAddress,
            activeBin: activeBinId,
            binStep,
            liquidityUSD,
            inventoryBase,
            inventoryQuote,
            feeRateBps,
            velocity,
            recentTrades,
            fetchedAt,
        };
        
        logger.debug(`[DLMM-SDK] ✓ ${metadata.name} | bin=${activeBinId} | liqUSD=$${liquidityUSD.toFixed(0)} | bins=${binCount} | resX=${inventoryBase.toFixed(2)} | resY=${inventoryQuote.toFixed(2)}`);
        
        return telemetry;
        
    } catch (error: any) {
        logger.debug(`[DLMM-SDK] FAIL ${poolAddress.slice(0, 8)}... (${metadata.name}): ${error.message || error}`);
        return null;
    }
}

/**
 * Hydrate pool with retry logic (2 retries = 3 total attempts)
 * Uses exponential backoff between retries.
 * 
 * REQUIRES metadata - will SKIP if not found.
 */
async function hydratePoolWithRetry(
    poolAddress: string,
    metadata: MeteoraPoolMetadata | null
): Promise<DLMMTelemetry | null> {
    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL: No metadata → SKIP pool
    // ═══════════════════════════════════════════════════════════════════════════
    if (!metadata) {
        logger.debug(`[DLMM-SDK] SKIP ${poolAddress.slice(0, 8)}...: No metadata from Meteora API`);
        return null;
    }
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await hydratePoolWithSDK(poolAddress, metadata);
            
            if (result) {
                if (attempt > 1) {
                    logger.debug(`[DLMM-SDK] Recovered ${poolAddress.slice(0, 8)}... on attempt ${attempt}`);
                }
                return result;
            }
        } catch (error) {
            // Continue to retry
        }
        
        // Exponential backoff before retry: 1s, 2s, 4s...
        if (attempt < MAX_RETRIES) {
            const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
    
    // All attempts failed → SKIP this pool (do NOT mark as "invalid")
    logger.debug(`[DLMM-SDK] SKIPPED ${poolAddress.slice(0, 8)}... (${metadata.name}) after ${MAX_RETRIES} attempts`);
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch telemetry for multiple pools in batches of 10.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FLOW:
 * 1. Fetch ALL metadata from Meteora API first
 * 2. For each pool, look up metadata
 * 3. Skip pools without metadata
 * 4. Hydrate with SDK using metadata
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Returns array of fully hydrated telemetry.
 * Failed pools are SKIPPED (not included in output).
 * 
 * @param poolAddresses - Array of pool addresses to hydrate
 * @returns Array of successfully hydrated DLMMTelemetry
 */
export async function fetchBatchTelemetry(
    poolAddresses: string[]
): Promise<DLMMTelemetry[]> {
    const results: DLMMTelemetry[] = [];
    
    if (poolAddresses.length === 0) {
        logger.info('[DLMM-SDK] No pools to hydrate');
        return results;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Fetch ALL metadata from Meteora API BEFORE hydration
    // ═══════════════════════════════════════════════════════════════════════════
    const metadataMap = await fetchAllMeteoraPoolMetadata();
    
    if (metadataMap.size === 0) {
        logger.error('[DLMM-SDK] ABORT: No metadata available from Meteora API');
        return results;
    }
    
    // Count how many requested pools have metadata
    let withMetadata = 0;
    let withoutMetadata = 0;
    
    for (const addr of poolAddresses) {
        if (metadataMap.has(addr)) {
            withMetadata++;
        } else {
            withoutMetadata++;
        }
    }
    
    logger.info(`[DLMM-SDK] Hydrating ${poolAddresses.length} pools (${withMetadata} with metadata, ${withoutMetadata} without → will skip)`);
    
    let successCount = 0;
    let skipCount = 0;
    let noMetadataCount = 0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Process in batches of 10
    // ═══════════════════════════════════════════════════════════════════════════
    for (let i = 0; i < poolAddresses.length; i += BATCH_SIZE) {
        const batch = poolAddresses.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(poolAddresses.length / BATCH_SIZE);
        
        logger.debug(`[DLMM-SDK] Processing batch ${batchNum}/${totalBatches} (${batch.length} pools)`);
        
        // Process batch in parallel
        const batchResults = await Promise.all(
            batch.map(async (address) => {
                // Look up metadata for this pool
                const metadata = metadataMap.get(address) || null;
                
                if (!metadata) {
                    noMetadataCount++;
                    return null;
                }
                
                const telemetry = await hydratePoolWithRetry(address, metadata);
                
                if (telemetry) {
                    successCount++;
                    return telemetry;
                } else {
                    skipCount++;
                    return null;
                }
            })
        );
        
        // Collect successful results
        for (const result of batchResults) {
            if (result) {
                results.push(result);
            }
        }
        
        // Small delay between batches to avoid RPC rate limiting
        if (i + BATCH_SIZE < poolAddresses.length) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    
    logger.info(`[DLMM-SDK] Batch complete: ${successCount} hydrated, ${skipCount} failed, ${noMetadataCount} no metadata`);
    
    return results;
}

/**
 * Fetch single pool telemetry with retry logic.
 * Will fetch metadata first if not cached.
 */
export async function fetchPoolTelemetry(poolAddress: string): Promise<DLMMTelemetry | null> {
    // Ensure metadata is loaded
    await fetchAllMeteoraPoolMetadata();
    
    const metadata = getPoolMetadata(poolAddress);
    return hydratePoolWithRetry(poolAddress, metadata);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY BUFFER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a telemetry snapshot in history buffer
 * 
 * MEMORY SAFETY:
 * - Enforces MAX_TRACKED_POOLS limit
 * - Removes oldest pools when limit exceeded
 * - Keeps only MAX_HISTORY_LENGTH (3) snapshots per pool
 */
export function recordSnapshot(telemetry: DLMMTelemetry): void {
    const poolId = telemetry.poolAddress;
    const now = Date.now();
    
    // Throttle snapshots
    const lastTime = lastSnapshotTime.get(poolId) || 0;
    if (now - lastTime < SNAPSHOT_INTERVAL_MS) {
        return;
    }
    
    // MEMORY SAFETY: Enforce pool limit
    if (!poolHistory.has(poolId) && poolHistory.size >= MAX_TRACKED_POOLS) {
        // Remove oldest tracked pool (first in Map)
        const oldestPoolId = poolHistory.keys().next().value;
        if (oldestPoolId) {
            poolHistory.delete(oldestPoolId);
            lastSnapshotTime.delete(oldestPoolId);
            swapHistory.delete(oldestPoolId);
        }
    }
    
    if (!poolHistory.has(poolId)) {
        poolHistory.set(poolId, []);
    }
    
    const history = poolHistory.get(poolId)!;
    history.push(telemetry);
    
    // Enforce rolling window (only 3 snapshots)
    while (history.length > MAX_HISTORY_LENGTH) {
        history.shift();
    }
    
    lastSnapshotTime.set(poolId, now);
}

/**
 * Get snapshot history for a pool
 */
export function getPoolHistory(poolId: string): DLMMTelemetry[] {
    return poolHistory.get(poolId) || [];
}

/**
 * Get swap history for a pool within a time window
 */
export function getSwapHistory(poolId: string, windowMs: number = 60000): SwapTick[] {
    const history = swapHistory.get(poolId) || [];
    const cutoff = Date.now() - windowMs;
    return history.filter(t => t.timestamp >= cutoff);
}

/**
 * Record swap event
 * 
 * MEMORY SAFETY:
 * - Only track swaps for pools we're already tracking
 * - Keep only last 10 swaps per pool (not 5 minutes worth)
 */
export function recordSwapEvent(
    poolId: string,
    amountIn: number,
    amountOut: number,
    binBefore: number,
    binAfter: number,
    feePaid: number
): void {
    // Only track if pool is already in telemetry
    if (!poolHistory.has(poolId)) {
        return;  // Skip - pool not tracked
    }
    
    if (!swapHistory.has(poolId)) {
        swapHistory.set(poolId, []);
    }
    
    const history = swapHistory.get(poolId)!;
    history.push({
        poolId,
        signature: `swap_${Date.now()}`,
        amountIn,
        amountOut,
        binBefore,
        binAfter,
        feePaid,
        timestamp: Date.now(),
        direction: amountIn > 0 ? 'buy' : 'sell',
    });
    
    // MEMORY SAFETY: Keep only last 10 swaps (not time-based)
    while (history.length > 10) {
        history.shift();
    }
}

/**
 * Clear all history
 */
export function clearAllHistory(): void {
    poolHistory.clear();
    swapHistory.clear();
    lastSnapshotTime.clear();
}

/**
 * Clear history for pools not in the current active set.
 * Call this at the end of each discovery cycle to prevent accumulation.
 * 
 * @param activePoolIds - Pool IDs that should be kept
 */
export function pruneInactivePools(activePoolIds: Set<string>): void {
    const poolsToRemove: string[] = [];
    
    for (const poolId of poolHistory.keys()) {
        if (!activePoolIds.has(poolId)) {
            poolsToRemove.push(poolId);
        }
    }
    
    for (const poolId of poolsToRemove) {
        poolHistory.delete(poolId);
        swapHistory.delete(poolId);
        lastSnapshotTime.delete(poolId);
    }
    
    if (poolsToRemove.length > 0) {
        logger.debug(`[DLMM-SDK] Pruned ${poolsToRemove.length} inactive pools from history`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MICROSTRUCTURE METRIC COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute microstructure metrics for a pool.
 * 
 * CRITICAL: Returns null if:
 * - Insufficient snapshot history (need >= 3)
 * - Pool is missing liquidity
 * - Pool is missing bins
 * 
 * Caller MUST disable scoring for null returns.
 */
export function computeMicrostructureMetrics(poolId: string): MicrostructureMetrics | null {
    const history = poolHistory.get(poolId) || [];
    
    // Require minimum 3 snapshots for velocity calculation
    if (history.length < 3) {
        return null;
    }
    
    const now = Date.now();
    const latest = history[history.length - 1];
    const oldest = history[0];
    const prev = history[history.length - 2];
    
    const windowMs = latest.fetchedAt - oldest.fetchedAt;
    if (windowMs <= 0) {
        return null;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL: DISABLE scoring for pools missing liquidity
    // ═══════════════════════════════════════════════════════════════════════════
    if (latest.liquidityUSD <= 0) {
        logger.debug(`[METRICS] DISABLE scoring for ${poolId.slice(0, 8)}...: liquidityUSD = 0`);
        return null;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Bin Movement Velocity (30% weight)
    // ═══════════════════════════════════════════════════════════════════════════
    const rawBinDelta = Math.abs(latest.activeBin - prev.activeBin);
    const timeDeltaSeconds = (latest.fetchedAt - prev.fetchedAt) / 1000;
    const rawBinVelocity = timeDeltaSeconds > 0 ? rawBinDelta / timeDeltaSeconds : 0;
    const binVelocity = Math.min((rawBinVelocity / 0.1) * 100, 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Liquidity Flow Intensity (30% weight) - using liquidityUSD
    // ═══════════════════════════════════════════════════════════════════════════
    const currentLiquidity = latest.liquidityUSD;
    const prevLiquidity = prev.liquidityUSD;
    const rawLiquidityDelta = Math.abs(currentLiquidity - prevLiquidity);
    const liquidityFlowRatio = currentLiquidity > 0 ? rawLiquidityDelta / currentLiquidity : 0;
    const liquidityFlow = Math.min((liquidityFlowRatio / 0.05) * 100, 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Swap Velocity (25% weight)
    // ═══════════════════════════════════════════════════════════════════════════
    const rawSwapCount = latest.recentTrades;
    const swapsPerSecond = latest.velocity;
    const swapVelocity = Math.min((swapsPerSecond / 1.0) * 100, 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Fee Intensity (15% weight)
    // ═══════════════════════════════════════════════════════════════════════════
    const rawFeesGenerated = (latest.feeRateBps / 10000) * latest.liquidityUSD * 0.001;
    const feeIntensityRatio = currentLiquidity > 0 ? rawFeesGenerated / currentLiquidity : 0;
    const feeIntensity = Math.min((feeIntensityRatio / 0.001) * 100, 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Pool Entropy (health indicator)
    // ═══════════════════════════════════════════════════════════════════════════
    const poolEntropy = computePoolEntropy(history);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Final Pool Score
    // ═══════════════════════════════════════════════════════════════════════════
    const poolScore = (
        binVelocity * SCORING_WEIGHTS.binVelocity +
        liquidityFlow * SCORING_WEIGHTS.liquidityFlow +
        swapVelocity * SCORING_WEIGHTS.swapVelocity +
        feeIntensity * SCORING_WEIGHTS.feeIntensity
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Gating Logic (market alive check)
    // ═══════════════════════════════════════════════════════════════════════════
    const gatingReasons: string[] = [];
    
    if (rawBinVelocity < GATING_THRESHOLDS.minBinVelocity) {
        gatingReasons.push(`binVelocity ${rawBinVelocity.toFixed(4)} < ${GATING_THRESHOLDS.minBinVelocity}`);
    }
    
    if (swapsPerSecond < GATING_THRESHOLDS.minSwapVelocity) {
        gatingReasons.push(`swapVelocity ${swapsPerSecond.toFixed(4)} < ${GATING_THRESHOLDS.minSwapVelocity}`);
    }
    
    if (poolEntropy < GATING_THRESHOLDS.minPoolEntropy) {
        gatingReasons.push(`poolEntropy ${poolEntropy.toFixed(4)} < ${GATING_THRESHOLDS.minPoolEntropy}`);
    }
    
    if (liquidityFlowRatio < GATING_THRESHOLDS.minLiquidityFlow) {
        gatingReasons.push(`liquidityFlow ${(liquidityFlowRatio * 100).toFixed(4)}% < ${GATING_THRESHOLDS.minLiquidityFlow * 100}%`);
    }
    
    const isMarketAlive = gatingReasons.length === 0;
    
    return {
        poolId,
        binVelocity,
        liquidityFlow,
        swapVelocity,
        feeIntensity,
        rawBinDelta,
        rawLiquidityDelta,
        rawSwapCount,
        rawFeesGenerated,
        poolEntropy,
        poolScore,
        isMarketAlive,
        gatingReasons,
        windowStartMs: oldest.fetchedAt,
        windowEndMs: latest.fetchedAt,
        snapshotCount: history.length,
        timestamp: now,
    };
}

/**
 * Compute pool entropy from history (health/activity indicator)
 */
function computePoolEntropy(history: DLMMTelemetry[]): number {
    if (history.length < 2) return 0;
    
    // Use inventory ratio variance as entropy proxy
    const ratios = history.map(s => {
        const total = s.inventoryBase + s.inventoryQuote;
        return total > 0 ? s.inventoryBase / total : 0.5;
    });
    
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const variance = ratios.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / ratios.length;
    
    // Normalize: variance of 0.25 = 1.0
    const normalizedEntropy = Math.min(variance / 0.25, 1.0);
    
    // Bin movement entropy
    const binDeltas = [];
    for (let i = 1; i < history.length; i++) {
        binDeltas.push(Math.abs(history[i].activeBin - history[i - 1].activeBin));
    }
    
    const binVariance = binDeltas.length > 0
        ? binDeltas.reduce((sum, d) => sum + d, 0) / binDeltas.length
        : 0;
    
    const binEntropy = Math.min(binVariance / 5, 1.0);
    
    return (normalizedEntropy * 0.6) + (binEntropy * 0.4);
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register a new position for exit monitoring
 */
export function registerPosition(position: BinFocusedPosition): void {
    activePositions.set(position.poolId, position);
    logger.info(`[DLMM-SDK] Registered position for ${position.poolId.slice(0, 8)}... at bin ${position.entryBin}`);
}

/**
 * Unregister a closed position
 */
export function unregisterPosition(poolId: string): void {
    activePositions.delete(poolId);
}

/**
 * Exit signal interface
 */
export interface ExitSignal {
    shouldExit: boolean;
    shouldRebalance: boolean;
    reason: string;
    currentBin: number;
    entryBin: number;
    binOffset: number;
    feeIntensityDrop: number;
    currentSwapVelocity: number;
}

/**
 * Evaluate exit conditions for a position
 */
export function evaluatePositionExit(poolId: string): ExitSignal | null {
    const position = activePositions.get(poolId);
    if (!position) return null;
    
    const metrics = computeMicrostructureMetrics(poolId);
    if (!metrics) return null;
    
    const history = poolHistory.get(poolId) || [];
    if (history.length === 0) return null;
    
    const latest = history[history.length - 1];
    const currentBin = latest.activeBin;
    const binOffset = Math.abs(currentBin - position.entryBin);
    
    // Fee intensity drop
    const feeIntensityDrop = position.entryFeeIntensity > 0
        ? (position.entryFeeIntensity - metrics.feeIntensity) / position.entryFeeIntensity
        : 0;
    
    // Current swap velocity
    const currentSwapVelocity = latest.velocity;
    
    // Check rebalance condition
    const shouldRebalance = binOffset >= EXIT_THRESHOLDS.maxBinOffset;
    
    // Check exit conditions
    let shouldExit = false;
    let reason = '';
    
    if (feeIntensityDrop >= EXIT_THRESHOLDS.feeIntensityCollapse) {
        shouldExit = true;
        reason = `Fee intensity collapsed ${(feeIntensityDrop * 100).toFixed(1)}% from entry`;
    } else if (currentSwapVelocity < EXIT_THRESHOLDS.minSwapVelocity) {
        shouldExit = true;
        reason = `Swap velocity ${currentSwapVelocity.toFixed(4)}/sec below ${EXIT_THRESHOLDS.minSwapVelocity}`;
    }
    
    return {
        shouldExit,
        shouldRebalance,
        reason,
        currentBin,
        entryBin: position.entryBin,
        binOffset,
        feeIntensityDrop,
        currentSwapVelocity,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log live microstructure metrics (verbose mode)
 */
export function logMicrostructureMetrics(metrics: MicrostructureMetrics): void {
    const divider = '─'.repeat(60);
    
    logger.info(`\n${divider}`);
    logger.info(`📊 DLMM LIVE METRICS: ${metrics.poolId.slice(0, 8)}...`);
    logger.info(divider);
    
    logger.info(`🔄 ActiveBin Δ:        ${metrics.rawBinDelta} bins (score: ${metrics.binVelocity.toFixed(1)}/100)`);
    logger.info(`📈 Swap Velocity:      ${metrics.rawSwapCount} trades (score: ${metrics.swapVelocity.toFixed(1)}/100)`);
    logger.info(`💧 Liquidity Flow Δ:   $${metrics.rawLiquidityDelta.toFixed(0)} (score: ${metrics.liquidityFlow.toFixed(1)}/100)`);
    logger.info(`💰 Fee Intensity:      ${metrics.rawFeesGenerated.toFixed(4)} (score: ${metrics.feeIntensity.toFixed(1)}/100)`);
    
    logger.info(`\n🧬 Pool Entropy:       ${metrics.poolEntropy.toFixed(4)}`);
    logger.info(`📌 Pool Score:         ${metrics.poolScore.toFixed(2)}/100`);
    
    if (metrics.isMarketAlive) {
        logger.info(`✅ Market Status:      ALIVE - Ready for entry`);
    } else {
        logger.warn(`⚠️  Market Status:      DORMANT`);
        for (const reason of metrics.gatingReasons) {
            logger.warn(`   → ${reason}`);
        }
    }
    
    logger.info(`\n📊 Window: ${metrics.snapshotCount} snapshots over ${((metrics.windowEndMs - metrics.windowStartMs) / 1000).toFixed(0)}s`);
    logger.info(divider + '\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Refresh all pool metrics using SDK
 */
export async function refreshAllPoolMetrics(
    poolAddresses: string[]
): Promise<Map<string, MicrostructureMetrics>> {
    // Fetch telemetry in batches
    const telemetryArray = await fetchBatchTelemetry(poolAddresses);
    
    // Record snapshots and compute metrics
    const results = new Map<string, MicrostructureMetrics>();
    
    for (const telemetry of telemetryArray) {
        recordSnapshot(telemetry);
        
        const metrics = computeMicrostructureMetrics(telemetry.poolAddress);
        if (metrics) {
            results.set(telemetry.poolAddress, metrics);
        }
    }
    
    return results;
}

/**
 * Get pools that pass gating conditions
 */
export function getAlivePoolIds(): string[] {
    const alive: string[] = [];
    
    for (const [poolId] of poolHistory) {
        const metrics = computeMicrostructureMetrics(poolId);
        if (metrics && metrics.isMarketAlive) {
            alive.push(poolId);
        }
    }
    
    return alive;
}

/**
 * Get pools sorted by microstructure score
 */
export function getRankedPools(): { poolId: string; score: number; metrics: MicrostructureMetrics }[] {
    const ranked: { poolId: string; score: number; metrics: MicrostructureMetrics }[] = [];
    
    for (const [poolId] of poolHistory) {
        const metrics = computeMicrostructureMetrics(poolId);
        if (metrics) {
            ranked.push({
                poolId,
                score: metrics.poolScore,
                metrics,
            });
        }
    }
    
    ranked.sort((a, b) => b.score - a.score);
    
    return ranked;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPATIBILITY EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get live DLMM state (compatibility with old interface)
 */
export async function getLiveDLMMState(poolId: string): Promise<DLMMState | null> {
    const telemetry = await fetchPoolTelemetry(poolId);
    if (!telemetry) return null;
    
    return {
        poolId: telemetry.poolAddress,
        tokenX: '',
        tokenY: '',
        activeBin: telemetry.activeBin,
        binStep: telemetry.binStep,
        liquidityX: telemetry.inventoryBase,
        liquidityY: telemetry.inventoryQuote,
        liquidityUSD: telemetry.liquidityUSD,
        feeTier: telemetry.feeRateBps / 100,
        timestamp: telemetry.fetchedAt,
    };
}

/**
 * Get all live states (compatibility)
 */
export async function getAllLiveDLMMStates(): Promise<DLMMState[]> {
    const states: DLMMState[] = [];
    
    for (const [poolId, history] of poolHistory) {
        if (history.length > 0) {
            const latest = history[history.length - 1];
            states.push({
                poolId: latest.poolAddress,
                tokenX: '',
                tokenY: '',
                activeBin: latest.activeBin,
                binStep: latest.binStep,
                liquidityX: latest.inventoryBase,
                liquidityY: latest.inventoryQuote,
                liquidityUSD: latest.liquidityUSD,
                feeTier: latest.feeRateBps / 100,
                timestamp: latest.fetchedAt,
            });
        }
    }
    
    return states;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cleanup resources - AGGRESSIVE memory release
 */
export function cleanup(): void {
    clearAllHistory();
    activePositions.clear();
    dlmmClientCache.clear();
    TOKEN_PRICE_CACHE.clear();
    poolMetadataCache.clear();
    metadataCacheTimestamp = 0;
    connection = null;
    
    // Force GC hint (if available in Node environment)
    if (global.gc) {
        try {
            global.gc();
        } catch {
            // Ignore - gc not exposed
        }
    }
    
    logger.info('[DLMM-SDK] Cleanup complete - all history cleared');
}

/**
 * Stub for compatibility (no WebSocket needed - using SDK polling)
 */
export function initializeSwapStream(): void {
    logger.info('[DLMM-SDK] Using full SDK hydration with Meteora API metadata');
    logger.info('[DLMM-SDK] ⚠️  NO external APIs (Birdeye/Bitquery) - pure Meteora SDK');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    GATING_THRESHOLDS,
    EXIT_THRESHOLDS,
    SCORING_WEIGHTS,
    MAX_HISTORY_LENGTH,
    SNAPSHOT_INTERVAL_MS,
    MAX_TRACKED_POOLS,
};
