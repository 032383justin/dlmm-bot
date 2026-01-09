/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEE BULLY MODE CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * The Fee Bully Mode transforms the bot into an aggressive fee-extraction engine.
 * It prioritizes:
 *   1. High capital utilization (90% target)
 *   2. Frequent rebalancing (minutes-level)
 *   3. Automatic compounding of realized fees
 *   4. Bootstrap scoring to eliminate deadlocks
 *   5. Infrastructure-only kill switches (no sentiment blocking)
 * 
 * This is NOT a trade prediction bot. It is a volatility-harvesting yield engine
 * that bullies manual farmers through superior execution frequency.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL RUNTIME MODE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fee Bully Mode master switch.
 * Enabled by default. Set FEE_BULLY_MODE=false to disable.
 */
export const FEE_BULLY_MODE_ENABLED = process.env.FEE_BULLY_MODE !== 'false';

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL UTILIZATION TARGETS
// ═══════════════════════════════════════════════════════════════════════════════

export const FEE_BULLY_CAPITAL = {
    /**
     * Target capital utilization (80-90%, not forced)
     * Idle capital is acceptable if payback fails.
     */
    TARGET_UTILIZATION: 0.85,
    
    /**
     * Minimum allocation per pool as % of equity
     * OVERRIDE: 15% minimum for capital concentration
     */
    MIN_PER_POOL_PCT: 0.15, // 15% (was 2%)
    
    /**
     * Maximum allocation per pool as % of equity
     * OVERRIDE: 25% maximum for capital concentration
     */
    MAX_PER_POOL_PCT: 0.25, // 25% (was 10%)
    
    /**
     * Minimum position size in USD
     */
    MIN_POSITION_SIZE_USD: 50,
    
    /**
     * Maximum position size in USD
     */
    MAX_POSITION_SIZE_USD: 5000,
    
    /**
     * Reserve buffer for transaction fees
     */
    RESERVE_BUFFER_USD: 10,
    
    /**
     * Allow idle capital if no pools pass payback gate
     */
    ALLOW_IDLE_CAPITAL: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// POOL SCALING CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const FEE_BULLY_POOLS = {
    /**
     * Number of pools to track and score each cycle
     */
    TARGET_POOL_SET: 24,
    
    /**
     * Maximum concurrent active positions
     * OVERRIDE: 3-5 pools for capital concentration
     */
    MAX_CONCURRENT_POSITIONS: 5,  // (was 12)
    
    /**
     * Minimum concurrent positions (soft target)
     */
    MIN_CONCURRENT_POSITIONS: 3,
    
    /**
     * Minimum pools to consider for entry
     */
    MIN_CANDIDATE_POOLS: 6,
};

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP SCORING — REMOVES SCORE=0/MHI=0 DEADLOCK
// ═══════════════════════════════════════════════════════════════════════════════

export const BOOTSTRAP_SCORING = {
    /**
     * Enable bootstrap scoring for pools without snapshot history
     */
    ENABLED: true,
    
    /**
     * Minimum bootstrap score to allow entry
     * This is derived from live metrics when no snapshots exist
     */
    MIN_BOOTSTRAP_SCORE: 20,
    
    /**
     * Bootstrap score weights (used when no telemetry history)
     */
    WEIGHTS: {
        VOLUME_24H: 0.25,     // Volume proxy
        TVL: 0.20,            // Liquidity depth
        FEE_RATE: 0.25,       // Fee tier (higher = better)
        BIN_STEP: 0.15,       // Bin width (tighter = more active)
        TOKEN_QUALITY: 0.15,  // Blue chip bonus
    },
    
    /**
     * Normalization ranges for bootstrap metrics
     */
    NORMALIZATION: {
        VOLUME_24H_MAX: 500000,  // $500k = max score
        TVL_MAX: 1000000,        // $1M = max score
        FEE_RATE_MAX: 0.01,      // 1% fee tier = max score
    },
    
    /**
     * Label for bootstrap-derived scores in logs
     */
    LABEL: 'BOOTSTRAP',
};

