/**
 * Fee-Bleed Failsafe — Rolling Fee/Slippage Loss Monitor
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 DOMINANT — DEATH BY FEES PREVENTION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Detect when the bot is bleeding capital through fees and slippage
 * faster than it can earn, and automatically tighten trading parameters.
 * 
 * ACTIVATION CONDITIONS (ALL must be true):
 *   - Net realized PnL < 0 over rolling window
 *   - > 70% of losses are fees + slippage
 *   - No positive EV trades in last N cycles
 * 
 * DEFENSIVE ACTIONS:
 *   1. Automatically tighten EV gate (increase required ratio)
 *   2. Reduce trade frequency (increase cooldown between entries)
 *   3. Prefer HOLD over EXIT where safe (avoid exit fees)
 * 
 * LOGS: [FEE-BLEED-DEFENSE] activated/deactivated with metrics
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — ALL JUSTIFIED
// ═══════════════════════════════════════════════════════════════════════════════

export const FEE_BLEED_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // DETECTION THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Rolling window size (number of cycles) for fee bleed detection
     * Justification: 20 cycles at 2-minute intervals = 40 minutes,
     * enough to detect persistent fee bleed patterns
     */
    rollingWindowCycles: 20,
    
    /**
     * Minimum trades in window to evaluate (avoid false positives on low sample)
     * Justification: Need at least 3 trades to establish a pattern
     */
    minTradesForEvaluation: 3,
    
    /**
     * Fee/slippage loss percentage threshold to trigger defense
     * Justification: If >70% of losses are from fees/slippage (not price),
     * we're bleeding to infrastructure costs
     */
    feeSlippageLossThresholdPct: 0.70, // 70%
    
    /**
     * Maximum cycles without positive EV trade before triggering defense
     * Justification: If we haven't had a positive EV trade in 10 cycles,
     * market conditions are adverse
     */
    maxCyclesWithoutPositiveEV: 10,
    
    /**
     * Minimum total loss (USD) to trigger defense
     * Justification: Don't overreact to small fluctuations; only trigger
     * if cumulative loss exceeds $5
     */
    minLossToTriggerUSD: 5.0,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DEFENSIVE ADJUSTMENTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * EV gate multiplier when defense is active
     * Justification: Increase required fee:cost ratio by 50% to filter
     * marginal trades during adverse conditions
     */
    evGateMultiplier: 1.50, // 50% tighter
    
    /**
     * Entry cooldown multiplier when defense is active
     * Justification: Double the time between entries to reduce frequency
     */
    entryCooldownMultiplier: 2.0,
    
    /**
     * Minimum position size multiplier when defense is active
     * Justification: Reduce position sizes by 40% to limit exposure
     */
    positionSizeMultiplier: 0.60,
    
    /**
     * Prefer hold over exit multiplier for exit threshold
     * Justification: Increase exit threshold by 25% to avoid triggering
     * exits that incur fees; only exit on strong signals
     */
    preferHoldExitThresholdMultiplier: 1.25,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RECOVERY THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Number of positive EV trades required to exit defense mode
     * Justification: Require 3 consecutive positive EV trades to confirm
     * conditions have improved before relaxing defenses
     */
    positiveEVTradesToRecover: 3,
    
    /**
     * Minimum time in defense mode before auto-recovery check (ms)
     * Justification: Stay in defense mode for at least 10 minutes to avoid
     * rapid cycling
     */
    minDefenseTimeMs: 10 * 60 * 1000, // 10 minutes
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MODULE 4: DEADLOCK PREVENTION — RECOVERY ESCAPE HATCH
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Maximum time defense can be active before forced deactivation (ms)
     * Justification: Defense cannot deadlock capital indefinitely.
     * After 60 minutes, defense deactivates to allow fresh entry attempts.
     */
    maxDefenseTimeMs: 60 * 60 * 1000, // 60 minutes
    
    /**
     * Number of consecutive trades with positive realized PnL for recovery
     * Justification: 3 consecutive profitable trades indicates market
     * conditions have improved
     */
    consecutiveProfitableTradesToRecover: 3,
    
    /**
     * Single positive EV trade threshold for immediate recovery consideration
     * Justification: If we can execute a trade with positive expected EV,
     * conditions may have improved enough to deactivate defense
     */
    singlePositiveEVForRecovery: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Single trade outcome for fee bleed tracking
 */
