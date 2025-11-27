export declare const BOT_CONFIG: {
    readonly LOOP_INTERVAL_MS: number;
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
    readonly MIN_DAILY_YIELD_PERCENT: 1;
    readonly DILUTION_PENALTY_THRESHOLD: 50;
    readonly DILUTION_PENALTY_MULTIPLIER: 0.75;
    readonly TOP_CANDIDATES_COUNT: 50;
    readonly DLMM_HISTORY_LENGTH: 20;
    readonly DLMM_MIN_ENTRY_SCORE: 65;
    readonly BLUE_CHIP_TOKENS: readonly ["SOL", "BTC", "ETH", "JLP", "JUP"];
    readonly STABLECOIN_IDENTIFIERS: readonly ["USDC", "USDT", "DAI"];
};
export type BotConfigType = typeof BOT_CONFIG;
export declare const ENV_KEYS: {
    readonly RPC_URL: "RPC_URL";
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