"use strict";
// Configuration Constants for DLMM Bot
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIER5_CONFIG = exports.PEPF_CONFIG = exports.ENABLE_PEPF = exports.TIER5_FEATURE_FLAGS = exports.MHI_HARD_FLOOR = exports.MHI_SOFT_FLOOR = exports.EXPLORATION_MAX_DEPLOYED_PCT = exports.isExplorationModeEnabled = exports.isVerboseScoringEnabled = exports.ENV_KEYS = exports.BOT_CONFIG = void 0;
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
// ═══════════════════════════════════════════════════════════════════════════════
// TIER 5: CONTROLLED AGGRESSION CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Feature flags for Tier 5 modules
 */
exports.TIER5_FEATURE_FLAGS = {
    /**
     * Master switch for all Tier 5 behavior
     * Can be disabled via CONTROLLED_AGGRESSION=false env var
     */
    ENABLE_CONTROLLED_AGGRESSION: process.env.CONTROLLED_AGGRESSION !== 'false',
    /**
     * Enable Volatility Skew Harvester
     */
    ENABLE_VSH: process.env.ENABLE_VSH !== 'false',
    /**
     * Enable Capital Concentration Engine
     */
    ENABLE_CCE: process.env.ENABLE_CCE !== 'false',
    /**
     * Enable Opportunity Density Detector
     */
    ENABLE_ODD: process.env.ENABLE_ODD !== 'false',
};
// ═══════════════════════════════════════════════════════════════════════════════
// PRE-ENTRY PERSISTENCE FILTER (PEPF) CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Enable Pre-Entry Persistence Filter
 * Blocks entries where EV is positive only for a single snapshot/cycle,
 * preventing micro-hold fee bleed from short-lived edge opportunities.
 *
 * Can be disabled via ENABLE_PEPF=false env var
 */
exports.ENABLE_PEPF = process.env.ENABLE_PEPF !== 'false'; // Default: enabled
/**
 * PEPF Configuration with justifications
 */
exports.PEPF_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // SNAPSHOT REQUIREMENTS
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * Minimum snapshots required for PEPF evaluation
     * Justification: Need enough history to compute meaningful persistence signals
     * Default: 15 (prefer 20, but allow evaluation with 15)
     */
    minSnapshots: 15,
    /**
     * Maximum staleness threshold (ms) for telemetry data
     * Justification: Reject if data is too old to be actionable
     * Default: 5 minutes
     */
    maxStalenessMs: 5 * 60 * 1000,
    /**
     * Maximum % of repeated identical timestamps allowed
     * Justification: Detects synthetic/stale telemetry that would produce false signals
     * Default: 30%
     */
    maxSyntheticTimestampPct: 0.30,
    // ═══════════════════════════════════════════════════════════════════════════
    // STREAK THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * Minimum consecutive cycles with EV >= 0 (Tier-4 base)
     * Justification: Prevents single-snapshot positive EV from triggering entry
     * Default: 3 cycles
     */
    minEvStreak: 3,
    /**
     * Minimum consecutive cycles with feeIntensity above minimum
     * Justification: Ensures fee generation is sustained, not a spike
     * Default: 2 cycles
     */
    minFiStreak: 2,
    /**
     * Minimum fee intensity threshold (normalized 0-1 scale)
     * Justification: Aligned with existing feeIntensity scale in microMetrics
     * Default: 0.02 (2% of max intensity)
     */
    minFeeIntensity: 0.02,
    // ═══════════════════════════════════════════════════════════════════════════
    // AMORTIZATION REQUIREMENTS
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * Multiplier for amortization time requirement
     * edgeHalfLife must be >= amortizationSec × this multiplier
     * Justification: Edge must persist long enough to cover costs with margin
     * Default: 1.25 (25% safety margin)
     */
    amortizationMultiplier: 1.25,
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER-5 RELAXATION (A2+ with ODD spike)
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * Minimum EV streak under Tier-5 relaxation
     * Justification: Still require multi-cycle confirmation, but less strict
     * Default: 2 (down from 3)
     */
    tier5MinEvStreak: 2,
    /**
     * Amortization multiplier under Tier-5 relaxation
     * Justification: ODD spike provides additional edge confirmation
     * Default: 1.05 (5% margin, down from 25%)
     */
    tier5AmortizationMultiplier: 1.05,
    // ═══════════════════════════════════════════════════════════════════════════
    // STATISTICAL PROCESSING
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * Maximum z-score magnitude for winsorization
     * Justification: Prevents single outlier from dominating half-life calculation
     * Default: 4.0 sigma
     */
    winsorZMax: 4.0,
    // ═══════════════════════════════════════════════════════════════════════════
    // COOLDOWN CONFIGURATION
    // Prevents repeatedly paying attention to the same mirage pool every cycle
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * Cooldown duration for pools rejected due to HALFLIFE_LT_AMORTIZATION
     * Justification: Edge decay issues take time to resolve; 20 min default
     * Default: 20 minutes
     */
    cooldownHalfLifeMs: 20 * 60 * 1000,
    /**
     * Cooldown duration for pools rejected due to EV_STREAK_BELOW_MIN
     * Justification: EV streak breaks need several cycles to rebuild
     * Default: 15 minutes
     */
    cooldownEvStreakMs: 15 * 60 * 1000,
    /**
     * Cooldown duration for pools rejected due to FI_STREAK_BELOW_MIN
     * Justification: Fee intensity streaks also need time to rebuild
     * Default: 10 minutes
     */
    cooldownFiStreakMs: 10 * 60 * 1000,
};
/**
 * Tier 5 Controlled Aggression Configuration
 */
