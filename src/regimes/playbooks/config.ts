/**
 * Regime Playbook Engine - Configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Playbook parameters for each regime mode.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { PlaybookParameters, PlaybookConfig, RegimeType } from './types';

/**
 * Default playbook configuration
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * HYSTERESIS SETTINGS — Prevent noisy regime flips
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PROBLEM: Regime flips every cycle due to noise, causing instability.
 * 
 * SOLUTION: Three-layer hysteresis:
 * 1. Minimum dwell time — Must stay in regime for N seconds before switching
 * 2. Consecutive confirmations — Need M of last N cycles to agree
 * 3. Hysteresis band — New regime must exceed threshold + buffer
 * 
 * These settings do NOT change regime definitions or MHI calculation.
 * They only gate WHEN a regime switch is allowed.
 */
export const DEFAULT_CONFIG: PlaybookConfig = {
    chaosEntropyThreshold: 0.80,          // Entropy > 0.80 = CHAOS
    trendSlopeThreshold: 0.02,            // Velocity slope > 0.02 = TREND
    chopConsistencyThreshold: 0.35,       // Consistency < 0.35 = CHOP
    highVelocityThreshold: 65,            // Velocity > 65 = HIGH_VELOCITY
    stackingExecutionQualityMin: 0.70,    // Execution quality for stacking
    minSamplesForDetection: 3,            // Minimum samples
    stabilityWindowMs: 60_000,            // 1 minute stability
    chaosCooldownMs: 120_000,             // 2 minute cooldown after CHAOS
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HYSTERESIS SETTINGS (NEW)
    // ═══════════════════════════════════════════════════════════════════════════
    minDwellTimeMs: 180_000,              // 3 minutes minimum in current regime before switch
    consecutiveConfirmations: 3,          // Need 3 of last 5 cycles to confirm new regime
    confirmationWindowSize: 5,            // Size of rolling confirmation window
    hysteresisBuffer: {                   // Buffer added to thresholds for switching
        entropy: 0.05,                    // Must exceed chaos threshold + 0.05 to switch
        velocity: 5,                      // Must exceed velocity threshold + 5
        slope: 0.005,                     // Must exceed slope threshold + 0.005
        consistency: 0.05,                // Must be below consistency threshold - 0.05
    },
};

/**
 * TREND playbook: Strong directional movement
 * - Larger size
 * - Slower exit cutoff
 * - Allow extended targets
 */
export const TREND_PLAYBOOK: PlaybookParameters = {
    regime: 'TREND',
    sizeMultiplier: 1.25,                 // 25% larger positions
    exitThreshold: 18,                    // Lower exit threshold (slower exit)
    holdWindowMultiplier: 1.5,            // 50% longer hold time
    allowExtendedTargets: true,           // Allow extended profit targets
    allowStacking: true,                  // Allow adding to winners
    stackingExecutionQualityThreshold: 0.70,
    entryCooldownSeconds: 30,             // Short cooldown
    maxConcurrentPositions: 5,            // Allow more positions
    blockEntries: false,
    forceExitAll: false,
    regimeCooldownSeconds: 0,
    description: 'TREND: Strong direction detected → larger size, slower exit, extended targets',
};

/**
 * CHOP playbook: Range-bound, oscillating
 * - Reduce size
 * - Faster exits
 * - Smaller hold windows
 */
export const CHOP_PLAYBOOK: PlaybookParameters = {
    regime: 'CHOP',
    sizeMultiplier: 0.60,                 // 40% smaller positions
    exitThreshold: 28,                    // Higher exit threshold (faster exit)
    holdWindowMultiplier: 0.50,           // Half the hold time
    allowExtendedTargets: false,          // No extended targets
    allowStacking: false,                 // No stacking
    stackingExecutionQualityThreshold: 1.0, // Effectively disabled
    entryCooldownSeconds: 120,            // Longer cooldown between entries
    maxConcurrentPositions: 2,            // Fewer positions
    blockEntries: false,
    forceExitAll: false,
    regimeCooldownSeconds: 0,
    description: 'CHOP: Range-bound market → reduced size, faster exits, smaller holds',
};

