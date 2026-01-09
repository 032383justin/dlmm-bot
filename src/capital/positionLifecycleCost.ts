/**
 * Position Lifecycle Cost Estimator — Realistic Cost Model for Exit Suppression
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * FIX: costTarget was set too high (entry+exit swap fees + slippage) causing
 * perpetual COST_NOT_AMORTIZED suppression. Real LP lifecycle costs are much lower.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * NEW COST MODEL:
 *   costTarget = (txCostUsd + impactCostUsd) × SAFETY_FACTOR
 * 
 * WHERE:
 *   - txCostUsd = transaction fees for enter + exit (priority fees + compute)
 *   - impactCostUsd = price impact / slippage for LP actions (usually 0 for LP)
 *   - SAFETY_FACTOR = 1.25 (25% buffer for variability)
 * 
 * KEY INSIGHT:
 *   LP positions do NOT pay swap fees like takers. The old model was using
 *   0.3% entry + 0.3% exit + 0.2% slippage = 0.8% of notional as costTarget.
 *   For $2800 notional, that's $22.40 — unrealistic for LP operations.
 * 
 *   Real LP costs are:
 *   - Tx costs: ~$0.40 per tx × 2 (enter + exit) = ~$0.80
 *   - Price impact: typically 0 for LP (we're adding liquidity, not swapping)
 *   - With safety factor: ~$1.00
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — Environment-Overridable Defaults
// ═══════════════════════════════════════════════════════════════════════════════

export const LIFECYCLE_COST_CONFIG = {
    /**
     * USD cost per on-chain action (transaction)
     * Covers priority fees + compute costs
     * Default: $0.40 (conservative for Solana with priority fees)
     */
    COST_TX_USD_PER_ACTION: parseFloat(process.env.COST_TX_USD_PER_ACTION ?? '0.40'),
    
    /**
     * Number of on-chain actions per LP lifecycle (enter + exit)
     * Default: 2
     */
    COST_ACTIONS_PER_LIFECYCLE: parseInt(process.env.COST_ACTIONS_PER_LIFECYCLE ?? '2', 10),
    
    /**
     * Price impact in basis points for LP operations
     * Default: 0 (LP does not incur taker swap fees)
     * Set to non-zero only if actual swap-based entry/exit is used
     */
    COST_IMPACT_BPS: parseFloat(process.env.COST_IMPACT_BPS ?? '0'),
    
    /**
     * Safety factor multiplier for cost target
     * Default: 1.25 (25% buffer)
     */
    COST_SAFETY_FACTOR: parseFloat(process.env.COST_SAFETY_FACTOR ?? '1.25'),
    
    /**
     * Minimum cost target floor (avoid zero)
     * Default: $0.75
     */
    MIN_COST_TARGET_USD: parseFloat(process.env.MIN_COST_TARGET_USD ?? '0.75'),
    
    /**
     * Maximum cost target as percentage of notional (hard clamp)
     * Default: 0.30% (0.003)
     * Prevents runaway cost targets from blocking all exits
     */
    MAX_COST_TARGET_PCT_OF_NOTIONAL: parseFloat(process.env.MAX_COST_TARGET_PCT ?? '0.003'),
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Position data for cost estimation
 */
export interface PositionForCostEstimate {
    /** Current notional value in USD */
    notionalUsd: number;
    /** Entry notional (optional, for comparison) */
    entryNotionalUsd?: number;
    /** Pool address for logging */
    poolAddress?: string;
}

/**
 * Full cost breakdown for transparency and logging
 */
export interface LifecycleCostEstimate {
    /** Transaction cost (priority fees + compute) */
    txCostUsd: number;
    
    /** Price impact cost (usually 0 for LP) */
    impactCostUsd: number;
    
    /** Total raw cost before safety factor */
    totalRawCostUsd: number;
    
    /** Safety factor applied */
    safetyFactor: number;
    
    /** Final cost target after safety factor */
    costTargetUsd: number;
    
    /** Whether a clamp was applied */
    clampApplied: boolean;
    
    /** Clamp type if applied */
    clampType?: 'MIN_FLOOR' | 'MAX_PCT_CAP';
    
    /** The notional used for calculation */
    notionalUsd: number;
    
