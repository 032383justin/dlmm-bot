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
    readonly EXPLORATION_MODE: "EXPLORATION_MODE";
};
/**
 * Check if verbose scoring diagnostics mode is enabled.
 * Set VERBOSE_SCORING=true in .env to enable detailed scoring logs.
 * Disable in production to reduce log noise.
 */
export declare const isVerboseScoringEnabled: () => boolean;
/**
 * Check if exploration mode is enabled.
 * Set EXPLORATION_MODE=true in .env to allow micro-size entries for data collection.
 */
export declare const isExplorationModeEnabled: () => boolean;
/**
 * Maximum capital deployed under exploration mode entries (as fraction)
 * e.g., 0.01 = 1% of total capital
 */
export declare const EXPLORATION_MAX_DEPLOYED_PCT = 0.01;
/**
 * MHI Soft Floor - entries allowed but size reduced below this
 */
export declare const MHI_SOFT_FLOOR = 0.35;
/**
 * MHI Hard Floor - true NO_TRADE below this (microstructure too unhealthy)
 */
export declare const MHI_HARD_FLOOR = 0.2;
/**
 * Feature flags for Tier 5 modules
 */
export declare const TIER5_FEATURE_FLAGS: {
    /**
     * Master switch for all Tier 5 behavior
     * Can be disabled via CONTROLLED_AGGRESSION=false env var
     */
    ENABLE_CONTROLLED_AGGRESSION: boolean;
    /**
     * Enable Volatility Skew Harvester
     */
    ENABLE_VSH: boolean;
    /**
     * Enable Capital Concentration Engine
     */
    ENABLE_CCE: boolean;
    /**
     * Enable Opportunity Density Detector
     */
    ENABLE_ODD: boolean;
};
/**
 * Tier 5 Controlled Aggression Configuration
 */
export declare const TIER5_CONFIG: {
    ODD: {
        /**
         * Minimum snapshots for z-score calculation
         * Justification: Need statistical significance
         */
        minSnapshotsForZScore: number;
        /**
         * Maximum snapshots in rolling window
         * Justification: 120 @ 2min = 4 hours of history
         */
        maxSnapshotsInWindow: number;
        /**
         * ODS spike threshold (sigma)
         * Justification: 2.2 sigma is ~1.4% occurrence rate
         */
        spikeThreshold: number;
        /**
         * Rare convergence threshold (sigma)
         * Justification: 2.8 sigma is ~0.3% occurrence rate
         */
        rareConvergenceThreshold: number;
        /**
         * Default TTL for ODS spike (ms)
         */
        defaultTTLMs: number;
        /**
         * Minimum TTL after decay (ms)
         */
        minTTLMs: number;
        /**
         * ODS drop threshold for early decay
         */
        decayDropThreshold: number;
    };
    AEL: {
        /**
         * Minimum cycles in same regime for stability
         */
        minCyclesForStability: number;
        /**
         * Minimum time in regime for stability (ms)
         */
        minTimeForStabilityMs: number;
        /**
         * Cycles to block escalation after instability
         */
        escalationBlockCycles: number;
        /**
         * TTL for A2 level (ms)
         */
        ttlA2Ms: number;
        /**
         * TTL for A3 level (ms)
         */
        ttlA3Ms: number;
        /**
         * TTL for A4 level (ms)
         */
        ttlA4Ms: number;
        /**
         * Size multipliers per level
         */
        sizeMultipliers: {
            A0: number;
            A1: number;
            A2: number;
            A3: number;
            A4: number;
        };
        /**
         * Bin width multipliers per level (lower = narrower)
         */
        binWidthMultipliers: {
            A0: number;
            A1: number;
            A2: number;
            A3: number;
            A4: number;
        };
        /**
         * Exit sensitivity multipliers per level (higher = less sensitive)
         */
        exitSensitivityMultipliers: {
            A0: number;
            A1: number;
            A2: number;
            A3: number;
            A4: number;
        };
    };
    CCE: {
        /**
         * Maximum total portfolio deployed (% of equity)
         */
        maxTotalDeployedPct: number;
        /**
         * Maximum per-pool hard cap (% of equity)
         */
        maxPerPoolHardCapPct: number;
        /**
         * Base per-pool cap before concentration
         */
        basePerPoolCapPct: number;
        /**
         * Concentration multipliers per level
         */
        concentrationMultipliers: {
            A0: number;
            A1: number;
            A2: number;
            A3: number;
            A4: number;
        };
        /**
         * Maximum tranches per pool
         */
        maxTranchesPerPool: number;
        /**
         * Minimum time between tranches (ms)
         */
        minTimeBetweenTranchesMs: number;
    };
    VSH: {
        /**
         * Maximum price velocity for eligibility (% per second)
         */
        maxPriceVelocity: number;
        /**
         * Minimum swap velocity for eligibility
         */
        minSwapVelocity: number;
        /**
         * Maximum migration slope for eligibility
         */
        maxMigrationSlope: number;
        /**
         * Minimum fee intensity for eligibility
         */
        minFeeIntensity: number;
        /**
         * Bin width multiplier for CHOP mode
         */
        binWidthMultiplierChop: number;
        /**
         * Bin width multiplier for STABLE mode
         */
        binWidthMultiplierStable: number;
        /**
         * Minimum churn quality for exit suppression hint
         */
        minChurnForSuppression: number;
    };
};
//# sourceMappingURL=constants.d.ts.map