exports.TIER5_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // ODD (Opportunity Density Detector) Configuration
    // ═══════════════════════════════════════════════════════════════════════════
    ODD: {
        /**
         * Minimum snapshots for z-score calculation
         * Justification: Need statistical significance
         */
        minSnapshotsForZScore: 30,
        /**
         * Maximum snapshots in rolling window
         * Justification: 120 @ 2min = 4 hours of history
         */
        maxSnapshotsInWindow: 120,
        /**
         * ODS spike threshold (sigma)
         * Justification: 2.2 sigma is ~1.4% occurrence rate
         */
        spikeThreshold: 2.2,
        /**
         * Rare convergence threshold (sigma)
         * Justification: 2.8 sigma is ~0.3% occurrence rate
         */
        rareConvergenceThreshold: 2.8,
        /**
         * Default TTL for ODS spike (ms)
         */
        defaultTTLMs: 15 * 60 * 1000, // 15 minutes
        /**
         * Minimum TTL after decay (ms)
         */
        minTTLMs: 5 * 60 * 1000, // 5 minutes
        /**
         * ODS drop threshold for early decay
         */
        decayDropThreshold: 0.30, // 30%
    },
    // ═══════════════════════════════════════════════════════════════════════════
    // AEL (Aggression Ladder) Configuration
    // ═══════════════════════════════════════════════════════════════════════════
    AEL: {
        /**
         * Minimum cycles in same regime for stability
         */
        minCyclesForStability: 3,
        /**
         * Minimum time in regime for stability (ms)
         */
        minTimeForStabilityMs: 5 * 60 * 1000, // 5 minutes
        /**
         * Cycles to block escalation after instability
         */
        escalationBlockCycles: 2,
        /**
         * TTL for A2 level (ms)
         */
        ttlA2Ms: 12 * 60 * 1000, // 12 minutes
        /**
         * TTL for A3 level (ms)
         */
        ttlA3Ms: 7 * 60 * 1000, // 7 minutes
        /**
         * TTL for A4 level (ms)
         */
        ttlA4Ms: 3 * 60 * 1000, // 3 minutes
        /**
         * Size multipliers per level
         */
        sizeMultipliers: {
            A0: 1.00,
            A1: 1.10,
            A2: 1.35,
            A3: 1.50,
            A4: 1.75,
        },
        /**
         * Bin width multipliers per level (lower = narrower)
         */
        binWidthMultipliers: {
            A0: 1.00,
            A1: 0.95,
            A2: 0.85,
            A3: 0.80,
            A4: 0.75,
        },
        /**
         * Exit sensitivity multipliers per level (higher = less sensitive)
         */
        exitSensitivityMultipliers: {
            A0: 1.00,
            A1: 1.05,
            A2: 1.10,
            A3: 1.15,
            A4: 1.20,
        },
    },
    // ═══════════════════════════════════════════════════════════════════════════
    // CCE (Capital Concentration Engine) Configuration
    // ═══════════════════════════════════════════════════════════════════════════
    CCE: {
        /**
         * Maximum total portfolio deployed (% of equity)
         */
        maxTotalDeployedPct: 0.25, // 25%
        /**
         * Maximum per-pool hard cap (% of equity)
         */
        maxPerPoolHardCapPct: 0.18, // 18%
        /**
         * Base per-pool cap before concentration
         */
        basePerPoolCapPct: 0.075, // 7.5%
        /**
         * Concentration multipliers per level
         */
        concentrationMultipliers: {
            A0: 1.0,
            A1: 1.0,
            A2: 1.5,
            A3: 2.0,
            A4: 2.5,
        },
        /**
         * Maximum tranches per pool
         */
        maxTranchesPerPool: 3,
        /**
         * Minimum time between tranches (ms)
         */
        minTimeBetweenTranchesMs: 5 * 60 * 1000, // 5 minutes
    },
    // ═══════════════════════════════════════════════════════════════════════════
    // VSH (Volatility Skew Harvester) Configuration
    // ═══════════════════════════════════════════════════════════════════════════
    VSH: {
        /**
         * Maximum price velocity for eligibility (% per second)
         */
        maxPriceVelocity: 0.001, // 0.1% per second
        /**
         * Minimum swap velocity for eligibility
         */
        minSwapVelocity: 0.08,
        /**
         * Maximum migration slope for eligibility
         */
        maxMigrationSlope: 0.10,
        /**
         * Minimum fee intensity for eligibility
         */
        minFeeIntensity: 0.05,
        /**
         * Bin width multiplier for CHOP mode
         */
        binWidthMultiplierChop: 1.25,
        /**
         * Bin width multiplier for STABLE mode
         */
        binWidthMultiplierStable: 0.90,
        /**
         * Minimum churn quality for exit suppression hint
         */
        minChurnForSuppression: 2.0,
    },
};
//# sourceMappingURL=constants.js.map