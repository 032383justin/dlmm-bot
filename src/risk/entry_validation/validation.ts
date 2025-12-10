/**
 * Entry Validation Module - Core Validation Logic
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Enforce ordered pre-trade validation with all safety checks.
 * 
 * EVALUATION ORDER:
 * 1. isNoTradeRegime()          → Block on market chaos
 * 2. shouldBlockEntryOnReversal() → Block on migration reversal
 * 3. getExecutionQuality()       → Check execution health
 * 4. getCongestionMultiplier()   → Check network congestion
 * 5. getPositionMultiplier()     → Compute final sizing
 * 
 * Only if ALL return valid → allow entry.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { 
    EntryValidationState, 
    EntryValidationResult, 
    CheckResult,
    PositionSizingResult,
    EntryValidationConfig 
} from './types';
import { DEFAULT_CONFIG } from './config';

// Import from other modules
import { 
    isNoTradeRegimeFromState, 
    getNoTradeResult 
} from '../../regimes/no_trade';

import { 
    shouldBlockEntryOnReversal, 
    detectReversal,
    TradingStateWithReversal 
} from '../guards/reversal';

import { 
    getExecutionQuality, 
    getExecutionQualityPositionMultiplier,
    computeExecutionQuality 
} from '../execution_quality';

import { 
    getCongestionPositionMultiplier, 
    getCongestionResult 
} from '../../infrastructure/congestion_mode';

import { 
    getPositionMultiplier, 
    computePositionMultiplier 
} from '../adaptive_sizing';

import logger from '../../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp a value between 0 and 1
 */
function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL CHECK FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * CHECK 1: No Trade Regime
 */
function runNoTradeCheck(state: EntryValidationState): CheckResult {
    const result = getNoTradeResult(state);
    
    return {
        check: 'no_trade_regime',
        passed: !result.isNoTradeRegime,
        blocked: result.isNoTradeRegime,
        value: result.confidence,
        reason: result.reason,
        cooldownSeconds: result.cooldownSeconds,
    };
}

/**
 * CHECK 2: Reversal Guard
 */
function runReversalCheck(state: EntryValidationState): CheckResult {
    const reversalState: TradingStateWithReversal = {
        ...state,
        poolAddress: state.poolAddress,
        migrationDirection: state.migrationDirection,
        migrationDirectionHistory: state.migrationDirectionHistory,
        entropyHistory: state.entropyHistory,
        liquidityFlowHistory: state.liquidityFlowHistory,
    };
    
    const result = detectReversal(reversalState);
    
    return {
        check: 'reversal_guard',
        passed: !result.shouldBlock,
        blocked: result.shouldBlock,
        value: result.sustainedCount,
        reason: result.reason,
        cooldownSeconds: result.cooldownSeconds,
    };
}

/**
 * CHECK 3: Execution Quality
 */
function runExecutionQualityCheck(
    state: EntryValidationState, 
    config: EntryValidationConfig
): CheckResult {
    const result = computeExecutionQuality();
    const quality = result.score;
    
    let blocked = false;
    let multiplier = 1.0;
    let reason: string;
    
    if (quality < config.executionBlockThreshold) {
        blocked = true;
        multiplier = 0;
        reason = `BLOCKED: execution quality ${(quality * 100).toFixed(1)}% < ${(config.executionBlockThreshold * 100).toFixed(0)}% threshold`;
    } else if (quality < config.executionReduceThreshold) {
        multiplier = config.executionReductionFactor;
        reason = `REDUCED: execution quality ${(quality * 100).toFixed(1)}% < ${(config.executionReduceThreshold * 100).toFixed(0)}% - position reduced to ${(multiplier * 100).toFixed(0)}%`;
    } else if (quality >= config.executionNormalThreshold) {
        multiplier = 1.0;
        reason = `NORMAL: execution quality ${(quality * 100).toFixed(1)}% ≥ ${(config.executionNormalThreshold * 100).toFixed(0)}%`;
    } else {
        // Linear interpolation between reduce and normal
        const range = config.executionNormalThreshold - config.executionReduceThreshold;
        const progress = (quality - config.executionReduceThreshold) / range;
        multiplier = config.executionReductionFactor + (progress * (1.0 - config.executionReductionFactor));
        reason = `SCALED: execution quality ${(quality * 100).toFixed(1)}% - position at ${(multiplier * 100).toFixed(0)}%`;
    }
    
    return {
        check: 'execution_quality',
        passed: !blocked,
        blocked,
        value: quality,
        multiplier,
        reason,
    };
}

