// Configuration Constants for DLMM Bot

export const BOT_CONFIG = {
    // Timing
    LOOP_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
    MIN_HOLD_TIME_MS: 4 * 60 * 60 * 1000, // 4 hours

    // Exit Triggers
    TRAILING_STOP_PERCENT: 0.10, // 10% from peak
    TVL_DROP_THRESHOLD: 0.20, // 20% TVL drop
    VELOCITY_DROP_THRESHOLD: 0.25, // 25% velocity drop
    MARKET_CRASH_EXIT_COUNT: 3, // Exit all if 3+ pools trigger

    // Position Management
    MAX_POSITIONS: 5,
    MAX_SIMULTANEOUS_POOLS: 5, // Only analyze and trade top 5 pools after scoring
    MAX_POSITIONS_PER_TYPE: 2,
    TARGET_ALLOCATIONS: [0.40, 0.25, 0.20, 0.10, 0.05] as const,

    // Liquidity Caps
    MAX_POOL_OWNERSHIP_PERCENT: 0.05, // Max 5% of pool TVL
    SMALL_POOL_THRESHOLD: 100000, // $100k
    SMALL_POOL_SIZE_MULTIPLIER: 0.5, // 50% size for small pools

    // Scoring
    MIN_DAILY_YIELD_PERCENT: 1.0, // 1% minimum daily return
    DILUTION_PENALTY_THRESHOLD: 50,
    DILUTION_PENALTY_MULTIPLIER: 0.75,

    // RPC
    TOP_CANDIDATES_COUNT: 50, // Only deep-analyze top 50 by volume

    // DLMM Microstructure
    DLMM_HISTORY_LENGTH: 20, // Keep last 20 bin snapshots per pool for scoring
    DLMM_MIN_ENTRY_SCORE: 65, // Minimum total bin score to enter (prevents blown accounts)

    // Token Categories
    BLUE_CHIP_TOKENS: ['SOL', 'BTC', 'ETH', 'JLP', 'JUP'] as const,
    STABLECOIN_IDENTIFIERS: ['USDC', 'USDT', 'DAI'] as const,
} as const;

export type BotConfigType = typeof BOT_CONFIG;

// Environment variable keys
export const ENV_KEYS = {
    RPC_URL: 'RPC_URL',
    SUPABASE_URL: 'SUPABASE_URL',
    SUPABASE_KEY: 'SUPABASE_KEY',
    ENV: 'ENV',
    TOTAL_CAPITAL: 'TOTAL_CAPITAL',
    PAPER_TRADING: 'PAPER_TRADING',
    PAPER_CAPITAL: 'PAPER_CAPITAL',
    VERBOSE_SCORING: 'VERBOSE_SCORING',
} as const;

/**
 * Check if verbose scoring diagnostics mode is enabled.
 * Set VERBOSE_SCORING=true in .env to enable detailed scoring logs.
 * Disable in production to reduce log noise.
 */
export const isVerboseScoringEnabled = (): boolean => {
    return process.env.VERBOSE_SCORING === 'true';
};
