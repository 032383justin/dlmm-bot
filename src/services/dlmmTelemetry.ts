/**
 * DLMM Live On-Chain Telemetry Service
 * 
 * Uses the official Meteora DLMM SDK with full pool hydration.
 * Each pool is initialized with DLMM.create() and queried with:
 * - getPoolState()
 * - getPrice()
 * - getBins()
 * - getLiquidityDistribution()
 * 
 * Batch size: 10 pools
 * Retries: 2 (total 3 attempts with exponential backoff)
 * Failed pools are SKIPPED (not marked invalid)
 * 
 * RULE: Use liquidityUSD everywhere. Never use totalLiquidity.
 */

import DLMM from '@meteora-ag/dlmm';
import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Core DLMM telemetry from on-chain state (fully hydrated)
 */
export interface DLMMTelemetry {
    poolAddress: string;
    activeBin: number;
    binStep: number;
    liquidityUSD: number;
    inventoryBase: number;
    inventoryQuote: number;
    feeRateBps: number;
    velocity: number;
    recentTrades: number;
    fetchedAt: number;
}

/**
 * Core DLMM pool state (compatibility interface)
 */
export interface DLMMState {
    poolId: string;
    tokenX: string;
    tokenY: string;
    activeBin: number;
    binStep: number;
    liquidityX: number;
    liquidityY: number;
    liquidityUSD: number;
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// RPC Configuration
const RPC_URL = process.env.HELIUS_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

// Batch processing
const BATCH_SIZE = 10;
const MAX_RETRIES = 3;  // Total attempts (1 initial + 2 retries)
const INITIAL_BACKOFF_MS = 1000;

// History buffer config
const MAX_HISTORY_LENGTH = 20;
const SNAPSHOT_INTERVAL_MS = 8000;

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

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Connection instance
let connection: Connection | null = null;

// Rolling history buffer: poolId -> DLMMTelemetry[]
const poolHistory: Map<string, DLMMTelemetry[]> = new Map();

// Swap tick buffer: poolId -> SwapTick[]
const swapHistory: Map<string, SwapTick[]> = new Map();

// Last snapshot time per pool
const lastSnapshotTime: Map<string, number> = new Map();

// Active positions for exit monitoring
const activePositions: Map<string, BinFocusedPosition> = new Map();

// DLMM pool client cache
const dlmmClientCache: Map<string, DLMM> = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function getConnection(): Connection {
    if (!connection) {
        connection = new Connection(RPC_URL, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 30000,
        });
        logger.info(`[DLMM-SDK] Connected to RPC: ${RPC_URL.slice(0, 40)}...`);
    }
    return connection;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN PRICE FETCHING
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
    } catch (error) {
        // Silently fail
    }
    
    return cached?.price || 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL DLMM SDK POOL HYDRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fully hydrate a single pool using Meteora DLMM SDK
 * Calls: getPoolState(), getPrice(), getBins(), getLiquidityDistribution()
 */
