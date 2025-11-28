/**
 * Market regime classification for Tier 4
 */
export type MarketRegime = 'BULL' | 'NEUTRAL' | 'BEAR';
/**
 * Migration direction for liquidity flow tracking
 */
export type MigrationDirection = 'in' | 'out' | 'neutral';
/**
 * Tier 4 dynamic thresholds based on regime
 */
export interface Tier4Thresholds {
    entryThreshold: number;
    exitThreshold: number;
}
/**
 * Tier 4 bin width configuration
 */
export interface BinWidthConfig {
    min: number;
    max: number;
    label: string;
}
/**
 * Complete Tier 4 scoring result
 */
export interface Tier4Score {
    binVelocityScore: number;
    swapVelocityScore: number;
    liquidityFlowScore: number;
    feeIntensityScore: number;
    entropyScore: number;
    rawBinVelocity: number;
    rawSwapVelocity: number;
    rawLiquidityFlow: number;
    rawFeeIntensity: number;
    rawEntropy: number;
    velocitySlope: number;
    liquiditySlope: number;
    entropySlope: number;
    regimeMultiplier: number;
    migrationMultiplier: number;
    slopeMultiplier: number;
    regime: MarketRegime;
    migrationDirection: MigrationDirection;
    baseScore: number;
    tier4Score: number;
    entryThreshold: number;
    exitThreshold: number;
    binWidth: BinWidthConfig;
    valid: boolean;
    invalidReason?: string;
    poolId: string;
    timestamp: number;
}
/**
 * Tier 4 entry evaluation result
 */
export interface Tier4EntryEvaluation {
    canEnter: boolean;
    blocked: boolean;
    blockReason?: string;
    score: number;
    regime: MarketRegime;
    migrationDirection: MigrationDirection;
    entryThreshold: number;
    meetsThreshold: boolean;
}
/**
 * Tier 4 exit evaluation result
 */
export interface Tier4ExitEvaluation {
    shouldExit: boolean;
    reason: string;
    score: number;
    exitThreshold: number;
    regime: MarketRegime;
}
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
    tier4Score?: number;
    regime?: MarketRegime;
    migrationDirection?: MigrationDirection;
}
export interface ActivePosition {
    poolAddress: string;
    readonly entryTime: number;
    readonly entryScore: number;
    readonly entryPrice: number;
    peakScore: number;
    amount: number;
    readonly entryTVL: number;
    readonly entryVelocity: number;
    consecutiveCycles: number;
    consecutiveLowVolumeCycles: number;
    readonly tokenType: TokenType;
    tookProfit1?: boolean;
    tookProfit2?: boolean;
    entryBin?: number;
    currentBin?: number;
    entryTier4Score?: number;
    entryRegime?: MarketRegime;
    entryMigrationDirection?: MigrationDirection;
    velocitySlope?: number;
    liquiditySlope?: number;
    entropySlope?: number;
}
export type TokenType = 'stable' | 'blue-chip' | 'meme';
export interface SafetyFilterResult {
    readonly passed: boolean;
    readonly reason?: string;
}
export interface ExitTrigger {
    readonly triggered: boolean;
    readonly reason: 'trailing-stop' | 'tvl-drop' | 'velocity-drop' | 'volume-exit' | 'market-crash' | 'microstructure' | 'tier4-regime' | 'tier4-migration';
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
    readonly tier4Score?: number;
    readonly regime?: MarketRegime;
    readonly migrationDirection?: MigrationDirection;
    readonly velocitySlope?: number;
    readonly liquiditySlope?: number;
    readonly entropySlope?: number;
    readonly binWidth?: number;
    readonly entryThreshold?: number;
    readonly exitThreshold?: number;
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
    readonly tier4Score?: number;
    readonly regime?: MarketRegime;
    readonly migrationDirection?: MigrationDirection;
    readonly velocitySlope?: number;
    readonly liquiditySlope?: number;
    readonly entropySlope?: number;
}
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
    liquidityUSD: number;
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
    binVelocity: number;
    liquidityFlow: number;
    swapVelocity: number;
    feeIntensity: number;
    rawBinDelta: number;
    rawLiquidityDelta: number;
    rawSwapCount: number;
    rawFeesGenerated: number;
    poolEntropy: number;
    poolScore: number;
    isMarketAlive: boolean;
    gatingReasons: string[];
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
    entryTier4Score?: number;
    entryRegime?: MarketRegime;
    entryMigrationDirection?: MigrationDirection;
    entryVelocitySlope?: number;
    entryLiquiditySlope?: number;
    entryEntropySlope?: number;
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
 * Entry gating status (Tier 4)
 */
export interface EntryGatingStatus {
    tier4Score: {
        value: number;
        required: number;
        passes: boolean;
    };
    regime: {
        value: MarketRegime;
        multiplier: number;
    };
    migration: {
        direction: MigrationDirection;
        blocked: boolean;
        reason?: string;
    };
    snapshotCount: {
        value: number;
        required: number;
        passes: boolean;
    };
    liquidityUSD: {
        value: number;
        required: number;
        passes: boolean;
    };
    allPass: boolean;
}
/**
 * Tier 4 cycle log entry
 */
export interface Tier4CycleLog {
    timestamp: number;
    poolId: string;
    regime: MarketRegime;
    regimeMultiplier: number;
    migrationDirection: MigrationDirection;
    migrationSlope: number;
    migrationBlocked: boolean;
    tier4Score: number;
    baseScore: number;
    slopeMultiplier: number;
    entryThreshold: number;
    exitThreshold: number;
    binWidth: BinWidthConfig;
    entryBlockReason?: string;
}
export type ReadonlyPool = Readonly<PoolMetrics>;
export type PartialPool = Partial<PoolMetrics>;
export type RequiredPoolFields = Required<Pick<PoolMetrics, 'address' | 'name' | 'liquidity' | 'volume24h'>>;
//# sourceMappingURL=index.d.ts.map