interface TradeOutcome {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    
    // PnL components
    grossPnLUSD: number;          // PnL before fees
    netPnLUSD: number;            // PnL after all fees
    totalFeesUSD: number;         // Entry + exit fees
    totalSlippageUSD: number;     // Entry + exit slippage
    
    // EV tracking
    expectedEV: number;           // EV at entry
    realizedEV: number;           // Actual net PnL
    evError: number;              // realizedEV - expectedEV
    wasPositiveEV: boolean;       // Was expected EV positive?
    
    timestamp: number;
}

/**
 * Fee bleed analysis result
 */
export interface FeeBleedAnalysis {
    // Window statistics
    windowSize: number;
    tradesInWindow: number;
    
    // PnL breakdown
    totalGrossPnL: number;
    totalNetPnL: number;
    totalFees: number;
    totalSlippage: number;
    totalFeeLossPct: number;      // (fees + slippage) / abs(totalNetPnL)
    
    // EV tracking
    cyclesSincePositiveEV: number;
    avgEVError: number;           // Average (realized - expected)
    
    // Defense status
    isDefenseActive: boolean;
    defenseTriggeredAt?: number;
    defenseReason?: string;
    
    // Adjustments when defense is active
    evGateMultiplier: number;
    entryCooldownMultiplier: number;
    positionSizeMultiplier: number;
    exitThresholdMultiplier: number;
    
    timestamp: number;
}

/**
 * Deactivation reason for defense mode
 */
export type DefenseDeactivationReason = 
    | 'RECOVERY'           // Positive trades indicate recovery
    | 'TIMEOUT'            // Max defense time exceeded
    | 'POSITIVE_EV_TRADE'  // Single positive EV trade executed
    | 'MANUAL';            // Forced deactivation

/**
 * Fee bleed defense state
 */
