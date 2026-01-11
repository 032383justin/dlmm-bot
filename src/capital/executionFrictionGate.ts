/**
 * Execution Friction Gate — Predator-Safe Entry Filter
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * OBJECTIVE:
 * Prevent entries where execution friction cannot be realistically repaid by
 * either fee capture or short-term price displacement under aggressive bin
 * dominance. This gate blocks ONLY structurally unwinnable trades, not reduce
 * aggression.
 * 
 * DECISION RULE:
 *   ALLOW entry if: max(feePaybackPossible, pricePaybackPossible) >= requiredPaybackUsd
 *   REJECT otherwise
 * 
 * This gate:
 *   ✅ Preserves maximum aggression
 *   ✅ Supports 288 rebalances/day
 *   ✅ Compatible with bin dominance
 *   ✅ Removes only structural losers
 *   ❌ Does NOT require high APY
 *   ❌ Does NOT penalize low-fee pools if price edge exists
 *   ❌ Does NOT affect pool scoring
 *   ❌ Does NOT affect future eligibility
 *   ❌ Does NOT affect kill-switch logic
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const FRICTION_GATE_CONFIG = {
    /** Safety multiplier for required payback (do NOT exceed 1.25 for predator) */
    SAFETY_MULTIPLIER: 1.15,
    
    /** Maximum hold time for payback estimation (minutes) */
    MAX_PREDATOR_HOLD_MINUTES: 90,
    
    /** Default estimated entry fee (USD) when not provided */
    DEFAULT_ENTRY_FEE_USD: 0.01,
    
    /** Default estimated exit fee (USD) when not provided */
    DEFAULT_EXIT_FEE_USD: 0.01,
    
    /** Default estimated entry slippage (USD) when not provided */
    DEFAULT_ENTRY_SLIPPAGE_USD: 0.02,
    
    /** Default estimated exit slippage (USD) when not provided */
    DEFAULT_EXIT_SLIPPAGE_USD: 0.02,
    
    /** Default bin share estimate when not calculated */
    DEFAULT_BIN_SHARE: 0.25,
    
    /** Default rebalance compression percent */
    DEFAULT_REBALANCE_COMPRESSION_PCT: 0.002,  // 0.2%
    
    /** Default dominance pressure percent */
    DEFAULT_DOMINANCE_PRESSURE_PCT: 0.003,  // 0.3%
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ExecutionFrictionInput {
    poolAddress: string;
    poolName: string;
    
    // Position sizing
    positionNotionalUsd: number;
    
    // Execution costs (all in USD)
    estimatedEntryFeeUsd?: number;
    estimatedExitFeeUsd?: number;
    estimatedEntrySlippageUsd?: number;
    estimatedExitSlippageUsd?: number;
    
    // Fee payback velocity inputs
    poolSwapVolume1h: number;      // USD volume in last hour
    poolFeeRate: number;           // Pool fee rate (e.g., 0.0025 for 0.25%)
    estimatedBinShare?: number;    // Our estimated share of active bin (0-1)
    
    // Price displacement inputs
    recentBinDisplacementPct?: number;   // Recent bin displacement (0-1)
    dominancePressurePct?: number;       // Dominance pressure estimate (0-1)
    rebalanceCompressionPct?: number;    // Rebalance compression (0-1)
}

export interface ExecutionFrictionResult {
    allowed: boolean;
    
    // Computed costs
    roundTripCostUsd: number;
    requiredPaybackUsd: number;
    
    // Payback paths
    feePaybackPossible: number;
    pricePaybackPossible: number;
    
    // Which path is dominant
    dominantPath: 'FEE' | 'PRICE';
    
