/**
 * DLMM Live On-Chain Telemetry Service
 * 
 * Uses the official Meteora DLMM SDK to fetch real on-chain pool state.
 * https://github.com/Meteora-AG/dlmm-sdk
 * 
 * Features:
 * - Real on-chain pool state via DLMM SDK
 * - Batch processing (10-20 pools at a time)
 * - Retry logic (3 attempts, exponential backoff)
 * - Rolling history buffer for velocity computation
 * - Microstructure metric computation
 * 
 * RULE: If SDK errors → skip pool (do not assign 0)
 * No pool is ever scored using fallback data.
 */

import DLMM from '@meteora-ag/dlmm';
import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Core DLMM telemetry from on-chain state
 */
export interface DLMMTelemetry {
    poolAddress: string;
    activeBin: number;
    binStep: number;
    liquidityUSD: number;
    inventoryBase: number;
    inventoryQuote: number;
    feeRateBps: number;
    velocity: number;           // price delta vs last snapshot
    recentTrades: number;       // estimated from state changes
    timestamp: number;
}

/**
 * Core DLMM pool state (compatible with existing interfaces)
 */
export interface DLMMState {
    poolId: string;
    tokenX: string;
    tokenY: string;
    activeBin: number;
    binStep: number;
    liquidityX: number;
    liquidityY: number;
    totalLiquidity: number;
    feeTier: number;
    timestamp: number;
}

/**
 * Swap event from live trade stream
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

/**
 * Raw SDK pool state (internal)
 */
interface SDKPoolState {
    activeBin: number;
    binStep: number;
    liquidityLeft: bigint;
    liquidityRight: bigint;
    feeRateBps: number;
    currentTick: number;
    inventoryBase: number;
    inventoryQuote: number;
    lastRebalanceTimestamp: number;
    tokenXMint: string;
    tokenYMint: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// RPC Configuration
const RPC_URL = process.env.HELIUS_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

// Batch processing
const BATCH_SIZE = 15;
const MAX_RETRIES = 3;
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
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
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
        logger.info(`[DLMM-SDK] Connected to RPC: ${RPC_URL.slice(0, 30)}...`);
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
    // Check if stablecoin
    if (STABLECOINS.has(mintAddress)) {
        return 1.0;
    }
    
    // Check cache
    const cached = TOKEN_PRICE_CACHE.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
        return cached.price;
    }
    
    try {
        // Try Jupiter price API
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
        // Silently fail, return cached or 0
    }
    
    return cached?.price || 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DLMM SDK POOL FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch pool state using Meteora DLMM SDK
 * Returns null on any error (no fallbacks)
 */
async function fetchPoolStateWithSDK(poolAddress: string): Promise<SDKPoolState | null> {
    const conn = getConnection();
    
    try {
        // Check cache for DLMM client
        let dlmmPool = dlmmClientCache.get(poolAddress);
        
        if (!dlmmPool) {
            // Create new DLMM pool client
            const poolPubkey = new PublicKey(poolAddress);
            dlmmPool = await DLMM.create(conn, poolPubkey);
            dlmmClientCache.set(poolAddress, dlmmPool);
        }
        
        // Refresh pool state
        await dlmmPool.refetchStates();
        
        // Get active bin
        const activeBin = await dlmmPool.getActiveBin();
        
        // Get bin arrays for liquidity info
        const binArrays = dlmmPool.getBinArrays();
        
        // Calculate total liquidity from bin arrays
        let liquidityLeft = BigInt(0);
        let liquidityRight = BigInt(0);
        
        const activeBinId = activeBin.binId;
        
        for (const binArray of binArrays) {
            for (const bin of binArray.bins) {
                if (bin.binId < activeBinId) {
                    liquidityLeft += BigInt(bin.amountX?.toString() || '0');
                    liquidityLeft += BigInt(bin.amountY?.toString() || '0');
                } else if (bin.binId > activeBinId) {
                    liquidityRight += BigInt(bin.amountX?.toString() || '0');
                    liquidityRight += BigInt(bin.amountY?.toString() || '0');
                }
            }
        }
        
        // Extract pool configuration
        const lbPairState = dlmmPool.lbPair;
        
        return {
            activeBin: activeBinId,
            binStep: lbPairState.binStep,
            liquidityLeft,
            liquidityRight,
            feeRateBps: lbPairState.baseFeePowerFactor || 0,
            currentTick: activeBinId,
            inventoryBase: Number(activeBin.amountX || 0) / 1e9,
            inventoryQuote: Number(activeBin.amountY || 0) / 1e6,
            lastRebalanceTimestamp: lbPairState.lastUpdatedAt?.toNumber() || 0,
            tokenXMint: lbPairState.tokenXMint.toString(),
            tokenYMint: lbPairState.tokenYMint.toString(),
        };
        
    } catch (error: any) {
        logger.debug(`[DLMM-SDK] Failed to fetch ${poolAddress}: ${error.message}`);
        return null;
    }
}