    /** Config values used (for logging) */
    config: {
        txPerAction: number;
        actionsPerLifecycle: number;
        impactBps: number;
        safetyFactor: number;
        minFloor: number;
        maxPctCap: number;
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ESTIMATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Estimate position lifecycle cost for exit suppression.
 * 
 * This is the NEW cost model that replaces the old "swap fees twice" approach.
 * 
 * @param position - Position data (notionalUsd required)
 * @returns Full cost breakdown including costTargetUsd
 */
export function estimatePositionLifecycleCostUsd(
    position: PositionForCostEstimate
): LifecycleCostEstimate {
    const config = LIFECYCLE_COST_CONFIG;
    
    // Transaction costs: fixed per-action cost × number of actions
    const txCostUsd = config.COST_TX_USD_PER_ACTION * config.COST_ACTIONS_PER_LIFECYCLE;
    
    // Impact cost: BPS of notional (usually 0 for LP operations)
    const impactCostUsd = position.notionalUsd * (config.COST_IMPACT_BPS / 10000);
    
    // Total raw cost
    const totalRawCostUsd = txCostUsd + impactCostUsd;
    
    // Apply safety factor
    let costTargetUsd = totalRawCostUsd * config.COST_SAFETY_FACTOR;
    
    // Apply clamps
    let clampApplied = false;
    let clampType: 'MIN_FLOOR' | 'MAX_PCT_CAP' | undefined = undefined;
    
    // Floor clamp: minimum cost target
    if (costTargetUsd < config.MIN_COST_TARGET_USD) {
        costTargetUsd = config.MIN_COST_TARGET_USD;
        clampApplied = true;
        clampType = 'MIN_FLOOR';
    }
    
    // Ceiling clamp: maximum as percentage of notional
    const maxCostTarget = position.notionalUsd * config.MAX_COST_TARGET_PCT_OF_NOTIONAL;
    if (costTargetUsd > maxCostTarget && maxCostTarget > config.MIN_COST_TARGET_USD) {
        costTargetUsd = maxCostTarget;
        clampApplied = true;
        clampType = 'MAX_PCT_CAP';
    }
    
    return {
        txCostUsd,
        impactCostUsd,
        totalRawCostUsd,
        safetyFactor: config.COST_SAFETY_FACTOR,
        costTargetUsd,
        clampApplied,
        clampType,
        notionalUsd: position.notionalUsd,
        config: {
            txPerAction: config.COST_TX_USD_PER_ACTION,
            actionsPerLifecycle: config.COST_ACTIONS_PER_LIFECYCLE,
            impactBps: config.COST_IMPACT_BPS,
            safetyFactor: config.COST_SAFETY_FACTOR,
            minFloor: config.MIN_COST_TARGET_USD,
            maxPctCap: config.MAX_COST_TARGET_PCT_OF_NOTIONAL,
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format lifecycle cost estimate for logging
 */
export function formatCostEstimate(estimate: LifecycleCostEstimate): string {
    const clampInfo = estimate.clampApplied 
        ? ` clamp=${estimate.clampType}` 
        : '';
    
    return (
        `txCost=$${estimate.txCostUsd.toFixed(2)} ` +
        `impact=$${estimate.impactCostUsd.toFixed(2)} ` +
        `raw=$${estimate.totalRawCostUsd.toFixed(2)} ` +
        `×${estimate.safetyFactor.toFixed(2)} ` +
        `→ costTarget=$${estimate.costTargetUsd.toFixed(2)} ` +
        `notional=$${estimate.notionalUsd.toFixed(2)}` +
        clampInfo
    );
}

/**
 * Log a cost estimate with full breakdown
 */
export function logCostEstimate(
    estimate: LifecycleCostEstimate,
    poolName: string,
    context: string = 'COST_ESTIMATE'
): void {
    logger.debug(
        `[${context}] pool=${poolName} ${formatCostEstimate(estimate)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPARISON UTILITY (for migration/debugging)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compare old vs new cost model for a given position.
 * Useful for verifying the fix during rollout.
 */
export function compareOldVsNewCostModel(
    notionalUsd: number,
    oldEntryFeeRate: number = 0.003,
    oldExitFeeRate: number = 0.003,
    oldSlippageRate: number = 0.002,
    oldAmortizationFactor: number = 1.10
): {
    oldCostTarget: number;
    newCostTarget: number;
    reduction: number;
    reductionPct: number;
} {
    // Old model: swap fees + slippage
    const oldCostTarget = (
        (notionalUsd * oldEntryFeeRate) +
        (notionalUsd * oldExitFeeRate) +
        (notionalUsd * oldSlippageRate)
    ) * oldAmortizationFactor;
    
    // New model: transaction costs only
    const newEstimate = estimatePositionLifecycleCostUsd({ notionalUsd });
    const newCostTarget = newEstimate.costTargetUsd;
    
    const reduction = oldCostTarget - newCostTarget;
    const reductionPct = (reduction / oldCostTarget) * 100;
    
    return {
        oldCostTarget,
        newCostTarget,
        reduction,
        reductionPct,
    };
}

/**
 * Log cost model comparison
 */
export function logCostModelComparison(notionalUsd: number, poolName: string): void {
    const comparison = compareOldVsNewCostModel(notionalUsd);
    
    logger.info(
        `[COST_MODEL_COMPARISON] pool=${poolName} notional=$${notionalUsd.toFixed(2)} | ` +
        `OLD=$${comparison.oldCostTarget.toFixed(2)} → ` +
        `NEW=$${comparison.newCostTarget.toFixed(2)} ` +
        `(↓${comparison.reductionPct.toFixed(0)}%)`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    LIFECYCLE_COST_CONFIG as CostConfig,
};