// ═══════════════════════════════════════════════════════════════════════════════
// REBALANCE CONTROLLER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const REBALANCE_CONFIG = {
    /**
     * Enable automatic rebalancing
     */
    ENABLED: true,
    
    /**
     * Minimum interval between rebalance checks (ms)
     */
    MIN_CHECK_INTERVAL_MS: 60 * 1000, // 1 minute
    
    /**
     * Maximum interval between rebalance checks (ms)
     */
    MAX_CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
    
    /**
     * Price drift threshold (bins) to trigger rebalance
     */
    BIN_DRIFT_THRESHOLD: 2,
    
    /**
     * Fee velocity drop threshold to trigger rebalance
     * If fee velocity drops below this % of rolling average
     */
    FEE_VELOCITY_DROP_THRESHOLD: 0.40, // 40% drop
    
    /**
     * Inventory imbalance threshold (% skew from 50/50)
     */
    INVENTORY_IMBALANCE_THRESHOLD: 0.30, // 30% skew
    
    /**
     * Rolling window for fee velocity calculation (ms)
     */
    FEE_VELOCITY_WINDOW_MS: 10 * 60 * 1000, // 10 minutes
    
    /**
     * Minimum hold time before rebalance is allowed (ms)
     */
    MIN_HOLD_BEFORE_REBALANCE_MS: 5 * 60 * 1000, // 5 minutes
    
    /**
     * Exit reason string for rebalance exits
     */
    EXIT_REASON: 'REBALANCE',
    
    /**
     * Maximum rebalances per position per hour
     */
    MAX_REBALANCES_PER_HOUR: 4,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TELEMETRY GATING — FEE BULLY MODE THRESHOLDS
// ═══════════════════════════════════════════════════════════════════════════════

