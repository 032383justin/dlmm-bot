/**
 * Regime Playbook Engine
 * 
 * PURPOSE: Implement mode-specific trading logic based on market regime.
 * 
 * REGIMES:
 * - TREND: larger size, slower exit cutoff, allow extended targets
 * - CHOP: reduce size, faster exits, smaller hold windows
 * - CHAOS: block entries, exit anything open, cooldown
 * - NEUTRAL: normal behavior
 * - HIGH_VELOCITY: allow slightly larger entries, allow stacking if executionQuality > threshold
 * 
 * INTEGRATION:
 * Before any entry:
 *   const playbook = getActiveRegimePlaybook(inputs);
 *   if (playbook.blockEntries) { // abort }
 *   positionSize *= playbook.sizeMultiplier;
 */

// Type exports
export type {
    RegimeType,
    RegimeInputs,
    PlaybookParameters,
    RegimeDetectionResult,
    PlaybookConfig,
    RegimeTransition,
} from './types';

// Config exports
export {
    DEFAULT_CONFIG,
    TREND_PLAYBOOK,
    CHOP_PLAYBOOK,
    CHAOS_PLAYBOOK,
    NEUTRAL_PLAYBOOK,
    HIGH_VELOCITY_PLAYBOOK,
    getPlaybookForRegime,
    createConfig,
    createPlaybook,
} from './config';

// Detection exports
export {
    detectRegime,
    getCurrentRegime,
    getLastTransition,
    getRegimeDuration,
    forceRegime,
    resetRegimeState,
    isInRegime,
    isInDangerRegime,
    isInChaosCooldown,
} from './detection';

// -----------------------------------------------------------------------------
// MAIN API
// -----------------------------------------------------------------------------

import { 
    RegimeInputs, 
    PlaybookParameters, 
    RegimeDetectionResult,
    RegimeType,
} from './types';
import { detectRegime, getCurrentRegime } from './detection';
import { getPlaybookForRegime, DEFAULT_CONFIG } from './config';

/**
 * Get the active regime playbook based on current market conditions.
 * This is the primary API for the Regime Playbook Engine.
 */
export function getActiveRegimePlaybook(inputs: RegimeInputs): PlaybookParameters {
    const result = detectRegime(inputs, DEFAULT_CONFIG);
    return result.playbook;
}

/**
 * Get full regime detection result with all details.
 */
export function getRegimeResult(inputs: RegimeInputs): RegimeDetectionResult {
    return detectRegime(inputs, DEFAULT_CONFIG);
}

/**
 * Get current regime type without re-detecting.
 */
export function getActiveRegime(): RegimeType {
    return getCurrentRegime();
}

/**
 * Get regime-specific size multiplier.
 */
export function getRegimeSizeMultiplier(inputs?: RegimeInputs): number {
    if (inputs) {
        const result = detectRegime(inputs, DEFAULT_CONFIG);
        return result.playbook.sizeMultiplier;
    }
    const playbook = getPlaybookForRegime(getCurrentRegime());
    return playbook.sizeMultiplier;
}

/**
 * Check if entries should be blocked by current regime.
 */
export function shouldBlockOnRegime(inputs?: RegimeInputs): boolean {
    if (inputs) {
        const result = detectRegime(inputs, DEFAULT_CONFIG);
        return result.playbook.blockEntries;
    }
    const playbook = getPlaybookForRegime(getCurrentRegime());
    return playbook.blockEntries;
}

/**
 * Check if all positions should be force-exited.
 */
export function shouldForceExitAll(inputs?: RegimeInputs): boolean {
    if (inputs) {
        const result = detectRegime(inputs, DEFAULT_CONFIG);
        return result.playbook.forceExitAll;
    }
    const playbook = getPlaybookForRegime(getCurrentRegime());
    return playbook.forceExitAll;
}

/**
 * Check if stacking is allowed under current regime and execution quality.
 */
export function isStackingAllowed(executionQuality: number, inputs?: RegimeInputs): boolean {
    let playbook: PlaybookParameters;
    if (inputs) {
        const result = detectRegime(inputs, DEFAULT_CONFIG);
        playbook = result.playbook;
    } else {
        playbook = getPlaybookForRegime(getCurrentRegime());
    }
    
    return playbook.allowStacking && executionQuality >= playbook.stackingExecutionQualityThreshold;
}

/**
 * Get regime-adjusted exit threshold.
 */
export function getRegimeExitThreshold(inputs?: RegimeInputs): number {
    if (inputs) {
        const result = detectRegime(inputs, DEFAULT_CONFIG);
        return result.playbook.exitThreshold;
    }
    const playbook = getPlaybookForRegime(getCurrentRegime());
    return playbook.exitThreshold;
}

/**
 * Get regime-adjusted hold window multiplier.
 */
export function getRegimeHoldWindowMultiplier(inputs?: RegimeInputs): number {
    if (inputs) {
        const result = detectRegime(inputs, DEFAULT_CONFIG);
        return result.playbook.holdWindowMultiplier;
    }
    const playbook = getPlaybookForRegime(getCurrentRegime());
    return playbook.holdWindowMultiplier;
}

/**
 * Get max concurrent positions for current regime.
 */
export function getRegimeMaxPositions(inputs?: RegimeInputs): number {
    if (inputs) {
        const result = detectRegime(inputs, DEFAULT_CONFIG);
        return result.playbook.maxConcurrentPositions;
    }
    const playbook = getPlaybookForRegime(getCurrentRegime());
    return playbook.maxConcurrentPositions;
}

/**
 * Create regime inputs from pool/system metrics.
 * Helper function to convert raw metrics to RegimeInputs.
 */
export function createRegimeInputs(
    velocitySlope: number,
    liquiditySlope: number,
    entropySlope: number,
    entropy: number,
    velocity: number,
    migrationConfidence: number,
    consistency: number,
    feeIntensity: number,
    executionQuality: number
): RegimeInputs {
    return {
        velocitySlope,
        liquiditySlope,
        entropySlope,
        entropy,
        velocity,
        migrationConfidence,
        consistency,
        feeIntensity,
        executionQuality,
    };
}