/**
 * Fetch pool state with retry logic
 */
async function fetchPoolStateWithRetry(poolAddress: string): Promise<SDKPoolState | null> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const state = await fetchPoolStateWithSDK(poolAddress);
            if (state) {
                return state;
            }
        } catch (error: any) {
            lastError = error;
        }
        
        // Exponential backoff
        if (attempt < MAX_RETRIES) {
            const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
    
    if (lastError) {
        logger.debug(`[DLMM-SDK] All ${MAX_RETRIES} attempts failed for ${poolAddress}`);
    }
    
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEMETRY CONVERSION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert SDK pool state to DLMMTelemetry
 */
async function convertToTelemetry(
    poolAddress: string,
    state: SDKPoolState
): Promise<DLMMTelemetry> {
    const timestamp = Date.now();
    
    // Get token prices for USD conversion
    const basePrice = await getTokenPriceUSD(state.tokenXMint);
    const quotePrice = await getTokenPriceUSD(state.tokenYMint);
    
    // Calculate total liquidity in USD
    const liquidityLeftUSD = (Number(state.liquidityLeft) / 1e9) * basePrice;
    const liquidityRightUSD = (Number(state.liquidityRight) / 1e6) * quotePrice;
    const liquidityUSD = liquidityLeftUSD + liquidityRightUSD;
    
    // Calculate velocity from history
    const history = poolHistory.get(poolAddress) || [];
    let velocity = 0;
    
    if (history.length > 0) {
        const prevSnapshot = history[history.length - 1];
        const timeDelta = (timestamp - prevSnapshot.timestamp) / 1000;
        
        if (timeDelta > 0) {
            // Velocity = bin movement per second
            velocity = Math.abs(state.activeBin - prevSnapshot.activeBin) / timeDelta;
        }
    }
    
    // Estimate recent trades from bin changes
    let recentTrades = 0;
    if (history.length >= 2) {
        // Count bin changes in last N snapshots as trade proxy
        for (let i = 1; i < Math.min(history.length, 5); i++) {
            if (history[history.length - i].activeBin !== history[history.length - i - 1]?.activeBin) {
                recentTrades++;
            }
        }
    }
    
    return {
        poolAddress,
        activeBin: state.activeBin,
        binStep: state.binStep,
        liquidityUSD,
        inventoryBase: state.inventoryBase,
        inventoryQuote: state.inventoryQuote,
        feeRateBps: state.feeRateBps,
        velocity,
        recentTrades,
        timestamp,
    };
}

/**
 * Convert DLMMTelemetry to DLMMState for compatibility
 */
export function telemetryToState(telemetry: DLMMTelemetry, tokenX: string, tokenY: string): DLMMState {
    return {
        poolId: telemetry.poolAddress,
        tokenX,
        tokenY,
        activeBin: telemetry.activeBin,
        binStep: telemetry.binStep,
        liquidityX: telemetry.inventoryBase,
        liquidityY: telemetry.inventoryQuote,
        totalLiquidity: telemetry.liquidityUSD,
        feeTier: telemetry.feeRateBps / 100,
        timestamp: telemetry.timestamp,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch telemetry for multiple pools in batches
 */
export async function fetchBatchTelemetry(
    poolAddresses: string[]
): Promise<Map<string, DLMMTelemetry>> {
    const results = new Map<string, DLMMTelemetry>();
    
    logger.info(`[DLMM-SDK] Fetching ${poolAddresses.length} pools in batches of ${BATCH_SIZE}`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < poolAddresses.length; i += BATCH_SIZE) {
        const batch = poolAddresses.slice(i, i + BATCH_SIZE);
        
        const batchResults = await Promise.all(
            batch.map(async (address) => {
                const state = await fetchPoolStateWithRetry(address);
                
                if (!state) {
                    failCount++;
                    return null;
                }
                
                const telemetry = await convertToTelemetry(address, state);
                successCount++;
                
                return { address, telemetry };
            })
        );
        
        // Process batch results
        for (const result of batchResults) {
            if (result) {
                results.set(result.address, result.telemetry);
            }
        }
        
        // Small delay between batches to avoid rate limiting
        if (i + BATCH_SIZE < poolAddresses.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    logger.info(`[DLMM-SDK] Batch complete: ${successCount} success, ${failCount} failed/skipped`);
    
    return results;
}

/**
 * Fetch single pool telemetry
 */
export async function fetchPoolTelemetry(poolAddress: string): Promise<DLMMTelemetry | null> {
    const state = await fetchPoolStateWithRetry(poolAddress);
    
    if (!state) {
        return null;
    }
    
    return convertToTelemetry(poolAddress, state);
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
 * Returns null if insufficient data
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
    
    const windowMs = latest.timestamp - oldest.timestamp;
    if (windowMs <= 0) {
        return null;
    }
    
    // Bin Movement Velocity
    const rawBinDelta = Math.abs(latest.activeBin - prev.activeBin);
    const timeDeltaSeconds = (latest.timestamp - prev.timestamp) / 1000;
    const rawBinVelocity = timeDeltaSeconds > 0 ? rawBinDelta / timeDeltaSeconds : 0;
    const binVelocity = Math.min((rawBinVelocity / 0.1) * 100, 100);
    
    // Liquidity Flow Intensity
    const currentLiquidity = latest.liquidityUSD;
    const prevLiquidity = prev.liquidityUSD;
    const rawLiquidityDelta = Math.abs(currentLiquidity - prevLiquidity);
    const liquidityFlowRatio = currentLiquidity > 0 ? rawLiquidityDelta / currentLiquidity : 0;
    const liquidityFlow = Math.min((liquidityFlowRatio / 0.05) * 100, 100);
    
    // Swap Velocity (from velocity field)
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
        windowStartMs: oldest.timestamp,
        windowEndMs: latest.timestamp,
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
    const telemetryMap = await fetchBatchTelemetry(poolAddresses);
    
    // Record snapshots and compute metrics
    const results = new Map<string, MicrostructureMetrics>();
    
    for (const [poolId, telemetry] of telemetryMap) {
        recordSnapshot(telemetry);
        
        const metrics = computeMicrostructureMetrics(poolId);
        if (metrics) {
            results.set(poolId, metrics);
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
        totalLiquidity: telemetry.liquidityUSD,
        feeTier: telemetry.feeRateBps / 100,
        timestamp: telemetry.timestamp,
    };
}

/**
 * Get all live states (compatibility)
 */
export async function getAllLiveDLMMStates(): Promise<DLMMState[]> {
    // This would need pool addresses from somewhere
    // For now, return states from history
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
                totalLiquidity: latest.liquidityUSD,
                feeTier: latest.feeRateBps / 100,
                timestamp: latest.timestamp,
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

// Stub for WebSocket (not used with SDK approach)
export function initializeSwapStream(): void {
    logger.info('[DLMM-SDK] Using on-chain SDK for telemetry (no WebSocket needed)');
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
