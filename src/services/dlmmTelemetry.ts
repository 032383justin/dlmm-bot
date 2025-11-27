/**
 * DLMM Live Microstructure Telemetry Service
 * 
 * CRITICAL: This replaces static 24h metrics with real-time DLMM-native signals.
 * All scoring MUST use short-term bin-level microstructure data.
 * 
 * Features:
 * - Live pool state from Meteora DLMM API
 * - Real-time swap stream via Helius WebSocket
 * - Rolling history buffer (20 snapshots, 6-12s intervals)
 * - Microstructure metric computation (binVelocity, liqFlow, swapVelocity, feeIntensity)
 * - Trading gating logic with strict conditions
 * 
 * RULE: No pool is ever scored using 24h or TVL-only metrics.
 * DLMM alpha exists inside short-term bin-level volatility.
 */

import axios from 'axios';
import WebSocket from 'ws';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Core DLMM pool state from live data
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
    timestamp: number;      // unix ms
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
    binVelocity: number;        // Rate of bin movement
    liquidityFlow: number;      // Liquidity change intensity
    swapVelocity: number;       // Swaps per minute
    feeIntensity: number;       // Fee generation rate
    
    // Raw values
    rawBinDelta: number;
    rawLiquidityDelta: number;
    rawSwapCount: number;
    rawFeesGenerated: number;
    
    // Pool entropy (distribution health)
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
 * Raw pool data from Meteora API
 */
interface MeteoraPoolData {
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
    hide: boolean;
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
    
