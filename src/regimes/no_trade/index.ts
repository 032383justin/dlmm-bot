/**
 * No Trade Regime Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Create an explicit "do nothing" state where the bot should not trade.
 * 
 * Top bots make most of their money by avoiding trades, not entering them.
 * This module defines conditions under which trading should be blocked.
 * 
 * RULES:
 * - if consistency < 0.35 → no trade (unreliable signals)
 * - if entropy > 0.80 → chaos → no trade
 * - if migration confidence < 0.25 → no trade (unclear direction)
 * - if liquidityFlowScore < 0.20 → no trade (thin liquidity)
 * 
 * INTEGRATION:
 * Before any entry action:
 *   if (isNoTradeRegime(inputs)) {
 *     // abort entry
 *     // trigger cooldown
 *   }
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Type exports
export type {
    NoTradeInputs,
    NoTradeResult,
    NoTradeTrigger,
    NoTradeTriggerType,
    NoTradeConfig,
} from './types';

// Config exports
export {
    DEFAULT_CONFIG,
    CONSERVATIVE_CONFIG,
    AGGRESSIVE_CONFIG,
    createConfig,
} from './config';

// Detection exports
export {
    detectNoTradeRegime,
    isNoTradeRegime,
    getNoTradeTriggerType,
} from './detection';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════════

import { TradingState } from '../../risk/adaptive_sizing/types';
import { detectNoTradeRegime, isNoTradeRegime as checkNoTrade } from './detection';
import { NoTradeInputs, NoTradeResult } from './types';
import { DEFAULT_CONFIG, FEE_BULLY_CONFIG } from './config';
import { FEE_BULLY_MODE_ENABLED } from '../../config/feeBullyConfig';

/**
 * Check if current trading state is a no-trade regime.
 * 
 * This is the primary API for the No Trade Regime module.
 * 
 * @param state - Current trading state
 * @returns true if trading should be blocked, false otherwise
 * 
 * @example
 * ```typescript
 * const state: TradingState = {
 *     entropy_score: 0.85,  // High entropy = chaos
 *     consistency_score: 0.30,
 *     // ...
 * };
 * 
 * if (isNoTradeRegimeFromState(state)) {
 *     // Abort entry, trigger cooldown
 *     return;
 * }
 * ```
 */
export function isNoTradeRegimeFromState(state: TradingState): boolean {
    const inputs = tradingStateToInputs(state);
    return checkNoTrade(inputs);
}

/**
 * Get full no-trade regime result from trading state
 * 
 * In Fee Bully Mode, uses much more permissive thresholds that only block
 * on true infrastructure red flags (extreme chaos, dead markets).
 */
export function getNoTradeResult(state: TradingState): NoTradeResult {
    const inputs = tradingStateToInputs(state);
    const config = FEE_BULLY_MODE_ENABLED ? FEE_BULLY_CONFIG : DEFAULT_CONFIG;
    return detectNoTradeRegime(inputs, config);
}

/**
 * Convert TradingState to NoTradeInputs
 */
export function tradingStateToInputs(state: TradingState): NoTradeInputs {
    return {
        entropyScore: state.entropy_score,
        consistencyScore: state.consistency_score,
        velocityScore: state.velocity_score,
        liquidityFlowScore: state.liquidityFlow_score,
        migrationDirectionConfidence: state.migrationDirection_confidence,
    };
}

/**
 * Check if trading should be blocked with detailed result
 */
export function shouldBlockTrade(state: TradingState): {
    blocked: boolean;
    reason: string;
    cooldownSeconds: number;
} {
    const result = getNoTradeResult(state);
    return {
        blocked: result.isNoTradeRegime,
        reason: result.reason,
        cooldownSeconds: result.cooldownSeconds,
    };
}

