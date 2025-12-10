/**
 * Reverse Entry Guard
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Prevent entering trades when migration direction reverses.
 * 
 * The bot can enter exactly when migration reverses. This guard prevents that
 * by detecting direction flips and requiring sustained migration.
 * 
 * RULES:
 * - If the most recent 1-3 confirming signals flip direction relative to the 
 *   last 5-10 samples, block entry
 * - Require sustained migration for at least 3 consecutive checks
 * - If reversal detected:
 *   - Abort entry
 *   - Force cooldown
 *   - Do NOT place new entry for 30-120 seconds
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Type exports
export type {
    HistoryTick,
    ReversalDetectionResult,
    ReversalGuardConfig,
    PoolCooldownState,
} from './types';

// Config exports
export {
    DEFAULT_CONFIG,
    createConfig,
} from './config';

// Tracker exports
export {
    recordTick,
    getPoolHistory,
    getRecentTicks,
    getHistoricalTicks,
    getMigrationDirectionHistory,
    clearPoolHistory,
    clearAllHistory,
    setCooldown,
    isInCooldown,
    getRemainingCooldown,
    getCooldownState,
    clearCooldown,
    clearAllCooldowns,
    countSustainedMigrations,
    detectDirectionFlip,
} from './tracker';

// Detection exports
export {
    detectReversal,
    shouldBlockEntryOnReversal,
} from './detection';

export type { TradingStateWithReversal } from './detection';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

import { TradingState } from '../../adaptive_sizing/types';
import { detectReversal, TradingStateWithReversal } from './detection';
import { DEFAULT_CONFIG } from './config';

/**
 * Check if entry should be blocked due to migration reversal.
 * 
 * This is the primary API for the Reversal Guard.
 * 
 * @param state - Current trading state with reversal inputs
 * @returns true if entry should be blocked, false otherwise
 * 
 * @example
 * ```typescript
 * const state: TradingStateWithReversal = {
 *     poolAddress: 'pool123...',
 *     migrationDirection: 'in',
 *     entropy_score: 0.75,
 *     liquidityFlow_score: 0.60,
 *     // ... other fields
 * };
 * 
 * if (shouldBlockEntryOnReversal(state)) {
 *     // Abort entry, pool is in reversal or cooldown
 *     return;
 * }
 * ```
 */
export function shouldBlockOnReversal(state: TradingStateWithReversal): boolean {
    const result = detectReversal(state, DEFAULT_CONFIG);
    return result.shouldBlock;
}

/**
 * Get full reversal detection result with details
 */
export function getReversalResult(state: TradingStateWithReversal) {
    return detectReversal(state, DEFAULT_CONFIG);
}

/**
 * Create a TradingStateWithReversal from a basic TradingState
 */
export function createReversalState(
    state: TradingState,
    poolAddress: string,
    migrationDirection?: 'in' | 'out' | 'neutral'
): TradingStateWithReversal {
    return {
        ...state,
        poolAddress,
        migrationDirection,
    };
}