    // Rolling averages at entry
    entry3mFeeIntensity: number;
    entry3mSwapVelocity: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// Meteora DLMM API
const METEORA_API_BASE = 'https://dlmm-api.meteora.ag';
const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

// Helius WebSocket
const HELIUS_WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`;

// History buffer config
const MAX_HISTORY_LENGTH = 20;
const SNAPSHOT_INTERVAL_MS = 8000; // 8 seconds (between 6-12s)
const SWAP_HISTORY_RETENTION_MS = 5 * 60 * 1000; // 5 minutes

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
    minSwapVelocity: 0.10,      // swaps per second
    minPoolEntropy: 0.65,
    minLiquidityFlow: 0.005,    // 0.5% of pool total
};

// Exit thresholds
const EXIT_THRESHOLDS = {
    feeIntensityCollapse: 0.35,  // 35% drop from 3m average
    minSwapVelocity: 0.05,       // swaps per second
    maxBinOffset: 2,             // Rebalance when offset >= 2
};

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Rolling history buffer: poolId -> DLMMState[]
const poolHistory: Map<string, DLMMState[]> = new Map();

// Swap tick buffer: poolId -> SwapTick[]
const swapHistory: Map<string, SwapTick[]> = new Map();

// Last snapshot time per pool
const lastSnapshotTime: Map<string, number> = new Map();

// Active positions for exit monitoring
const activePositions: Map<string, BinFocusedPosition> = new Map();

// WebSocket connection
let heliusWs: WebSocket | null = null;
let wsReconnectTimer: NodeJS.Timeout | null = null;

// Cache for Meteora API
let meteoraPoolCache: Map<string, MeteoraPoolData> = new Map();
let lastMeteoraFetch = 0;
const METEORA_CACHE_TTL = 10000; // 10 seconds

// ═══════════════════════════════════════════════════════════════════════════════
// METEORA API FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch all DLMM pools from Meteora API
 */
async function fetchMeteoraPoolsRaw(): Promise<MeteoraPoolData[]> {
    try {
        const response = await axios.get<MeteoraPoolData[]>(`${METEORA_API_BASE}/pair/all`, {
            timeout: 15000,
            headers: {
                'Accept': 'application/json',
            },
        });
        
        if (!response.data || !Array.isArray(response.data)) {
            logger.warn('[DLMM-TELEMETRY] Invalid response from Meteora API');
            return [];
        }
        
        // Filter hidden pools
        return response.data.filter(p => !p.hide);
        
    } catch (error: any) {
        logger.error('[DLMM-TELEMETRY] Failed to fetch Meteora pools:', error.message);
        return [];
    }
}

/**
 * Get cached or fresh Meteora pool data
 */
async function getMeteoraPoolData(): Promise<Map<string, MeteoraPoolData>> {
    const now = Date.now();
    
    // Return cache if fresh
    if (now - lastMeteoraFetch < METEORA_CACHE_TTL && meteoraPoolCache.size > 0) {
        return meteoraPoolCache;
    }
    
    // Fetch fresh data
    const pools = await fetchMeteoraPoolsRaw();
    
    if (pools.length > 0) {
        meteoraPoolCache.clear();
        for (const pool of pools) {
            meteoraPoolCache.set(pool.address, pool);
        }
        lastMeteoraFetch = now;
        logger.debug(`[DLMM-TELEMETRY] Cached ${pools.length} Meteora pools`);
    }
    
    return meteoraPoolCache;
}

/**
 * Convert Meteora pool data to DLMMState
 */
function meteoraToDLMMState(pool: MeteoraPoolData): DLMMState {
    const liquidityX = pool.reserve_x_amount || 0;
    const liquidityY = pool.reserve_y_amount || 0;
    
    return {
        poolId: pool.address,
        tokenX: pool.mint_x,
        tokenY: pool.mint_y,
        activeBin: estimateActiveBin(pool.current_price, pool.bin_step),
        binStep: pool.bin_step,
        liquidityX,
        liquidityY,
        totalLiquidity: parseFloat(pool.liquidity) || (liquidityX + liquidityY),
        feeTier: parseFloat(pool.base_fee_percentage) || 0,
        timestamp: Date.now(),
    };
}

/**
 * Estimate active bin from price and bin step
 */
function estimateActiveBin(price: number, binStep: number): number {
    if (price <= 0 || binStep <= 0) return 0;
    // Bin price formula: price = (1 + binStep/10000)^binId
    // Solving for binId: binId = ln(price) / ln(1 + binStep/10000)
    const binPrice = 1 + binStep / 10000;
    return Math.round(Math.log(price) / Math.log(binPrice));
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE POOL STATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get live DLMM state for a specific pool
 */
export async function getLiveDLMMState(poolId: string): Promise<DLMMState | null> {
    try {
        const poolData = await getMeteoraPoolData();
        const pool = poolData.get(poolId);
        
        if (!pool) {
            return null;
        }
        
        return meteoraToDLMMState(pool);
        
    } catch (error: any) {
        logger.error(`[DLMM-TELEMETRY] Failed to get state for ${poolId}:`, error.message);
        return null;
    }
}

/**
 * Get live states for all active DLMM pools
 */
export async function getAllLiveDLMMStates(): Promise<DLMMState[]> {
    const poolData = await getMeteoraPoolData();
    const states: DLMMState[] = [];
    
    for (const pool of poolData.values()) {
        states.push(meteoraToDLMMState(pool));
    }
    
    return states;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELIUS WEBSOCKET SWAP STREAM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize Helius WebSocket connection for live swap events
 */
export function initializeSwapStream(): void {
    if (!process.env.HELIUS_API_KEY) {
        logger.warn('[DLMM-TELEMETRY] No HELIUS_API_KEY configured, swap stream disabled');
        return;
    }
    
    connectHeliusWebSocket();
}

function connectHeliusWebSocket(): void {
    if (heliusWs) {
        try {
            heliusWs.close();
        } catch (e) {}
    }
    
    logger.info('[DLMM-TELEMETRY] Connecting to Helius WebSocket...');
    
    heliusWs = new WebSocket(HELIUS_WS_URL);
    
    heliusWs.on('open', () => {
        logger.info('[DLMM-TELEMETRY] ✅ Helius WebSocket connected');
        
        // Subscribe to DLMM program swap events
        const subscribeMsg = {
            jsonrpc: '2.0',
            id: 1,
            method: 'transactionSubscribe',
            params: [
                {
                    accountInclude: [METEORA_DLMM_PROGRAM],
                },
                {
                    commitment: 'confirmed',
                    encoding: 'jsonParsed',
                    transactionDetails: 'full',
                    showRewards: false,
                    maxSupportedTransactionVersion: 0,
                },
            ],
        };
        
        heliusWs!.send(JSON.stringify(subscribeMsg));
    });
    
    heliusWs.on('message', (data: Buffer) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.params?.result) {
                processTransactionEvent(message.params.result);
            }
        } catch (error) {
            // Ignore parse errors for non-JSON messages
        }
    });
    
    heliusWs.on('error', (error: Error) => {
        logger.error('[DLMM-TELEMETRY] WebSocket error:', error.message);
    });
    
    heliusWs.on('close', () => {
        logger.warn('[DLMM-TELEMETRY] WebSocket closed, reconnecting in 5s...');
        scheduleReconnect();
    });
}

function scheduleReconnect(): void {
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
    }
    
    wsReconnectTimer = setTimeout(() => {
        connectHeliusWebSocket();
    }, 5000);
}

/**
 * Process incoming transaction event from Helius
 */
function processTransactionEvent(event: any): void {
    try {
        const signature = event.signature;
        const transaction = event.transaction;
        
        if (!transaction?.message?.instructions) return;
        
        // Look for DLMM swap instruction
        for (const ix of transaction.message.instructions) {
            if (ix.programId === METEORA_DLMM_PROGRAM) {
                const swapTick = parseSwapInstruction(ix, signature, event.slot);
                if (swapTick) {
                    recordSwapTick(swapTick);
                }
            }
        }
        
    } catch (error) {
        // Silently ignore parse errors
    }
}

/**
 * Parse swap instruction to extract tick data
 */
function parseSwapInstruction(ix: any, signature: string, slot: number): SwapTick | null {
    try {
        // Extract pool ID from accounts (typically first account)
        const accounts = ix.accounts || [];
        if (accounts.length < 1) return null;
        
        const poolId = accounts[0];
        
        // Parse instruction data (simplified - actual parsing depends on instruction layout)
        const data = ix.data;
        
        // For now, create a basic swap tick with available data
        // Real implementation would decode the instruction data properly
        return {
            poolId,
            signature,
            amountIn: 0,  // Would be decoded from instruction
            amountOut: 0,
            binBefore: 0,
            binAfter: 0,
            feePaid: 0,
            timestamp: Date.now(),
            direction: 'buy', // Would be determined from accounts
        };
        
    } catch (error) {
        return null;
    }
}

/**
 * Record a swap tick in history
 */
function recordSwapTick(tick: SwapTick): void {
    if (!swapHistory.has(tick.poolId)) {
        swapHistory.set(tick.poolId, []);
    }
    
    const history = swapHistory.get(tick.poolId)!;
    history.push(tick);
    
    // Prune old ticks
    const cutoff = Date.now() - SWAP_HISTORY_RETENTION_MS;
    while (history.length > 0 && history[0].timestamp < cutoff) {
        history.shift();
    }
}

/**
 * Manually record a swap event (for use when WebSocket unavailable)
 */
export function recordSwapEvent(
    poolId: string,
    amountIn: number,
    amountOut: number,
    binBefore: number,
    binAfter: number,
    feePaid: number
): void {
    const tick: SwapTick = {
        poolId,
        signature: `manual_${Date.now()}`,
        amountIn,
        amountOut,
        binBefore,
        binAfter,
        feePaid,
        timestamp: Date.now(),
        direction: amountIn > 0 ? 'buy' : 'sell',
    };
    
    recordSwapTick(tick);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY BUFFER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a DLMM state snapshot in history buffer
 */
export function recordSnapshot(state: DLMMState): void {
    const poolId = state.poolId;
    const now = Date.now();
    
    // Check if enough time has passed since last snapshot
    const lastTime = lastSnapshotTime.get(poolId) || 0;
    if (now - lastTime < SNAPSHOT_INTERVAL_MS) {
        return; // Skip, too soon
    }
    
    if (!poolHistory.has(poolId)) {
        poolHistory.set(poolId, []);
    }
    
    const history = poolHistory.get(poolId)!;
    history.push(state);
    
    // Enforce max length
    while (history.length > MAX_HISTORY_LENGTH) {
        history.shift();
    }
    
    lastSnapshotTime.set(poolId, now);
}

/**
 * Get snapshot history for a pool
 */
export function getPoolHistory(poolId: string): DLMMState[] {
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
 * Clear all history (for testing/reset)
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
 * 
 * CRITICAL: Returns null if insufficient data (pool is invalid for scoring)
 * Caller MUST skip pool if null is returned.
 */
export function computeMicrostructureMetrics(poolId: string): MicrostructureMetrics | null {
    const history = poolHistory.get(poolId) || [];
    
    // Require minimum 3 snapshots for delta computation
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
    
    // ═══════════════════════════════════════════════════════════════════════════
    // 4.1 Bin Movement Velocity
    // binVelocity = (activeBin[n] - activeBin[n-1]) / Δtime
    // ═══════════════════════════════════════════════════════════════════════════
    const rawBinDelta = Math.abs(latest.activeBin - prev.activeBin);
    const timeDeltaSeconds = (latest.timestamp - prev.timestamp) / 1000;
    const rawBinVelocity = timeDeltaSeconds > 0 ? rawBinDelta / timeDeltaSeconds : 0;
    
    // Normalize to 0-100 (0.1 bin/sec = 100)
    const binVelocity = Math.min((rawBinVelocity / 0.1) * 100, 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // 4.2 Liquidity Flow Intensity
    // liqFlow = abs((liqX+liqY)[n] - (liqX+liqY)[n-1]) normalized by current pool liquidity
    // ═══════════════════════════════════════════════════════════════════════════
    const currentLiquidity = latest.totalLiquidity;
    const prevLiquidity = prev.totalLiquidity;
    const rawLiquidityDelta = Math.abs(currentLiquidity - prevLiquidity);
    const liquidityFlowRatio = currentLiquidity > 0 ? rawLiquidityDelta / currentLiquidity : 0;
    
    // Normalize to 0-100 (5% flow = 100)
    const liquidityFlow = Math.min((liquidityFlowRatio / 0.05) * 100, 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // 4.3 Swap Velocity
    // swapsPerMinute = swaps in last 60s
    // ═══════════════════════════════════════════════════════════════════════════
    const recentSwaps = getSwapHistory(poolId, 60000);
    const rawSwapCount = recentSwaps.length;
    const swapsPerSecond = rawSwapCount / 60;
    
    // Normalize to 0-100 (1 swap/sec = 100)
    const swapVelocity = Math.min((swapsPerSecond / 1.0) * 100, 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // 4.4 Fee Intensity
    // Total fees in last 1-5 minutes / pool TVL
    // ═══════════════════════════════════════════════════════════════════════════
    const feeSwaps = getSwapHistory(poolId, 5 * 60 * 1000);
    const rawFeesGenerated = feeSwaps.reduce((sum, s) => sum + s.feePaid, 0);
    const feeIntensityRatio = currentLiquidity > 0 ? rawFeesGenerated / currentLiquidity : 0;
    
    // Normalize to 0-100 (0.001 = 0.1% fee/TVL in 5min = 100)
    const feeIntensity = Math.min((feeIntensityRatio / 0.001) * 100, 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Pool Entropy (distribution health)
    // Computed from liquidity spread across bins
    // ═══════════════════════════════════════════════════════════════════════════
    const poolEntropy = computePoolEntropy(history);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Compute Final Pool Score
    // poolScore = Σ(metric * weight)
    // ═══════════════════════════════════════════════════════════════════════════
    const poolScore = (
        binVelocity * SCORING_WEIGHTS.binVelocity +
        liquidityFlow * SCORING_WEIGHTS.liquidityFlow +
        swapVelocity * SCORING_WEIGHTS.swapVelocity +
        feeIntensity * SCORING_WEIGHTS.feeIntensity
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Trading Gating Logic
    // Enter only when market is alive (all conditions must be true in last 30-120s)
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
        
        // Normalized scores (0-100)
        binVelocity,
        liquidityFlow,
        swapVelocity,
        feeIntensity,
        
        // Raw values
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
 * Compute pool entropy from liquidity distribution
 */
function computePoolEntropy(history: DLMMState[]): number {
    if (history.length === 0) return 0;
    
    // Use liquidity X/Y ratio variance as entropy proxy
    const ratios = history.map(s => {
        const total = s.liquidityX + s.liquidityY;
        return total > 0 ? s.liquidityX / total : 0.5;
    });
    
    // Compute entropy from ratio distribution
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const variance = ratios.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / ratios.length;
    
    // Higher variance = higher entropy (more balanced activity)
    // Normalize: variance of 0.25 (perfect 50/50 spread) = 1.0
    const normalizedEntropy = Math.min(variance / 0.25, 1.0);
    
    // Also consider bin movement entropy
    const binDeltas = [];
    for (let i = 1; i < history.length; i++) {
        binDeltas.push(Math.abs(history[i].activeBin - history[i - 1].activeBin));
    }
    
    const binVariance = binDeltas.length > 0
        ? binDeltas.reduce((sum, d) => sum + d, 0) / binDeltas.length
        : 0;
    
    // Combine ratio and bin entropy
    const binEntropy = Math.min(binVariance / 5, 1.0); // 5 bin average delta = max
    
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
    logger.info(`[DLMM-TELEMETRY] Registered position for ${position.poolId} at bin ${position.entryBin}`);
}

/**
 * Unregister a closed position
 */
export function unregisterPosition(poolId: string): void {
    activePositions.delete(poolId);
}

/**
 * Get position exit signal
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
    
    // Compute current fee intensity for 3m window
    const feeSwaps3m = getSwapHistory(poolId, 3 * 60 * 1000);
    const current3mFees = feeSwaps3m.reduce((sum, s) => sum + s.feePaid, 0);
    const current3mFeeIntensity = latest.totalLiquidity > 0 
        ? current3mFees / latest.totalLiquidity 
        : 0;
    
    // Fee intensity drop from entry
    const feeIntensityDrop = position.entry3mFeeIntensity > 0
        ? (position.entry3mFeeIntensity - current3mFeeIntensity) / position.entry3mFeeIntensity
        : 0;
    
    // Swap velocity
    const recentSwaps = getSwapHistory(poolId, 60000);
    const currentSwapVelocity = recentSwaps.length / 60;
    
    // Check rebalance condition
    const shouldRebalance = binOffset >= EXIT_THRESHOLDS.maxBinOffset;
    
    // Check exit conditions
    let shouldExit = false;
    let reason = '';
    
    if (feeIntensityDrop >= EXIT_THRESHOLDS.feeIntensityCollapse) {
        shouldExit = true;
        reason = `Fee intensity collapsed ${(feeIntensityDrop * 100).toFixed(1)}% from 3m average`;
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
 * Log live microstructure metrics (replaces static 24h logging)
 */
export function logMicrostructureMetrics(metrics: MicrostructureMetrics): void {
    const divider = '─'.repeat(60);
    
    logger.info(`\n${divider}`);
    logger.info(`📊 DLMM LIVE METRICS: ${metrics.poolId.slice(0, 8)}...`);
    logger.info(divider);
    
    // Core metrics
    logger.info(`🔄 ActiveBin Δ:        ${metrics.rawBinDelta} bins (velocity: ${metrics.binVelocity.toFixed(1)}/100)`);
    logger.info(`📈 Swap Velocity:      ${metrics.rawSwapCount} swaps/min (score: ${metrics.swapVelocity.toFixed(1)}/100)`);
    logger.info(`💧 Liquidity Flow Δ:   ${metrics.rawLiquidityDelta.toFixed(0)} (${metrics.liquidityFlow.toFixed(1)}/100)`);
    logger.info(`💰 Fee Intensity Δ:    ${metrics.rawFeesGenerated.toFixed(4)} (${metrics.feeIntensity.toFixed(1)}/100)`);
    
    // Pool health
    logger.info(`\n🧬 Pool Entropy:       ${metrics.poolEntropy.toFixed(4)}`);
    logger.info(`📌 Pool Score:         ${metrics.poolScore.toFixed(2)}/100`);
    
    // Gating status
    if (metrics.isMarketAlive) {
        logger.info(`✅ Market Status:      ALIVE - Ready for entry`);
    } else {
        logger.warn(`⚠️  Market Status:      DORMANT`);
        for (const reason of metrics.gatingReasons) {
            logger.warn(`   → ${reason}`);
        }
    }
    
    // Window info
    logger.info(`\n📊 Window: ${metrics.snapshotCount} snapshots over ${((metrics.windowEndMs - metrics.windowStartMs) / 1000).toFixed(0)}s`);
    logger.info(divider + '\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Refresh all pool states and compute metrics
 */
export async function refreshAllPoolMetrics(): Promise<Map<string, MicrostructureMetrics>> {
    const states = await getAllLiveDLMMStates();
    const results = new Map<string, MicrostructureMetrics>();
    
    for (const state of states) {
        // Record snapshot
        recordSnapshot(state);
        
        // Compute metrics
        const metrics = computeMicrostructureMetrics(state.poolId);
        if (metrics) {
            results.set(state.poolId, metrics);
        }
    }
    
    return results;
}

/**
 * Get pools that pass gating conditions (market is alive)
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
    
    // Sort by score descending
    ranked.sort((a, b) => b.score - a.score);
    
    return ranked;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cleanup resources
 */
export function cleanup(): void {
    if (heliusWs) {
        heliusWs.close();
        heliusWs = null;
    }
    
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
    
    clearAllHistory();
    activePositions.clear();
    meteoraPoolCache.clear();
    
    logger.info('[DLMM-TELEMETRY] Cleanup complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS FOR COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════════════

export {
    GATING_THRESHOLDS,
    EXIT_THRESHOLDS,
    SCORING_WEIGHTS,
    MAX_HISTORY_LENGTH,
    SNAPSHOT_INTERVAL_MS,
};

