/**
 * Tier 4 Entry Gating — Unified Entry Decision System
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Single entry point for all entry gating decisions.
 * 
 * INTEGRATION ORDER (before any entry):
 * 1. isNoTradeRegime()
 * 2. shouldBlockEntryOnReversal()
 * 3. getExecutionQuality()
 * 4. getCongestionMultiplier()
 * 5. getActiveRegimePlaybook()
 * 6. poolSharpeMemory gate
 * 7. adaptivePoolSelection filter
 * 8. final position sizing
 * 
 * Only proceed if all say "allow"
 * 
 * POSITION MULTIPLIER STACKING:
 * Final position size = baseSize
 *   × executionQuality
 *   × congestionMultiplier
 *   × regimeMultiplier
 *   × poolSharpeMultiplier
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { TradingState } from '../risk/adaptive_sizing/types';
import { isNoTradeRegimeFromState, getNoTradeResult } from '../regimes/no_trade';
import { shouldBlockOnReversal, createReversalState, TradingStateWithReversal } from '../risk/guards/reversal';
import { 
    getExecutionQuality, 
    getExecutionQualityPositionMultiplier,
    isExecutionQualityBlocked,
} from '../execution/qualityOptimizer';
import { 
    getCongestionPositionMultiplier, 
    shouldBlockOnCongestion,
    getCongestionResult,
} from '../infrastructure/congestion_mode';
import { 
    getActiveRegimePlaybook, 
    createRegimeInputs,
    shouldBlockOnRegime,
    shouldForceExitAll,
    getActiveRegime,
    RegimeInputs,
    PlaybookParameters,
} from '../regimes/playbooks';
import { 
    getPoolSharpe, 
    getPoolSharpePositionMultiplier,
    isPoolSharpeBlocked,
} from '../risk/poolSharpeMemory';
import { 
    isPoolAllowedForTrading, 
    getPoolPriorityMultiplier,
    getPoolEntry,
} from '../discovery/adaptive';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Entry gating inputs
 */
export interface EntryGatingInputs {
    /** Pool address */
    poolAddress: string;
    
    /** Pool name */
    poolName: string;
    
    /** Trading state */
    tradingState: TradingState;
    
    /** Migration direction */
    migrationDirection?: 'in' | 'out' | 'neutral';
    
    /** Regime inputs (if available) */
    regimeInputs?: RegimeInputs;
    
    /** Base position size before multipliers */
    basePositionSize: number;
    
    /** Current open position count */
    openPositionCount: number;
    
    /** Total equity */
    totalEquity: number;
}

/**
 * Entry gating result
 */
export interface EntryGatingResult {
    /** Whether entry is allowed */
    allowed: boolean;
    
    /** If not allowed, the blocking gate */
    blockedBy?: string;
    
    /** Blocking reason */
    blockReason?: string;
    
    /** Final position size after all multipliers */
    finalPositionSize: number;
    
    /** Breakdown of all multipliers */
    multiplierBreakdown: {
        executionQuality: number;
        congestion: number;
        regime: number;
        poolSharpe: number;
        adaptivePriority: number;
        combined: number;
    };
    
    /** Active regime playbook */
    playbook: PlaybookParameters;
    
    /** Detailed gate results */
    gates: {
        noTradeRegime: { passed: boolean; reason?: string };
        reversalGuard: { passed: boolean; reason?: string };
        executionQuality: { passed: boolean; score: number; reason?: string };
        congestion: { passed: boolean; level: string; reason?: string };
        regimePlaybook: { passed: boolean; regime: string; reason?: string };
        poolSharpe: { passed: boolean; score: number; reason?: string };
        adaptivePool: { passed: boolean; status: string; reason?: string };
    };
    
