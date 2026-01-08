/**
 * Fee Velocity Gate — Payback-First Entry System
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CORE PRINCIPLE: Only deploy capital where entry costs amortize within 1-2 hours.
 * 
 * This module replaces strategy optimization with fee velocity domination.
 * 
 * TWO-STAGE GATING:
 * 
 * STAGE 1 - HARD POOL GATES (Binary, Non-negotiable):
 *   1. Pool age ≥ 30 days
 *   2. TVL ≥ $50,000
 *   3. 24h Volume ≥ $150,000
 *   4. Fee tier ≤ 1%
 *   5. Active bins ≥ 10
 *   6. Swap frequency ≥ 1 trade/minute
 *   7. Holder count ≥ 2,000
 *   8. Token immutable, no mint, no freeze
 *   9. Non-hidden, non-synthetic pools only
 * 
 * STAGE 2 - PAYBACK TIME GATE:
 *   paybackTime = entryCost / feesPerMinute
 *   Entry allowed ONLY if paybackTime ≤ 120 minutes
 * 
 * BOOTSTRAP MODE:
 *   - Time-based: 6 hours from first entry
 *   - During bootstrap: Only blocks dead pools, catastrophic costs (>$10), size violations
 *   - After 6 hours: Strict gating resumes
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { Tier4EnrichedPool } from '../scoring/microstructureScoring';

// ═══════════════════════════════════════════════════════════════════════════════
// HARD POOL GATE THRESHOLDS — NON-NEGOTIABLE BINARY FILTERS
// ═══════════════════════════════════════════════════════════════════════════════

export const HARD_POOL_GATES = {
    /** Pool age minimum in days */
    MIN_POOL_AGE_DAYS: 30,
    
    /** Minimum TVL in USD */
    MIN_TVL_USD: 50_000,
    
    /** Minimum 24h volume in USD */
    MIN_VOLUME_24H_USD: 150_000,
    
    /** Maximum fee tier (1% = 0.01) */
    MAX_FEE_TIER: 0.01,
    
    /** Minimum active bins */
    MIN_ACTIVE_BINS: 10,
    
    /** 
     * DEAD POOL DETECTION — Relative threshold
     * 
     * Changed from absolute (1 swap/min) to relative check:
     * - Pool is DEAD only if swapsPerMinute == 0 (true dead pool)
     * - Low activity is handled by payback gate (fees too slow)
     * 
     * This prevents false positives on major pools like SOL/USDC
     * where the normalized swapVelocity calculation may underestimate.
     */
    MIN_SWAPS_PER_MINUTE: 0,  // Only block truly dead pools (0 activity)
    
    /**
     * Alternative: Use volume-based activity check instead of swap count
     * Pool is "alive" if it has meaningful 24h volume relative to TVL
     */
    MIN_VOLUME_TO_TVL_RATIO: 0.1,  // 10% daily turnover minimum
    
    /** Minimum holder count */
    MIN_HOLDER_COUNT: 2_000,
    
    /** Block pools with mint authority */
    BLOCK_MINTABLE: true,
    
    /** Block pools with freeze authority */
    BLOCK_FREEZABLE: true,
    
    /** Block hidden/synthetic pools */
    BLOCK_HIDDEN_SYNTHETIC: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// PAYBACK TIME GATE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const PAYBACK_GATE_CONFIG = {
    /** Maximum payback time in minutes for entry */
    MAX_PAYBACK_MINUTES: 120,
    
    /** Entry cost components */
    ENTRY_COST: {
        /** Base entry fee as % of position */
        BASE_FEE_PCT: 0.0015,  // 0.15%
        
        /** Expected entry slippage as % of position */
        SLIPPAGE_PCT: 0.0008,  // 0.08%
        
        /** Solana transaction fees in USD */
        TX_FEE_USD: 0.01,
    },
    
    /** Exit cost components (for total round-trip) */
    EXIT_COST: {
        /** Base exit fee as % of position */
        BASE_FEE_PCT: 0.0015,  // 0.15%
        
        /** Expected exit slippage as % of position */
        SLIPPAGE_PCT: 0.0012,  // 0.12%
        
        /** Solana transaction fees in USD */
        TX_FEE_USD: 0.01,
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-BASED BOOTSTRAP CONFIGURATION (Replaces cycle-based)
// ═══════════════════════════════════════════════════════════════════════════════

export const BOOTSTRAP_CONFIG = {
    /** Enable time-based bootstrap */
    ENABLED: true,
    
    /** Bootstrap duration in milliseconds (6 hours) */
    DURATION_MS: 6 * 60 * 60 * 1000,
    
    /** During bootstrap, only block these conditions */
    BOOTSTRAP_BLOCKS: {
        /** Block if pool appears dead (no activity) */
        DEAD_POOL: true,
        
        /** Block if entry cost exceeds this USD amount */
        MAX_COST_USD: 10,
        
        /** Block if position size exceeds % of equity */
        MAX_SIZE_PCT: 0.25,
    },
    
    /** EV gate is disabled during bootstrap */
    EV_GATE_DISABLED: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL CONCENTRATION OVERRIDES
// ═══════════════════════════════════════════════════════════════════════════════

export const CONCENTRATION_OVERRIDE = {
    /** Maximum concurrent pools */
    MAX_CONCURRENT_POOLS: 5,
    
    /** Minimum concurrent pools (soft target) */
    MIN_CONCURRENT_POOLS: 3,
    
    /** Minimum per-pool allocation as % of equity */
    MIN_PER_POOL_PCT: 0.15,  // 15%
    
    /** Maximum per-pool allocation as % of equity */
    MAX_PER_POOL_PCT: 0.25,  // 25%
    
    /** Target utilization (80-90%, not forced) */
    TARGET_UTILIZATION: 0.85,
    
    /** Idle capital is acceptable if payback fails */
    ALLOW_IDLE_CAPITAL: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Time of first entry (for bootstrap duration tracking) */
let firstEntryTime: number | null = null;

/** Track rejected pools this cycle for logging */
const rejectedPools = new Map<string, string>();

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HardGateResult {
    passed: boolean;
    failedGate?: string;
    failedReason?: string;
    metrics: {
        poolAgeDays: number;
        tvlUsd: number;
        volume24hUsd: number;
        feeTier: number;
        activeBins: number;
        swapsPerMinute: number;
        holderCount: number;
        isMintable: boolean;
        isFreezable: boolean;
        isHidden: boolean;
    };
}

export interface PaybackGateResult {
    passed: boolean;
    paybackMinutes: number;
    entryCostUsd: number;
    feesPerMinuteUsd: number;
    blockReason?: string;
}

export interface FeeVelocityGateResult {
    /** Entry allowed? */
    allowed: boolean;
    
    /** Reason for decision */
    reason: string;
    
    /** Final position size (0 if blocked) */
    finalSize: number;
    
    /** Hard gate results */
    hardGate: HardGateResult;
    
    /** Payback gate results */
    paybackGate: PaybackGateResult;
    
    /** Is bootstrap mode active? */
    isBootstrapMode: boolean;
    
    /** Bootstrap time remaining (ms) */
    bootstrapTimeRemainingMs: number;
    
    /** Deploy reason for logging */
    deployReason: 'payback_ok' | 'bootstrap' | 'stabilize' | 'blocked';
}

export interface PoolMetricsForGate {
    address: string;
    name: string;
    
    // Required metrics for hard gates
    createdAt?: number;          // Unix timestamp
    tvlUsd: number;
    volume24hUsd: number;
    feeTier: number;             // 0-1 (e.g., 0.003 = 0.3%)
    activeBins: number;
    swapsPerMinute: number;
    holderCount: number;
    isMintable: boolean;
    isFreezable: boolean;
    isHidden: boolean;
    
    // Required metrics for payback gate
    fees24hUsd: number;
    feeIntensity: number;        // fees per second normalized by TVL
    
    // Position context
    positionSizeUsd: number;
    totalEquity: number;
    
    // Bin coverage for position-attributable fee calculation
    positionBinCount?: number;   // Number of bins the position will cover
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP MODE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record first entry time (call on first successful entry)
 */
export function recordFirstEntry(): void {
    if (firstEntryTime === null) {
        firstEntryTime = Date.now();
        logger.info(
            `[BOOTSTRAP] ⏱️ First entry recorded — Bootstrap active for ${BOOTSTRAP_CONFIG.DURATION_MS / (60 * 60 * 1000)}h`
        );
    }
}

/**
 * Check if bootstrap mode is active
 */
export function isBootstrapModeActive(): boolean {
    if (!BOOTSTRAP_CONFIG.ENABLED) return false;
    if (firstEntryTime === null) return true; // Before first entry = bootstrap
    
    const elapsed = Date.now() - firstEntryTime;
    return elapsed < BOOTSTRAP_CONFIG.DURATION_MS;
}

/**
 * Get bootstrap time remaining in milliseconds
 */
export function getBootstrapTimeRemaining(): number {
    if (!BOOTSTRAP_CONFIG.ENABLED) return 0;
    if (firstEntryTime === null) return BOOTSTRAP_CONFIG.DURATION_MS;
    
    const elapsed = Date.now() - firstEntryTime;
    return Math.max(0, BOOTSTRAP_CONFIG.DURATION_MS - elapsed);
}

/**
 * Get bootstrap status for logging
 */
export function getBootstrapStatus(): {
    active: boolean;
    startedAt: number | null;
    remainingMs: number;
    remainingHours: number;
} {
    const remainingMs = getBootstrapTimeRemaining();
    return {
        active: isBootstrapModeActive(),
        startedAt: firstEntryTime,
        remainingMs,
        remainingHours: remainingMs / (60 * 60 * 1000),
    };
}

/**
 * Reset bootstrap state (for testing)
 */
export function resetBootstrapState(): void {
    firstEntryTime = null;
    rejectedPools.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// HARD POOL GATES — BINARY FILTERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate hard pool gates (binary, non-scoring)
 * If ANY gate fails, pool is discarded for this cycle.
 */
export function evaluateHardGates(metrics: PoolMetricsForGate): HardGateResult {
    const now = Date.now();
    
    // Calculate pool age
    const poolAgeDays = metrics.createdAt 
        ? (now - metrics.createdAt) / (24 * 60 * 60 * 1000)
        : 999; // Assume old if unknown
    
    // Build metrics object for logging
    const metricsObj = {
        poolAgeDays,
        tvlUsd: metrics.tvlUsd,
        volume24hUsd: metrics.volume24hUsd,
        feeTier: metrics.feeTier,
        activeBins: metrics.activeBins,
        swapsPerMinute: metrics.swapsPerMinute,
        holderCount: metrics.holderCount,
        isMintable: metrics.isMintable,
        isFreezable: metrics.isFreezable,
        isHidden: metrics.isHidden,
    };
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 1: Pool age ≥ 30 days
    // ───────────────────────────────────────────────────────────────────────────
    if (poolAgeDays < HARD_POOL_GATES.MIN_POOL_AGE_DAYS) {
        return {
            passed: false,
            failedGate: 'POOL_AGE',
            failedReason: `${poolAgeDays.toFixed(0)} days < ${HARD_POOL_GATES.MIN_POOL_AGE_DAYS} days`,
            metrics: metricsObj,
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 2: TVL ≥ $50,000
    // ───────────────────────────────────────────────────────────────────────────
    if (metrics.tvlUsd < HARD_POOL_GATES.MIN_TVL_USD) {
        return {
            passed: false,
            failedGate: 'TVL',
            failedReason: `$${metrics.tvlUsd.toFixed(0)} < $${HARD_POOL_GATES.MIN_TVL_USD}`,
            metrics: metricsObj,
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 3: 24h Volume ≥ $150,000
    // ───────────────────────────────────────────────────────────────────────────
    if (metrics.volume24hUsd < HARD_POOL_GATES.MIN_VOLUME_24H_USD) {
        return {
            passed: false,
            failedGate: 'VOLUME_24H',
            failedReason: `$${metrics.volume24hUsd.toFixed(0)} < $${HARD_POOL_GATES.MIN_VOLUME_24H_USD}`,
            metrics: metricsObj,
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 4: Fee tier ≤ 1%
    // ───────────────────────────────────────────────────────────────────────────
    if (metrics.feeTier > HARD_POOL_GATES.MAX_FEE_TIER) {
        return {
            passed: false,
            failedGate: 'FEE_TIER',
            failedReason: `${(metrics.feeTier * 100).toFixed(2)}% > ${(HARD_POOL_GATES.MAX_FEE_TIER * 100).toFixed(0)}%`,
            metrics: metricsObj,
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 5: Active bins ≥ 10
    // ───────────────────────────────────────────────────────────────────────────
    if (metrics.activeBins < HARD_POOL_GATES.MIN_ACTIVE_BINS) {
        return {
            passed: false,
            failedGate: 'ACTIVE_BINS',
            failedReason: `${metrics.activeBins} < ${HARD_POOL_GATES.MIN_ACTIVE_BINS}`,
            metrics: metricsObj,
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 6: DEAD POOL DETECTION — Volume-based (not swap count)
    // 
    // Problem: Raw swap count from telemetry can be unreliable/underestimated
    // Solution: Use volume/TVL ratio as proxy for pool activity
    // 
    // Pool is DEAD only if:
    // - swapsPerMinute == 0 AND volume/TVL ratio < minimum
    // This prevents false positives on major pools like SOL/USDC
    // ───────────────────────────────────────────────────────────────────────────
    const volumeToTvlRatio = metrics.tvlUsd > 0 
        ? metrics.volume24hUsd / metrics.tvlUsd 
        : 0;
    
    const isDeadPool = (
        metrics.swapsPerMinute <= HARD_POOL_GATES.MIN_SWAPS_PER_MINUTE &&
        volumeToTvlRatio < HARD_POOL_GATES.MIN_VOLUME_TO_TVL_RATIO
    );
    
    if (isDeadPool) {
        logger.info(
            `[DEAD-POOL-DEBUG] pool=${metrics.name} swapsPerMinute=${metrics.swapsPerMinute.toFixed(2)} ` +
            `volume/tvl=${(volumeToTvlRatio * 100).toFixed(1)}% (min=${(HARD_POOL_GATES.MIN_VOLUME_TO_TVL_RATIO * 100).toFixed(0)}%)`
        );
        return {
            passed: false,
            failedGate: 'DEAD_POOL',
            failedReason: `swaps=${metrics.swapsPerMinute.toFixed(2)}/min vol/tvl=${(volumeToTvlRatio * 100).toFixed(1)}% - pool appears dead`,
            metrics: metricsObj,
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 7: Holder count ≥ 2,000
    // ───────────────────────────────────────────────────────────────────────────
    if (metrics.holderCount < HARD_POOL_GATES.MIN_HOLDER_COUNT) {
        return {
            passed: false,
            failedGate: 'HOLDER_COUNT',
            failedReason: `${metrics.holderCount} < ${HARD_POOL_GATES.MIN_HOLDER_COUNT}`,
            metrics: metricsObj,
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 8: Token immutable (no mint authority)
    // ───────────────────────────────────────────────────────────────────────────
    if (HARD_POOL_GATES.BLOCK_MINTABLE && metrics.isMintable) {
        return {
            passed: false,
            failedGate: 'MINTABLE',
            failedReason: 'Token has mint authority',
            metrics: metricsObj,
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 9: No freeze authority
    // ───────────────────────────────────────────────────────────────────────────
    if (HARD_POOL_GATES.BLOCK_FREEZABLE && metrics.isFreezable) {
        return {
            passed: false,
            failedGate: 'FREEZABLE',
            failedReason: 'Token has freeze authority',
            metrics: metricsObj,
        };
    }
    
    // ───────────────────────────────────────────────────────────────────────────
    // GATE 10: Non-hidden, non-synthetic
    // ───────────────────────────────────────────────────────────────────────────
    if (HARD_POOL_GATES.BLOCK_HIDDEN_SYNTHETIC && metrics.isHidden) {
        return {
            passed: false,
            failedGate: 'HIDDEN_SYNTHETIC',
            failedReason: 'Pool is hidden or synthetic',
            metrics: metricsObj,
        };
    }
    
    // All gates passed
    return {
        passed: true,
        metrics: metricsObj,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYBACK TIME GATE — FEE VELOCITY CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate entry cost in USD
 */
export function calculateEntryCost(positionSizeUsd: number): number {
    const entryFee = positionSizeUsd * PAYBACK_GATE_CONFIG.ENTRY_COST.BASE_FEE_PCT;
    const entrySlippage = positionSizeUsd * PAYBACK_GATE_CONFIG.ENTRY_COST.SLIPPAGE_PCT;
    const exitFee = positionSizeUsd * PAYBACK_GATE_CONFIG.EXIT_COST.BASE_FEE_PCT;
    const exitSlippage = positionSizeUsd * PAYBACK_GATE_CONFIG.EXIT_COST.SLIPPAGE_PCT;
    const txFees = PAYBACK_GATE_CONFIG.ENTRY_COST.TX_FEE_USD + PAYBACK_GATE_CONFIG.EXIT_COST.TX_FEE_USD;
    
    return entryFee + entrySlippage + exitFee + exitSlippage + txFees;
}

/**
 * Calculate POSITION-ATTRIBUTABLE fees per minute.
 * 
 * CRITICAL: This is NOT pool-level fees × position share.
 * Position only captures fees from trades that cross its bins.
 * 
 * Formula:
 *   poolFeesPerMinute = fees24hUsd / (24 * 60)
 *   attributableFees = poolFeesPerMinute × positionShare × binCoverageRatio
 * 
 * UNIT FIX: Previous code had a bug multiplying by TVL which caused
 * fees/min=$12600 type errors. Now correctly uses only 24h fee data.
 */
export function calculateFeesPerMinute(
    positionSizeUsd: number,
    poolTvlUsd: number,
    fees24hUsd: number,
    _feeIntensity: number,  // Deprecated - not used due to unit confusion
    positionBinCount: number = 10,  // Default to bin strategy HARVEST mode
    totalActiveBins: number = 50    // Pool's total active bins
): number {
    if (poolTvlUsd <= 0) return 0;
    if (totalActiveBins <= 0) return 0;
    if (fees24hUsd <= 0) return 0;
    
    // Position share of pool (TVL-based)
    const positionShare = positionSizeUsd / poolTvlUsd;
    
    // BIN COVERAGE RATIO — Critical for position-attributable fees
    // If position covers 10 bins out of 50 active, it only captures ~20% of volume
    const binCoverageRatio = Math.min(1, positionBinCount / totalActiveBins);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SINGLE SOURCE OF TRUTH: 24h fees (most reliable data)
    // ═══════════════════════════════════════════════════════════════════════════
    const poolFeesPerMinute = fees24hUsd / (24 * 60);  // Total pool fees per minute
    const attributableFees = poolFeesPerMinute * positionShare * binCoverageRatio;
    
    // Log raw components for debugging unit issues
    logger.info(
        `[FEE-VELOCITY-DEBUG] ` +
        `fees24h=$${fees24hUsd.toFixed(2)} → poolFees/min=$${poolFeesPerMinute.toFixed(4)} | ` +
        `posShare=${(positionShare * 100).toFixed(2)}% | ` +
        `binCoverage=${(binCoverageRatio * 100).toFixed(1)}% (${positionBinCount}/${totalActiveBins}) | ` +
        `→ attributable=$${attributableFees.toFixed(4)}/min`
    );
    
    return attributableFees;
}

/**
 * Evaluate payback time gate using POSITION-ATTRIBUTABLE fees
 */
export function evaluatePaybackGate(metrics: PoolMetricsForGate): PaybackGateResult {
    const entryCost = calculateEntryCost(metrics.positionSizeUsd);
    
    // Use position bin count for accurate fee attribution
    // Default to HARVEST mode (10 bins) if not specified
    const positionBins = metrics.positionBinCount ?? 10;
    const totalActiveBins = metrics.activeBins > 0 ? metrics.activeBins : 50;
    
    const feesPerMinute = calculateFeesPerMinute(
        metrics.positionSizeUsd,
        metrics.tvlUsd,
        metrics.fees24hUsd,
        metrics.feeIntensity,
        positionBins,
        totalActiveBins
    );
    
    // Handle zero fees
    if (feesPerMinute <= 0) {
        return {
            passed: false,
            paybackMinutes: Infinity,
            entryCostUsd: entryCost,
            feesPerMinuteUsd: 0,
            blockReason: 'Zero fee velocity detected',
        };
    }
    
    const paybackMinutes = entryCost / feesPerMinute;
    
    // Calculate bin coverage for logging
    const binCoverage = ((positionBins / totalActiveBins) * 100).toFixed(1);
    
    // Log payback calculation with position-attributable context
    logger.info(
        `[PAYBACK] cost=$${entryCost.toFixed(2)} fees/min=$${feesPerMinute.toFixed(4)} ` +
        `payback=${paybackMinutes.toFixed(0)}m binCoverage=${binCoverage}% (${positionBins}/${totalActiveBins})`
    );
    
    if (paybackMinutes > PAYBACK_GATE_CONFIG.MAX_PAYBACK_MINUTES) {
        return {
            passed: false,
            paybackMinutes,
            entryCostUsd: entryCost,
            feesPerMinuteUsd: feesPerMinute,
            blockReason: `Payback ${paybackMinutes.toFixed(0)}m > ${PAYBACK_GATE_CONFIG.MAX_PAYBACK_MINUTES}m max`,
        };
    }
    
    return {
        passed: true,
        paybackMinutes,
        entryCostUsd: entryCost,
        feesPerMinuteUsd: feesPerMinute,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FEE VELOCITY GATE — COMBINED EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate fee velocity gate for a pool.
 * 
 * This is the main entry point that combines:
 * 1. Hard pool gates (binary filters)
 * 2. Payback time gate (fee velocity requirement)
 * 3. Bootstrap mode override
 */
export function evaluateFeeVelocityGate(metrics: PoolMetricsForGate): FeeVelocityGateResult {
    const isBootstrap = isBootstrapModeActive();
    const bootstrapRemaining = getBootstrapTimeRemaining();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 1: HARD POOL GATES (always evaluated, even during bootstrap)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const hardGate = evaluateHardGates(metrics);
    
    // During bootstrap, only some hard gates block
    if (!hardGate.passed && !isBootstrap) {
        logRejection(metrics.address, metrics.name, `HARD_GATE:${hardGate.failedGate}`, hardGate.failedReason!);
        
        return {
            allowed: false,
            reason: `Hard gate failed: ${hardGate.failedGate} - ${hardGate.failedReason}`,
            finalSize: 0,
            hardGate,
            paybackGate: { passed: false, paybackMinutes: 0, entryCostUsd: 0, feesPerMinuteUsd: 0 },
            isBootstrapMode: isBootstrap,
            bootstrapTimeRemainingMs: bootstrapRemaining,
            deployReason: 'blocked',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BOOTSTRAP MODE: Relaxed gating for first 6 hours
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (isBootstrap) {
        // Check bootstrap-specific blocks
        const entryCost = calculateEntryCost(metrics.positionSizeUsd);
        
        // Block: Catastrophic cost
        if (entryCost > BOOTSTRAP_CONFIG.BOOTSTRAP_BLOCKS.MAX_COST_USD) {
            logRejection(metrics.address, metrics.name, 'BOOTSTRAP_COST', 
                `Entry cost $${entryCost.toFixed(2)} > $${BOOTSTRAP_CONFIG.BOOTSTRAP_BLOCKS.MAX_COST_USD}`);
            
            return {
                allowed: false,
                reason: `Bootstrap block: Entry cost $${entryCost.toFixed(2)} exceeds $${BOOTSTRAP_CONFIG.BOOTSTRAP_BLOCKS.MAX_COST_USD}`,
                finalSize: 0,
                hardGate,
                paybackGate: { passed: false, paybackMinutes: 0, entryCostUsd: entryCost, feesPerMinuteUsd: 0 },
                isBootstrapMode: true,
                bootstrapTimeRemainingMs: bootstrapRemaining,
                deployReason: 'blocked',
            };
        }
        
        // Block: Size violation
        const sizePct = metrics.positionSizeUsd / metrics.totalEquity;
        if (sizePct > BOOTSTRAP_CONFIG.BOOTSTRAP_BLOCKS.MAX_SIZE_PCT) {
            logRejection(metrics.address, metrics.name, 'BOOTSTRAP_SIZE',
                `Size ${(sizePct * 100).toFixed(1)}% > ${(BOOTSTRAP_CONFIG.BOOTSTRAP_BLOCKS.MAX_SIZE_PCT * 100).toFixed(0)}%`);
            
            return {
                allowed: false,
                reason: `Bootstrap block: Size ${(sizePct * 100).toFixed(1)}% exceeds ${(BOOTSTRAP_CONFIG.BOOTSTRAP_BLOCKS.MAX_SIZE_PCT * 100).toFixed(0)}%`,
                finalSize: 0,
                hardGate,
                paybackGate: { passed: false, paybackMinutes: 0, entryCostUsd: entryCost, feesPerMinuteUsd: 0 },
                isBootstrapMode: true,
                bootstrapTimeRemainingMs: bootstrapRemaining,
                deployReason: 'blocked',
            };
        }
        
        // Block: Dead pool (zero fees)
        if (BOOTSTRAP_CONFIG.BOOTSTRAP_BLOCKS.DEAD_POOL && metrics.fees24hUsd <= 0 && metrics.feeIntensity <= 0) {
            logRejection(metrics.address, metrics.name, 'BOOTSTRAP_DEAD', 'Zero fee activity');
            
            return {
                allowed: false,
                reason: 'Bootstrap block: Dead pool (zero fee activity)',
                finalSize: 0,
                hardGate,
                paybackGate: { passed: false, paybackMinutes: 0, entryCostUsd: entryCost, feesPerMinuteUsd: 0 },
                isBootstrapMode: true,
                bootstrapTimeRemainingMs: bootstrapRemaining,
                deployReason: 'blocked',
            };
        }
        
        // Bootstrap allows entry - calculate payback for logging only
        const feesPerMinute = calculateFeesPerMinute(
            metrics.positionSizeUsd,
            metrics.tvlUsd,
            metrics.fees24hUsd,
            metrics.feeIntensity
        );
        const paybackMinutes = feesPerMinute > 0 ? entryCost / feesPerMinute : Infinity;
        
        logger.info(
            `[DEPLOY-REASON] bootstrap | pool=${metrics.name} | ` +
            `timeRemaining=${(bootstrapRemaining / (60 * 60 * 1000)).toFixed(1)}h | ` +
            `payback=${paybackMinutes.toFixed(0)}m (not enforced)`
        );
        
        return {
            allowed: true,
            reason: 'Bootstrap mode active - relaxed gating',
            finalSize: metrics.positionSizeUsd,
            hardGate,
            paybackGate: {
                passed: true, // Not enforced during bootstrap
                paybackMinutes,
                entryCostUsd: entryCost,
                feesPerMinuteUsd: feesPerMinute,
            },
            isBootstrapMode: true,
            bootstrapTimeRemainingMs: bootstrapRemaining,
            deployReason: 'bootstrap',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 2: PAYBACK TIME GATE (strict mode after bootstrap)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const paybackGate = evaluatePaybackGate(metrics);
    
    if (!paybackGate.passed) {
        logRejection(metrics.address, metrics.name, 'PAYBACK', paybackGate.blockReason!);
        
        return {
            allowed: false,
            reason: `Payback gate failed: ${paybackGate.blockReason}`,
            finalSize: 0,
            hardGate,
            paybackGate,
            isBootstrapMode: false,
            bootstrapTimeRemainingMs: 0,
            deployReason: 'blocked',
        };
    }
    
    // All gates passed
    logger.info(
        `[DEPLOY-REASON] payback_ok | pool=${metrics.name} | ` +
        `payback=${paybackGate.paybackMinutes.toFixed(0)}m | ` +
        `cost=$${paybackGate.entryCostUsd.toFixed(2)} | ` +
        `fees/min=$${paybackGate.feesPerMinuteUsd.toFixed(4)}`
    );
    
    return {
        allowed: true,
        reason: `Payback OK: ${paybackGate.paybackMinutes.toFixed(0)} minutes`,
        finalSize: metrics.positionSizeUsd,
        hardGate,
        paybackGate,
        isBootstrapMode: false,
        bootstrapTimeRemainingMs: 0,
        deployReason: 'payback_ok',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log pool rejection with reason
 */
function logRejection(address: string, name: string, gate: string, reason: string): void {
    rejectedPools.set(address, `${gate}: ${reason}`);
    
    logger.info(
        `[GATE-REJECT] pool=${name} gate=${gate} reason="${reason}"`
    );
}

/**
 * Get rejected pools summary for this cycle
 */
export function getRejectedPoolsSummary(): Map<string, string> {
    return new Map(rejectedPools);
}

/**
 * Clear rejected pools (call at start of each cycle)
 */
export function clearRejectedPools(): void {
    rejectedPools.clear();
}

/**
 * Log fee velocity summary for a pool
 */
export function logFeeVelocity(
    poolName: string,
    feesPerHour: number,
    entryCost: number,
    elapsed: number
): void {
    logger.info(
        `[FEE-VELOCITY] pool=${poolName} fees/hour=$${feesPerHour.toFixed(2)}`
    );
    
    logger.info(
        `[COST-AMORTIZATION] pool=${poolName} elapsed=${(elapsed / 60000).toFixed(0)}m cost=$${entryCost.toFixed(2)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert Tier4EnrichedPool to PoolMetricsForGate
 */
export function poolToGateMetrics(
    pool: Tier4EnrichedPool,
    positionSizeUsd: number,
    totalEquity: number
): PoolMetricsForGate {
    const microMetrics = pool.microMetrics;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SWAP VELOCITY CALCULATION — FIXED
    // ═══════════════════════════════════════════════════════════════════════════
    // 
    // Problem: swapVelocity is 0-100 normalized where 100 = 1 swap/sec (capped)
    // This severely underestimates high-volume pools like SOL/USDC
    //
    // Solution: Use rawSwapCount if available, otherwise estimate from volume
    // ═══════════════════════════════════════════════════════════════════════════
    
    let swapsPerMinute = 0;
    const rawSwapCount = (microMetrics as any)?.rawSwapCount ?? 0;
    const volume24h = pool.volume24h || 0;
    const tvl = pool.liquidity || (pool as any).tvl || 0;
    
    if (rawSwapCount > 0) {
        // Best: Use actual raw swap count (per snapshot window, typically 1-5 min)
        // Assume snapshot window is ~2 minutes
        swapsPerMinute = rawSwapCount / 2;
    } else if (volume24h > 0 && tvl > 0) {
        // Fallback: Estimate from volume assuming avg trade size = TVL/50
        const avgTradeSize = tvl / 50;
        const tradesPerDay = volume24h / avgTradeSize;
        swapsPerMinute = tradesPerDay / (24 * 60);
    } else {
        // Last resort: Use normalized swapVelocity (0-100 scale)
        const normalizedVelocity = microMetrics?.swapVelocity ?? 0;
        // swapVelocity 100 = 1 swap/sec = 60 swaps/min, but it's capped
        // So we scale more generously for high values
        swapsPerMinute = (normalizedVelocity / 100) * 60;
    }
    
    // Log raw inputs for debugging DEAD_POOL issues
    logger.debug(
        `[SWAP-VELOCITY-DEBUG] pool=${pool.name} ` +
        `rawSwapCount=${rawSwapCount} swapVelocity=${microMetrics?.swapVelocity ?? 0} ` +
        `volume24h=$${volume24h.toFixed(0)} tvl=$${tvl.toFixed(0)} ` +
        `→ swapsPerMinute=${swapsPerMinute.toFixed(2)}`
    );
    
    return {
        address: pool.address,
        name: pool.name,
        createdAt: (pool as any).createdAt,
        tvlUsd: tvl,
        volume24hUsd: volume24h,
        feeTier: (pool as any).feeRate ?? (pool.binStep ? pool.binStep / 10000 : 0.003),
        activeBins: (pool as any).activeBins || (microMetrics as any)?.activeBins || 0,
        swapsPerMinute,
        holderCount: (pool as any).holderCount || (pool as any).holders || 0,
        isMintable: (pool as any).isMintable ?? false,
        isFreezable: (pool as any).isFreezable ?? false,
        isHidden: (pool as any).isHidden ?? false,
        fees24hUsd: pool.fees24h || 0,
        feeIntensity: microMetrics?.feeIntensity ?? 0,
        positionSizeUsd,
        totalEquity,
    };
}


