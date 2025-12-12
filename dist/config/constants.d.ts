export declare const BOT_CONFIG: {
    readonly LOOP_INTERVAL_MS: number;
    readonly TELEMETRY_REFRESH_MS: number;
    readonly MIN_HOLD_TIME_MS: number;
    readonly TRAILING_STOP_PERCENT: 0.1;
    readonly TVL_DROP_THRESHOLD: 0.2;
    readonly VELOCITY_DROP_THRESHOLD: 0.25;
    readonly MARKET_CRASH_EXIT_COUNT: 3;
    readonly MAX_POSITIONS: 5;
    readonly MAX_SIMULTANEOUS_POOLS: 5;
    readonly MAX_POSITIONS_PER_TYPE: 2;
    readonly TARGET_ALLOCATIONS: readonly [0.4, 0.25, 0.2, 0.1, 0.05];
    readonly MAX_POOL_OWNERSHIP_PERCENT: 0.05;
    readonly SMALL_POOL_THRESHOLD: 100000;
    readonly SMALL_POOL_SIZE_MULTIPLIER: 0.5;
    readonly MICROSTRUCTURE_WEIGHTS: {
        readonly BIN_VELOCITY: 0.3;
        readonly LIQUIDITY_FLOW: 0.2;
        readonly SWAP_VELOCITY: 0.25;
        readonly FEE_INTENSITY: 0.15;
        readonly ENTROPY: 0.1;
    };
    readonly PRE_TIER_MIN_SWAP_VELOCITY: 0.12;
    readonly PRE_TIER_MIN_POOL_ENTROPY: 0.65;
    readonly PRE_TIER_MIN_LIQUIDITY_FLOW: 0.005;
    readonly PRE_TIER_MIN_VOLUME_24H: 75000;
    readonly MARKET_DEPTH_MIN_TVL: 200000;
    readonly MARKET_DEPTH_MIN_SWAPPERS: 35;
    readonly MARKET_DEPTH_MIN_TRADE_SIZE: 75;
    readonly TIME_WEIGHT_HISTORY_WINDOW_MS: number;
    readonly TIME_WEIGHT_MIN_CONSISTENCY: 40;
    readonly TIME_WEIGHT_MAX_SPIKE_RATIO: 2;
    readonly TIME_WEIGHT_CONSISTENCY_BOOST: 0.15;
    readonly TIME_WEIGHT_SPIKE_PENALTY: 0.2;
    readonly GATING_MIN_BIN_VELOCITY: 0.03;
    readonly GATING_MIN_SWAP_VELOCITY: 0.12;
    readonly GATING_MIN_POOL_ENTROPY: 0.65;
    readonly GATING_MIN_LIQUIDITY_FLOW: 0.005;
    readonly EXIT_FEE_INTENSITY_COLLAPSE: 0.35;
    readonly EXIT_MIN_SWAP_VELOCITY: 0.05;
    readonly EXIT_MAX_BIN_OFFSET: 2;
    readonly DLMM_HISTORY_LENGTH: 20;
    readonly SNAPSHOT_INTERVAL_MS: 8000;
    readonly DLMM_MIN_ENTRY_SCORE: 24;
    readonly DLMM_PRIORITY_SCORE: 40;
    readonly DISCOVERY_CACHE_TTL_MINUTES: 12;
    readonly DISCOVERY_ROTATION_INTERVAL_MINUTES: 3;
    readonly DISCOVERY_DEAD_POOL_THRESHOLD: 15;
    /** @deprecated Use MICROSTRUCTURE_WEIGHTS instead */
    readonly MIN_DAILY_YIELD_PERCENT: 1;
    /** @deprecated Use microstructure scoring */
    readonly DILUTION_PENALTY_THRESHOLD: 50;
    /** @deprecated Use microstructure scoring */
    readonly DILUTION_PENALTY_MULTIPLIER: 0.75;
    readonly TOP_CANDIDATES_COUNT: 50;
    readonly BLUE_CHIP_TOKENS: readonly ["SOL", "BTC", "ETH", "JLP", "JUP"];
    readonly STABLECOIN_IDENTIFIERS: readonly ["USDC", "USDT", "DAI"];
};
export type BotConfigType = typeof BOT_CONFIG;
export declare const ENV_KEYS: {
    readonly SOLANA_RPC_URL: "SOLANA_RPC_URL";
    readonly SUPABASE_URL: "SUPABASE_URL";
    readonly SUPABASE_KEY: "SUPABASE_KEY";
    readonly ENV: "ENV";
    readonly TOTAL_CAPITAL: "TOTAL_CAPITAL";
    readonly PAPER_TRADING: "PAPER_TRADING";
    readonly PAPER_CAPITAL: "PAPER_CAPITAL";
    readonly VERBOSE_SCORING: "VERBOSE_SCORING";
};
/**
 * Check if verbose scoring diagnostics mode is enabled.
 * Set VERBOSE_SCORING=true in .env to enable detailed scoring logs.
 * Disable in production to reduce log noise.
 */
export declare const isVerboseScoringEnabled: () => boolean;
//# sourceMappingURL=constants.d.ts.map