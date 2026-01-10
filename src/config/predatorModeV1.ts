/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREDATOR MODE v1 — FEE BULLY / BIN PREDATOR CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Authority: Architect (final)
 * Codename: Fee Bully / Bin Predator
 * 
 * PRIME DIRECTIVE:
 * The system is NOT: a market predictor, a risk minimizer, a fair LP participant.
 * The system IS: a liquidity bully that centralizes capital, forces oscillation
 * capture, and compounds fees aggressively.
 * 
 * If a piece of logic reduces fee velocity or increases exit frequency without
 * preventing catastrophic loss, it is WRONG.
 * 
 * TARGET: Maximum aggressive compounding profit by dominating DLMM bins and
 * extracting fees faster than competitors, with zero catastrophic failure and
 * no multi-day drawdowns.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER SWITCH — PREDATOR MODE v1
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Master switch for Predator Mode v1.
 * Default: ENABLED. Set PREDATOR_MODE_V1=false to disable.
 */
export const PREDATOR_MODE_V1_ENABLED = process.env.PREDATOR_MODE_V1 !== 'false';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. POOL DISCOVERY — PREY SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * HARD FILTERS — All must be true to be eligible prey
 * These are NON-NEGOTIABLE requirements for pool selection.
 */
export const PREY_SELECTION_HARD_FILTERS = {
    /**
     * Pool age minimum (days)
     * RULE: Pool age ≥ 7 days (prefer ≥14 days)
     */
    MIN_POOL_AGE_DAYS: 7,
    PREFERRED_POOL_AGE_DAYS: 14,
    
    /**
     * Sustained volume requirements
     * RULE: 24h volume ≥ $500k (configurable)
     */
    MIN_VOLUME_24H_USD: 500_000,
    
    /**
     * Volume persistence
     * RULE: Volume persistence ≥ 5 of last 7 days
     */
    MIN_VOLUME_DAYS_OF_7: 5,
    
    /**
     * TVL within bully range
     * RULE: TVL ≤ 20× target position size
     */
    TVL_MULTIPLIER_MAX: 20,
    
    /**
     * Safety checks
     */
    NO_MIGRATION: true,
    NO_DECIMALS_ANOMALIES: true,
    NO_RUG_FLAGS: true,
    
    /**
     * Absolute minimum TVL to prevent stuck positions
     */
    MIN_TVL_USD: 50_000,
};

/**
 * SOFT PREFERENCE SCORING — Higher score = better prey
 * These BOOST priority but don't disqualify.
 */
export const PREY_SELECTION_SOFT_SCORING = {
    /**
     * Mean-reverting price behavior (oscillation)
     * Weight for pools that show consistent price oscillation
     */
    MEAN_REVERSION_WEIGHT: 0.25,
    
    /**
     * Consistent oscillation across same bins
     * Weight for pools with repeated bin crossings
     */
    BIN_OSCILLATION_WEIGHT: 0.25,
    
    /**
     * Human LP dominance (wide bin spacing, sparse depth)
     * Weight for pools where retail/manual LPs dominate
     */
    HUMAN_LP_DOMINANCE_WEIGHT: 0.25,
    
    /**
     * Repeated volume regardless of regime
     * Weight for consistent volume regardless of market conditions
     */
    VOLUME_CONSISTENCY_WEIGHT: 0.25,
    
    /**
     * EXPLICIT: Pools like PIPPIN/SOL, BRAIN/SOL, ZEC/USDC must score HIGHER
     * than generic "safe" pools
     */
    MEME_POOL_BONUS: 1.5,  // 50% score boost for meme/retail pools
};

/**
 * KNOWN HIGH-VALUE PREY — Force-surface these pools
 */
export const HIGH_VALUE_PREY_TOKENS = [
    // Meme tokens (PRIMARY TARGETS)
    'PIPPIN', 'BRAIN', 'FISH', 'BONK', 'WIF', 'POPCAT', 'BOME', 'MEW',
    'SLERF', 'HARAMBE', 'MOTHER', 'GIGA', 'RETARDIO', 'PENG', 'BILLY',
    'SIGMA', 'NEIRO', 'GOAT', 'FWOG', 'MOODENG', 'CHILLGUY', 'PNUT',
    'ACT', 'BUCK', 'AI16Z', 'VINE', 'ANIME', 'TRUMP', 'MELANIA',
    'FARTCOIN', 'ZEREBRO', 'GRIFFAIN', 'SWARM', 'ELIZA', 'SOLAMA',
    // Privacy coins with stable volume
    'ZEC', 'XMR', 'DASH',
];

// ═══════════════════════════════════════════════════════════════════════════════
// 2. BIN STRATEGY — DOMINATE, DON'T DIVERSIFY
// ═══════════════════════════════════════════════════════════════════════════════