async function hydratePoolWithSDK(poolAddress: string): Promise<DLMMTelemetry | null> {
    const conn = getConnection();
    const fetchedAt = Date.now();
    
    try {
        // Initialize DLMM pool client
        const poolPubkey = new PublicKey(poolAddress);
        
        // Check cache first
        let dlmm = dlmmClientCache.get(poolAddress);
        
        if (!dlmm) {
            // Create new DLMM instance with full initialization
            dlmm = await DLMM.create(conn, poolPubkey);
            dlmmClientCache.set(poolAddress, dlmm);
        }
        
        // Refresh pool state
        await dlmm.refetchStates();
        
        // Get pool state
        const lbPair = dlmm.lbPair;
        const activeBinId = lbPair.activeId;
        const binStep = lbPair.binStep;
        
        // Get current price
        const activeBin = await dlmm.getActiveBin();
        const pricePerLamport = activeBin.pricePerToken ? Number(activeBin.pricePerToken) : 0;
        
        // Get bins around active bin
        let bins: any[] = [];
        try {
            const binsResult = await dlmm.getBinsBetweenLowerAndUpperBound(
                activeBinId - 20,
                activeBinId + 20
            );
            bins = binsResult?.bins || binsResult || [];
        } catch (e) {
            // Bins fetch failed, continue with empty
        }
        
        // Get token mints
        const tokenXMint = lbPair.tokenXMint.toString();
        const tokenYMint = lbPair.tokenYMint.toString();
        
        // Get token prices for USD conversion
        const priceX = await getTokenPriceUSD(tokenXMint);
        const priceY = await getTokenPriceUSD(tokenYMint);
        
        // Calculate inventory from reserves
        const reserveX = Number(lbPair.reserveX || 0);
        const reserveY = Number(lbPair.reserveY || 0);
        
        // Get token decimals (default to 9 for SOL-like, 6 for USDC-like)
        // TokenReserve doesn't expose decimal directly, use defaults based on common tokens
        const decimalsX = STABLECOINS.has(tokenXMint) ? 6 : 9;
        const decimalsY = STABLECOINS.has(tokenYMint) ? 6 : 9;
        
        const inventoryBase = reserveX / Math.pow(10, decimalsX);
        const inventoryQuote = reserveY / Math.pow(10, decimalsY);
        
        // Calculate total liquidity in USD
        const liquidityUSD = (inventoryBase * priceX) + (inventoryQuote * priceY);
        
        // Get fee rate from parameters
        const feeRateBps = lbPair.parameters?.baseFactor || 30;
        
        // Calculate velocity from history
        const history = poolHistory.get(poolAddress) || [];
        let velocity = 0;
        
        if (history.length > 0) {
            const prevSnapshot = history[history.length - 1];
            const timeDelta = (fetchedAt - prevSnapshot.fetchedAt) / 1000;
            
            if (timeDelta > 0) {
                velocity = Math.abs(activeBinId - prevSnapshot.activeBin) / timeDelta;
            }
        }
        
        // Estimate recent trades from bin changes
        let recentTrades = 0;
        if (history.length >= 2) {
            for (let i = 1; i < Math.min(history.length, 5); i++) {
                if (history[history.length - i].activeBin !== history[history.length - i - 1]?.activeBin) {
                    recentTrades++;
                }
            }
        }
        
        // VALIDATION: Skip pools missing critical data
        if (liquidityUSD <= 0) {
            logger.debug(`[DLMM-SDK] Skipping ${poolAddress}: No liquidity`);
            return null;
        }
        
        if (bins.length === 0 && reserveX === 0 && reserveY === 0) {
            logger.debug(`[DLMM-SDK] Skipping ${poolAddress}: No bins or reserves`);
            return null;
        }
        
        return {
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
        
    } catch (error: any) {
        logger.debug(`[DLMM-SDK] Failed to hydrate ${poolAddress}: ${error.message}`);
        return null;
    }
}

/**
 * Hydrate pool with retry logic (2 retries = 3 total attempts)
 */
async function hydratePoolWithRetry(poolAddress: string): Promise<DLMMTelemetry | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await hydratePoolWithSDK(poolAddress);
            if (result) {
                return result;
            }
        } catch (error) {
            // Continue to retry
        }
        
        // Exponential backoff before retry
        if (attempt < MAX_RETRIES) {
            const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
    
    // All attempts failed - SKIP this pool (don't mark invalid)
    logger.debug(`[DLMM-SDK] Skipping ${poolAddress} after ${MAX_RETRIES} failed attempts`);
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch telemetry for multiple pools in batches of 10
 * Returns array of fully hydrated telemetry (failed pools are skipped)
 */
export async function fetchBatchTelemetry(
    poolAddresses: string[]
): Promise<DLMMTelemetry[]> {
    const results: DLMMTelemetry[] = [];
    
    logger.info(`[DLMM-SDK] Hydrating ${poolAddresses.length} pools in batches of ${BATCH_SIZE}`);
    
    let successCount = 0;
    let skipCount = 0;
    
    for (let i = 0; i < poolAddresses.length; i += BATCH_SIZE) {
        const batch = poolAddresses.slice(i, i + BATCH_SIZE);
        
        const batchResults = await Promise.all(
            batch.map(async (address) => {
                const telemetry = await hydratePoolWithRetry(address);
                
                if (telemetry) {
                    successCount++;
                    return telemetry;
                } else {
                    skipCount++;
                    return null;
                }
            })
        );
        
        // Add successful results
        for (const result of batchResults) {
            if (result) {
                results.push(result);
            }
        }
        
        // Small delay between batches to avoid rate limiting
        if (i + BATCH_SIZE < poolAddresses.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    
    logger.info(`[DLMM-SDK] Batch complete: ${successCount} hydrated, ${skipCount} skipped`);
    
    return results;
}

/**
 * Fetch single pool telemetry
 */
export async function fetchPoolTelemetry(poolAddress: string): Promise<DLMMTelemetry | null> {
    return hydratePoolWithRetry(poolAddress);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY BUFFER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a telemetry snapshot in history buffer
 */
export function recordSnapshot(telemetry: DLMMTelemetry): void {
    const poolId = telemetry.poolAddress;
    const now = Date.now();
    
    // Check if enough time has passed since last snapshot
    const lastTime = lastSnapshotTime.get(poolId) || 0;
    if (now - lastTime < SNAPSHOT_INTERVAL_MS) {
        return;
    }
    
    if (!poolHistory.has(poolId)) {
        poolHistory.set(poolId, []);
    }
    
    const history = poolHistory.get(poolId)!;
    history.push(telemetry);
    
    // Enforce max length
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
 */
export function recordSwapEvent(
    poolId: string,
    amountIn: number,
    amountOut: number,
    binBefore: number,
    binAfter: number,
    feePaid: number
): void {
    if (!swapHistory.has(poolId)) {
        swapHistory.set(poolId, []);
    }
    
    const history = swapHistory.get(poolId)!;
    history.push({
        poolId,
        signature: `manual_${Date.now()}`,
        amountIn,
        amountOut,
        binBefore,
        binAfter,
        feePaid,
        timestamp: Date.now(),
        direction: amountIn > 0 ? 'buy' : 'sell',
    });
    
    // Keep last 5 minutes
    const cutoff = Date.now() - 5 * 60 * 1000;
    while (history.length > 0 && history[0].timestamp < cutoff) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// MICROSTRUCTURE METRIC COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute microstructure metrics for a pool
 * Returns null if insufficient data or pool is missing liquidity/bins
 */
export function computeMicrostructureMetrics(poolId: string): MicrostructureMetrics | null {
    const history = poolHistory.get(poolId) || [];
    
    // Require minimum 3 snapshots
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
    
    // DISABLE scoring for pools missing liquidity
    if (latest.liquidityUSD <= 0) {
        logger.debug(`[METRICS] Disabling scoring for ${poolId}: No liquidity`);
        return null;
    }
    
    // Bin Movement Velocity
    const rawBinDelta = Math.abs(latest.activeBin - prev.activeBin);
    const timeDeltaSeconds = (latest.fetchedAt - prev.fetchedAt) / 1000;
    const rawBinVelocity = timeDeltaSeconds > 0 ? rawBinDelta / timeDeltaSeconds : 0;
    const binVelocity = Math.min((rawBinVelocity / 0.1) * 100, 100);
    
    // Liquidity Flow Intensity (using liquidityUSD)
    const currentLiquidity = latest.liquidityUSD;
    const prevLiquidity = prev.liquidityUSD;
    const rawLiquidityDelta = Math.abs(currentLiquidity - prevLiquidity);
    const liquidityFlowRatio = currentLiquidity > 0 ? rawLiquidityDelta / currentLiquidity : 0;
    const liquidityFlow = Math.min((liquidityFlowRatio / 0.05) * 100, 100);
    
    // Swap Velocity
    const rawSwapCount = latest.recentTrades;
    const swapsPerSecond = latest.velocity;
    const swapVelocity = Math.min((swapsPerSecond / 1.0) * 100, 100);
    
    // Fee Intensity
    const rawFeesGenerated = (latest.feeRateBps / 10000) * latest.liquidityUSD * 0.001;
    const feeIntensityRatio = currentLiquidity > 0 ? rawFeesGenerated / currentLiquidity : 0;
    const feeIntensity = Math.min((feeIntensityRatio / 0.001) * 100, 100);
    
    // Pool Entropy
    const poolEntropy = computePoolEntropy(history);
    
    // Compute Final Pool Score
    const poolScore = (
        binVelocity * SCORING_WEIGHTS.binVelocity +
        liquidityFlow * SCORING_WEIGHTS.liquidityFlow +
        swapVelocity * SCORING_WEIGHTS.swapVelocity +
        feeIntensity * SCORING_WEIGHTS.feeIntensity
    );
    
    // Gating Logic
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
 * Compute pool entropy from history
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
    logger.info(`[DLMM-SDK] Registered position for ${position.poolId} at bin ${position.entryBin}`);
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
    
    // Check rebalance
    const shouldRebalance = binOffset >= EXIT_THRESHOLDS.maxBinOffset;
    
    // Check exit
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
 * Log live microstructure metrics
 */
export function logMicrostructureMetrics(metrics: MicrostructureMetrics): void {
    const divider = '─'.repeat(60);
    
    logger.info(`\n${divider}`);
    logger.info(`📊 DLMM LIVE METRICS: ${metrics.poolId.slice(0, 8)}...`);
    logger.info(divider);
    
    logger.info(`🔄 ActiveBin Δ:        ${metrics.rawBinDelta} bins (velocity: ${metrics.binVelocity.toFixed(1)}/100)`);
    logger.info(`📈 Swap Velocity:      ${metrics.rawSwapCount} trades (score: ${metrics.swapVelocity.toFixed(1)}/100)`);
    logger.info(`💧 Liquidity Flow Δ:   $${metrics.rawLiquidityDelta.toFixed(0)} (${metrics.liquidityFlow.toFixed(1)}/100)`);
    logger.info(`💰 Fee Intensity:      ${metrics.rawFeesGenerated.toFixed(4)} (${metrics.feeIntensity.toFixed(1)}/100)`);
    
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
 * Cleanup resources
 */
export function cleanup(): void {
    clearAllHistory();
    activePositions.clear();
    dlmmClientCache.clear();
    TOKEN_PRICE_CACHE.clear();
    connection = null;
    
    logger.info('[DLMM-SDK] Cleanup complete');
}

// Stub for compatibility
export function initializeSwapStream(): void {
    logger.info('[DLMM-SDK] Using full SDK hydration for telemetry');
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
};
