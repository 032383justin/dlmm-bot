"use strict";
// Configuration Constants for DLMM Bot
Object.defineProperty(exports, "__esModule", { value: true });
exports.isVerboseScoringEnabled = exports.ENV_KEYS = exports.BOT_CONFIG = void 0;
exports.BOT_CONFIG = {
    // Timing
    LOOP_INTERVAL_MS: 2 * 60 * 1000, // 2 minutes (reduced for faster telemetry)
    TELEMETRY_REFRESH_MS: 10 * 1000, // 10 seconds telemetry refresh
    MIN_HOLD_TIME_MS: 4 * 60 * 60 * 1000, // 4 hours
    // Exit Triggers (Microstructure-based)
    TRAILING_STOP_PERCENT: 0.10, // 10% from peak
    TVL_DROP_THRESHOLD: 0.20, // 20% TVL drop (deprecated - use microstructure)
    VELOCITY_DROP_THRESHOLD: 0.25, // 25% velocity drop (deprecated - use microstructure)
    MARKET_CRASH_EXIT_COUNT: 3, // Exit all if 3+ pools trigger
    // Position Management
    MAX_POSITIONS: 5,
    MAX_SIMULTANEOUS_POOLS: 5, // Only analyze and trade top 5 pools after scoring
    MAX_POSITIONS_PER_TYPE: 2,
    TARGET_ALLOCATIONS: [0.40, 0.25, 0.20, 0.10, 0.05],
    // Liquidity Caps
    MAX_POOL_OWNERSHIP_PERCENT: 0.05, // Max 5% of pool TVL
    SMALL_POOL_THRESHOLD: 100000, // $100k
    SMALL_POOL_SIZE_MULTIPLIER: 0.5, // 50% size for small pools
    // ═══════════════════════════════════════════════════════════════════════════
    // MICROSTRUCTURE SCORING (NEW)
    // Uses real-time DLMM signals instead of 24h metrics
    // ═══════════════════════════════════════════════════════════════════════════
    MICROSTRUCTURE_WEIGHTS: {
        BIN_VELOCITY: 0.30, // Rate of bin movement
        LIQUIDITY_FLOW: 0.30, // Liquidity change intensity
        SWAP_VELOCITY: 0.25, // Swaps per minute
        FEE_INTENSITY: 0.15, // Fee generation rate
    },
    // Gating Thresholds (all must be met for entry)
    GATING_MIN_BIN_VELOCITY: 0.03,
    GATING_MIN_SWAP_VELOCITY: 0.10, // swaps per second
    GATING_MIN_POOL_ENTROPY: 0.65,
    GATING_MIN_LIQUIDITY_FLOW: 0.005, // 0.5% of pool total
    // Exit Thresholds (microstructure-based)
    EXIT_FEE_INTENSITY_COLLAPSE: 0.35, // 35% drop from 3m average
    EXIT_MIN_SWAP_VELOCITY: 0.05, // swaps per second
    EXIT_MAX_BIN_OFFSET: 2, // Rebalance when offset >= 2
    // History Buffer
    DLMM_HISTORY_LENGTH: 20, // Keep last 20 snapshots per pool
    SNAPSHOT_INTERVAL_MS: 8000, // 8 seconds between snapshots
    // Minimum Scores
    DLMM_MIN_ENTRY_SCORE: 24, // Minimum microstructure score to enter
    DLMM_PRIORITY_SCORE: 40, // Priority entry threshold
    // ═══════════════════════════════════════════════════════════════════════════
    // DEPRECATED (24h metrics - do not use for scoring)
    // ═══════════════════════════════════════════════════════════════════════════
    /** @deprecated Use MICROSTRUCTURE_WEIGHTS instead */
    MIN_DAILY_YIELD_PERCENT: 1.0,
    /** @deprecated Use microstructure scoring */
    DILUTION_PENALTY_THRESHOLD: 50,
    /** @deprecated Use microstructure scoring */
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
    VERBOSE_SCORING: 'VERBOSE_SCORING',
};
/**
 * Check if verbose scoring diagnostics mode is enabled.
 * Set VERBOSE_SCORING=true in .env to enable detailed scoring logs.
 * Disable in production to reduce log noise.
 */
const isVerboseScoringEnabled = () => {
    return process.env.VERBOSE_SCORING === 'true';
};
exports.isVerboseScoringEnabled = isVerboseScoringEnabled;
//# sourceMappingURL=constants.js.map