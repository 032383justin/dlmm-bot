"use strict";
// Configuration Constants for DLMM Bot
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENV_KEYS = exports.BOT_CONFIG = void 0;
exports.BOT_CONFIG = {
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
    MAX_POSITIONS_PER_TYPE: 2,
    TARGET_ALLOCATIONS: [0.40, 0.25, 0.20, 0.10, 0.05],
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
    // Token Categories
    BLUE_CHIP_TOKENS: ['SOL', 'BTC', 'ETH', 'JLP', 'JUP'],
    STABLECOIN_IDENTIFIERS: ['USDC', 'USDT', 'DAI'],
};
// Environment variable keys
exports.ENV_KEYS = {
    RPC_URL: 'RPC_URL',
    SUPABASE_URL: 'SUPABASE_URL',
    SUPABASE_KEY: 'SUPABASE_KEY',
    ENV: 'ENV',
    TOTAL_CAPITAL: 'TOTAL_CAPITAL',
    PAPER_TRADING: 'PAPER_TRADING',
    PAPER_CAPITAL: 'PAPER_CAPITAL',
};