interface FeeBleedState {
    isDefenseActive: boolean;
    defenseTriggeredAt: number;
    defenseReason: string;
    consecutivePositiveEVTrades: number;
    consecutiveProfitableTrades: number;  // MODULE 4: Track realized PnL trades
    cyclesSincePositiveEV: number;
    lastDeactivationReason?: DefenseDeactivationReason;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

const tradeOutcomes: TradeOutcome[] = [];
let feeBleedState: FeeBleedState = {
    isDefenseActive: false,
    defenseTriggeredAt: 0,
    defenseReason: '',
    consecutivePositiveEVTrades: 0,
    consecutiveProfitableTrades: 0,
    cyclesSincePositiveEV: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE RECORDING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a trade outcome for fee bleed analysis
 * Call when a trade is closed with full cost breakdown
 */
export function recordTradeOutcome(outcome: {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    grossPnLUSD: number;
    netPnLUSD: number;
    entryFeesUSD: number;
    exitFeesUSD: number;
    entrySlippageUSD: number;
    exitSlippageUSD: number;
    expectedEV: number;
}): void {
    const totalFees = outcome.entryFeesUSD + outcome.exitFeesUSD;
    const totalSlippage = outcome.entrySlippageUSD + outcome.exitSlippageUSD;
    const realizedEV = outcome.netPnLUSD;
    const evError = realizedEV - outcome.expectedEV;
    
    const tradeOutcome: TradeOutcome = {
        tradeId: outcome.tradeId,
        poolAddress: outcome.poolAddress,
        poolName: outcome.poolName,
        grossPnLUSD: outcome.grossPnLUSD,
        netPnLUSD: outcome.netPnLUSD,
        totalFeesUSD: totalFees,
        totalSlippageUSD: totalSlippage,
        expectedEV: outcome.expectedEV,
        realizedEV,
        evError,
        wasPositiveEV: outcome.expectedEV > 0,
        timestamp: Date.now(),
    };
    
    tradeOutcomes.push(tradeOutcome);
    
    // Trim to rolling window
    while (tradeOutcomes.length > FEE_BLEED_CONFIG.rollingWindowCycles * 2) {
        tradeOutcomes.shift();
    }
    
    // Track positive EV trades for recovery
    if (outcome.netPnLUSD > 0) {
        feeBleedState.consecutivePositiveEVTrades++;
        feeBleedState.consecutiveProfitableTrades++;
        feeBleedState.cyclesSincePositiveEV = 0;
    } else {
        feeBleedState.consecutivePositiveEVTrades = 0;
        feeBleedState.consecutiveProfitableTrades = 0;
    }
    
    logger.debug(
        `[FEE-BLEED] Recorded trade ${outcome.poolName}: ` +
        `net=$${outcome.netPnLUSD.toFixed(2)} fees=$${totalFees.toFixed(2)} slip=$${totalSlippage.toFixed(2)} ` +
        `evError=${evError >= 0 ? '+' : ''}$${evError.toFixed(2)}`
    );
}

/**
 * Record a cycle without positive EV trade
 * Call at end of each scan cycle if no positive EV entries were made
 */
export function recordNoPositiveEVCycle(): void {
    feeBleedState.cyclesSincePositiveEV++;
}

/**
 * Record a positive EV trade (resets counter)
 */
export function recordPositiveEVTrade(): void {
    feeBleedState.cyclesSincePositiveEV = 0;
    feeBleedState.consecutivePositiveEVTrades++;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEE BLEED ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyze fee bleed and update defense state
 * Call on each scan cycle
 */
export function analyzeFeeBleed(): FeeBleedAnalysis {
    const now = Date.now();
    
    // Get recent trades in window
    const windowCutoff = now - (FEE_BLEED_CONFIG.rollingWindowCycles * 2 * 60 * 1000); // 2 min per cycle
    const recentTrades = tradeOutcomes.filter(t => t.timestamp > windowCutoff);
    
    // Calculate window statistics
    let totalGrossPnL = 0;
    let totalNetPnL = 0;
    let totalFees = 0;
    let totalSlippage = 0;
    let totalEVError = 0;
    
    for (const trade of recentTrades) {
        totalGrossPnL += trade.grossPnLUSD;
        totalNetPnL += trade.netPnLUSD;
        totalFees += trade.totalFeesUSD;
        totalSlippage += trade.totalSlippageUSD;
        totalEVError += trade.evError;
    }
    
    const tradesInWindow = recentTrades.length;
    const avgEVError = tradesInWindow > 0 ? totalEVError / tradesInWindow : 0;
    
    // Calculate fee loss percentage
    const totalFeeLoss = totalFees + totalSlippage;
    const absNetPnL = Math.abs(totalNetPnL);
    const totalFeeLossPct = absNetPnL > 0 ? totalFeeLoss / absNetPnL : 0;
    
    // Check defense trigger conditions
    const hasEnoughTrades = tradesInWindow >= FEE_BLEED_CONFIG.minTradesForEvaluation;
    const isNetNegative = totalNetPnL < -FEE_BLEED_CONFIG.minLossToTriggerUSD;
    const isFeeDominated = totalFeeLossPct >= FEE_BLEED_CONFIG.feeSlippageLossThresholdPct;
    const noPositiveEV = feeBleedState.cyclesSincePositiveEV >= FEE_BLEED_CONFIG.maxCyclesWithoutPositiveEV;
    
    const shouldTriggerDefense = hasEnoughTrades && isNetNegative && isFeeDominated && noPositiveEV;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MODULE 4: RECOVERY ESCAPE HATCH — PREVENT DEADLOCK
    // Defense deactivates if ANY is true:
    //   1. 3 consecutive trades with positive realized PnL
    //   2. OR 1 trade executed with positive ExpectedNetEVUSD
    //   3. OR defense active > 60 minutes (TIMEOUT)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const defenseActiveMs = feeBleedState.isDefenseActive 
        ? now - feeBleedState.defenseTriggeredAt 
        : 0;
    const minDefenseTimePassed = defenseActiveMs >= FEE_BLEED_CONFIG.minDefenseTimeMs;
    
    // Recovery condition 1: Consecutive positive realized PnL trades
    const recoverByProfitableTrades = feeBleedState.isDefenseActive &&
        minDefenseTimePassed &&
        feeBleedState.consecutiveProfitableTrades >= FEE_BLEED_CONFIG.consecutiveProfitableTradesToRecover;
    
    // Recovery condition 2: Single positive EV trade (handled via recordPositiveEVTrade)
    // This is checked in the recordPositiveEVTrade function
    
    // Recovery condition 3: TIMEOUT — defense active > 60 minutes
    const recoverByTimeout = feeBleedState.isDefenseActive &&
        defenseActiveMs >= FEE_BLEED_CONFIG.maxDefenseTimeMs;
    
    // Legacy recovery condition (kept for compatibility)
    const canRecover = feeBleedState.isDefenseActive && 
        feeBleedState.consecutivePositiveEVTrades >= FEE_BLEED_CONFIG.positiveEVTradesToRecover &&
        minDefenseTimePassed;
    
    // Determine if any recovery condition is met
    const shouldRecover = recoverByProfitableTrades || recoverByTimeout || canRecover;
    let deactivationReason: DefenseDeactivationReason | undefined;
    
    if (recoverByProfitableTrades) {
        deactivationReason = 'RECOVERY';
    } else if (recoverByTimeout) {
        deactivationReason = 'TIMEOUT';
    } else if (canRecover) {
        deactivationReason = 'RECOVERY';
    }
    
    // Update defense state
    if (shouldTriggerDefense && !feeBleedState.isDefenseActive) {
        feeBleedState.isDefenseActive = true;
        feeBleedState.defenseTriggeredAt = now;
        feeBleedState.defenseReason = 
            `Net PnL: $${totalNetPnL.toFixed(2)} | ` +
            `Fee/Slip: ${(totalFeeLossPct * 100).toFixed(0)}% of losses | ` +
            `Cycles w/o +EV: ${feeBleedState.cyclesSincePositiveEV}`;
        
        // MODULE 4: Log activation with all defense parameters
        logger.warn(
            `[FEE-BLEED-DEFENSE] 🛡️ ACTIVATED\n` +
            `  active=true\n` +
            `  evTightenFactor=${FEE_BLEED_CONFIG.evGateMultiplier.toFixed(2)}\n` +
            `  sizeReductionFactor=${FEE_BLEED_CONFIG.positionSizeMultiplier.toFixed(2)}\n` +
            `  cooldownMultiplier=${FEE_BLEED_CONFIG.entryCooldownMultiplier.toFixed(2)}\n` +
            `  exitThresholdAdjustment=${FEE_BLEED_CONFIG.preferHoldExitThresholdMultiplier.toFixed(2)}\n` +
            `  reason=${feeBleedState.defenseReason}`
        );
    } else if (shouldRecover && feeBleedState.isDefenseActive) {
        const defenseTimeMin = defenseActiveMs / (1000 * 60);
        
        // MODULE 4: Log deactivation with explicit reason
        logger.info(
            `[FEE-BLEED-DEFENSE] ✅ deactivated reason=${deactivationReason} | ` +
            `active=${defenseTimeMin.toFixed(1)} minutes | ` +
            `consecutiveProfitableTrades=${feeBleedState.consecutiveProfitableTrades} | ` +
            `consecutivePositiveEVTrades=${feeBleedState.consecutivePositiveEVTrades}`
        );
        
        feeBleedState.isDefenseActive = false;
        feeBleedState.consecutivePositiveEVTrades = 0;
        feeBleedState.consecutiveProfitableTrades = 0;
        feeBleedState.lastDeactivationReason = deactivationReason;
    }
    
    // Calculate active multipliers
    const isActive = feeBleedState.isDefenseActive;
    
    return {
        windowSize: FEE_BLEED_CONFIG.rollingWindowCycles,
        tradesInWindow,
        
        totalGrossPnL,
        totalNetPnL,
        totalFees,
        totalSlippage,
        totalFeeLossPct,
        
        cyclesSincePositiveEV: feeBleedState.cyclesSincePositiveEV,
        avgEVError,
        
        isDefenseActive: isActive,
        defenseTriggeredAt: isActive ? feeBleedState.defenseTriggeredAt : undefined,
        defenseReason: isActive ? feeBleedState.defenseReason : undefined,
        
        evGateMultiplier: isActive ? FEE_BLEED_CONFIG.evGateMultiplier : 1.0,
        entryCooldownMultiplier: isActive ? FEE_BLEED_CONFIG.entryCooldownMultiplier : 1.0,
        positionSizeMultiplier: isActive ? FEE_BLEED_CONFIG.positionSizeMultiplier : 1.0,
        exitThresholdMultiplier: isActive ? FEE_BLEED_CONFIG.preferHoldExitThresholdMultiplier : 1.0,
        
        timestamp: now,
    };
}

/**
 * Quick check if fee bleed defense is active
 */
export function isFeeBleedDefenseActive(): boolean {
    return feeBleedState.isDefenseActive;
}

/**
 * Get multipliers when defense is active
 */
export function getFeeBleedMultipliers(): {
    evGateMultiplier: number;
    entryCooldownMultiplier: number;
    positionSizeMultiplier: number;
    exitThresholdMultiplier: number;
} {
    if (!feeBleedState.isDefenseActive) {
        return {
            evGateMultiplier: 1.0,
            entryCooldownMultiplier: 1.0,
            positionSizeMultiplier: 1.0,
            exitThresholdMultiplier: 1.0,
        };
    }
    
    return {
        evGateMultiplier: FEE_BLEED_CONFIG.evGateMultiplier,
        entryCooldownMultiplier: FEE_BLEED_CONFIG.entryCooldownMultiplier,
        positionSizeMultiplier: FEE_BLEED_CONFIG.positionSizeMultiplier,
        exitThresholdMultiplier: FEE_BLEED_CONFIG.preferHoldExitThresholdMultiplier,
    };
}

/**
 * Apply fee bleed adjustments to EV gate ratio
 */
export function applyFeeBleedToEVRatio(baseRatio: number): number {
    return baseRatio * getFeeBleedMultipliers().evGateMultiplier;
}

/**
 * Apply fee bleed adjustments to position size
 */
export function applyFeeBleedToPositionSize(baseSize: number): number {
    return Math.floor(baseSize * getFeeBleedMultipliers().positionSizeMultiplier);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log fee bleed analysis summary
 */
export function logFeeBleedStatus(): void {
    const analysis = analyzeFeeBleed();
    
    if (analysis.isDefenseActive) {
        const defenseTime = analysis.defenseTriggeredAt 
            ? (Date.now() - analysis.defenseTriggeredAt) / (1000 * 60) 
            : 0;
        
        logger.info(
            `[FEE-BLEED-DEFENSE] 🛡️ ACTIVE for ${defenseTime.toFixed(1)}min | ` +
            `Multipliers: EV=${analysis.evGateMultiplier.toFixed(2)}× ` +
            `size=${analysis.positionSizeMultiplier.toFixed(2)}× ` +
            `cooldown=${analysis.entryCooldownMultiplier.toFixed(1)}× ` +
            `exit=${analysis.exitThresholdMultiplier.toFixed(2)}×`
        );
    } else {
        logger.debug(
            `[FEE-BLEED] Window: ${analysis.tradesInWindow} trades | ` +
            `NetPnL: $${analysis.totalNetPnL.toFixed(2)} | ` +
            `FeeLoss: ${(analysis.totalFeeLossPct * 100).toFixed(0)}% | ` +
            `Cycles w/o +EV: ${analysis.cyclesSincePositiveEV}`
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get recent trade outcomes for analysis
 */
export function getRecentTradeOutcomes(limit: number = 10): TradeOutcome[] {
    return tradeOutcomes.slice(-limit);
}

/**
 * Get fee bleed state for debugging
 */
export function getFeeBleedState(): Readonly<FeeBleedState> {
    return { ...feeBleedState };
}

/**
 * Force activate defense mode (for testing)
 */
export function forceActivateDefense(reason: string): void {
    feeBleedState.isDefenseActive = true;
    feeBleedState.defenseTriggeredAt = Date.now();
    feeBleedState.defenseReason = `FORCED: ${reason}`;
    logger.warn(`[FEE-BLEED-DEFENSE] 🛡️ FORCE ACTIVATED: ${reason}`);
}

/**
 * Force deactivate defense mode (for testing)
 */
export function forceDeactivateDefense(): void {
    feeBleedState.isDefenseActive = false;
    feeBleedState.consecutivePositiveEVTrades = 0;
    logger.info(`[FEE-BLEED-DEFENSE] ✅ FORCE DEACTIVATED`);
}

/**
 * Reset all fee bleed state (for testing)
 */
export function resetFeeBleedState(): void {
    tradeOutcomes.length = 0;
    feeBleedState = {
        isDefenseActive: false,
        defenseTriggeredAt: 0,
        defenseReason: '',
        consecutivePositiveEVTrades: 0,
        consecutiveProfitableTrades: 0,
        cyclesSincePositiveEV: 0,
    };
    logger.info('[FEE-BLEED] State reset');
}

/**
 * MODULE 4: Check if defense should auto-deactivate due to timeout
 * Call this periodically to ensure defense doesn't deadlock
 */
export function checkDefenseTimeout(): boolean {
    if (!feeBleedState.isDefenseActive) return false;
    
    const now = Date.now();
    const defenseActiveMs = now - feeBleedState.defenseTriggeredAt;
    
    if (defenseActiveMs >= FEE_BLEED_CONFIG.maxDefenseTimeMs) {
        const defenseTimeMin = defenseActiveMs / (1000 * 60);
        
        logger.info(
            `[FEE-BLEED-DEFENSE] ✅ deactivated reason=TIMEOUT | ` +
            `active=${defenseTimeMin.toFixed(1)} minutes exceeded ${FEE_BLEED_CONFIG.maxDefenseTimeMs / (1000 * 60)} minute limit`
        );
        
        feeBleedState.isDefenseActive = false;
        feeBleedState.consecutivePositiveEVTrades = 0;
        feeBleedState.consecutiveProfitableTrades = 0;
        feeBleedState.lastDeactivationReason = 'TIMEOUT';
        
        return true;
    }
    
    return false;
}

/**
 * MODULE 4: Record a trade with positive expected EV (for recovery)
 * If singlePositiveEVForRecovery is enabled, this can trigger recovery
 */
export function recordPositiveExpectedEVTrade(): void {
    if (!feeBleedState.isDefenseActive) return;
    
    const now = Date.now();
    const defenseActiveMs = now - feeBleedState.defenseTriggeredAt;
    const minDefenseTimePassed = defenseActiveMs >= FEE_BLEED_CONFIG.minDefenseTimeMs;
    
    if (FEE_BLEED_CONFIG.singlePositiveEVForRecovery && minDefenseTimePassed) {
        const defenseTimeMin = defenseActiveMs / (1000 * 60);
        
        logger.info(
            `[FEE-BLEED-DEFENSE] ✅ deactivated reason=POSITIVE_EV_TRADE | ` +
            `active=${defenseTimeMin.toFixed(1)} minutes | ` +
            `triggered by positive expected EV trade execution`
        );
        
        feeBleedState.isDefenseActive = false;
        feeBleedState.consecutivePositiveEVTrades = 0;
        feeBleedState.consecutiveProfitableTrades = 0;
        feeBleedState.lastDeactivationReason = 'POSITIVE_EV_TRADE';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// FEE_BLEED_CONFIG is already exported at declaration

