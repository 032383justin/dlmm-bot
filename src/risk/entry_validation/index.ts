/**
 * Entry Validation Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Unified pre-trade validation that enforces all safety checks in order.
 * 
 * This module is the SINGLE POINT of entry validation for the trading engine.
 * It combines all risk checks in the correct order and returns a unified result.
 * 
 * EVALUATION ORDER:
 * 1. isNoTradeRegime()          → Block on market chaos
 * 2. shouldBlockEntryOnReversal() → Block on migration reversal  
 * 3. getExecutionQuality()       → Check execution health
 * 4. getCongestionMultiplier()   → Check network congestion
 * 5. getPositionMultiplier()     → Compute final sizing
 * 
 * Only if ALL return valid → allow entry.
 * 
 * USAGE:
 * ```typescript
 * import { validateEntry, shouldBlockEntry } from './risk/entry_validation';
 * 
 * // Full validation with detailed result
 * const result = validateEntry(state);
 * if (!result.canEnter) {
 *     console.log(`Entry blocked: ${result.reason}`);
 *     applyCooldown(result.cooldownSeconds);
 *     return;
 * }
 * 
 * const positionSize = baseSize * result.finalPositionMultiplier;
 * 
 * // Quick check
 * if (shouldBlockEntry(state)) {
 *     return;
 * }
 * ```
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Type exports
export type {
    EntryValidationState,
    EntryValidationResult,
    CheckResult,
    PositionSizingResult,
    EntryValidationConfig,
} from './types';

// Config exports
export {
    DEFAULT_CONFIG,
    CONSERVATIVE_CONFIG,
    AGGRESSIVE_CONFIG,
    createConfig,
} from './config';

// Validation exports
export {
    validateEntry,
    getEnhancedPositionMultiplier,
    shouldBlockEntry,
    getFinalPositionMultiplier,
} from './validation';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API - RE-EXPORTS WITH CLEAR NAMING
// ═══════════════════════════════════════════════════════════════════════════════

import { TradingState } from '../adaptive_sizing/types';
import { MigrationDirection } from '../../types';
import { EntryValidationState, EntryValidationResult, PositionSizingResult } from './types';
import { DEFAULT_CONFIG, EntryValidationConfig } from './config';
import { 
    validateEntry as validate, 
    getEnhancedPositionMultiplier as getEnhanced,
    shouldBlockEntry as shouldBlock 
} from './validation';

/**
 * Create an EntryValidationState from a TradingState
 */
export function createEntryValidationState(
    state: TradingState,
    poolAddress: string,
    migrationDirection?: MigrationDirection,
    options?: {
        migrationDirectionHistory?: MigrationDirection[];
        entropyHistory?: number[];
        liquidityFlowHistory?: number[];
    }
): EntryValidationState {
    return {
        ...state,
        poolAddress,
        migrationDirection,
        migrationDirectionHistory: options?.migrationDirectionHistory,
        entropyHistory: options?.entropyHistory,
        liquidityFlowHistory: options?.liquidityFlowHistory,
    };
}

/**
 * Run full entry validation and return result.
 * This is the PRIMARY API for entry decisions.
 * 
 * @param state - Extended trading state with pool and migration info
 * @param config - Optional configuration override
 * @returns Complete validation result
 * 
 * @example
 * ```typescript
 * const state = createEntryValidationState(tradingState, poolAddress, 'in');
 * const result = runEntryValidation(state);
 * 
 * if (!result.canEnter) {
 *     console.log(`Blocked: ${result.reason}`);
 *     return;
 * }
 * 
 * const size = basePosition * result.finalPositionMultiplier;
 * ```
 */
export function runEntryValidation(
    state: EntryValidationState,
    config?: EntryValidationConfig
): EntryValidationResult {
    return validate(state, config ?? DEFAULT_CONFIG);
}

/**
 * Quick check if entry should be blocked.
 * Use this for fast gating before detailed validation.
 * 
 * @param state - Extended trading state
 * @returns true if entry should be blocked
 */
export function isEntryBlocked(
    state: EntryValidationState,
    config?: EntryValidationConfig
): boolean {
    return shouldBlock(state, config ?? DEFAULT_CONFIG);
}

/**
 * Get combined position multiplier with all adjustments.
 * 
 * @param state - Extended trading state
 * @returns Position sizing result with breakdown
 */
export function getPositionSizing(
    state: EntryValidationState,
    config?: EntryValidationConfig
): PositionSizingResult {
    return getEnhanced(state, config ?? DEFAULT_CONFIG);
}

/**
 * Get final position multiplier as a single value.
 * 
 * @param state - Extended trading state
 * @returns Position multiplier between 0 and 1.8
 */
export function getPositionMultiplierValue(
    state: EntryValidationState,
    config?: EntryValidationConfig
): number {
    const result = getEnhanced(state, config ?? DEFAULT_CONFIG);
    return result.finalMultiplier;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if trading conditions are favorable.
 * Returns true only if all checks pass and multiplier is reasonable.
 */
export function areTradingConditionsFavorable(
    state: EntryValidationState,
    minMultiplier: number = 0.30,
    config?: EntryValidationConfig
): boolean {
    const result = validate(state, config ?? DEFAULT_CONFIG);
    return result.canEnter && result.finalPositionMultiplier >= minMultiplier;
}

/**
 * Get a summary string of current validation state.
 * Useful for logging and debugging.
 */
export function getValidationSummary(
    state: EntryValidationState,
    config?: EntryValidationConfig
): string {
    const result = validate(state, config ?? DEFAULT_CONFIG);
    
    const status = result.canEnter ? '✅ VALID' : '⛔ BLOCKED';
    const multiplier = `${(result.finalPositionMultiplier * 100).toFixed(1)}%`;
    const breakdown = [
        `R=${(result.regimeMultiplier * 100).toFixed(0)}%`,
        `E=${(result.executionQuality * 100).toFixed(0)}%`,
        `C=${(result.congestionMultiplier * 100).toFixed(0)}%`,
    ].join(' ');
    
    return `${status} | Mult: ${multiplier} (${breakdown}) | ${result.reason}`;
}

