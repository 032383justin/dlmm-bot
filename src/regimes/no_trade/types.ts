/**
 * No Trade Regime - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Define an explicit "do nothing" state where the bot should not trade.
 * 
 * Top bots make most of their money by avoiding trades, not entering them.
 * This module creates an explicit no-trade regime based on market conditions.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Input signals for no-trade regime detection
 */
export interface NoTradeInputs {
    /** Entropy score (0-1) - higher = more disorder */
    entropyScore: number;
    
    /** Consistency score (0-1) - higher = more consistent */
    consistencyScore: number;
    
    /** Velocity score (0-1) - combined bin/swap velocity */
    velocityScore: number;
    
    /** Liquidity flow score (0-1) - LP inflow/outflow normalized */
    liquidityFlowScore: number;
    
    /** Migration direction confidence (0-1) */
    migrationDirectionConfidence: number;
}

/**
 * Result of no-trade regime detection
 */
export interface NoTradeResult {
    /** Whether trading should be blocked */
    isNoTradeRegime: boolean;
    
    /** Cooldown duration to apply in seconds */
    cooldownSeconds: number;
    
    /** Primary reason for the result */
    reason: string;
    
    /** All triggering conditions */
    triggers: NoTradeTrigger[];
    
    /** Confidence level of the detection (0-1) */
    confidence: number;
    
    /** Timestamp of detection */
    timestamp: number;
}

/**
 * Individual trigger for no-trade regime
 */
export interface NoTradeTrigger {
    /** Trigger type */
    type: NoTradeTriggerType;
    
    /** Current value */
    value: number;
    
    /** Threshold that was triggered */
    threshold: number;
    
    /** Description of the trigger */
    description: string;
}

/**
 * Types of no-trade triggers
 */
export type NoTradeTriggerType = 
    | 'low_consistency'
    | 'high_entropy'
    | 'low_migration_confidence'
    | 'low_liquidity_flow'
    | 'low_velocity'
    | 'combined_weak';

/**
 * Configuration for no-trade regime detection
 */
export interface NoTradeConfig {
    /** Consistency threshold - below this = no trade */
    consistencyThreshold: number;
    
    /** Entropy threshold - above this = chaos = no trade */
    entropyThreshold: number;
    
    /** Migration confidence threshold - below this = no trade */
    migrationConfidenceThreshold: number;
    
    /** Liquidity flow threshold - below this = no trade */
    liquidityFlowThreshold: number;
    
    /** Velocity threshold - below this = no trade */
    velocityThreshold: number;
    
    /** Combined score threshold for weak regime detection */
    combinedWeakThreshold: number;
    
    /** Default cooldown duration when no-trade regime detected */
    defaultCooldownSeconds: number;
    
    /** Maximum cooldown duration */
    maxCooldownSeconds: number;
}

