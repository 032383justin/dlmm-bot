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
}
export type TokenType = 'stable' | 'blue-chip' | 'meme';
export interface SafetyFilterResult {
    readonly passed: boolean;
    readonly reason?: string;
}
export interface ExitTrigger {
    readonly triggered: boolean;
    readonly reason: 'trailing-stop' | 'tvl-drop' | 'velocity-drop' | 'volume-exit' | 'market-crash';
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
    readonly action: 'ENTRY' | 'EXIT' | 'MARKET_CRASH_EXIT' | 'HEARTBEAT';
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
}
export interface PoolSnapshot {
    readonly timestamp: number;
    readonly data: PoolMetrics;
}
export type ReadonlyPool = Readonly<PoolMetrics>;
export type PartialPool = Partial<PoolMetrics>;
export type RequiredPoolFields = Required<Pick<PoolMetrics, 'address' | 'name' | 'liquidity' | 'volume24h'>>;
//# sourceMappingURL=index.d.ts.map