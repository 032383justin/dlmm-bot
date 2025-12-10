/**
 * Reverse Entry Guard - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Detect when migration direction reverses to prevent entering 
 * at exactly the wrong moment.
 * 
 * The bot can enter exactly when migration reverses. This guard prevents that
 * by requiring sustained migration for at least 3 consecutive checks.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { MigrationDirection } from '../../../types';

/**
 * Historical tick data for reversal detection
 */
export interface HistoryTick {
    /** Timestamp of the tick */
    timestamp: number;
    
    /** Migration direction at this tick */
    migrationDirection: MigrationDirection;
    
    /** Pool entropy at this tick */
    entropy: number;
    
    /** Liquidity flow score at this tick */
    liquidityFlow: number;
    
    /** Velocity score at this tick */
    velocity?: number;
}

/**
 * Reversal detection result
 */
export interface ReversalDetectionResult {
    /** Whether entry should be blocked */
    shouldBlock: boolean;
    
    /** Whether a reversal was detected */
    reversalDetected: boolean;
    
    /** Cooldown duration in seconds (0 if no cooldown) */
    cooldownSeconds: number;
    
    /** Timestamp when cooldown expires */
    cooldownExpiresAt?: number;
    
    /** Reason for the result */
    reason: string;
    
    /** Recent migration direction history */
    recentDirections: MigrationDirection[];
    
    /** Sustained direction count */
    sustainedCount: number;
    
    /** Required sustained count */
    requiredSustained: number;
}

/**
 * Configuration for reversal detection
 */
export interface ReversalGuardConfig {
    /** Number of recent ticks to analyze */
    recentTickCount: number;
    
    /** Number of older ticks for comparison */
    historicalTickCount: number;
    
    /** Minimum sustained migrations required before entry */
    minSustainedMigrations: number;
    
    /** Cooldown duration in seconds when reversal detected */
    cooldownSeconds: number;
    
    /** Maximum cooldown duration in seconds */
    maxCooldownSeconds: number;
    
    /** Entropy change threshold for reversal detection */
    entropyChangeThreshold: number;
    
    /** Liquidity flow reversal threshold */
    liquidityFlowReversalThreshold: number;
}

/**
 * Cooldown state for a pool
 */
export interface PoolCooldownState {
    /** Pool address */
    poolAddress: string;
    
    /** Cooldown start timestamp */
    startedAt: number;
    
    /** Cooldown duration in seconds */
    durationSeconds: number;
    
    /** Reason for cooldown */
    reason: string;
}

