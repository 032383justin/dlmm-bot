"use strict";
// Configuration Constants for DLMM Bot
Object.defineProperty(exports, "__esModule", { value: true });
exports.MHI_HARD_FLOOR = exports.MHI_SOFT_FLOOR = exports.EXPLORATION_MAX_DEPLOYED_PCT = exports.isExplorationModeEnabled = exports.isVerboseScoringEnabled = exports.ENV_KEYS = exports.BOT_CONFIG = void 0;
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
    // MICROSTRUCTURE SCORING (UPGRADED)
    // Uses real-time DLMM signals instead of 24h metrics
    // Includes pre-tier filtering and time-weighted scoring
    // ═══════════════════════════════════════════════════════════════════════════
    MICROSTRUCTURE_WEIGHTS: {
        BIN_VELOCITY: 0.30, // Rate of bin movement
        LIQUIDITY_FLOW: 0.20, // Liquidity change intensity
        SWAP_VELOCITY: 0.25, // Swaps per minute
        FEE_INTENSITY: 0.15, // Fee generation rate
        ENTROPY: 0.10, // Bin distribution entropy
    },
    // ═══════════════════════════════════════════════════════════════════════════
    // PRE-TIER THRESHOLDS (Discard at ingest - NEVER reach Tier4 scoring)
    // ═══════════════════════════════════════════════════════════════════════════
    PRE_TIER_MIN_SWAP_VELOCITY: 0.12, // swaps per second
    PRE_TIER_MIN_POOL_ENTROPY: 0.65, // Shannon entropy
    PRE_TIER_MIN_LIQUIDITY_FLOW: 0.005, // 0.5% of pool total
    PRE_TIER_MIN_VOLUME_24H: 75000, // $75k minimum volume
    // ═══════════════════════════════════════════════════════════════════════════
    // MARKET DEPTH REQUIREMENTS
    // ═══════════════════════════════════════════════════════════════════════════
    MARKET_DEPTH_MIN_TVL: 200000, // $200k minimum TVL
    MARKET_DEPTH_MIN_SWAPPERS: 35, // 35 unique swappers in 24h
    MARKET_DEPTH_MIN_TRADE_SIZE: 75, // $75 median trade size
    // ═══════════════════════════════════════════════════════════════════════════
    // TIME-WEIGHTED SCORING
    // Prefer consistent bin shifts, persistent flow, NOT single candle spikes
    // ═══════════════════════════════════════════════════════════════════════════
    TIME_WEIGHT_HISTORY_WINDOW_MS: 30 * 60 * 1000, // 30 minutes
    TIME_WEIGHT_MIN_CONSISTENCY: 40, // Minimum consistency score (0-100)
    TIME_WEIGHT_MAX_SPIKE_RATIO: 2.0, // Maximum acceptable spike ratio
    TIME_WEIGHT_CONSISTENCY_BOOST: 0.15, // 15% boost for high consistency
    TIME_WEIGHT_SPIKE_PENALTY: 0.20, // 20% penalty for high spikes
    // Gating Thresholds (all must be met for entry)
    GATING_MIN_BIN_VELOCITY: 0.03,
    GATING_MIN_SWAP_VELOCITY: 0.12, // Upgraded to match pre-tier
    GATING_MIN_POOL_ENTROPY: 0.65, // Upgraded to match pre-tier
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
    // CACHE SETTINGS
    // ═══════════════════════════════════════════════════════════════════════════
    DISCOVERY_CACHE_TTL_MINUTES: 12, // 12 minutes (10-15 range)
    DISCOVERY_ROTATION_INTERVAL_MINUTES: 3, // Check for rotation every 3 min
    DISCOVERY_DEAD_POOL_THRESHOLD: 15, // Score below 15 = dead pool
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
    SOLANA_RPC_URL: 'SOLANA_RPC_URL',
    SUPABASE_URL: 'SUPABASE_URL',
    SUPABASE_KEY: 'SUPABASE_KEY',
    ENV: 'ENV',
    TOTAL_CAPITAL: 'TOTAL_CAPITAL',
    PAPER_TRADING: 'PAPER_TRADING',
    PAPER_CAPITAL: 'PAPER_CAPITAL',
    VERBOSE_SCORING: 'VERBOSE_SCORING',
    EXPLORATION_MODE: 'EXPLORATION_MODE',
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
// ═══════════════════════════════════════════════════════════════════════════════
// EXPLORATION MODE - Safe data collection when market is dead
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Check if exploration mode is enabled.
 * Set EXPLORATION_MODE=true in .env to allow micro-size entries for data collection.
 */
const isExplorationModeEnabled = () => {
    return process.env.EXPLORATION_MODE === 'true';
};
exports.isExplorationModeEnabled = isExplorationModeEnabled;
/**
 * Maximum capital deployed under exploration mode entries (as fraction)
 * e.g., 0.01 = 1% of total capital
 */
exports.EXPLORATION_MAX_DEPLOYED_PCT = 0.01;
// ═══════════════════════════════════════════════════════════════════════════════
// MHI THRESHOLDS - Sizing Governor (not hard gate)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * MHI Soft Floor - entries allowed but size reduced below this
 */
exports.MHI_SOFT_FLOOR = 0.35;
/**
 * MHI Hard Floor - true NO_TRADE below this (microstructure too unhealthy)
 */
exports.MHI_HARD_FLOOR = 0.20;
//# sourceMappingURL=constants.js.map