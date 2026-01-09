/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEE PREDATOR MODE — AGGRESSIVE FEE EXTRACTION CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This system exists to:
 *   - Bully retail-driven pools
 *   - Dominate bins
 *   - Rebalance aggressively
 *   - Compound daily
 * 
 * Model cleanliness, regime purity, and short-term EV are SECONDARY.
 * 
 * TARGET: Beat 2-3% DAILY compounding via aggressive DLMM fee extraction.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL FEATURE FLAG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fee Predator Mode master switch.
 * Enabled by default. Set FEE_PREDATOR_MODE=false to disable.
 */
export const FEE_PREDATOR_MODE_ENABLED = process.env.FEE_PREDATOR_MODE !== 'false';

// ═══════════════════════════════════════════════════════════════════════════════
// POOL TAXONOMY — HARD CLASSIFICATION AT DISCOVERY TIME
// ═══════════════════════════════════════════════════════════════════════════════

export type PoolClass = 'CLASS_A_FEE_FOUNTAIN' | 'CLASS_B_STABILITY' | 'CLASS_UNKNOWN';

/**
 * CLASS_A_FEE_FOUNTAIN (PRIMARY) — Meme/retail pools to be bullied
 * 
 * These pools are characterized by:
 *   - Meme / retail tokens
 *   - Persistent volume without directional trend
 *   - Repeated bin crossings
 *   - High swap count vs price drift
 *   - High entropy / oscillation
 *   - Emotional liquidity (small to mid swaps)
 * 
 * Examples: PIPPIN/SOL, BRAIN/SOL, FISH/SOL
 */
export const CLASS_A_CRITERIA = {
    /** Minimum signals required to classify as Class A (3 or more) */
    MIN_SIGNALS: 3,
    
    /** Known meme/retail token patterns */
    MEME_TOKEN_PATTERNS: [
        'PIPPIN', 'BRAIN', 'FISH', 'BONK', 'WIF', 'POPCAT', 'BOME', 'MEW',
        'SLERF', 'HARAMBE', 'MOTHER', 'GIGA', 'RETARDIO', 'PENG', 'BILLY',
        'SIGMA', 'NEIRO', 'GOAT', 'FWOG', 'MOODENG', 'CHILLGUY', 'PNUT',
        'ACT', 'BUCK', 'AI16Z', 'VINE', 'ANIME', 'TRUMP', 'MELANIA',
        'FARTCOIN', 'ZEREBRO', 'GRIFFAIN', 'SWARM', 'ELIZA', 'SOLAMA'
    ],
    
    /** Volume persistence thresholds */
    MIN_VOLUME_24H_USD: 100_000,
    
    /** High entropy threshold (indicates oscillation) */
    HIGH_ENTROPY_THRESHOLD: 0.55,
    
    /** High bin velocity threshold (repeated crossings) */
    HIGH_BIN_VELOCITY_THRESHOLD: 0.03,
    
    /** High swap frequency (swaps per minute) */
    HIGH_SWAP_FREQUENCY: 0.5,
    
    /** High swap count vs price drift ratio */
    HIGH_SWAP_TO_DRIFT_RATIO: 5.0,
    
    /** Retail swap ratio (small swaps / total swaps) */
    HIGH_RETAIL_SWAP_RATIO: 0.60,
    
    /** Maximum TVL to be considered retail-driven */
    MAX_TVL_FOR_MEME: 2_000_000,
    
    /** Maximum median trade size for retail */
    MAX_MEDIAN_TRADE_SIZE: 500,
};

/**
 * CLASS_B_STABILITY — Major pairs for parking/smoothing
 * 
 * Used only for:
 *   - Capital parking
 *   - Smoothing
 *   - Secondary yield
 */
export const CLASS_B_CRITERIA = {
    /** Known stable/major token pairs */
    STABLE_TOKENS: ['USDC', 'USDT', 'DAI', 'PYUSD', 'EURC'],
    MAJOR_TOKENS: ['SOL', 'ETH', 'BTC', 'WBTC', 'JLP', 'JITOSOL', 'MSOL', 'BSOL'],
    
    /** Minimum TVL for stability classification */
    MIN_TVL_FOR_STABLE: 500_000,
    
    /** Maximum fee tier for stability pools */
    MAX_FEE_TIER_FOR_STABLE: 0.005,  // 0.5%
};

