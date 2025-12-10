/**
 * No Trade Regime - Detection Logic
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Detect when market conditions indicate the bot should not trade.
 * 
 * Top bots make most of their money by avoiding trades, not entering them.
 * This creates an explicit no-trade state.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { 
    NoTradeInputs, 
    NoTradeResult, 
    NoTradeTrigger,
    NoTradeConfig 
} from './types';
import { DEFAULT_CONFIG } from './config';
import logger from '../../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTION LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect if current conditions constitute a no-trade regime
 */
export function detectNoTradeRegime(
    inputs: NoTradeInputs,
    config: NoTradeConfig = DEFAULT_CONFIG
): NoTradeResult {
    const triggers: NoTradeTrigger[] = [];
    const now = Date.now();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: Low consistency (unreliable signals)
    // ═══════════════════════════════════════════════════════════════════════════
    if (inputs.consistencyScore < config.consistencyThreshold) {
        triggers.push({
            type: 'low_consistency',
            value: inputs.consistencyScore,
            threshold: config.consistencyThreshold,
            description: `Consistency ${(inputs.consistencyScore * 100).toFixed(1)}% < ${(config.consistencyThreshold * 100).toFixed(0)}% threshold`,
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: High entropy (chaos)
    // ═══════════════════════════════════════════════════════════════════════════
    if (inputs.entropyScore > config.entropyThreshold) {
        triggers.push({
            type: 'high_entropy',
            value: inputs.entropyScore,
            threshold: config.entropyThreshold,
            description: `Entropy ${(inputs.entropyScore * 100).toFixed(1)}% > ${(config.entropyThreshold * 100).toFixed(0)}% threshold (chaos)`,
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 3: Low migration confidence (unclear direction)
    // ═══════════════════════════════════════════════════════════════════════════
    if (inputs.migrationDirectionConfidence < config.migrationConfidenceThreshold) {
        triggers.push({
            type: 'low_migration_confidence',
            value: inputs.migrationDirectionConfidence,
            threshold: config.migrationConfidenceThreshold,
            description: `Migration confidence ${(inputs.migrationDirectionConfidence * 100).toFixed(1)}% < ${(config.migrationConfidenceThreshold * 100).toFixed(0)}% threshold`,
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 4: Low liquidity flow (thin market)
    // ═══════════════════════════════════════════════════════════════════════════
    if (inputs.liquidityFlowScore < config.liquidityFlowThreshold) {
        triggers.push({
            type: 'low_liquidity_flow',
            value: inputs.liquidityFlowScore,
            threshold: config.liquidityFlowThreshold,
            description: `Liquidity flow ${(inputs.liquidityFlowScore * 100).toFixed(1)}% < ${(config.liquidityFlowThreshold * 100).toFixed(0)}% threshold`,
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 5: Low velocity (dead market)
    // ═══════════════════════════════════════════════════════════════════════════
    if (inputs.velocityScore < config.velocityThreshold) {
        triggers.push({
            type: 'low_velocity',
            value: inputs.velocityScore,
            threshold: config.velocityThreshold,
            description: `Velocity ${(inputs.velocityScore * 100).toFixed(1)}% < ${(config.velocityThreshold * 100).toFixed(0)}% threshold`,
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 6: Combined weak regime (all signals are marginal)
    // ═══════════════════════════════════════════════════════════════════════════
    const combinedScore = (
        inputs.consistencyScore +
        (1 - inputs.entropyScore) + // Invert entropy (lower is better)
        inputs.migrationDirectionConfidence +
        inputs.liquidityFlowScore +
        inputs.velocityScore
    ) / 5;
    
    if (combinedScore < config.combinedWeakThreshold && triggers.length === 0) {
        triggers.push({
            type: 'combined_weak',
            value: combinedScore,
            threshold: config.combinedWeakThreshold,
            description: `Combined regime strength ${(combinedScore * 100).toFixed(1)}% < ${(config.combinedWeakThreshold * 100).toFixed(0)}% threshold`,
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE RESULT
    // ═══════════════════════════════════════════════════════════════════════════
    const isNoTradeRegime = triggers.length > 0;
    
    // Cooldown duration scales with number of triggers
    let cooldownSeconds = 0;
    if (isNoTradeRegime) {
        cooldownSeconds = Math.min(
            config.defaultCooldownSeconds * triggers.length,
            config.maxCooldownSeconds
        );
    }
    
    // Calculate confidence based on how many triggers fired
    const confidence = isNoTradeRegime 
        ? Math.min(triggers.length / 3, 1.0)  // Max confidence at 3+ triggers
        : combinedScore;
    
    // Generate primary reason
    let reason: string;
    if (!isNoTradeRegime) {
        reason = `Trade allowed: regime strength ${(combinedScore * 100).toFixed(1)}%`;
    } else if (triggers.length === 1) {
        reason = triggers[0].description;
    } else {
        reason = `Multiple no-trade triggers: ${triggers.map(t => t.type).join(', ')}`;
    }
    
    // Log if no-trade regime detected
    if (isNoTradeRegime) {
        logger.info(`[NO_TRADE_REGIME] ⛔ ${reason}`);
        for (const trigger of triggers) {
            logger.debug(`[NO_TRADE_REGIME]   - ${trigger.description}`);
        }
    }
    
    return {
        isNoTradeRegime,
        cooldownSeconds,
        reason,
        triggers,
        confidence,
        timestamp: now,
    };
}

/**
 * Quick check if trading should be blocked
 */
export function isNoTradeRegime(inputs: NoTradeInputs): boolean {
    const result = detectNoTradeRegime(inputs);
    return result.isNoTradeRegime;
}

/**
 * Get the primary trigger type if in no-trade regime
 */
export function getNoTradeTriggerType(inputs: NoTradeInputs): string | null {
    const result = detectNoTradeRegime(inputs);
    if (!result.isNoTradeRegime) return null;
    return result.triggers[0]?.type ?? null;
}

