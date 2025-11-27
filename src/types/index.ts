// Type Definitions for DLMM Bot

export interface PoolMetrics {
    readonly address: string;
    readonly name: string;
    readonly mintX: string;
    readonly mintY: string;
    liquidity: number;
    volume1h: number;
    volume4h: number;
    volume24h: number;
    velocity: number;
    fees24h: number;
    apr: number;
    binStep: number;
    baseFee: number;
    createdAt: number;
    holderCount: number;
    topHolderPercent: number;
    isRenounced: boolean;
    riskScore: number;
    dilutionScore: number;
    score: number;
    binCount: number;
}

export interface ActivePosition {
    poolAddress: string;
    readonly entryTime: number;
    readonly entryScore: number;
    readonly entryPrice: number; // Added for profit taking
    peakScore: number;
    amount: number; // Removed readonly to allow partial exits
    readonly entryTVL: number;
    readonly entryVelocity: number;
    consecutiveCycles: number;
    consecutiveLowVolumeCycles: number; // Track volume exit confirmation
    readonly tokenType: TokenType;
    tookProfit1?: boolean; // +15% hit
    tookProfit2?: boolean; // +30% hit
    
    // Bin-focused tracking (microstructure)
    entryBin?: number;
    currentBin?: number;
}

export type TokenType = 'stable' | 'blue-chip' | 'meme';

export interface SafetyFilterResult {
    readonly passed: boolean;
    readonly reason?: string;
}

export interface ExitTrigger {
    readonly triggered: boolean;
    readonly reason: 'trailing-stop' | 'tvl-drop' | 'velocity-drop' | 'volume-exit' | 'market-crash' | 'microstructure';
}

export interface BotConfig {
    readonly loopIntervalMs: number;
    readonly minHoldTimeMs: number;
    readonly paperTrading: boolean;
    readonly paperCapital: number;
    readonly totalCapital: number;
    readonly trailingStopPercent: number;
    readonly tvlDropThreshold: number;
    readonly velocityDropThreshold: number;
    readonly marketCrashExitCount: number;
    readonly maxPositionsPerType: number;
}

export interface LogAction {
    readonly action: 'ENTRY' | 'EXIT' | 'MARKET_CRASH_EXIT' | 'HEARTBEAT' | 'KILL_SWITCH';
    readonly pool?: string;
    readonly score?: number;
    readonly amount?: number;
    readonly type?: TokenType;
    readonly reason?: string;
    readonly peakScore?: number;
    readonly currentScore?: number;
    readonly paperTrading?: boolean;
    readonly paperPnL?: number;
    readonly paperBalance?: number;
    readonly exitSignalCount?: number;
    readonly duration?: number;
    readonly candidates?: number;
    
    // Microstructure fields
    readonly microMetrics?: MicrostructureLogMetrics;
    readonly entryBin?: number;
    readonly binOffset?: number;
    readonly feeIntensityDrop?: number;
    readonly currentSwapVelocity?: number;
}

/**
 * Microstructure metrics for logging
 */
export interface MicrostructureLogMetrics {
    binVelocity: number;
    liquidityFlow: number;
    swapVelocity: number;
    feeIntensity: number;
    poolEntropy: number;
}

export interface PoolSnapshot {
    readonly timestamp: number;
    readonly data: PoolMetrics;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MICROSTRUCTURE TYPES
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
 * Exit signal from microstructure evaluation
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
 * Entry gating status
 */
export interface EntryGatingStatus {
    binVelocity: { value: number; required: number; passes: boolean };
    swapVelocity: { value: number; required: number; passes: boolean };
    poolEntropy: { value: number; required: number; passes: boolean };
    liquidityFlow: { value: number; required: number; passes: boolean };
    allPass: boolean;
}

// Utility Types
export type ReadonlyPool = Readonly<PoolMetrics>;
export type PartialPool = Partial<PoolMetrics>;
export type RequiredPoolFields = Required<Pick<PoolMetrics, 'address' | 'name' | 'liquidity' | 'volume24h'>>;