// ═══════════════════════════════════════════════════════════════════════════════
// HUMAN EXPLOITATION SCORE (HES) — RETAIL BEHAVIOR DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * HES = Human Exploitation Score
 * 
 * Higher HES = More retail-driven = Better fee extraction target
 * 
 * Formula:
 *   HES = swapCount / priceDrift
 *       + repeatedBinCrossings
 *       + volumePersistenceWithoutTrend
 *       + retailSwapRatio
 * 
 * RULES:
 *   - If HES is high → pool promoted regardless of MHI
 *   - HES outranks regime signals for Class A
 */
export const HES_CONFIG = {
    /** Enable HES scoring */
    ENABLED: true,
    
    /** Weight components for HES calculation */
    WEIGHTS: {
        SWAP_TO_DRIFT: 0.30,        // Higher = more churn vs direction
        BIN_CROSSINGS: 0.25,        // Repeated bin crossings
        VOLUME_PERSISTENCE: 0.25,   // Sustained volume without trend
        RETAIL_RATIO: 0.20,         // Small swap ratio
    },
    
    /** Thresholds for HES classification */
    THRESHOLDS: {
        HIGH_HES: 70,       // High exploitation potential
        MEDIUM_HES: 45,     // Medium exploitation potential
        LOW_HES: 25,        // Low exploitation potential
    },
    
    /** HES promotion overrides MHI/regime signals */
    HES_OVERRIDES_MHI: true,
    HES_OVERRIDES_REGIME: true,
    
    /** Minimum HES to force pool promotion */
    PROMOTION_THRESHOLD: 60,
};

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP CONFIGURATION — AGGRESSIVE 60-90 MINUTES
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_BOOTSTRAP_CONFIG = {
    /** Enable predator bootstrap mode */
    ENABLED: true,
    
    /** Bootstrap duration in milliseconds (90 minutes MAX) */
    DURATION_MS: 90 * 60 * 1000,  // 90 minutes
    
    /** Target bootstrap completion time (60 minutes) */
    TARGET_DURATION_MS: 60 * 60 * 1000,  // 60 minutes
    
    /** Initial position size during bootstrap (2-3% of equity) */
    BOOTSTRAP_SIZE_PCT: 0.025,  // 2.5%
    
    /** Immediately place tight bin concentration */
    AGGRESSIVE_BIN_PLACEMENT: true,
    
    /** Skip EV gating during bootstrap */
    SKIP_EV_GATING: true,
    
    /** Skip regime gating during bootstrap */
    SKIP_REGIME_GATING: true,
    
    /** Bootstrap exists to: Lock into dominant bins, Observe real churn, Prepare scaling */
    PURPOSE: 'BIN_CONTROL_ESTABLISHMENT',
    
    /** If bootstrap lasts >90 minutes → FAIL */
    MAX_DURATION_MS: 90 * 60 * 1000,
    
    /** Failure log message */
    FAILURE_MESSAGE: 'BOOTSTRAP_EXCEEDED_90_MINUTES',
};

