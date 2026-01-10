/**
 * Predator Mode Configuration — Bin Dominance System
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PRIMARY OBJECTIVE (NON-NEGOTIABLE):
 *   Maximize daily compounding profit by enforcing bin dominance in bullyable
 *   DLMM pools, using aggressive, fee-positive rebalancing, while preventing
 *   catastrophic drawdown or multi-day capital lock.
 * 
 * WINNING METRICS:
 *   - ≥90% winning days
 *   - 0.5%-3% daily compounding target
 *   - No 3+ day drawdowns
 *   - Capital utilization ≥90%
 *   - Rebalance cadence up to ~300/day if fee-positive
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// PREDATOR MODE — MASTER CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_CONFIG = {
    /** Enable predator mode */
    ENABLED: true,
    
    /** Mode name for logging */
    MODE_NAME: 'BIN_DOMINANCE',
    
    // ═══════════════════════════════════════════════════════════════════════════
    // POOL DISCOVERY
    // ═══════════════════════════════════════════════════════════════════════════
    
    DISCOVERY: {
        /** Minimum pool age (days) */
        MIN_AGE_DAYS: 5,
        
        /** Minimum 24h volume (USD) */
        MIN_VOLUME_24H: 50_000,
        
        /** Maximum TVL to avoid pro pools (USD) */
        MAX_TVL: 500_000,
        
        /** Minimum bully score */
        MIN_BULLY_SCORE: 0.40,
        
        /** Maximum pools to track simultaneously */
        MAX_CONCURRENT_POOLS: 3,
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BIN DOMINANCE ENTRY
    // ═══════════════════════════════════════════════════════════════════════════
    
    ENTRY: {
        /** Single bin on entry */
        BIN_COUNT: 1,
        
        /** Entry mode */
        MODE: 'DOMINANCE',
        
        /** Place at highest swap-cross bin */
        TARGET_BIN: 'HIGHEST_SWAP_CROSS',
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DOMINANCE THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    DOMINANCE: {
        /** DOMINANT state threshold */
        DOMINANT_THRESHOLD: 0.25,   // 25% swap share
        
        /** WEAK state threshold */
        WEAK_THRESHOLD: 0.10,       // 10% swap share
        
        /** Cycles of FAILED before exit consideration */
        FAILED_CYCLES_FOR_EXIT: 3,
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REBALANCE CADENCE
    // ═══════════════════════════════════════════════════════════════════════════
    
    REBALANCE: {
        /** Interval when DOMINANT (ms) */
        DOMINANT_INTERVAL_MS: 4 * 60 * 1000,    // 4 minutes
        
        /** Interval when WEAK (ms) */
        WEAK_INTERVAL_MS: 90 * 1000,            // 90 seconds
        
        /** Interval when FAILED (ms) */
        FAILED_INTERVAL_MS: 60 * 1000,          // 60 seconds
        
        /** Maximum rebalances per day */
        MAX_PER_DAY: 288,
        
        /** Minimum fee gain multiplier vs tx cost */
        MIN_FEE_GAIN_MULTIPLIER: 1.5,
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT CONDITIONS
    // ═══════════════════════════════════════════════════════════════════════════
    
    EXIT: {
        /** Exit only on dominance failure, not regime/score */
        DOMINANCE_FIRST: true,
        
        /** Cycles of FAILED state before exit */
        FAILED_CYCLES_REQUIRED: 3,
        
        /** Allow exit even if not amortized if dominance failed */
        OVERRIDE_AMORTIZATION_ON_FAILURE: true,
        
        /** Hard stops */
        MAX_INTRADAY_LOSS_PCT: 5.0,  // 5% max loss per day
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CAPITAL UTILIZATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    CAPITAL: {
        /** Maximum idle capital (%) */
        MAX_IDLE_PCT: 10,
        
        /** Target utilization (%) */
        TARGET_UTILIZATION: 90,
        
        /** Minimum position size (USD) */
        MIN_POSITION_SIZE: 50,
        
        /** Maximum per pool (%) */
        MAX_PER_POOL_PCT: 50,
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // KILL SWITCH MODIFICATIONS
    // ═══════════════════════════════════════════════════════════════════════════
    
    KILL_SWITCH: {
        /** Cannot force exit from active dominant bins */
        BLOCK_DOMINANT_EXIT: true,
        
        /** Can block new entries */
        ALLOW_BLOCK_ENTRIES: true,
        
        /** Cannot suppress rebalancing in dominance mode */
        BLOCK_REBALANCE_SUPPRESSION: true,
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// REMOVED FEATURES (EXPLICIT)
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_REMOVED_FEATURES = {
    /** Regime-weighted suppression for entries */
    REGIME_ENTRY_SUPPRESSION: false,
    
    /** Over-reliance on global market health */
    GLOBAL_MARKET_HEALTH_GATING: false,
    
    /** Passive EV-only gating */
    EV_ONLY_GATING: false,
    
    /** Regime flip exits */
    REGIME_FLIP_EXITS: false,
    
    /** Global market health exits */
    MARKET_HEALTH_EXITS: false,
    
    /** Tier score decay exits */
    TIER_SCORE_DECAY_EXITS: false,
    
    /** Multi-bin passive LP */
    MULTI_BIN_PASSIVE: false,
    
    /** Creating new bin arrays */
    CREATE_BIN_ARRAYS: false,
    
    /** Market making */
    MARKET_MAKING: false,
    
    /** Predictive trading */
    PREDICTIVE_TRADING: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// WHAT WE ARE NOT DOING (EXPLICIT)
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_NON_OBJECTIVES = [
    'Creating new bin arrays',
    'Market making',
    'Predictive trading',
    'Multi-bin passive LP',
    'Risk minimization beyond catastrophic loss avoidance',
    'EV optimization',
    'Trade minimization',
    'Regime prediction',
];

// ═══════════════════════════════════════════════════════════════════════════════
// WHAT WE ARE DOING
// ═══════════════════════════════════════════════════════════════════════════════

export const PREDATOR_OBJECTIVES = [
    'Bullying manual farmers',
    'Extracting fees aggressively from repetitive trader behavior',
    'Rebalancing frequently (up to 288/day)',
    'Concentrating liquidity in single bins',
    'Capturing disproportionate share of fees',
];

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP BANNER
// ═══════════════════════════════════════════════════════════════════════════════

export function logPredatorBanner(): void {
    logger.info(`═══════════════════════════════════════════════════════════════════`);
    logger.info(`  🦖 PREDATOR MODE: BIN DOMINANCE SYSTEM`);
    logger.info(`═══════════════════════════════════════════════════════════════════`);
    logger.info(``);
    logger.info(`  OBJECTIVE: Maximize daily compounding via bin dominance`);
    logger.info(`  TARGET: ≥90% winning days | 0.5%-3% daily | ≥90% utilization`);
    logger.info(``);
    logger.info(`  DISCOVERY:`);
    logger.info(`    - Pool age ≥ ${PREDATOR_CONFIG.DISCOVERY.MIN_AGE_DAYS} days`);
    logger.info(`    - Volume24h ≥ $${PREDATOR_CONFIG.DISCOVERY.MIN_VOLUME_24H.toLocaleString()}`);
    logger.info(`    - TVL ≤ $${PREDATOR_CONFIG.DISCOVERY.MAX_TVL.toLocaleString()} (avoid pro pools)`);
    logger.info(`    - Bully score ≥ ${PREDATOR_CONFIG.DISCOVERY.MIN_BULLY_SCORE}`);
    logger.info(``);
    logger.info(`  ENTRY:`);
    logger.info(`    - Mode: SINGLE BIN DOMINANCE`);
    logger.info(`    - Target: Highest swap-cross bin`);
    logger.info(`    - binCount = 1`);
    logger.info(``);
    logger.info(`  DOMINANCE STATES:`);
    logger.info(`    - DOMINANT: ≥${(PREDATOR_CONFIG.DOMINANCE.DOMINANT_THRESHOLD * 100).toFixed(0)}% swap share`);
    logger.info(`    - WEAK: ${(PREDATOR_CONFIG.DOMINANCE.WEAK_THRESHOLD * 100).toFixed(0)}-${(PREDATOR_CONFIG.DOMINANCE.DOMINANT_THRESHOLD * 100).toFixed(0)}%`);
    logger.info(`    - FAILED: <${(PREDATOR_CONFIG.DOMINANCE.WEAK_THRESHOLD * 100).toFixed(0)}%`);
    logger.info(``);
    logger.info(`  REBALANCE CADENCE:`);
    logger.info(`    - DOMINANT: every ${PREDATOR_CONFIG.REBALANCE.DOMINANT_INTERVAL_MS / 60000}m`);
    logger.info(`    - WEAK: every ${PREDATOR_CONFIG.REBALANCE.WEAK_INTERVAL_MS / 1000}s`);
    logger.info(`    - FAILED: every ${PREDATOR_CONFIG.REBALANCE.FAILED_INTERVAL_MS / 1000}s`);
    logger.info(`    - Max per day: ${PREDATOR_CONFIG.REBALANCE.MAX_PER_DAY}`);
    logger.info(``);
    logger.info(`  EXITS (DOMINANCE-FIRST):`);
    logger.info(`    ✅ Dominance failure (${PREDATOR_CONFIG.EXIT.FAILED_CYCLES_REQUIRED} cycles FAILED)`);
    logger.info(`    ✅ Liquidity drain / structural decay`);
    logger.info(`    ✅ Hard risk stops (${PREDATOR_CONFIG.EXIT.MAX_INTRADAY_LOSS_PCT}% max loss)`);
    logger.info(`    ❌ Regime flip exits: REMOVED`);
    logger.info(`    ❌ Score decay exits: REMOVED`);
    logger.info(`    ❌ Market health exits: REMOVED`);
    logger.info(``);
    logger.info(`  KILL SWITCH:`);
    logger.info(`    ❌ Cannot force exit from DOMINANT bins`);
    logger.info(`    ✅ Can block new entries`);
    logger.info(`    ❌ Cannot suppress rebalancing`);
    logger.info(``);
    logger.info(`  NOT DOING: ${PREDATOR_NON_OBJECTIVES.join(', ')}`);
    logger.info(``);
    logger.info(`═══════════════════════════════════════════════════════════════════`);
}