    /** Timestamp */
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate all entry gates and compute final position size.
 * This is the primary API for the Tier 4 Entry Gating system.
 */
export function evaluateEntryGating(inputs: EntryGatingInputs): EntryGatingResult {
    const now = Date.now();
    const { poolAddress, tradingState, basePositionSize } = inputs;
    
    // Initialize result
    const result: EntryGatingResult = {
        allowed: true,
        finalPositionSize: basePositionSize,
        multiplierBreakdown: {
            executionQuality: 1,
            congestion: 1,
            regime: 1,
            poolSharpe: 1,
            adaptivePriority: 1,
            combined: 1,
        },
        playbook: getActiveRegimePlaybook(inputs.regimeInputs ?? createDefaultRegimeInputs(tradingState)),
        gates: {
            noTradeRegime: { passed: true },
            reversalGuard: { passed: true },
            executionQuality: { passed: true, score: 1 },
            congestion: { passed: true, level: 'LOW' },
            regimePlaybook: { passed: true, regime: 'NEUTRAL' },
            poolSharpe: { passed: true, score: 0.5 },
            adaptivePool: { passed: true, status: 'UNKNOWN' },
        },
        timestamp: now,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 1: No Trade Regime
    // ═══════════════════════════════════════════════════════════════════════════
    const noTradeResult = getNoTradeResult(tradingState);
    if (noTradeResult.isNoTradeRegime) {
        result.allowed = false;
        result.blockedBy = 'NO_TRADE_REGIME';
        result.blockReason = noTradeResult.reason;
        result.finalPositionSize = 0;
        result.gates.noTradeRegime = { passed: false, reason: noTradeResult.reason };
        return result;
    }
    result.gates.noTradeRegime = { passed: true };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 2: Reversal Guard
    // ═══════════════════════════════════════════════════════════════════════════
    const reversalState = createReversalState(
        tradingState,
        poolAddress,
        inputs.migrationDirection
    );
    if (shouldBlockOnReversal(reversalState)) {
        result.allowed = false;
        result.blockedBy = 'REVERSAL_GUARD';
        result.blockReason = 'Migration direction reversal detected';
        result.finalPositionSize = 0;
        result.gates.reversalGuard = { passed: false, reason: 'Migration direction reversal' };
        return result;
    }
    result.gates.reversalGuard = { passed: true };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 3: Execution Quality
    // ═══════════════════════════════════════════════════════════════════════════
    const executionQuality = getExecutionQuality();
    result.multiplierBreakdown.executionQuality = executionQuality.positionMultiplier;
    result.gates.executionQuality = { 
        passed: !executionQuality.blockEntries, 
        score: executionQuality.score,
        reason: executionQuality.reason,
    };
    
    if (executionQuality.blockEntries) {
        result.allowed = false;
        result.blockedBy = 'EXECUTION_QUALITY';
        result.blockReason = executionQuality.reason;
        result.finalPositionSize = 0;
        return result;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 4: Congestion
    // ═══════════════════════════════════════════════════════════════════════════
    const congestionResult = getCongestionResult();
    result.multiplierBreakdown.congestion = congestionResult.positionMultiplier;
    result.gates.congestion = { 
        passed: !congestionResult.blockTrading, 
        level: congestionResult.level,
        reason: congestionResult.reason,
    };
    
    if (congestionResult.blockTrading) {
        result.allowed = false;
        result.blockedBy = 'NETWORK_CONGESTION';
        result.blockReason = congestionResult.reason;
        result.finalPositionSize = 0;
        return result;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 5: Regime Playbook
    // ═══════════════════════════════════════════════════════════════════════════
    const regimeInputs = inputs.regimeInputs ?? createDefaultRegimeInputs(tradingState);
    const playbook = getActiveRegimePlaybook(regimeInputs);
    result.playbook = playbook;
    result.multiplierBreakdown.regime = playbook.sizeMultiplier;
    result.gates.regimePlaybook = { 
        passed: !playbook.blockEntries, 
        regime: playbook.regime,
        reason: playbook.description,
    };
    
    if (playbook.blockEntries) {
        result.allowed = false;
        result.blockedBy = 'REGIME_PLAYBOOK';
        result.blockReason = playbook.description;
        result.finalPositionSize = 0;
        return result;
    }
    
    // Check max positions for regime
    if (inputs.openPositionCount >= playbook.maxConcurrentPositions) {
        result.allowed = false;
        result.blockedBy = 'REGIME_MAX_POSITIONS';
        result.blockReason = `Max positions (${playbook.maxConcurrentPositions}) reached for ${playbook.regime} regime`;
        result.finalPositionSize = 0;
        return result;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 6: Pool Sharpe Memory
    // ═══════════════════════════════════════════════════════════════════════════
    const sharpeResult = getPoolSharpe(poolAddress);
    result.multiplierBreakdown.poolSharpe = sharpeResult.sharpeMultiplier;
    result.gates.poolSharpe = { 
        passed: !sharpeResult.shouldBlock, 
        score: sharpeResult.sharpeScore,
        reason: sharpeResult.reason,
    };
    
    if (sharpeResult.shouldBlock) {
        result.allowed = false;
        result.blockedBy = 'POOL_SHARPE';
        result.blockReason = sharpeResult.reason;
        result.finalPositionSize = 0;
        return result;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 7: Adaptive Pool Selection
    // ═══════════════════════════════════════════════════════════════════════════
    const poolEntry = getPoolEntry(poolAddress);
    const isAllowed = isPoolAllowedForTrading(poolAddress);
    const priorityMultiplier = getPoolPriorityMultiplier(poolAddress);
    
    result.multiplierBreakdown.adaptivePriority = priorityMultiplier;
    result.gates.adaptivePool = { 
        passed: isAllowed || poolEntry === undefined, // Unknown pools pass (first-time discovery)
        status: poolEntry?.status ?? 'UNKNOWN',
        reason: poolEntry ? `Pool status: ${poolEntry.status}` : 'Pool not in adaptive universe',
    };
    
    if (poolEntry && !isAllowed) {
        result.allowed = false;
        result.blockedBy = 'ADAPTIVE_POOL_BLOCKED';
        result.blockReason = `Pool ${poolAddress.slice(0, 8)}... is ${poolEntry.status} in adaptive universe`;
        result.finalPositionSize = 0;
        return result;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE FINAL POSITION SIZE
    // ═══════════════════════════════════════════════════════════════════════════
    const combinedMultiplier = 
        result.multiplierBreakdown.executionQuality *
        result.multiplierBreakdown.congestion *
        result.multiplierBreakdown.regime *
        result.multiplierBreakdown.poolSharpe *
        result.multiplierBreakdown.adaptivePriority;
    
    result.multiplierBreakdown.combined = combinedMultiplier;
    result.finalPositionSize = Math.floor(basePositionSize * combinedMultiplier);
    
    // Minimum viable position check
    if (result.finalPositionSize < 30) { // $30 minimum
        result.allowed = false;
        result.blockedBy = 'SIZE_TOO_SMALL';
        result.blockReason = `Final size $${result.finalPositionSize} below $30 minimum after multipliers`;
        result.finalPositionSize = 0;
    }
    
    return result;
}

/**
 * Quick check if entry should be blocked (doesn't compute full result)
 */
export function shouldBlockEntry(
    poolAddress: string,
    tradingState: TradingState,
    migrationDirection?: 'in' | 'out' | 'neutral'
): boolean {
    // Gate 1: No Trade Regime
    if (isNoTradeRegimeFromState(tradingState)) return true;
    
    // Gate 2: Reversal Guard
    const reversalState = createReversalState(tradingState, poolAddress, migrationDirection);
    if (shouldBlockOnReversal(reversalState)) return true;
    
    // Gate 3: Execution Quality
    if (isExecutionQualityBlocked()) return true;
    
    // Gate 4: Congestion
    if (shouldBlockOnCongestion()) return true;
    
    // Gate 5: Regime Playbook
    if (shouldBlockOnRegime()) return true;
    
    // Gate 6: Pool Sharpe
    if (isPoolSharpeBlocked(poolAddress)) return true;
    
    // Gate 7: Adaptive Pool
    const entry = getPoolEntry(poolAddress);
    if (entry && !isPoolAllowedForTrading(poolAddress)) return true;
    
    return false;
}

/**
 * Get combined position multiplier without full gating
 */
export function getCombinedPositionMultiplier(poolAddress: string): number {
    const executionMultiplier = getExecutionQualityPositionMultiplier();
    const congestionMultiplier = getCongestionPositionMultiplier();
    const regimeMultiplier = getActiveRegimePlaybook(createDefaultRegimeInputs({
        entropy_score: 0.5,
        liquidityFlow_score: 0.5,
        migrationDirection_confidence: 0.5,
        consistency_score: 0.5,
        velocity_score: 0.5,
        execution_quality: executionMultiplier,
    })).sizeMultiplier;
    const sharpeMultiplier = getPoolSharpePositionMultiplier(poolAddress);
    const adaptiveMultiplier = getPoolPriorityMultiplier(poolAddress);
    
    return executionMultiplier * congestionMultiplier * regimeMultiplier * sharpeMultiplier * adaptiveMultiplier;
}

/**
 * Check if force exit should be triggered
 */
export function shouldForceExitAllPositions(): boolean {
    return shouldForceExitAll();
}

/**
 * Get active regime for logging
 */
export function getActiveRegimeForLogging(): string {
    return getActiveRegime();
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create default regime inputs from trading state
 */
function createDefaultRegimeInputs(tradingState: TradingState): RegimeInputs {
    return createRegimeInputs(
        0,                                      // velocitySlope (default neutral)
        0,                                      // liquiditySlope
        0,                                      // entropySlope
        tradingState.entropy_score,
        tradingState.velocity_score * 100,     // Scale to 0-100
        tradingState.migrationDirection_confidence,
        tradingState.consistency_score,
        0.05,                                   // feeIntensity (default)
        tradingState.execution_quality
    );
}

/**
 * Create trading state from pool metrics
 */
export function createTradingStateFromMetrics(
    entropy: number,
    liquidityFlow: number,
    migrationConfidence: number,
    consistency: number,
    velocity: number,
    executionQuality: number = 1
): TradingState {
    return {
        entropy_score: entropy,
        liquidityFlow_score: liquidityFlow,
        migrationDirection_confidence: migrationConfidence,
        consistency_score: consistency,
        velocity_score: velocity,
        execution_quality: executionQuality,
    };
}