// ═══════════════════════════════════════════════════════════════════════════════
// HOLD & EXIT RULES — CLASS A SPECIFIC
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_HOLD_CONFIG = {
    /** ABSOLUTE MINIMUM HOLD for Class A (90 minutes) */
    MIN_HOLD_MINUTES_CLASS_A: 90,
    
    /** Minimum hold for Class B (60 minutes) */
    MIN_HOLD_MINUTES_CLASS_B: 60,
    
    /** DISABLE these exit types for Class A */
    DISABLED_EXITS_CLASS_A: [
        'HARMONIC_EXIT',
        'ENTROPY_BASED_EXIT',
        'VELOCITY_COLLAPSE_EXIT',
        'REGIME_BASED_EXIT',
        'SCORE_DECAY_EXIT',
        'MHI_DROP',
        'TIER4_SCORE_DROP',
        'FEE_VELOCITY_LOW',
        'SWAP_VELOCITY_LOW',
        'VELOCITY_DIP',
    ],
    
    /** VALID exit conditions for Class A ONLY */
    VALID_EXITS_CLASS_A: [
        'RUG_PULL',
        'LIQUIDITY_COLLAPSE',
        'TVL_COLLAPSE',
        'DECIMALS_ERROR',
        'SDK_FAILURE',
        'PROTOCOL_HALT',
        'POOL_MIGRATION',
        'POOL_DEPRECATED',
        'FEE_VELOCITY_PERSISTENT_DECAY',  // Multiple windows
    ],
    
    /** Number of consecutive decay windows required for valid exit */
    FEE_VELOCITY_DECAY_WINDOWS_REQUIRED: 5,
    
    /** Fee velocity decay threshold (% drop from entry) */
    FEE_VELOCITY_DECAY_THRESHOLD: 0.70,  // 70% drop
    
    /** Temporary slowdowns are NOISE - require this many windows to confirm */
    MIN_DECAY_CONFIRMATION_WINDOWS: 3,
};

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL DEPLOYMENT — AGGRESSIVE TARGETS
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_CAPITAL_CONFIG = {
    /** Target capital utilization (70-90%) */
    TARGET_UTILIZATION_MIN: 0.70,
    TARGET_UTILIZATION_MAX: 0.90,
    TARGET_UTILIZATION: 0.85,
    
    /** Maximum concurrent pools (3-5) */
    MAX_CONCURRENT_POOLS: 5,
    MIN_CONCURRENT_POOLS: 3,
    
    /** Per-pool allocation range */
    MIN_PER_POOL_PCT: 0.15,  // 15%
    MAX_PER_POOL_PCT: 0.30,  // 30%
    
    /** Minimum position size in USD */
    MIN_POSITION_SIZE_USD: 50,
    
    /** Maximum position size in USD */
    MAX_POSITION_SIZE_USD: 5000,
    
    /** Reserve buffer for transaction fees */
    RESERVE_BUFFER_USD: 10,
    
    /** IDLE CAPITAL = FAILURE */
    IDLE_CAPITAL_IS_FAILURE: true,
    
    /** Over-diversification = FAILURE (>5 pools) */
    OVER_DIVERSIFICATION_IS_FAILURE: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// BIN STRATEGY — AGGRESSIVE FOR CLASS A
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_BIN_CONFIG = {
    /** Class A bin strategy - NARROW for dominance */
    CLASS_A_BIN_COUNT: 5,      // Very narrow
    CLASS_A_BIN_MAX: 8,        // Maximum spread
    
    /** Class B bin strategy - Wider for stability */
    CLASS_B_BIN_COUNT: 15,
    CLASS_B_BIN_MAX: 25,
    
    /** Rebalance triggers for Class A */
    REBALANCE_TRIGGERS: {
        /** Price exits dominant churn zone (bins) */
        PRICE_DRIFT_BINS: 2,
        
        /** Retail flow migrates bins */
        FLOW_MIGRATION_THRESHOLD: 0.30,  // 30% of activity outside position
        
        /** Minimum interval between rebalances (ms) */
        MIN_REBALANCE_INTERVAL_MS: 5 * 60 * 1000,  // 5 minutes
        
        /** Maximum rebalances per hour */
        MAX_REBALANCES_PER_HOUR: 6,
    },
    
    /** DO NOT wait for "stability" before rebalancing */
    WAIT_FOR_STABILITY: false,
    
    /** Rebalancing is EXPECTED - fees come from bullying re-entries */
    AGGRESSIVE_REBALANCE: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOUNDING — IMMEDIATE FEE REINVESTMENT
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_COMPOUNDING_CONFIG = {
    /** Enable immediate fee reinvestment */
    ENABLED: true,
    
    /** Reinvest fees immediately after each cycle */
    IMMEDIATE_REINVEST: true,
    
    /** Minimum fees before reinvestment (USD) */
    MIN_REINVEST_AMOUNT_USD: 1,
    
    /** Allow tranche stacking per pool */
    ALLOW_TRANCHE_STACKING: true,
    
    /** Increase bin dominance as fees accrue */
    SCALE_BIN_DOMINANCE: true,
    
    /** Aggression scales with observed fee density, not regime */
    AGGRESSION_FOLLOWS_FEE_DENSITY: true,
    
    /** Daily compounding > theoretical EV */
    PRIORITIZE_COMPOUNDING: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY PENALTY OVERRIDES — INVERT FOR CLASS A
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_DISCOVERY_CONFIG = {
    /** REMOVE / INVERT these penalties for Class A */
    INVERTED_PENALTIES_CLASS_A: [
        'HIGH_ENTROPY',           // POSITIVE for Class A
        'HIGH_BIN_VELOCITY',      // POSITIVE for Class A
        'SWAP_VOLATILITY',        // POSITIVE for Class A
        'NOISY_TELEMETRY',        // POSITIVE for Class A
        'OSCILLATION',            // POSITIVE for Class A
        'REGIME_CHAOS',           // NEUTRAL for Class A
    ],
    
    /** Inversion multiplier (converts penalty to bonus) */
    PENALTY_INVERSION_MULTIPLIER: 1.0,  // Full inversion
    
    /** HES outranks MHI for Class A */
    HES_OUTRANKS_MHI: true,
    
    /** HES outranks regime signals for Class A */
    HES_OUTRANKS_REGIME: true,
    
    /** PIPPIN/SOL-type pools MUST surface whenever active */
    FORCE_SURFACE_MEME_POOLS: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// PAYBACK RULE — DEMOTED FOR CLASS A
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_PAYBACK_CONFIG = {
    /** Payback rule for Class A */
    CLASS_A: {
        /** May be logged */
        LOG_PAYBACK: true,
        
        /** MUST NOT block entry */
        BLOCK_ENTRY: false,
        
        /** MUST NOT suppress aggression */
        SUPPRESS_AGGRESSION: false,
        
        /** MUST NOT trigger exit */
        TRIGGER_EXIT: false,
    },
    
    /** Payback rule for Class B (stricter) */
    CLASS_B: {
        LOG_PAYBACK: true,
        BLOCK_ENTRY: true,
        SUPPRESS_AGGRESSION: false,
        TRIGGER_EXIT: true,
        MAX_PAYBACK_MINUTES: 120,
    },
    
    /** We are not trying to "get paid back" - we are compounding continuously */
    PHILOSOPHY: 'CONTINUOUS_COMPOUNDING',
};

// ═══════════════════════════════════════════════════════════════════════════════
// PREDATOR METRICS — OBSERVABILITY ONLY (NEVER BLOCKS)
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_METRICS_CONFIG = {
    /** Enable predator-specific metrics */
    ENABLED: true,
    
    /** Metrics to track */
    TRACK: {
        FEE_PER_HOUR: true,
        FEES_PER_DEPLOYED_CAPITAL: true,
        REBALANCE_COUNT: true,
        BIN_DOMINANCE_DURATION: true,
        COMPOUNDED_NOTIONAL_GROWTH: true,
        HES_SCORE: true,
        POOL_CLASS: true,
    },
    
    /** Log interval (ms) */
    LOG_INTERVAL_MS: 5 * 60 * 1000,  // 5 minutes
    
    /** MUST NEVER BLOCK execution */
    NEVER_BLOCKS: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// FAILURE DETECTION — DEBUG ONLY
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_FAILURE_CONDITIONS = {
    /** PIPPIN/SOL-type pools are skipped */
    MEME_POOLS_SKIPPED: 'IMPLEMENTATION_WRONG',
    
    /** Bootstrap exceeds 90 minutes */
    BOOTSTRAP_EXCEEDED: 'IMPLEMENTATION_WRONG',
    
    /** Capital stays <50% deployed */
    CAPITAL_UNDERUTILIZED: 'IMPLEMENTATION_WRONG',
    
    /** Positions exit before fees accrue */
    PREMATURE_EXITS: 'IMPLEMENTATION_WRONG',
};

// ═══════════════════════════════════════════════════════════════════════════════
// POOL CLASSIFICATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify a pool at discovery time.
 * Returns CLASS_A_FEE_FOUNTAIN, CLASS_B_STABILITY, or CLASS_UNKNOWN.
 */
export interface PoolClassificationInput {
    name: string;
    tokenX: string;
    tokenY: string;
    tvlUsd: number;
    volume24hUsd: number;
    fees24hUsd: number;
    entropy?: number;
    binVelocity?: number;
    swapVelocity?: number;
    swapsPerMinute?: number;
    medianTradeSize?: number;
    feeTier?: number;
    priceChange24h?: number;
    binCrossings?: number;
}

export interface PoolClassificationResult {
    poolClass: PoolClass;
    signals: string[];
    signalCount: number;
    hesScore: number;
    isEligibleForPredator: boolean;
    reason: string;
}

/**
 * Check if token matches meme/retail patterns
 */
function isMemeToken(token: string): boolean {
    const upperToken = token.toUpperCase();
    return CLASS_A_CRITERIA.MEME_TOKEN_PATTERNS.some(pattern => 
        upperToken.includes(pattern) || pattern.includes(upperToken)
    );
}

/**
 * Check if token is stable or major
 */
function isStableOrMajorToken(token: string): boolean {
    const upperToken = token.toUpperCase();
    return CLASS_B_CRITERIA.STABLE_TOKENS.some(t => upperToken.includes(t)) ||
           CLASS_B_CRITERIA.MAJOR_TOKENS.some(t => upperToken.includes(t));
}

/**
 * Calculate Human Exploitation Score (HES)
 */
export function calculateHES(input: PoolClassificationInput): number {
    if (!HES_CONFIG.ENABLED) return 0;
    
    let score = 0;
    
    // Swap to drift ratio component
    const swapToDrift = (input.swapVelocity || 0) / Math.max(Math.abs(input.priceChange24h || 0.01), 0.01);
    const swapToDriftNorm = Math.min(swapToDrift / CLASS_A_CRITERIA.HIGH_SWAP_TO_DRIFT_RATIO, 1) * 100;
    score += swapToDriftNorm * HES_CONFIG.WEIGHTS.SWAP_TO_DRIFT;
    
    // Bin crossings component
    const binCrossingsNorm = Math.min((input.binCrossings || 0) / 50, 1) * 100;
    score += binCrossingsNorm * HES_CONFIG.WEIGHTS.BIN_CROSSINGS;
    
    // Volume persistence component (volume without corresponding price move)
    const volumePersistence = input.volume24hUsd / Math.max(input.tvlUsd * Math.abs(input.priceChange24h || 0.01), 1);
    const volumePersistenceNorm = Math.min(volumePersistence / 10, 1) * 100;
    score += volumePersistenceNorm * HES_CONFIG.WEIGHTS.VOLUME_PERSISTENCE;
    
    // Retail ratio component (inverse of median trade size)
    const retailRatio = input.medianTradeSize 
        ? Math.min(CLASS_A_CRITERIA.MAX_MEDIAN_TRADE_SIZE / input.medianTradeSize, 1)
        : 0.5;
    score += retailRatio * 100 * HES_CONFIG.WEIGHTS.RETAIL_RATIO;
    
    return Math.min(Math.round(score), 100);
}

/**
 * Classify pool as Class A (Fee Fountain), Class B (Stability), or Unknown
 */
export function classifyPool(input: PoolClassificationInput): PoolClassificationResult {
    const signals: string[] = [];
    let signalCount = 0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK CLASS B FIRST (Stability pools)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const isStablePair = isStableOrMajorToken(input.tokenX) && isStableOrMajorToken(input.tokenY);
    const hasHighTvl = input.tvlUsd >= CLASS_B_CRITERIA.MIN_TVL_FOR_STABLE;
    const hasLowFeeTier = (input.feeTier || 0) <= CLASS_B_CRITERIA.MAX_FEE_TIER_FOR_STABLE;
    
    if (isStablePair && hasHighTvl) {
        return {
            poolClass: 'CLASS_B_STABILITY',
            signals: ['STABLE_PAIR', 'HIGH_TVL'],
            signalCount: 2,
            hesScore: 0,
            isEligibleForPredator: false,
            reason: 'Stable/major pair for capital parking',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK CLASS A SIGNALS (Fee Fountain)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Signal 1: Meme/retail token
    if (isMemeToken(input.tokenX) || isMemeToken(input.tokenY)) {
        signals.push('MEME_TOKEN');
        signalCount++;
    }
    
    // Signal 2: Persistent volume without directional trend
    const lowDrift = Math.abs(input.priceChange24h || 0) < 0.05;  // <5% price change
    const hasVolume = input.volume24hUsd >= CLASS_A_CRITERIA.MIN_VOLUME_24H_USD;
    if (lowDrift && hasVolume) {
        signals.push('VOLUME_WITHOUT_TREND');
        signalCount++;
    }
    
    // Signal 3: Repeated bin crossings
    if ((input.binCrossings || 0) > 20) {
        signals.push('HIGH_BIN_CROSSINGS');
        signalCount++;
    }
    
    // Signal 4: High swap count vs price drift
    const swapToDrift = (input.swapsPerMinute || 0) / Math.max(Math.abs(input.priceChange24h || 0.01), 0.01);
    if (swapToDrift >= CLASS_A_CRITERIA.HIGH_SWAP_TO_DRIFT_RATIO) {
        signals.push('HIGH_SWAP_TO_DRIFT');
        signalCount++;
    }
    
    // Signal 5: High entropy / oscillation
    if ((input.entropy || 0) >= CLASS_A_CRITERIA.HIGH_ENTROPY_THRESHOLD) {
        signals.push('HIGH_ENTROPY');
        signalCount++;
    }
    
    // Signal 6: Emotional liquidity (small to mid swaps)
    if ((input.medianTradeSize || 0) <= CLASS_A_CRITERIA.MAX_MEDIAN_TRADE_SIZE && input.medianTradeSize !== undefined) {
        signals.push('RETAIL_SWAPS');
        signalCount++;
    }
    
    // Signal 7: TVL in meme range
    if (input.tvlUsd <= CLASS_A_CRITERIA.MAX_TVL_FOR_MEME && input.tvlUsd > 0) {
        signals.push('MEME_TVL_RANGE');
        signalCount++;
    }
    
    // Signal 8: High bin velocity
    if ((input.binVelocity || 0) >= CLASS_A_CRITERIA.HIGH_BIN_VELOCITY_THRESHOLD) {
        signals.push('HIGH_BIN_VELOCITY');
        signalCount++;
    }
    
    // Signal 9: High swap frequency
    if ((input.swapsPerMinute || 0) >= CLASS_A_CRITERIA.HIGH_SWAP_FREQUENCY) {
        signals.push('HIGH_SWAP_FREQUENCY');
        signalCount++;
    }
    
    // Calculate HES
    const hesScore = calculateHES(input);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CLASSIFICATION DECISION
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Class A if 3+ signals OR high HES
    if (signalCount >= CLASS_A_CRITERIA.MIN_SIGNALS || hesScore >= HES_CONFIG.PROMOTION_THRESHOLD) {
        return {
            poolClass: 'CLASS_A_FEE_FOUNTAIN',
            signals,
            signalCount,
            hesScore,
            isEligibleForPredator: true,
            reason: `Fee fountain: ${signalCount} signals, HES=${hesScore}`,
        };
    }
    
    // Unknown classification
    return {
        poolClass: 'CLASS_UNKNOWN',
        signals,
        signalCount,
        hesScore,
        isEligibleForPredator: false,
        reason: `Insufficient signals: ${signalCount} < ${CLASS_A_CRITERIA.MIN_SIGNALS}`,
    };
}

/**
 * Check if pool should be force-surfaced (PIPPIN/SOL-type)
 */
export function shouldForceSurface(input: PoolClassificationInput): boolean {
    if (!PREDATOR_DISCOVERY_CONFIG.FORCE_SURFACE_MEME_POOLS) return false;
    
    const classification = classifyPool(input);
    
    // Force surface if Class A with high HES
    if (classification.poolClass === 'CLASS_A_FEE_FOUNTAIN' && 
        classification.hesScore >= HES_CONFIG.THRESHOLDS.HIGH_HES) {
        return true;
    }
    
    // Force surface known meme pools with volume
    if ((isMemeToken(input.tokenX) || isMemeToken(input.tokenY)) && 
        input.volume24hUsd >= CLASS_A_CRITERIA.MIN_VOLUME_24H_USD) {
        return true;
    }
    
    return false;
}

/**
 * Check if exit is valid for given pool class
 */
export function isValidExitForClass(exitReason: string, poolClass: PoolClass): boolean {
    if (poolClass !== 'CLASS_A_FEE_FOUNTAIN') {
        return true;  // All exits valid for non-Class A
    }
    
    const upperReason = exitReason.toUpperCase();
    
    // Check if it's a disabled exit for Class A
    for (const disabledExit of PREDATOR_HOLD_CONFIG.DISABLED_EXITS_CLASS_A) {
        if (upperReason.includes(disabledExit)) {
            return false;
        }
    }
    
    // Check if it's a valid exit for Class A
    for (const validExit of PREDATOR_HOLD_CONFIG.VALID_EXITS_CLASS_A) {
        if (upperReason.includes(validExit)) {
            return true;
        }
    }
    
    return false;  // Default: not valid for Class A
}

/**
 * Get minimum hold time for pool class
 */
export function getMinHoldMinutes(poolClass: PoolClass): number {
    if (poolClass === 'CLASS_A_FEE_FOUNTAIN') {
        return PREDATOR_HOLD_CONFIG.MIN_HOLD_MINUTES_CLASS_A;
    }
    return PREDATOR_HOLD_CONFIG.MIN_HOLD_MINUTES_CLASS_B;
}

/**
 * Get bin configuration for pool class
 */
export function getBinConfigForClass(poolClass: PoolClass): { binCount: number; binMax: number } {
    if (poolClass === 'CLASS_A_FEE_FOUNTAIN') {
        return {
            binCount: PREDATOR_BIN_CONFIG.CLASS_A_BIN_COUNT,
            binMax: PREDATOR_BIN_CONFIG.CLASS_A_BIN_MAX,
        };
    }
    return {
        binCount: PREDATOR_BIN_CONFIG.CLASS_B_BIN_COUNT,
        binMax: PREDATOR_BIN_CONFIG.CLASS_B_BIN_MAX,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logPredatorBanner(): void {
    if (!FEE_PREDATOR_MODE_ENABLED) {
        logger.info('[FEE-PREDATOR] DISABLED');
        return;
    }
    
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                              ║');
    console.log('║   🦅🦅🦅  FEE PREDATOR MODE  🦅🦅🦅                                          ║');
    console.log('║                                                                              ║');
    console.log('║   MISSION: Beat 2-3% DAILY compounding via aggressive fee extraction        ║');
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log('║   POOL TAXONOMY:                                                             ║');
    console.log('║     🔥 CLASS_A_FEE_FOUNTAIN: Meme/retail pools (PRIMARY TARGET)             ║');
    console.log('║     📊 CLASS_B_STABILITY: Major pairs (capital parking only)                ║');
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log('║   PREDATOR RULES:                                                            ║');
    console.log(`║     ⏱️  Bootstrap: ${PREDATOR_BOOTSTRAP_CONFIG.TARGET_DURATION_MS / 60000}-${PREDATOR_BOOTSTRAP_CONFIG.MAX_DURATION_MS / 60000} minutes MAX (bin control establishment)       ║`);
    console.log(`║     🔒 Min Hold: ${PREDATOR_HOLD_CONFIG.MIN_HOLD_MINUTES_CLASS_A}m Class A / ${PREDATOR_HOLD_CONFIG.MIN_HOLD_MINUTES_CLASS_B}m Class B                             ║`);
    console.log(`║     📊 Capital: ${(PREDATOR_CAPITAL_CONFIG.TARGET_UTILIZATION_MIN * 100).toFixed(0)}-${(PREDATOR_CAPITAL_CONFIG.TARGET_UTILIZATION_MAX * 100).toFixed(0)}% deployed, ${PREDATOR_CAPITAL_CONFIG.MIN_CONCURRENT_POOLS}-${PREDATOR_CAPITAL_CONFIG.MAX_CONCURRENT_POOLS} pools                              ║`);
    console.log(`║     🎯 Bins: ${PREDATOR_BIN_CONFIG.CLASS_A_BIN_COUNT}-${PREDATOR_BIN_CONFIG.CLASS_A_BIN_MAX} (Class A) / ${PREDATOR_BIN_CONFIG.CLASS_B_BIN_COUNT}-${PREDATOR_BIN_CONFIG.CLASS_B_BIN_MAX} (Class B)                       ║`);
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log('║   ❌ DISABLED: Payback blocking, EV gating, regime exits, score exits       ║');
    console.log('║   ✅ ENABLED:  HES scoring, aggressive rebalance, instant compounding       ║');
    console.log('║                                                                              ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log('');
    
    logger.info(`[FEE-PREDATOR] ACTIVE | HES=${HES_CONFIG.ENABLED} | minHold=${PREDATOR_HOLD_CONFIG.MIN_HOLD_MINUTES_CLASS_A}m | bootstrap=${PREDATOR_BOOTSTRAP_CONFIG.MAX_DURATION_MS / 60000}m`);
}

export function logPoolClassification(name: string, result: PoolClassificationResult): void {
    const classEmoji = result.poolClass === 'CLASS_A_FEE_FOUNTAIN' ? '🔥' :
                       result.poolClass === 'CLASS_B_STABILITY' ? '📊' : '❓';
    
    logger.info(
        `[POOL-CLASS] ${classEmoji} ${name} → ${result.poolClass} | ` +
        `HES=${result.hesScore} | signals=${result.signalCount} [${result.signals.slice(0, 3).join(',')}] | ` +
        `predator=${result.isEligibleForPredator}`
    );
}

export function logPredatorMetrics(metrics: {
    poolName: string;
    poolClass: PoolClass;
    feePerHour: number;
    feesPerDeployedCapital: number;
    rebalanceCount: number;
    binDominanceDuration: number;
    compoundedGrowth: number;
}): void {
    if (!PREDATOR_METRICS_CONFIG.ENABLED) return;
    
    const classEmoji = metrics.poolClass === 'CLASS_A_FEE_FOUNTAIN' ? '🔥' : '📊';
    
    logger.info(
        `[PREDATOR-METRICS] ${classEmoji} ${metrics.poolName} | ` +
        `fee/hr=$${metrics.feePerHour.toFixed(4)} | ` +
        `fee/capital=${(metrics.feesPerDeployedCapital * 100).toFixed(3)}% | ` +
        `rebalances=${metrics.rebalanceCount} | ` +
        `binDom=${metrics.binDominanceDuration.toFixed(0)}m | ` +
        `compound=${(metrics.compoundedGrowth * 100).toFixed(2)}%`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    FEE_PREDATOR_MODE_ENABLED,
    CLASS_A_CRITERIA,
    CLASS_B_CRITERIA,
    HES_CONFIG,
    PREDATOR_BOOTSTRAP_CONFIG,
    PREDATOR_HOLD_CONFIG,
    PREDATOR_CAPITAL_CONFIG,
    PREDATOR_BIN_CONFIG,
    PREDATOR_COMPOUNDING_CONFIG,
    PREDATOR_DISCOVERY_CONFIG,
    PREDATOR_PAYBACK_CONFIG,
    PREDATOR_METRICS_CONFIG,
    PREDATOR_FAILURE_CONDITIONS,
    classifyPool,
    calculateHES,
    shouldForceSurface,
    isValidExitForClass,
    getMinHoldMinutes,
    getBinConfigForClass,
    logPredatorBanner,
    logPoolClassification,
    logPredatorMetrics,
};

