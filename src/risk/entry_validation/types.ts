/**
 * Entry Validation Module - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Unified pre-trade validation that enforces all safety checks in order.
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

import { TradingState } from '../adaptive_sizing/types';
import { MigrationDirection } from '../../types';

/**
 * Extended trading state with all validation inputs
 */
export interface EntryValidationState extends TradingState {
    /** Pool address for per-pool tracking */
    poolAddress: string;
    
    /** Current migration direction */
    migrationDirection?: MigrationDirection;
    
    /** Migration direction history (last N ticks) */
    migrationDirectionHistory?: MigrationDirection[];
    
    /** Entropy history (last N ticks) */
    entropyHistory?: number[];
    
    /** Liquidity flow history (last N ticks) */
    liquidityFlowHistory?: number[];
}

/**
 * Individual check result
 */
export interface CheckResult {
    /** Name of the check */
    check: string;
    
    /** Whether the check passed */
    passed: boolean;
    
    /** Whether this check blocked entry */
    blocked: boolean;
    
    /** Computed value or score */
    value?: number;
    
    /** Applied multiplier (if any) */
    multiplier?: number;
    
    /** Reason for the result */
    reason: string;
    
    /** Cooldown to apply if blocked (seconds) */
    cooldownSeconds?: number;
}

/**
 * Complete entry validation result
 */
export interface EntryValidationResult {
    /** Whether entry is allowed */
    canEnter: boolean;
    
    /** Whether entry was explicitly blocked */
    blocked: boolean;
    
    /** Primary reason for the result */
    reason: string;
    
    /** Combined position multiplier after all adjustments */
    finalPositionMultiplier: number;
    
    /** Execution quality score (0-1) */
    executionQuality: number;
    
    /** Congestion multiplier (0-1) */
    congestionMultiplier: number;
    
    /** Base regime multiplier (0-1.8) */
    regimeMultiplier: number;
    
    /** Results of each individual check */
    checks: CheckResult[];
    
    /** Cooldown to apply if blocked (seconds) */
    cooldownSeconds: number;
    
    /** Timestamp of validation */
    timestamp: number;
}

/**
 * Configuration for entry validation thresholds
 */
export interface EntryValidationConfig {
    /** Enable/disable individual checks */
    enableNoTradeCheck: boolean;
    enableReversalCheck: boolean;
    enableExecutionCheck: boolean;
    enableCongestionCheck: boolean;
    
    /** Execution quality thresholds */
    executionBlockThreshold: number;    // < 0.35 → block entries
    executionReduceThreshold: number;   // < 0.50 → reduce position size by 60%
    executionNormalThreshold: number;   // > 0.80 → allow normal sizing
    executionReductionFactor: number;   // 0.40 = 60% reduction
    
    /** Congestion thresholds */
    congestionBlockThreshold: number;   // > 0.85 → block trading
    congestionHalfThreshold: number;    // > 0.70 → halve position size
    congestionReduceThreshold: number;  // > 0.60 → reduce frequency
    
    /** Minimum combined multiplier to allow entry */
    minCombinedMultiplier: number;
    
    /** Default cooldown when blocked (seconds) */
    defaultCooldownSeconds: number;
    
    /** Max cooldown duration (seconds) */
    maxCooldownSeconds: number;
}

/**
 * Position sizing result with all multipliers
 */
export interface PositionSizingResult {
    /** Final position multiplier (product of all) */
    finalMultiplier: number;
    
    /** Individual multiplier breakdown */
    regimeMultiplier: number;
    executionMultiplier: number;
    congestionMultiplier: number;
    
    /** Whether sizing is blocked (multiplier = 0) */
    blocked: boolean;
    
    /** Reason for the multiplier value */
    reason: string;
}