/**
 * CHECK 4: Congestion Mode
 */
function runCongestionCheck(config: EntryValidationConfig): CheckResult {
    const result = getCongestionResult();
    const score = result.congestionScore;
    
    let blocked = false;
    let multiplier = 1.0;
    let reason: string;
    
    if (score >= config.congestionBlockThreshold) {
        blocked = true;
        multiplier = 0;
        reason = `BLOCKED: congestion score ${(score * 100).toFixed(1)}% ≥ ${(config.congestionBlockThreshold * 100).toFixed(0)}% - network too congested`;
    } else if (score >= config.congestionHalfThreshold) {
        multiplier = 0.5;
        reason = `HALVED: congestion score ${(score * 100).toFixed(1)}% ≥ ${(config.congestionHalfThreshold * 100).toFixed(0)}% - position halved`;
    } else if (score >= config.congestionReduceThreshold) {
        // Linear interpolation between 0.5 and 1.0
        const range = config.congestionHalfThreshold - config.congestionReduceThreshold;
        const progress = (config.congestionHalfThreshold - score) / range;
        multiplier = 0.5 + (progress * 0.5);
        reason = `REDUCED: congestion score ${(score * 100).toFixed(1)}% - position at ${(multiplier * 100).toFixed(0)}%`;
    } else {
        multiplier = 1.0;
        reason = `NORMAL: congestion score ${(score * 100).toFixed(1)}% < ${(config.congestionReduceThreshold * 100).toFixed(0)}%`;
    }
    
    return {
        check: 'congestion_mode',
        passed: !blocked,
        blocked,
        value: score,
        multiplier,
        reason,
    };
}

/**
 * CHECK 5: Regime-Based Position Sizing
 */