export const FEE_BULLY_TELEMETRY = {
    /**
     * RPC health threshold to allow ENTRY
     * Lower than default to allow more aggressive farming
     */
    ENTRY_HEALTH_THRESHOLD: 45, // Was 60
    
    /**
     * RPC health threshold to trigger SAFE_MODE
     * Below this, no new entries but exits allowed
     */
    SAFE_MODE_HEALTH_THRESHOLD: 35,
    
    /**
     * Timeout rate threshold to trigger SAFE_MODE
     */
    SAFE_MODE_TIMEOUT_RATE: 0.10, // 10%
    
    /**
     * Error rate threshold to trigger SAFE_MODE
     */
    SAFE_MODE_ERROR_RATE: 0.15, // 15%
    
    /**
     * FORCED_EXIT always bypasses gating
     */
    FORCED_EXIT_BYPASS: true,
    
    /**
     * Throttle settings when health is degraded
     */
    THROTTLE: {
        /**
         * Health score below which throttling kicks in
         */
        THROTTLE_BELOW_HEALTH: 60,
        
        /**
         * Cycle interval multiplier when throttled
         */
        CYCLE_INTERVAL_MULTIPLIER: 1.5,
        
        /**
         * Max entries per cycle when throttled
         */
        MAX_ENTRIES_THROTTLED: 2,
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE KILL SWITCH (REPLACES SENTIMENT-BASED BLOCKING)
// ═══════════════════════════════════════════════════════════════════════════════

export const INFRASTRUCTURE_KILL_SWITCH = {
    /**
     * Enable infrastructure-based kill switch only
     * Disables sentiment-based global entry blocks
     */
    ENABLED: true,
    
    /**
     * SAFE_MODE triggers (infrastructure failure detection)
     */
    SAFE_MODE_TRIGGERS: {
        /**
         * RPC health below this = SAFE_MODE
         */
        RPC_HEALTH_CRITICAL: 35,
        
        /**
         * Timeout rate above this = SAFE_MODE
         */
        TIMEOUT_RATE_CRITICAL: 0.10,
        
        /**
         * Error rate above this = SAFE_MODE
         */
        ERROR_RATE_CRITICAL: 0.15,
        
        /**
         * Consecutive failed transactions to trigger
         */
        CONSECUTIVE_TX_FAILURES: 5,
    },
    
    /**
     * SAFE_MODE behavior
     */
    SAFE_MODE_BEHAVIOR: {
        /**
         * Allow new entries in SAFE_MODE
         */
        ALLOW_ENTRIES: false,
        
        /**
         * Allow regular exits in SAFE_MODE
         */
        ALLOW_EXITS: true,
        
        /**
         * FORCED_EXIT always bypasses SAFE_MODE
         */
        FORCED_EXIT_BYPASS: true,
        
        /**
         * Continue monitoring for recovery
         */
        MONITOR_FOR_RECOVERY: true,
        
        /**
         * Cooldown after SAFE_MODE recovery (ms)
         */
        RECOVERY_COOLDOWN_MS: 60 * 1000, // 1 minute
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOUNDING CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const COMPOUNDING_CONFIG = {
    /**
     * Enable automatic compounding of realized fees
     */
    ENABLED: true,
    
    /**
     * Minimum realized fees before compounding (USD)
     */
    MIN_COMPOUND_AMOUNT_USD: 5,
    
    /**
     * Compound on every exit
     */
    COMPOUND_ON_EXIT: true,
    
    /**
     * Compound check interval (ms)
     */
    CHECK_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
};

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING TAGS
// ═══════════════════════════════════════════════════════════════════════════════

export const FEE_BULLY_TAGS = {
    MAIN: '[FEE-BULLY]',
    UTILIZATION: '[UTILIZATION]',
    REBALANCE: '[REBALANCE]',
    COMPOUND: '[COMPOUND]',
    TELEMETRY: '[TELEMETRY]',
    SAFE_MODE: '[SAFE-MODE]',
    BOOTSTRAP: '[BOOTSTRAP]',
};

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP BANNER
// ═══════════════════════════════════════════════════════════════════════════════

export function logFeeBullyBanner(): void {
    if (!FEE_BULLY_MODE_ENABLED) {
        logger.info('[FEE-BULLY] DISABLED - Running in standard mode (maxConcurrentPools=3, maxExposure=30%)');
        return;
    }
    
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                              ║');
    console.log('║   ███████╗███████╗███████╗    ██╗   ██╗███████╗██╗      ██████╗  ██████╗     ║');
    console.log('║   ██╔════╝██╔════╝██╔════╝    ██║   ██║██╔════╝██║     ██╔═══██╗██╔════╝     ║');
    console.log('║   █████╗  █████╗  █████╗      ██║   ██║█████╗  ██║     ██║   ██║██║          ║');
    console.log('║   ██╔══╝  ██╔══╝  ██╔══╝      ╚██╗ ██╔╝██╔══╝  ██║     ██║   ██║██║          ║');
    console.log('║   ██║     ███████╗███████╗     ╚████╔╝ ███████╗███████╗╚██████╔╝╚██████╗     ║');
    console.log('║   ╚═╝     ╚══════╝╚══════╝      ╚═══╝  ╚══════╝╚══════╝ ╚═════╝  ╚═════╝     ║');
    console.log('║                                                                              ║');
    console.log('║              ⚡⚡⚡ FEE VELOCITY DOMINATION MODE ⚡⚡⚡                       ║');
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log('║   CORE PRINCIPLE: Only deploy where costs amortize in 1-2 hours             ║');
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log(`║   🎯 MAX CONCURRENT POOLS:  ${FEE_BULLY_POOLS.MAX_CONCURRENT_POSITIONS.toString().padEnd(2)} (concentrated)                             ║`);
    console.log(`║   💰 PER-POOL ALLOCATION:   ${(FEE_BULLY_CAPITAL.MIN_PER_POOL_PCT * 100).toFixed(0)}%-${(FEE_BULLY_CAPITAL.MAX_PER_POOL_PCT * 100).toFixed(0)}% of equity                              ║`);
    console.log(`║   📊 DEPLOY TARGET:         ${(FEE_BULLY_CAPITAL.TARGET_UTILIZATION * 100).toFixed(0)}% (idle ok if payback fails)                    ║`);
    console.log('║                                                                              ║');
    console.log('║   ⏱️  PAYBACK GATE:         ≤120 minutes (replaces EV gate)                  ║');
    console.log('║   🚀 BOOTSTRAP:            6 hours (time-based, not cycles)                 ║');
    console.log('║   📐 BIN STRATEGY:          HARVEST (5-10) / STABILIZE (15-25)              ║');
    console.log('║                                                                              ║');
    console.log('║   ❌ DISABLED: EV gate, over-diversification, entry throttling              ║');
    console.log('║   ❌ DISABLED: Regime-based sizing, blocking, exits                         ║');
    console.log('║   ✅ ENABLED:  Payback-first gating, capital concentration                  ║');
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log('║   MODE: Fee Extraction Machine (not research project)                       ║');
    console.log('║   TARGET: 2-3% daily returns via fee velocity domination                    ║');
    console.log('║   REGIME: OBSERVATION_ONLY (no economic impact)                             ║');
    console.log('║                                                                              ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log('');
    
    // THE UNMISSABLE LOG LINE
    logger.info(
        `[FEE-VELOCITY] ACTIVE | ` +
        `maxPools=${FEE_BULLY_POOLS.MAX_CONCURRENT_POSITIONS} | ` +
        `perPool=${(FEE_BULLY_CAPITAL.MIN_PER_POOL_PCT * 100).toFixed(0)}-${(FEE_BULLY_CAPITAL.MAX_PER_POOL_PCT * 100).toFixed(0)}% | ` +
        `payback≤120m | bootstrap=6h | EV_GATE=DISABLED`
    );
    
    // REGIME NEUTRALIZATION LOG — Critical for observability (MANDATORY)
    logger.info(`[REGIME] ECONOMIC_IMPACT=DISABLED`);
    logger.info(
        `[REGIME] Tier scores: regime-invariant | Thresholds: static | Sizing: regime-blind | ` +
        `Aggression: regime-independent | Exits: fee-velocity only`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PER-CYCLE SUMMARY LOG
// ═══════════════════════════════════════════════════════════════════════════════

export interface FeeBullyCycleSummary {
    utilizationPct: number;
    deployedUsd: number;
    availableUsd: number;
    activePositionCount: number;
    realizedFeesLastMinutes: number;
    rebalanceCountLastCycle: number;
    rpcHealthScore: number;
    isSafeMode: boolean;
}

export function logFeeBullyCycleSummary(summary: FeeBullyCycleSummary): void {
    if (!FEE_BULLY_MODE_ENABLED) return;
    
    const safeModeIndicator = summary.isSafeMode ? ' ⚠️ SAFE-MODE' : '';
    
    // Format matching the required output:
    // [UTILIZATION] deployed=$X available=$Y util=Z% activePositions=N rebalances=K realizedFees(rolling)=...
    logger.info(
        `[UTILIZATION] ` +
        `deployed=$${summary.deployedUsd.toFixed(0)} ` +
        `available=$${summary.availableUsd.toFixed(0)} ` +
        `util=${summary.utilizationPct.toFixed(1)}% ` +
        `activePositions=${summary.activePositionCount}/${FEE_BULLY_POOLS.MAX_CONCURRENT_POSITIONS} ` +
        `rebalances=${summary.rebalanceCountLastCycle} ` +
        `realizedFees(rolling)=$${summary.realizedFeesLastMinutes.toFixed(2)}` +
        `${safeModeIndicator}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFE MODE STATE
// ═══════════════════════════════════════════════════════════════════════════════

let safeModeActive = false;
let safeModeActivatedAt = 0;
let safeModeReason = '';

export function isSafeModeActive(): boolean {
    return safeModeActive;
}

export function activateSafeMode(reason: string): void {
    if (!safeModeActive) {
        safeModeActive = true;
        safeModeActivatedAt = Date.now();
        safeModeReason = reason;
        logger.warn(`${FEE_BULLY_TAGS.SAFE_MODE} ACTIVATED | reason="${reason}"`);
    }
}

export function deactivateSafeMode(): void {
    if (safeModeActive) {
        const duration = Date.now() - safeModeActivatedAt;
        logger.info(`${FEE_BULLY_TAGS.SAFE_MODE} DEACTIVATED | duration=${Math.floor(duration / 1000)}s | previousReason="${safeModeReason}"`);
        safeModeActive = false;
        safeModeReason = '';
    }
}

export function getSafeModeStatus(): { active: boolean; reason: string; durationMs: number } {
    return {
        active: safeModeActive,
        reason: safeModeReason,
        durationMs: safeModeActive ? Date.now() - safeModeActivatedAt : 0,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMIC ALLOCATION CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

export interface AllocationResult {
    poolAddress: string;
    poolName: string;
    normalizedScore: number;
    allocatedUsd: number;
    allocatedPct: number;
}

/**
 * Calculate dynamic allocation for entry candidates.
 * Uses score-weighted distribution with min/max constraints.
 */
export function calculateDynamicAllocations(
    candidates: Array<{ address: string; name: string; score: number }>,
    equity: number,
    availableCapital: number,
    currentPositionCount: number
): AllocationResult[] {
    if (candidates.length === 0) return [];
    
    const maxNewPositions = FEE_BULLY_POOLS.MAX_CONCURRENT_POSITIONS - currentPositionCount;
    if (maxNewPositions <= 0) return [];
    
    // Calculate target deployment
    const targetDeployed = equity * FEE_BULLY_CAPITAL.TARGET_UTILIZATION;
    const deployTarget = Math.min(availableCapital, targetDeployed) - FEE_BULLY_CAPITAL.RESERVE_BUFFER_USD;
    
    if (deployTarget <= 0) return [];
    
    // Calculate min/max per pool
    const minPerPool = Math.max(
        FEE_BULLY_CAPITAL.MIN_POSITION_SIZE_USD,
        equity * FEE_BULLY_CAPITAL.MIN_PER_POOL_PCT
    );
    const maxPerPool = Math.min(
        FEE_BULLY_CAPITAL.MAX_POSITION_SIZE_USD,
        equity * FEE_BULLY_CAPITAL.MAX_PER_POOL_PCT
    );
    
    // Limit candidates to available slots
    const eligibleCandidates = candidates.slice(0, maxNewPositions);
    
    // Calculate total score for normalization
    const totalScore = eligibleCandidates.reduce((sum, c) => sum + Math.max(c.score, 1), 0);
    
    // Allocate by normalized score weights
    const allocations: AllocationResult[] = [];
    let remainingBudget = deployTarget;
    
    for (const candidate of eligibleCandidates) {
        if (remainingBudget < minPerPool) break;
        
        // Weight by score
        const scoreWeight = Math.max(candidate.score, 1) / totalScore;
        let rawAllocation = deployTarget * scoreWeight;
        
        // Apply min/max constraints
        rawAllocation = Math.max(minPerPool, Math.min(maxPerPool, rawAllocation));
        
        // Don't exceed remaining budget
        rawAllocation = Math.min(rawAllocation, remainingBudget);
        
        if (rawAllocation >= minPerPool) {
            allocations.push({
                poolAddress: candidate.address,
                poolName: candidate.name,
                normalizedScore: scoreWeight,
                allocatedUsd: Math.floor(rawAllocation),
                allocatedPct: rawAllocation / equity,
            });
            remainingBudget -= rawAllocation;
        }
    }
    
    return allocations;
}