/**
 * CHAOS playbook: High entropy, unpredictable
 * - Block entries
 * - Exit anything open
 * - Cooldown
 */
export const CHAOS_PLAYBOOK: PlaybookParameters = {
    regime: 'CHAOS',
    sizeMultiplier: 0,                    // No new positions
    exitThreshold: 100,                   // Exit immediately
    holdWindowMultiplier: 0,              // No hold time
    allowExtendedTargets: false,
    allowStacking: false,
    stackingExecutionQualityThreshold: 1.0,
    entryCooldownSeconds: 300,            // 5 minute cooldown
    maxConcurrentPositions: 0,            // No positions allowed
    blockEntries: true,                   // Block all entries
    forceExitAll: true,                   // Force exit all
    regimeCooldownSeconds: 120,           // 2 minute cooldown after exit
    description: 'CHAOS: High entropy detected → block entries, exit all, cooldown',
};

/**
 * NEUTRAL playbook: Normal conditions
 * - Normal behavior
 */
export const NEUTRAL_PLAYBOOK: PlaybookParameters = {
    regime: 'NEUTRAL',
    sizeMultiplier: 1.0,                  // Normal size
    exitThreshold: 22,                    // Standard exit threshold
    holdWindowMultiplier: 1.0,            // Normal hold time
    allowExtendedTargets: false,
    allowStacking: false,
    stackingExecutionQualityThreshold: 0.85,
    entryCooldownSeconds: 60,             // Standard cooldown
    maxConcurrentPositions: 3,            // Standard positions
    blockEntries: false,
    forceExitAll: false,
    regimeCooldownSeconds: 0,
    description: 'NEUTRAL: Normal conditions → standard behavior',
};

/**
 * HIGH_VELOCITY playbook: High activity with direction
 * - Slightly larger entries
 * - Allow stacking if execution quality > threshold
 */
export const HIGH_VELOCITY_PLAYBOOK: PlaybookParameters = {
    regime: 'HIGH_VELOCITY',
    sizeMultiplier: 1.15,                 // 15% larger positions
    exitThreshold: 20,                    // Slightly lower exit threshold
    holdWindowMultiplier: 1.25,           // 25% longer hold
    allowExtendedTargets: true,
    allowStacking: true,                  // Allow stacking
    stackingExecutionQualityThreshold: 0.70, // Only if execution quality > 70%
    entryCooldownSeconds: 45,
    maxConcurrentPositions: 4,
    blockEntries: false,
    forceExitAll: false,
    regimeCooldownSeconds: 0,
    description: 'HIGH_VELOCITY: High activity with direction → larger entries, stacking allowed',
};

/**
 * Get playbook for a regime type
 */
export function getPlaybookForRegime(regime: RegimeType): PlaybookParameters {
    switch (regime) {
        case 'TREND':
            return TREND_PLAYBOOK;
        case 'CHOP':
            return CHOP_PLAYBOOK;
        case 'CHAOS':
            return CHAOS_PLAYBOOK;
        case 'HIGH_VELOCITY':
            return HIGH_VELOCITY_PLAYBOOK;
        case 'NEUTRAL':
        default:
            return NEUTRAL_PLAYBOOK;
    }
}

/**
 * Create custom config with overrides
 */
export function createConfig(overrides: Partial<PlaybookConfig>): PlaybookConfig {
    return {
        ...DEFAULT_CONFIG,
        ...overrides,
    };
}

/**
 * Create custom playbook with overrides
 */
export function createPlaybook(
    base: RegimeType,
    overrides: Partial<PlaybookParameters>
): PlaybookParameters {
    return {
        ...getPlaybookForRegime(base),
        ...overrides,
    };
}