function runPositionMultiplierCheck(state: EntryValidationState): CheckResult {
    const result = computePositionMultiplier(state);
    const blocked = result.trading_blocked;
    
    return {
        check: 'position_sizing',
        passed: !blocked,
        blocked,
        value: result.regime_confidence,
        multiplier: result.position_multiplier,
        reason: result.reason,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN VALIDATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run full entry validation with all checks in order.
 * 
 * EVALUATION ORDER:
 * 1. isNoTradeRegime()          → Block on market chaos
 * 2. shouldBlockEntryOnReversal() → Block on migration reversal
 * 3. getExecutionQuality()       → Check execution health
 * 4. getCongestionMultiplier()   → Check network congestion
 * 5. getPositionMultiplier()     → Compute final sizing
 * 
 * Only if ALL pass → allow entry with computed multiplier.
 */
export function validateEntry(
    state: EntryValidationState,
    config: EntryValidationConfig = DEFAULT_CONFIG
): EntryValidationResult {
    const now = Date.now();
    const checks: CheckResult[] = [];
    
    let canEnter = true;
    let blocked = false;
    let reason = '';
    let cooldownSeconds = 0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: No Trade Regime
    // ═══════════════════════════════════════════════════════════════════════════
    if (config.enableNoTradeCheck) {
        const noTradeCheck = runNoTradeCheck(state);
        checks.push(noTradeCheck);
        
        if (noTradeCheck.blocked) {
            canEnter = false;
            blocked = true;
            reason = `NO_TRADE_REGIME: ${noTradeCheck.reason}`;
            cooldownSeconds = Math.max(cooldownSeconds, noTradeCheck.cooldownSeconds ?? config.defaultCooldownSeconds);
            
            logger.warn(`[ENTRY_VALIDATION] ⛔ ${reason}`);
            
            // Early exit - no need to check further
            return buildResult(
                canEnter, blocked, reason, 0, 0, 0, 0,
                checks, cooldownSeconds, now
            );
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: Reversal Guard
    // ═══════════════════════════════════════════════════════════════════════════
    if (config.enableReversalCheck) {
        const reversalCheck = runReversalCheck(state);
        checks.push(reversalCheck);
        
        if (reversalCheck.blocked) {
            canEnter = false;
            blocked = true;
            reason = `REVERSAL_GUARD: ${reversalCheck.reason}`;
            cooldownSeconds = Math.max(cooldownSeconds, reversalCheck.cooldownSeconds ?? config.defaultCooldownSeconds);
            
            logger.warn(`[ENTRY_VALIDATION] ⛔ ${reason}`);
            
            return buildResult(
                canEnter, blocked, reason, 0, 0, 0, 0,
                checks, cooldownSeconds, now
            );
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 3: Execution Quality
    // ═══════════════════════════════════════════════════════════════════════════
    let executionMultiplier = 1.0;
    let executionQuality = 1.0;
    
    if (config.enableExecutionCheck) {
        const executionCheck = runExecutionQualityCheck(state, config);
        checks.push(executionCheck);
        
        executionQuality = executionCheck.value ?? 1.0;
        executionMultiplier = executionCheck.multiplier ?? 1.0;
        
        if (executionCheck.blocked) {
            canEnter = false;
            blocked = true;
            reason = `EXECUTION_QUALITY: ${executionCheck.reason}`;
            cooldownSeconds = Math.max(cooldownSeconds, config.defaultCooldownSeconds);
            
            logger.warn(`[ENTRY_VALIDATION] ⛔ ${reason}`);
            
            return buildResult(
                canEnter, blocked, reason, 0, executionQuality, 0, 0,
                checks, cooldownSeconds, now
            );
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 4: Congestion Mode
    // ═══════════════════════════════════════════════════════════════════════════
    let congestionMultiplier = 1.0;
    
    if (config.enableCongestionCheck) {
        const congestionCheck = runCongestionCheck(config);
        checks.push(congestionCheck);
        
        congestionMultiplier = congestionCheck.multiplier ?? 1.0;
        
        if (congestionCheck.blocked) {
            canEnter = false;
            blocked = true;
            reason = `CONGESTION_MODE: ${congestionCheck.reason}`;
            cooldownSeconds = Math.max(cooldownSeconds, config.defaultCooldownSeconds);
            
            logger.warn(`[ENTRY_VALIDATION] ⛔ ${reason}`);
            
            return buildResult(
                canEnter, blocked, reason, 0, executionQuality, congestionMultiplier, 0,
                checks, cooldownSeconds, now
            );
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 5: Regime-Based Position Sizing
    // ═══════════════════════════════════════════════════════════════════════════
    const positionCheck = runPositionMultiplierCheck(state);
    checks.push(positionCheck);
    
    const regimeMultiplier = positionCheck.multiplier ?? 0;
    
    if (positionCheck.blocked) {
        canEnter = false;
        blocked = true;
        reason = `POSITION_SIZING: ${positionCheck.reason}`;
        cooldownSeconds = Math.max(cooldownSeconds, config.defaultCooldownSeconds);
        
        logger.warn(`[ENTRY_VALIDATION] ⛔ ${reason}`);
        
        return buildResult(
            canEnter, blocked, reason, 0, executionQuality, congestionMultiplier, regimeMultiplier,
            checks, cooldownSeconds, now
        );
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ALL CHECKS PASSED - Compute Final Multiplier
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Combine all multipliers
    const finalMultiplier = regimeMultiplier * executionMultiplier * congestionMultiplier;
    
    // Check if combined multiplier is too low
    if (finalMultiplier < config.minCombinedMultiplier) {
        canEnter = false;
        blocked = true;
        reason = `COMBINED_MULTIPLIER: ${(finalMultiplier * 100).toFixed(1)}% < ${(config.minCombinedMultiplier * 100).toFixed(0)}% minimum`;
        cooldownSeconds = Math.max(cooldownSeconds, config.defaultCooldownSeconds);
        
        logger.info(`[ENTRY_VALIDATION] ⚠️ ${reason}`);
    } else {
        reason = `VALID: final multiplier ${(finalMultiplier * 100).toFixed(1)}% ` +
            `(regime=${(regimeMultiplier * 100).toFixed(0)}% × ` +
            `exec=${(executionMultiplier * 100).toFixed(0)}% × ` +
            `cong=${(congestionMultiplier * 100).toFixed(0)}%)`;
        
        logger.debug(`[ENTRY_VALIDATION] ✅ ${reason}`);
    }
    
    return buildResult(
        canEnter, blocked, reason, finalMultiplier,
        executionQuality, congestionMultiplier, regimeMultiplier,
        checks, cooldownSeconds, now
    );
}

/**
 * Helper to build the result object
 */
function buildResult(
    canEnter: boolean,
    blocked: boolean,
    reason: string,
    finalPositionMultiplier: number,
    executionQuality: number,
    congestionMultiplier: number,
    regimeMultiplier: number,
    checks: CheckResult[],
    cooldownSeconds: number,
    timestamp: number
): EntryValidationResult {
    return {
        canEnter,
        blocked,
        reason,
        finalPositionMultiplier,
        executionQuality,
        congestionMultiplier,
        regimeMultiplier,
        checks,
        cooldownSeconds,
        timestamp,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENHANCED POSITION MULTIPLIER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get final position multiplier combining regime, execution, and congestion.
 * 
 * This is the enhanced version of getPositionMultiplier that integrates:
 * - Regime-based sizing (0-1.8)
 * - Execution quality multiplier (0-1)
 * - Congestion multiplier (0-1)
 * 
 * Formula: finalMultiplier = regimeMultiplier × executionMultiplier × congestionMultiplier
 */
export function getEnhancedPositionMultiplier(
    state: EntryValidationState,
    config: EntryValidationConfig = DEFAULT_CONFIG
): PositionSizingResult {
    // Get regime-based multiplier
    const regimeResult = computePositionMultiplier(state);
    const regimeMultiplier = regimeResult.position_multiplier;
    
    // Get execution quality multiplier
    let executionMultiplier = 1.0;
    if (config.enableExecutionCheck) {
        const execResult = computeExecutionQuality();
        const quality = execResult.score;
        
        if (quality < config.executionBlockThreshold) {
            executionMultiplier = 0;
        } else if (quality < config.executionReduceThreshold) {
            executionMultiplier = config.executionReductionFactor;
        } else if (quality >= config.executionNormalThreshold) {
            executionMultiplier = 1.0;
        } else {
            const range = config.executionNormalThreshold - config.executionReduceThreshold;
            const progress = (quality - config.executionReduceThreshold) / range;
            executionMultiplier = config.executionReductionFactor + (progress * (1.0 - config.executionReductionFactor));
        }
    }
    
    // Get congestion multiplier
    let congestionMultiplier = 1.0;
    if (config.enableCongestionCheck) {
        congestionMultiplier = getCongestionPositionMultiplier();
    }
    
    // Combine multipliers
    const finalMultiplier = regimeMultiplier * executionMultiplier * congestionMultiplier;
    const blocked = finalMultiplier === 0;
    
    let reason: string;
    if (blocked) {
        const blockedBy = regimeMultiplier === 0 ? 'regime' 
            : executionMultiplier === 0 ? 'execution' 
            : 'congestion';
        reason = `BLOCKED by ${blockedBy}`;
    } else {
        reason = `Multiplier: ${(finalMultiplier * 100).toFixed(1)}% ` +
            `(R=${(regimeMultiplier * 100).toFixed(0)}% × ` +
            `E=${(executionMultiplier * 100).toFixed(0)}% × ` +
            `C=${(congestionMultiplier * 100).toFixed(0)}%)`;
    }
    
    return {
        finalMultiplier,
        regimeMultiplier,
        executionMultiplier,
        congestionMultiplier,
        blocked,
        reason,
    };
}

/**
 * Quick check if entry should be blocked (any check fails)
 */
export function shouldBlockEntry(
    state: EntryValidationState,
    config: EntryValidationConfig = DEFAULT_CONFIG
): boolean {
    const result = validateEntry(state, config);
    return result.blocked;
}

/**
 * Get the final position multiplier value (shorthand)
 */
export function getFinalPositionMultiplier(
    state: EntryValidationState,
    config: EntryValidationConfig = DEFAULT_CONFIG
): number {
    const result = getEnhancedPositionMultiplier(state, config);
    return result.finalMultiplier;
}