export const BIN_DOMINANCE_CONFIG = {
    /**
     * HARD RULE: DO NOT CREATE BIN ARRAYS
     * Only use existing bins.
     */
    CREATE_BIN_ARRAYS: false,
    
    /**
     * PRIMARY MODE: Single-bin dominance (default)
     */
    SINGLE_BIN_DOMINANCE: true,
    
    /**
     * Optional 3-bin micro spread ONLY if oscillation amplitude demands it
     */
    MAX_BINS_MICRO_SPREAD: 3,
    
    /**
     * Allocate >70% of position liquidity into modal bin
     */
    MODAL_BIN_ALLOCATION_PCT: 0.70,
    
    /**
     * Remaining 30% sits in adjacent bins as shock absorbers
     */
    ADJACENT_BIN_ALLOCATION_PCT: 0.30,
    
    /**
     * Bin width logic favors TIGHTNESS, not safety
     * Lower = tighter = more aggressive
     */
    DEFAULT_BIN_COUNT: 1,
    MAX_BIN_COUNT: 3,
    
    /**
     * Bin selection priority: Modal price bin (highest recurring price density)
     */
    SELECT_MODAL_BIN: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. REBALANCING — AGGRESSION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export const REBALANCE_AGGRESSION_CONFIG = {
    /**
     * REMOVED: Rebalance throttles >5 minutes
     * REMOVED: Rebalance suppression due to "noise"
     */
    SUPPRESS_FOR_NOISE: false,
    
    /**
     * Event-driven + time-based hybrid rebalancing
     */
    EVENT_DRIVEN: true,
    TIME_BASED_FALLBACK: true,
    
    /**
     * Rebalance WHEN:
     */
    TRIGGERS: {
        /** Price exits dominant bin */
        PRICE_EXITS_BIN: true,
        /** Oscillation midpoint shifts */
        MIDPOINT_SHIFT: true,
        /** Fee velocity decay is detected */
        FEE_VELOCITY_DECAY: true,
    },
    
    /**
     * Time-based fallback cadence
     * RULE: Rebalance cadence target: 60–240 seconds equivalent
     */
    MIN_REBALANCE_INTERVAL_MS: 60 * 1000,    // 60 seconds minimum
    MAX_REBALANCE_INTERVAL_MS: 240 * 1000,   // 240 seconds maximum
    TARGET_REBALANCE_INTERVAL_MS: 120 * 1000, // 2 minutes target
    
    /**
     * YES, this increases churn. That is INTENTIONAL.
     * No cap on rebalances per hour — we are bullying bins.
     */
    MAX_REBALANCES_PER_HOUR: 999,  // Effectively unlimited
    
    /**
     * Price drift threshold (bins) to trigger rebalance
     */
    BIN_DRIFT_THRESHOLD: 1,  // Tighter than before
    
    /**
     * Fee velocity drop threshold to trigger rebalance
     */
    FEE_VELOCITY_DROP_THRESHOLD: 0.20, // 20% drop triggers rebalance
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4. EXIT LOGIC — TIERED MIN HOLD + EMERGENCY OVERRIDE (REPLACES OLD LOGIC)
// ═══════════════════════════════════════════════════════════════════════════════

const MINUTE = 60 * 1000;

/**
 * TIERED MIN HOLD — Replaces static 60min hold
 */
export const MIN_HOLD_BY_TIER = {
    A: 20 * MINUTE,  // High-value prey: 20 min
    B: 30 * MINUTE,  // Medium prey: 30 min
    C: 10 * MINUTE,  // Low/risky: 10 min
} as const;

/**
 * EMERGENCY EXIT OVERRIDE — Bypasses MIN_HOLD after 10 minutes
 * Exit IMMEDIATELY if ANY of the following are true after 10min live:
 */
export const EMERGENCY_EXIT_OVERRIDE = {
    /** Minimum time before emergency override can apply */
    MIN_TIME_FOR_OVERRIDE_MS: 10 * MINUTE,
    
    /** Fee velocity floor (exit if below 25% of expected) */
    FEE_VELOCITY_FLOOR_RATIO: 0.25,
    
    /** Stable zero activity threshold (exit if zero for 10min+) */
    STABLE_ZERO_ACTIVITY_MS: 10 * MINUTE,
    
    /** Harmonic health floor (exit if below) */
    HARD_HEALTH_FLOOR: 0.42,
};

export const EXIT_SUPPRESSION_CONFIG = {
    /**
     * CHANGED: Cost amortization is INFORMATIONAL ONLY, not a blocker.
     * It may affect re-entry cooldown, aggression scaling.
     * It may NOT block exits once emergency criteria are met.
     */
    REQUIRE_COST_AMORTIZATION: false,  // CHANGED from true
    COST_AMORTIZATION_INFORMATIONAL: true,  // NEW: telemetry only
    
    /**
     * Safety multiplier for cost amortization (informational only)
     */
    COST_AMORTIZATION_MULTIPLIER: 1.25,  // 25% margin
    
    /**
     * EXIT ALLOWED ONLY IF (any of):
     * Now includes emergency override conditions
     */
    VALID_EXIT_CONDITIONS: [
        'POOL_MIGRATION',
        'POOL_DEPRECATED',
        'VOLUME_COLLAPSE_70PCT',  // >70% volume collapse sustained
        'TVL_COLLAPSE',
        'LIQUIDITY_DISAPPEARS',
        'BINS_INACTIVE',
        'DECIMALS_CORRUPTION',
        'MINT_CORRUPTION',
        'KILL_SWITCH_MARKET_FAILURE',
        'RUG_PULL',
        'FREEZE_AUTHORITY',
        // NEW: Emergency override conditions
        'EMERGENCY_OVERRIDE_FEE_VELOCITY',
        'EMERGENCY_OVERRIDE_ZERO_ACTIVITY',
        'EMERGENCY_OVERRIDE_HEALTH_FLOOR',
        'ROTATION_REPLACEMENT',  // NEW: Aggressive rotation
        'HARMONIC_EXIT_TRIGGERED',  // CHANGED: Harmonic can now exit!
    ],
    
    /**
     * Volume collapse threshold for valid exit
     */
    VOLUME_COLLAPSE_THRESHOLD: 0.70,  // 70% drop
    VOLUME_COLLAPSE_WINDOW_HOURS: 12, // Sustained for 12 hours
    
    /**
     * EXIT FORBIDDEN IF (any of):
     * REDUCED LIST — We no longer block harmonic, fee velocity, etc.
     */
    FORBIDDEN_EXIT_CONDITIONS: [
        'EV_NEGATIVE_BOOTSTRAP',  // During bootstrap only
        'ENTROPY_DROP_TEMPORARY',
        'OSCILLATION_PAUSE_SHORT',
        'SCORE_DROP',  // Score alone cannot trigger exit
        'MHI_DROP',    // MHI alone cannot trigger exit
        'REGIME_FLIP', // Regime alone cannot trigger exit
        'TIER4_SCORE_DROP',
        // REMOVED: 'HARMONIC_EXIT', 'FEE_VELOCITY_LOW_EARLY', 'FEE_BLEED_ACTIVE', 'VELOCITY_DIP'
        // These can now trigger exits!
    ],
    
    /**
     * Cost amortization includes (informational only):
     */
    COST_COMPONENTS: {
        ENTRY_FEE_RATE: 0.003,      // 0.3% entry fees
        EXIT_FEE_RATE: 0.003,       // 0.3% exit fees
        SLIPPAGE_RATE: 0.002,       // 0.2% slippage
        REBALANCE_COST_ROLLING: true, // Include rolling rebalance costs
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4b. AGGRESSIVE ROTATION BIAS — CORE PREDATOR BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════

export const ROTATION_BIAS_CONFIG = {
    /**
     * Force rotation if a position:
     * - has <0.05% fee accrual after 30 minutes
     * - AND velocity entropy collapsed
     * - AND another pool ranks higher by +2
     */
    ENABLED: true,
    
    /** Min time before rotation considered */
    MIN_TIME_FOR_ROTATION_MS: 30 * MINUTE,
    
    /** Fee yield floor (below this = candidate for rotation) */
    FEE_YIELD_FLOOR: 0.0005,  // 0.05%
    
    /** Rank delta required for rotation */
    RANK_DELTA_THRESHOLD: 2,
    
    /** Entropy collapse threshold */
    ENTROPY_COLLAPSE_THRESHOLD: 0.3,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 5. BOOTSTRAP — PROBING, NOT EARNING
// ═══════════════════════════════════════════════════════════════════════════════

export const BOOTSTRAP_PROBE_CONFIG = {
    /**
     * Bootstrap PURPOSE:
     * - Detect oscillation persistence
     * - Detect rebalance density
     * - Detect bin dominance feasibility
     */
    PURPOSE: 'PROBE_OSCILLATION_BIN_DOMINANCE',
    
    /**
     * Bootstrap duration (configurable)
     * RULE: Default 6 hours
     */
    DURATION_MS: 6 * 60 * 60 * 1000,  // 6 hours
    
    /**
     * During bootstrap:
     */
    EV_GATE_DISABLED: true,           // EV gate DISABLED
    PAYBACK_NOT_ENFORCED: true,       // Payback NOT enforced
    AGGRESSION_CAPPED_BY_SAFETY: true, // Only hard safety rules apply
    
    /**
     * EXPLICIT: Logs WILL look bad during bootstrap. This is EXPECTED and CORRECT.
     */
    EXPECT_BAD_LOGS: true,
    
    /**
     * Bootstrap metrics to track (informational only)
     */
    TRACK_METRICS: [
        'oscillation_count',
        'bin_crossings',
        'fee_velocity',
        'rebalance_count',
        'volume_consistency',
    ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// 6. CAPITAL UTILIZATION — CONCENTRATE THEN SCALE (WITH GLOBAL RESERVE)
// ═══════════════════════════════════════════════════════════════════════════════

export const CAPITAL_CONCENTRATION_CONFIG = {
    /**
     * CRITICAL: GLOBAL RESERVE RATIO
     * At all times: deployed_equity <= total_equity * (1 - GLOBAL_RESERVE_RATIO)
     * This guarantees rotation ammo and prevents capital starvation.
     */
    GLOBAL_RESERVE_RATIO: 0.30,  // 30% always free
    
    /**
     * MAX SINGLE POOL ENTRY
     * Never allocate >20% of equity to a single pool on entry.
     */
    MAX_SINGLE_POOL_ENTRY_PCT: 0.20,  // 20% max on entry
    
    /**
     * INITIAL DEPLOYMENT
     */
    INITIAL: {
        /** Max active pools during initial phase */
        MAX_ACTIVE_POOLS: 5,
        MIN_ACTIVE_POOLS: 3,
        
        /** Initial allocation per pool (% of equity) */
        ALLOCATION_PER_POOL_MIN_PCT: 0.02,  // 2%
        ALLOCATION_PER_POOL_MAX_PCT: 0.05,  // 5%
    },
    
    /**
     * POST-GRADUATION (after bootstrap success)
     */
    POST_GRADUATION: {
        /** Ramp capital AGGRESSIVELY into survivors */
        RAMP_AGGRESSIVELY: true,
        
        /** Favor fewer pools with HIGHER dominance */
        PREFER_CONCENTRATION: true,
        
        /** Maximum per-pool allocation after graduation */
        MAX_PER_POOL_PCT: 0.30,  // 30% max in best performer
        
        /** Target pool count after graduation */
        TARGET_POOL_COUNT: 3,
    },
    
    /**
     * Idle capital policy
     * RULE: Idle capital is ACCEPTABLE only while identifying prey
     */
    IDLE_CAPITAL_ACCEPTABLE_DURING: ['PREY_SELECTION', 'BOOTSTRAP'],
    IDLE_CAPITAL_FAILURE_AFTER_BOOTSTRAP: true,
    
    /**
     * Reserve buffer for transaction fees
     */
    RESERVE_BUFFER_USD: 20,
    
    /**
     * Position size limits
     */
    MIN_POSITION_SIZE_USD: 25,
    MAX_POSITION_SIZE_USD: 10_000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 7. MARKET REGIME — OBSERVATIONAL ONLY
// ═══════════════════════════════════════════════════════════════════════════════

export const REGIME_OBSERVATIONAL_CONFIG = {
    /**
     * HARD RULE: Market regime MUST NOT:
     */
    REGIME_MUST_NOT: {
        BLOCK_ENTRIES: true,
        TRIGGER_EXITS: true,
        REDUCE_AGGRESSION: true,
    },
    
    /**
     * Regime MAY (slightly):
     */
    REGIME_MAY: {
        /** Slightly modulate rebalance cadence */
        MODULATE_REBALANCE_CADENCE: true,
        REBALANCE_CADENCE_RANGE: { min: 0.9, max: 1.1 }, // ±10%
        
        /** Slightly adjust bin tightness */
        ADJUST_BIN_TIGHTNESS: true,
        BIN_TIGHTNESS_RANGE: { min: 0.95, max: 1.05 }, // ±5%
    },
    
    /**
     * PHILOSOPHICAL RULE: Fees do not care about regime.
     * Regime logic is INFORMATIONAL, not AUTHORITATIVE.
     */
    REGIME_IS_INFORMATIONAL: true,
    REGIME_IS_AUTHORITATIVE: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 8. TELEMETRY — OPTIMIZE FOR FEE VELOCITY
// ═══════════════════════════════════════════════════════════════════════════════

export const TELEMETRY_OPTIMIZATION_CONFIG = {
    /**
     * STOP OPTIMIZING FOR:
     */
    STOP_OPTIMIZING_FOR: [
        'pretty_ev_curves',
        'short_term_pnl_cleanliness',
        'early_profitability',
    ],
    
    /**
     * START OPTIMIZING FOR:
     */
    START_OPTIMIZING_FOR: [
        'fee_velocity',           // Fee generation per unit time
        'rebalance_density',      // Rebalances per hour
        'time_in_bin_dominance',  // Time spent as bin leader
        'capital_reuse_speed',    // How fast capital cycles
    ],
    
    /**
     * Success metrics (what matters)
     */
    SUCCESS_METRICS: {
        /** Winning days matter */
        PORTFOLIO_GREEN_DAYS_TARGET: 0.90,  // 90%+ green days
        
        /** Individual trades do NOT matter */
        INDIVIDUAL_TRADE_WIN_RATE_IGNORED: true,
    },
    
    /**
     * Telemetry refresh rate (for fee velocity tracking)
     */
    TELEMETRY_REFRESH_MS: 10 * 1000,  // 10 seconds
    
    /**
     * Rolling windows for metrics
     */
    FEE_VELOCITY_WINDOW_MS: 5 * 60 * 1000,  // 5 minutes
    REBALANCE_DENSITY_WINDOW_MS: 60 * 60 * 1000,  // 1 hour
};

// ═══════════════════════════════════════════════════════════════════════════════
// 9. NON-NEGOTIABLE SAFETY — ONLY THESE
// ═══════════════════════════════════════════════════════════════════════════════

export const SAFETY_ONLY_CONFIG = {
    /**
     * Safety exists ONLY to prevent:
     */
    SAFETY_PREVENTS: {
        CATASTROPHIC_LIQUIDATION: true,
        CAPITAL_LOCK: true,
        MULTI_DAY_DRAWDOWN_CASCADES: true,
    },
    
    /**
     * Anything else is ACCEPTABLE COLLATERAL DAMAGE.
     */
    ACCEPTABLE_COLLATERAL_DAMAGE: [
        'temporary_losses',
        'short_term_negative_ev',
        'ugly_log_output',
        'high_rebalance_count',
        'low_individual_trade_win_rate',
    ],
    
    /**
     * Kill switch triggers (TRUE emergencies only)
     */
    KILL_SWITCH_TRIGGERS: [
        'RPC_TOTAL_FAILURE',
        'DATABASE_CORRUPTION',
        'WALLET_COMPROMISE',
        'PROTOCOL_HALT',
        'MULTIPLE_POOL_RUG_DETECTION',
    ],
    
    /**
     * Maximum drawdown before forced cooldown
     */
    MAX_PORTFOLIO_DRAWDOWN_PCT: 0.25,  // 25% max drawdown
    DRAWDOWN_COOLDOWN_HOURS: 4,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 10. LOG THROTTLING (SANITY + PERFORMANCE)
// ═══════════════════════════════════════════════════════════════════════════════

export const LOG_THROTTLE_CONFIG = {
    /**
     * Same trade + same reason → log once every 5 minutes
     * Log only on state change, not repeated checks.
     */
    ENABLED: true,
    
    /** Time before same message can be logged again (per trade) */
    THROTTLE_INTERVAL_MS: 5 * 60 * 1000,  // 5 minutes
    
    /** Messages to throttle */
    THROTTLE_PATTERNS: [
        'EXIT_TRIGGERED',
        'EXIT_SUPPRESS',
        'MTM_LOG',
        'COST_SUPPRESSED',
        'NOISE_SUPPRESSED',
        'BOOTSTRAP_SUPPRESSED',
    ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// 11. SUCCESS CRITERIA (LOG-BASED)
// ═══════════════════════════════════════════════════════════════════════════════

export const SUCCESS_CRITERIA = {
    /**
     * Predator Mode is WORKING if logs show:
     */
    WORKING_INDICATORS: [
        'positions_held_hours_to_days',       // Not minutes
        'frequent_rebalances',                // Many per hour
        'fees_growing_faster_than_costs',     // Net positive
        'fewer_exits_more_compounding',       // Hold through noise
        'capital_utilization_rising_post_bootstrap', // Deploying more
        'portfolio_90pct_green_days',         // Winning overall
    ],
    
    /**
     * Predator Mode is BROKEN if logs show:
     */
    BROKEN_INDICATORS: [
        'positions_exiting_within_minutes',
        'low_rebalance_count',
        'fees_not_covering_costs',
        'frequent_exits_for_noise',
        'idle_capital_after_bootstrap',
        'portfolio_majority_red_days',
    ],
    
    /**
     * Log assertion messages
     */
    ASSERTIONS: {
        ON_ENTRY: 'PREDATOR_PREY_LOCKED',
        ON_REBALANCE: 'PREDATOR_BIN_RECENTER',
        ON_FEE_COMPOUND: 'PREDATOR_FEE_EXTRACTED',
        ON_EXIT: 'PREDATOR_POSITION_RELEASED',
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a token is in the high-value prey list
 */
export function isHighValuePrey(tokenSymbol: string): boolean {
    if (!PREDATOR_MODE_V1_ENABLED) return false;
    const upper = tokenSymbol.toUpperCase();
    return HIGH_VALUE_PREY_TOKENS.some(prey => 
        upper.includes(prey) || prey.includes(upper)
    );
}

/**
 * Check if exit reason is valid under Predator Mode v1
 */
export function isValidPredatorExit(exitReason: string): boolean {
    if (!PREDATOR_MODE_V1_ENABLED) return true;
    
    const normalized = exitReason.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    
    // Check if it's a forbidden exit
    for (const forbidden of EXIT_SUPPRESSION_CONFIG.FORBIDDEN_EXIT_CONDITIONS) {
        if (normalized.includes(forbidden) || forbidden.includes(normalized)) {
            return false;
        }
    }
    
    // Check if it's a valid exit
    for (const valid of EXIT_SUPPRESSION_CONFIG.VALID_EXIT_CONDITIONS) {
        if (normalized.includes(valid) || valid.includes(normalized)) {
            return true;
        }
    }
    
    // Default: block unknown exits during predator mode
    return false;
}

/**
 * Calculate cost amortization requirement
 */
export function calculateCostAmortizationRequired(
    entrySizeUsd: number,
    rebalanceCount: number = 0
): number {
    const { ENTRY_FEE_RATE, EXIT_FEE_RATE, SLIPPAGE_RATE } = EXIT_SUPPRESSION_CONFIG.COST_COMPONENTS;
    
    const entryCost = entrySizeUsd * ENTRY_FEE_RATE;
    const exitCost = entrySizeUsd * EXIT_FEE_RATE;
    const slippage = entrySizeUsd * SLIPPAGE_RATE;
    
    // Each rebalance has ~50% of entry/exit cost
    const rebalanceCost = rebalanceCount * entrySizeUsd * ((ENTRY_FEE_RATE + EXIT_FEE_RATE) * 0.5);
    
    const totalCost = entryCost + exitCost + slippage + rebalanceCost;
    
    return totalCost * EXIT_SUPPRESSION_CONFIG.COST_AMORTIZATION_MULTIPLIER;
}

/**
 * Check if fees have amortized costs
 */
export function hasCostAmortized(
    feesAccrued: number,
    entrySizeUsd: number,
    rebalanceCount: number = 0
): boolean {
    if (!PREDATOR_MODE_V1_ENABLED) return true;
    
    const required = calculateCostAmortizationRequired(entrySizeUsd, rebalanceCount);
    return feesAccrued >= required;
}

/**
 * Check if pool meets hard filter criteria
 */
export function meetsHardFilters(pool: {
    ageInDays?: number;
    volume24hUsd?: number;
    tvlUsd?: number;
    volumeDaysOf7?: number;
    positionSizeUsd?: number;
}): { passes: boolean; failedReasons: string[] } {
    if (!PREDATOR_MODE_V1_ENABLED) return { passes: true, failedReasons: [] };
    
    const failedReasons: string[] = [];
    const filters = PREY_SELECTION_HARD_FILTERS;
    
    if ((pool.ageInDays || 0) < filters.MIN_POOL_AGE_DAYS) {
        failedReasons.push(`AGE: ${pool.ageInDays || 0}d < ${filters.MIN_POOL_AGE_DAYS}d`);
    }
    
    if ((pool.volume24hUsd || 0) < filters.MIN_VOLUME_24H_USD) {
        failedReasons.push(`VOLUME: $${((pool.volume24hUsd || 0) / 1000).toFixed(0)}k < $${(filters.MIN_VOLUME_24H_USD / 1000).toFixed(0)}k`);
    }
    
    if ((pool.tvlUsd || 0) < filters.MIN_TVL_USD) {
        failedReasons.push(`TVL: $${((pool.tvlUsd || 0) / 1000).toFixed(0)}k < $${(filters.MIN_TVL_USD / 1000).toFixed(0)}k`);
    }
    
    if (pool.positionSizeUsd && pool.tvlUsd) {
        const maxTvl = pool.positionSizeUsd * filters.TVL_MULTIPLIER_MAX;
        if (pool.tvlUsd > maxTvl) {
            failedReasons.push(`TVL_RATIO: $${(pool.tvlUsd / 1000).toFixed(0)}k > ${filters.TVL_MULTIPLIER_MAX}× position`);
        }
    }
    
    if ((pool.volumeDaysOf7 || 0) < filters.MIN_VOLUME_DAYS_OF_7) {
        failedReasons.push(`PERSISTENCE: ${pool.volumeDaysOf7 || 0}/7 days < ${filters.MIN_VOLUME_DAYS_OF_7}/7 days`);
    }
    
    return {
        passes: failedReasons.length === 0,
        failedReasons,
    };
}

/**
 * Calculate prey score with soft preferences
 */
export function calculatePreyScore(pool: {
    meanReversionScore?: number;
    binOscillationScore?: number;
    humanLpDominanceScore?: number;
    volumeConsistencyScore?: number;
    tokenSymbol?: string;
}): number {
    if (!PREDATOR_MODE_V1_ENABLED) return 50;  // Neutral score
    
    const weights = PREY_SELECTION_SOFT_SCORING;
    
    let score = 0;
    score += (pool.meanReversionScore || 0) * weights.MEAN_REVERSION_WEIGHT;
    score += (pool.binOscillationScore || 0) * weights.BIN_OSCILLATION_WEIGHT;
    score += (pool.humanLpDominanceScore || 0) * weights.HUMAN_LP_DOMINANCE_WEIGHT;
    score += (pool.volumeConsistencyScore || 0) * weights.VOLUME_CONSISTENCY_WEIGHT;
    
    // Apply meme pool bonus
    if (pool.tokenSymbol && isHighValuePrey(pool.tokenSymbol)) {
        score *= weights.MEME_POOL_BONUS;
    }
    
    return Math.min(100, Math.max(0, score));
}

/**
 * Get bin configuration for predator mode
 */
export function getPredatorBinConfig(): { binCount: number; modalBinAllocation: number } {
    if (!PREDATOR_MODE_V1_ENABLED) {
        return { binCount: 10, modalBinAllocation: 0.5 };  // Default
    }
    
    return {
        binCount: BIN_DOMINANCE_CONFIG.DEFAULT_BIN_COUNT,
        modalBinAllocation: BIN_DOMINANCE_CONFIG.MODAL_BIN_ALLOCATION_PCT,
    };
}

/**
 * Check if rebalance should occur
 */
export function shouldRebalance(
    lastRebalanceMs: number,
    priceExitedBin: boolean,
    midpointShifted: boolean,
    feeVelocityDecayed: boolean
): { shouldRebalance: boolean; trigger: string } {
    if (!PREDATOR_MODE_V1_ENABLED) {
        return { shouldRebalance: false, trigger: 'PREDATOR_DISABLED' };
    }
    
    const now = Date.now();
    const elapsed = now - lastRebalanceMs;
    const config = REBALANCE_AGGRESSION_CONFIG;
    
    // Check minimum interval
    if (elapsed < config.MIN_REBALANCE_INTERVAL_MS) {
        return { shouldRebalance: false, trigger: 'MIN_INTERVAL_NOT_MET' };
    }
    
    // Event-driven triggers
    if (config.TRIGGERS.PRICE_EXITS_BIN && priceExitedBin) {
        return { shouldRebalance: true, trigger: 'PRICE_EXIT_BIN' };
    }
    
    if (config.TRIGGERS.MIDPOINT_SHIFT && midpointShifted) {
        return { shouldRebalance: true, trigger: 'MIDPOINT_SHIFT' };
    }
    
    if (config.TRIGGERS.FEE_VELOCITY_DECAY && feeVelocityDecayed) {
        return { shouldRebalance: true, trigger: 'FEE_VELOCITY_DECAY' };
    }
    
    // Time-based fallback
    if (config.TIME_BASED_FALLBACK && elapsed >= config.MAX_REBALANCE_INTERVAL_MS) {
        return { shouldRebalance: true, trigger: 'TIME_FALLBACK' };
    }
    
    return { shouldRebalance: false, trigger: 'NO_TRIGGER' };
}

/**
 * Check if in bootstrap mode
 */
export function isInBootstrapMode(entryTime: number): boolean {
    if (!PREDATOR_MODE_V1_ENABLED) return false;
    
    const elapsed = Date.now() - entryTime;
    return elapsed < BOOTSTRAP_PROBE_CONFIG.DURATION_MS;
}

/**
 * Get regime multipliers (observational only)
 */
export function getRegimeMultipliers(regime: string): {
    rebalanceCadenceMultiplier: number;
    binTightnessMultiplier: number;
} {
    if (!PREDATOR_MODE_V1_ENABLED || !REGIME_OBSERVATIONAL_CONFIG.REGIME_IS_INFORMATIONAL) {
        return { rebalanceCadenceMultiplier: 1.0, binTightnessMultiplier: 1.0 };
    }
    
    const rebalanceRange = REGIME_OBSERVATIONAL_CONFIG.REGIME_MAY.REBALANCE_CADENCE_RANGE;
    const binRange = REGIME_OBSERVATIONAL_CONFIG.REGIME_MAY.BIN_TIGHTNESS_RANGE;
    
    switch (regime.toUpperCase()) {
        case 'BULL':
            return {
                rebalanceCadenceMultiplier: rebalanceRange.min,  // Faster
                binTightnessMultiplier: binRange.min,  // Tighter
            };
        case 'BEAR':
            return {
                rebalanceCadenceMultiplier: rebalanceRange.max,  // Slower
                binTightnessMultiplier: binRange.max,  // Wider
            };
        default:
            return {
                rebalanceCadenceMultiplier: 1.0,
                binTightnessMultiplier: 1.0,
            };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING — PREDATOR MODE BANNER
// ═══════════════════════════════════════════════════════════════════════════════

export function logPredatorModeV1Banner(): void {
    if (!PREDATOR_MODE_V1_ENABLED) {
        logger.info('[PREDATOR-V1] DISABLED — Running in standard mode');
        return;
    }
    
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                              ║');
    console.log('║   ██████╗ ██████╗ ███████╗██████╗  █████╗ ████████╗ ██████╗ ██████╗          ║');
    console.log('║   ██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗         ║');
    console.log('║   ██████╔╝██████╔╝█████╗  ██║  ██║███████║   ██║   ██║   ██║██████╔╝         ║');
    console.log('║   ██╔═══╝ ██╔══██╗██╔══╝  ██║  ██║██╔══██║   ██║   ██║   ██║██╔══██╗         ║');
    console.log('║   ██║     ██║  ██║███████╗██████╔╝██║  ██║   ██║   ╚██████╔╝██║  ██║         ║');
    console.log('║   ╚═╝     ╚═╝  ╚═╝╚══════╝╚═════╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝         ║');
    console.log('║                                                                              ║');
    console.log('║              🦅 PREDATOR MODE v1 — FEE BULLY / BIN PREDATOR 🦅               ║');
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log('║   PRIME DIRECTIVE:                                                          ║');
    console.log('║   "You are not optimizing a DeFi bot. You are weaponizing liquidity.        ║');
    console.log('║    If a decision increases fee extraction speed without risking total       ║');
    console.log('║    failure, it is correct."                                                 ║');
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log('║   🎯 PREY SELECTION:                                                         ║');
    console.log(`║      • Pool age ≥ ${PREY_SELECTION_HARD_FILTERS.MIN_POOL_AGE_DAYS}d, volume ≥ $${(PREY_SELECTION_HARD_FILTERS.MIN_VOLUME_24H_USD / 1000).toFixed(0)}k/24h                                     ║`);
    console.log(`║      • TVL ≤ ${PREY_SELECTION_HARD_FILTERS.TVL_MULTIPLIER_MAX}× position, persistence ≥ ${PREY_SELECTION_HARD_FILTERS.MIN_VOLUME_DAYS_OF_7}/7 days                               ║`);
    console.log('║      • Meme pools (PIPPIN, BRAIN, etc.) get 50% score bonus                 ║');
    console.log('║                                                                              ║');
    console.log('║   📐 BIN STRATEGY:                                                           ║');
    console.log(`║      • Single-bin dominance (${BIN_DOMINANCE_CONFIG.DEFAULT_BIN_COUNT}-${BIN_DOMINANCE_CONFIG.MAX_BINS_MICRO_SPREAD} bins max)                                         ║`);
    console.log(`║      • ${(BIN_DOMINANCE_CONFIG.MODAL_BIN_ALLOCATION_PCT * 100).toFixed(0)}% allocation to modal bin                                          ║`);
    console.log('║      • DO NOT create bin arrays — use existing bins only                    ║');
    console.log('║                                                                              ║');
    console.log('║   ⚡ REBALANCING:                                                            ║');
    console.log(`║      • Cadence: ${REBALANCE_AGGRESSION_CONFIG.MIN_REBALANCE_INTERVAL_MS / 1000}-${REBALANCE_AGGRESSION_CONFIG.MAX_REBALANCE_INTERVAL_MS / 1000} seconds                                              ║`);
    console.log('║      • Event-driven + time-based fallback                                   ║');
    console.log('║      • NO throttling, NO noise suppression                                  ║');
    console.log('║                                                                              ║');
    console.log('║   🔒 EXIT LOGIC:                                                             ║');
    console.log('║      • Cost amortization REQUIRED before any exit                           ║');
    console.log('║      • Score/MHI/regime exits DISABLED                                      ║');
    console.log('║      • Only TRUE emergencies bypass gates                                   ║');
    console.log('║                                                                              ║');
    console.log('║   ⏱️  BOOTSTRAP:                                                             ║');
    console.log(`║      • Duration: ${BOOTSTRAP_PROBE_CONFIG.DURATION_MS / (60 * 60 * 1000)}h probe mode                                                 ║`);
    console.log('║      • EV gate DISABLED, payback NOT enforced                               ║');
    console.log('║      • Expect ugly logs — this is CORRECT                                   ║');
    console.log('║                                                                              ║');
    console.log('║   💰 CAPITAL:                                                                ║');
    console.log(`║      • Initial: ${CAPITAL_CONCENTRATION_CONFIG.INITIAL.MIN_ACTIVE_POOLS}-${CAPITAL_CONCENTRATION_CONFIG.INITIAL.MAX_ACTIVE_POOLS} pools @ ${(CAPITAL_CONCENTRATION_CONFIG.INITIAL.ALLOCATION_PER_POOL_MIN_PCT * 100).toFixed(0)}-${(CAPITAL_CONCENTRATION_CONFIG.INITIAL.ALLOCATION_PER_POOL_MAX_PCT * 100).toFixed(0)}% each                                      ║`);
    console.log(`║      • Post-graduation: ${CAPITAL_CONCENTRATION_CONFIG.POST_GRADUATION.TARGET_POOL_COUNT} pools @ up to ${(CAPITAL_CONCENTRATION_CONFIG.POST_GRADUATION.MAX_PER_POOL_PCT * 100).toFixed(0)}%                                ║`);
    console.log('║                                                                              ║');
    console.log('║   📊 REGIME: OBSERVATIONAL ONLY                                             ║');
    console.log('║      • CANNOT block entries, trigger exits, reduce aggression              ║');
    console.log('║      • MAY slightly adjust rebalance cadence ±10%                           ║');
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log('║   ❌ DISABLED: EV gate, payback blocking, regime exits, score exits         ║');
    console.log('║   ❌ DISABLED: Harmonic exits, entropy exits, velocity exits                ║');
    console.log('║   ✅ ENABLED:  Aggressive rebalancing, bin dominance, instant compounding   ║');
    console.log('║   ✅ ENABLED:  Meme pool prioritization, cost amortization gates            ║');
    console.log('║                                                                              ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log('');
    
    logger.info(
        `[PREDATOR-V1] 🦅 ACTIVE | ` +
        `pools=${CAPITAL_CONCENTRATION_CONFIG.INITIAL.MIN_ACTIVE_POOLS}-${CAPITAL_CONCENTRATION_CONFIG.INITIAL.MAX_ACTIVE_POOLS} | ` +
        `bins=${BIN_DOMINANCE_CONFIG.DEFAULT_BIN_COUNT}-${BIN_DOMINANCE_CONFIG.MAX_BINS_MICRO_SPREAD} | ` +
        `rebalance=${REBALANCE_AGGRESSION_CONFIG.MIN_REBALANCE_INTERVAL_MS / 1000}-${REBALANCE_AGGRESSION_CONFIG.MAX_REBALANCE_INTERVAL_MS / 1000}s | ` +
        `bootstrap=${BOOTSTRAP_PROBE_CONFIG.DURATION_MS / (60 * 60 * 1000)}h`
    );
    
    logger.info(`[PREDATOR-V1] REGIME_IMPACT=OBSERVATIONAL_ONLY — Cannot block or exit`);
    logger.info(`[PREDATOR-V1] EV_GATE=DISABLED — EV is telemetry only`);
    logger.info(`[PREDATOR-V1] EXIT_GATE=COST_AMORTIZATION — Score/MHI/regime exits blocked`);
    logger.info(`[PREDATOR-V1] TARGET: 90%+ green days via fee velocity domination`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL GATE HELPER — Checks reserve ratio
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if entry is allowed based on global reserve ratio
 * At all times: deployed_equity <= total_equity * (1 - GLOBAL_RESERVE_RATIO)
 */
export function isEntryAllowedByReserve(
    totalEquityUsd: number,
    deployedEquityUsd: number,
    newEntrySizeUsd: number
): { allowed: boolean; reason: string; availableUsd: number } {
    const maxDeployed = totalEquityUsd * (1 - CAPITAL_CONCENTRATION_CONFIG.GLOBAL_RESERVE_RATIO);
    const afterDeployment = deployedEquityUsd + newEntrySizeUsd;
    const availableUsd = Math.max(0, maxDeployed - deployedEquityUsd);
    
    if (afterDeployment > maxDeployed) {
        return {
            allowed: false,
            reason: `CAPITAL_GATE: Would exceed ${((1 - CAPITAL_CONCENTRATION_CONFIG.GLOBAL_RESERVE_RATIO) * 100).toFixed(0)}% max deployment (${(afterDeployment / totalEquityUsd * 100).toFixed(1)}%)`,
            availableUsd,
        };
    }
    
    return {
        allowed: true,
        reason: 'RESERVE_OK',
        availableUsd,
    };
}

/**
 * Calculate max entry size respecting both reserve and per-pool limits
 */
export function calculateMaxEntrySizeUsd(
    totalEquityUsd: number,
    deployedEquityUsd: number
): number {
    const maxByReserve = totalEquityUsd * (1 - CAPITAL_CONCENTRATION_CONFIG.GLOBAL_RESERVE_RATIO) - deployedEquityUsd;
    const maxByPoolLimit = totalEquityUsd * CAPITAL_CONCENTRATION_CONFIG.MAX_SINGLE_POOL_ENTRY_PCT;
    
    return Math.max(0, Math.min(maxByReserve, maxByPoolLimit, CAPITAL_CONCENTRATION_CONFIG.MAX_POSITION_SIZE_USD));
}

/**
 * Get tiered min hold time for a pool tier
 */
export function getMinHoldTime(tier: 'A' | 'B' | 'C'): number {
    return MIN_HOLD_BY_TIER[tier] || MIN_HOLD_BY_TIER.B;
}

/**
 * Check if emergency exit override applies
 */
export function checkEmergencyExitOverride(input: {
    holdTimeMs: number;
    feeVelocity: number;
    expectedFeeVelocity: number;
    zeroActivityDurationMs: number;
    harmonicHealthScore: number;
}): { shouldOverride: boolean; reason: string } {
    // Must have held for at least MIN_TIME_FOR_OVERRIDE_MS
    if (input.holdTimeMs < EMERGENCY_EXIT_OVERRIDE.MIN_TIME_FOR_OVERRIDE_MS) {
        return { shouldOverride: false, reason: 'TOO_EARLY' };
    }
    
    // Check fee velocity floor
    const feeVelocityFloor = input.expectedFeeVelocity * EMERGENCY_EXIT_OVERRIDE.FEE_VELOCITY_FLOOR_RATIO;
    if (input.feeVelocity < feeVelocityFloor) {
        return {
            shouldOverride: true,
            reason: `EMERGENCY_OVERRIDE_FEE_VELOCITY: ${input.feeVelocity.toFixed(4)} < floor ${feeVelocityFloor.toFixed(4)}`,
        };
    }
    
    // Check zero activity duration
    if (input.zeroActivityDurationMs >= EMERGENCY_EXIT_OVERRIDE.STABLE_ZERO_ACTIVITY_MS) {
        return {
            shouldOverride: true,
            reason: `EMERGENCY_OVERRIDE_ZERO_ACTIVITY: ${(input.zeroActivityDurationMs / 60000).toFixed(0)}min of zero activity`,
        };
    }
    
    // Check harmonic health floor
    if (input.harmonicHealthScore < EMERGENCY_EXIT_OVERRIDE.HARD_HEALTH_FLOOR) {
        return {
            shouldOverride: true,
            reason: `EMERGENCY_OVERRIDE_HEALTH_FLOOR: ${input.harmonicHealthScore.toFixed(2)} < floor ${EMERGENCY_EXIT_OVERRIDE.HARD_HEALTH_FLOOR}`,
        };
    }
    
    return { shouldOverride: false, reason: 'NO_OVERRIDE' };
}

/**
 * Check if rotation should be forced
 */
export function shouldForceRotation(input: {
    holdTimeMs: number;
    feeYield: number;
    entropyCollapsed: boolean;
    rankDelta: number;
}): { shouldRotate: boolean; reason: string } {
    if (!ROTATION_BIAS_CONFIG.ENABLED) {
        return { shouldRotate: false, reason: 'ROTATION_DISABLED' };
    }
    
    if (input.holdTimeMs < ROTATION_BIAS_CONFIG.MIN_TIME_FOR_ROTATION_MS) {
        return { shouldRotate: false, reason: 'TOO_EARLY_FOR_ROTATION' };
    }
    
    if (input.feeYield >= ROTATION_BIAS_CONFIG.FEE_YIELD_FLOOR) {
        return { shouldRotate: false, reason: 'FEE_YIELD_OK' };
    }
    
    if (!input.entropyCollapsed) {
        return { shouldRotate: false, reason: 'ENTROPY_OK' };
    }
    
    if (input.rankDelta < ROTATION_BIAS_CONFIG.RANK_DELTA_THRESHOLD) {
        return { shouldRotate: false, reason: 'NO_BETTER_POOL' };
    }
    
    return {
        shouldRotate: true,
        reason: `ROTATION_REPLACEMENT: feeYield=${(input.feeYield * 100).toFixed(3)}% < ${(ROTATION_BIAS_CONFIG.FEE_YIELD_FLOOR * 100).toFixed(3)}%, rankDelta=+${input.rankDelta}`,
    };
}

export default {
    PREDATOR_MODE_V1_ENABLED,
    PREY_SELECTION_HARD_FILTERS,
    PREY_SELECTION_SOFT_SCORING,
    HIGH_VALUE_PREY_TOKENS,
    BIN_DOMINANCE_CONFIG,
    REBALANCE_AGGRESSION_CONFIG,
    EXIT_SUPPRESSION_CONFIG,
    BOOTSTRAP_PROBE_CONFIG,
    CAPITAL_CONCENTRATION_CONFIG,
    REGIME_OBSERVATIONAL_CONFIG,
    TELEMETRY_OPTIMIZATION_CONFIG,
    SAFETY_ONLY_CONFIG,
    SUCCESS_CRITERIA,
    // NEW CONFIGS
    MIN_HOLD_BY_TIER,
    EMERGENCY_EXIT_OVERRIDE,
    ROTATION_BIAS_CONFIG,
    LOG_THROTTLE_CONFIG,
    // Functions
    isHighValuePrey,
    isValidPredatorExit,
    calculateCostAmortizationRequired,
    hasCostAmortized,
    meetsHardFilters,
    calculatePreyScore,
    getPredatorBinConfig,
    shouldRebalance,
    isInBootstrapMode,
    getRegimeMultipliers,
    logPredatorModeV1Banner,
    // NEW FUNCTIONS
    isEntryAllowedByReserve,
    calculateMaxEntrySizeUsd,
    getMinHoldTime,
    checkEmergencyExitOverride,
    shouldForceRotation,
};