    // Rejection reason (if rejected)
    reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE GATE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate Execution Friction Gate
 * 
 * Runs after pool selection and before position creation.
 * Blocks ONLY structurally unwinnable trades.
 */
export function evaluateExecutionFrictionGate(input: ExecutionFrictionInput): ExecutionFrictionResult {
    const config = FRICTION_GATE_CONFIG;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Compute Real Execution Cost (USD)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const entryFee = input.estimatedEntryFeeUsd ?? config.DEFAULT_ENTRY_FEE_USD;
    const exitFee = input.estimatedExitFeeUsd ?? config.DEFAULT_EXIT_FEE_USD;
    const entrySlippage = input.estimatedEntrySlippageUsd ?? config.DEFAULT_ENTRY_SLIPPAGE_USD;
    const exitSlippage = input.estimatedExitSlippageUsd ?? config.DEFAULT_EXIT_SLIPPAGE_USD;
    
    const roundTripCostUsd = entryFee + exitFee + entrySlippage + exitSlippage;
    
    // Apply safety multiplier (capped at 1.25 for predator mode)
    const requiredPaybackUsd = roundTripCostUsd * config.SAFETY_MULTIPLIER;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2A: Fee Payback Velocity (Slow Path)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const binShare = input.estimatedBinShare ?? config.DEFAULT_BIN_SHARE;
    
    // Expected fee per hour = volume × feeRate × binShare
    const expectedFeePerHourUsd = input.poolSwapVolume1h * input.poolFeeRate * binShare;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2B: Bin-Bullying Price Displacement (Fast Path)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const recentDisplacement = input.recentBinDisplacementPct ?? config.DEFAULT_REBALANCE_COMPRESSION_PCT;
    const dominancePressure = input.dominancePressurePct ?? config.DEFAULT_DOMINANCE_PRESSURE_PCT;
    const rebalanceCompression = input.rebalanceCompressionPct ?? config.DEFAULT_REBALANCE_COMPRESSION_PCT;
    
    // Use minimum of all displacement estimates (conservative)
    const achievableEdgePct = Math.min(recentDisplacement, dominancePressure, rebalanceCompression);
    
    // Expected price edge = notional × achievable edge
    const expectedPriceEdgeUsd = input.positionNotionalUsd * achievableEdgePct;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Bounded Time Horizon Check
    // ═══════════════════════════════════════════════════════════════════════════
    
    const holdHours = config.MAX_PREDATOR_HOLD_MINUTES / 60;
    
    // Fee payback possible = fee/hour × hold hours
    const feePaybackPossible = expectedFeePerHourUsd * holdHours;
    
    // Price payback possible = expected price edge
    const pricePaybackPossible = expectedPriceEdgeUsd;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: ENTRY DECISION RULE
    // ═══════════════════════════════════════════════════════════════════════════
    
    const maxPaybackPossible = Math.max(feePaybackPossible, pricePaybackPossible);
    const dominantPath: 'FEE' | 'PRICE' = feePaybackPossible >= pricePaybackPossible ? 'FEE' : 'PRICE';
    
    const allowed = maxPaybackPossible >= requiredPaybackUsd;
    
    // Log decision
    const decision = allowed ? 'ALLOW' : 'REJECT';
    logger.info(
        `[ENTRY-FRICTION] pool=${input.poolName} ` +
        `requiredPaybackUsd=$${requiredPaybackUsd.toFixed(4)} ` +
        `feePaybackPossible=$${feePaybackPossible.toFixed(4)} ` +
        `pricePaybackPossible=$${pricePaybackPossible.toFixed(4)} ` +
        `decision=${decision}`
    );
    
    if (!allowed) {
        logger.warn(
            `[ENTRY-GATE] REJECTED: EXECUTION_FRICTION_UNPAYABLE | ` +
            `pool=${input.poolName} | ` +
            `requiredPaybackUsd=$${requiredPaybackUsd.toFixed(4)} | ` +
            `feePaybackPossible=$${feePaybackPossible.toFixed(4)} | ` +
            `pricePaybackPossible=$${pricePaybackPossible.toFixed(4)} | ` +
            `roundTripCost=$${roundTripCostUsd.toFixed(4)}`
        );
    }
    
    return {
        allowed,
        roundTripCostUsd,
        requiredPaybackUsd,
        feePaybackPossible,
        pricePaybackPossible,
        dominantPath,
        reason: allowed ? undefined : 'EXECUTION_FRICTION_UNPAYABLE',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Estimate Execution Costs from Pool Metrics
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Estimate execution costs based on pool TVL and position size
 */
export function estimateExecutionCosts(
    positionSizeUsd: number,
    poolTvlUsd: number,
    poolFeeRate: number,
): {
    entryFeeUsd: number;
    exitFeeUsd: number;
    entrySlippageUsd: number;
    exitSlippageUsd: number;
} {
    // Fee is straightforward: positionSize × feeRate
    const feeUsd = positionSizeUsd * poolFeeRate;
    
    // Slippage estimate based on position size relative to TVL
    // Larger positions relative to TVL = more slippage
    const sizeRatio = poolTvlUsd > 0 ? positionSizeUsd / poolTvlUsd : 0.01;
    const slippagePct = Math.min(0.01, sizeRatio * 0.5);  // Cap at 1%
    const slippageUsd = positionSizeUsd * slippagePct;
    
    return {
        entryFeeUsd: feeUsd,
        exitFeeUsd: feeUsd,
        entrySlippageUsd: slippageUsd,
        exitSlippageUsd: slippageUsd,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Estimate Bin Share from Dominance Metrics
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Estimate expected bin share based on dominance tracking
 */
export function estimateBinShare(
    ourLiquidityUsd: number,
    totalBinLiquidityUsd: number,
    dominanceState?: 'DOMINANT' | 'WEAK' | 'FAILED' | 'UNKNOWN',
): number {
    // If we have actual liquidity data, use it
    if (totalBinLiquidityUsd > 0) {
        return Math.min(1.0, ourLiquidityUsd / totalBinLiquidityUsd);
    }
    
    // Otherwise, estimate based on dominance state
    switch (dominanceState) {
        case 'DOMINANT':
            return 0.30;  // 30% share expected
        case 'WEAK':
            return 0.15;  // 15% share expected
        case 'FAILED':
            return 0.05;  // 5% share expected
        default:
            return FRICTION_GATE_CONFIG.DEFAULT_BIN_SHARE;  // 25% default
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Estimate Price Displacement Metrics
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Estimate price displacement metrics from pool telemetry
 */
export function estimatePriceDisplacement(
    binVelocity: number,
    volatilityPctPerHour: number,
    rebalancesPerDay: number,
): {
    recentBinDisplacementPct: number;
    dominancePressurePct: number;
    rebalanceCompressionPct: number;
} {
    // Higher bin velocity = more displacement opportunity
    const binDisplacement = Math.min(0.01, binVelocity * 0.001);
    
    // Higher volatility = more pressure opportunity
    const dominancePressure = Math.min(0.01, volatilityPctPerHour * 0.1);
    
    // More rebalances = more compression opportunity
    const rebalanceCompression = Math.min(0.005, (rebalancesPerDay / 288) * 0.005);
    
    return {
        recentBinDisplacementPct: binDisplacement,
        dominancePressurePct: dominancePressure,
        rebalanceCompressionPct: rebalanceCompression,
    };
}
