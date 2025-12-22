/**
 * Regime Playbook Engine - Detection
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Detects current market regime and returns appropriate playbook.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
    RegimeType,
    RegimeInputs,
    RegimeDetectionResult,
    PlaybookConfig,
    RegimeTransition,
} from './types';
import { 
    DEFAULT_CONFIG, 
    getPlaybookForRegime,
} from './config';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let currentRegime: RegimeType = 'NEUTRAL';
let regimeStartTime: number = Date.now();
let lastTransition: RegimeTransition | null = null;
let chaosExitTime: number = 0;
const recentInputs: RegimeInputs[] = [];
const MAX_INPUT_HISTORY = 10;

// ═══════════════════════════════════════════════════════════════════════════════
// HYSTERESIS STATE — Tracks regime detection history for confirmation
// ═══════════════════════════════════════════════════════════════════════════════
const recentDetections: RegimeType[] = [];
let lastRegimeFlipLog: number = 0;
const FLIP_LOG_COOLDOWN_MS = 30_000; // Don't spam flip logs more than once per 30s

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect current regime based on market inputs
 */
export function detectRegime(
    inputs: RegimeInputs,
    config: PlaybookConfig = DEFAULT_CONFIG
): RegimeDetectionResult {
    const now = Date.now();
    
    // Store input for stability detection
    recentInputs.push(inputs);
    if (recentInputs.length > MAX_INPUT_HISTORY) {
        recentInputs.shift();
    }
    
    // Check if in cooldown after CHAOS exit
    if (chaosExitTime > 0 && now - chaosExitTime < config.chaosCooldownMs) {
        const playbook = getPlaybookForRegime('NEUTRAL');
        return {
            regime: 'NEUTRAL',
            confidence: 0.5,
            playbook: {
                ...playbook,
                blockEntries: true, // Still block during cooldown
                description: 'Post-CHAOS cooldown → entries blocked',
            },
            reason: `In cooldown after CHAOS exit (${Math.round((config.chaosCooldownMs - (now - chaosExitTime)) / 1000)}s remaining)`,
            allowTrading: false,
            timestamp: now,
            transitionDetected: false,
        };
    }
    
    // Detect regime with priority order
    // NOTE: Detection logic is UNCHANGED — only the gating of transitions is modified
    let detectedRegime: RegimeType;
    let confidence: number;
    let reason: string;
    
    // CHAOS detection (highest priority)
    if (inputs.entropy > config.chaosEntropyThreshold) {
        detectedRegime = 'CHAOS';
        confidence = Math.min(1, (inputs.entropy - config.chaosEntropyThreshold) / 0.1 + 0.7);
        reason = `High entropy ${(inputs.entropy * 100).toFixed(1)}% > ${(config.chaosEntropyThreshold * 100).toFixed(0)}% threshold`;
    }
    // TREND detection
    else if (
        Math.abs(inputs.velocitySlope) > config.trendSlopeThreshold &&
        inputs.migrationConfidence > 0.50
    ) {
        detectedRegime = 'TREND';
        confidence = Math.min(1, inputs.migrationConfidence + 0.2);
        reason = `Strong velocity slope ${(inputs.velocitySlope * 100).toFixed(2)}% with migration confidence ${(inputs.migrationConfidence * 100).toFixed(0)}%`;
    }
    // HIGH_VELOCITY detection
    else if (
        inputs.velocity > config.highVelocityThreshold &&
        inputs.migrationConfidence > 0.40
    ) {
        detectedRegime = 'HIGH_VELOCITY';
        confidence = Math.min(1, (inputs.velocity - config.highVelocityThreshold) / 35 + 0.5);
        reason = `High velocity ${inputs.velocity.toFixed(0)} > ${config.highVelocityThreshold} with direction`;
    }
    // CHOP detection
    else if (inputs.consistency < config.chopConsistencyThreshold) {
        detectedRegime = 'CHOP';
        confidence = Math.min(1, (config.chopConsistencyThreshold - inputs.consistency) / 0.2 + 0.5);
        reason = `Low consistency ${(inputs.consistency * 100).toFixed(1)}% < ${(config.chopConsistencyThreshold * 100).toFixed(0)}% threshold`;
    }
    // Default to NEUTRAL
    else {
        detectedRegime = 'NEUTRAL';
        confidence = 0.6;
        reason = 'No strong regime signals detected';
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HYSTERESIS LAYER 1: Store detection for confirmation tracking
    // ═══════════════════════════════════════════════════════════════════════════
    recentDetections.push(detectedRegime);
    const windowSize = config.confirmationWindowSize || 5;
    if (recentDetections.length > windowSize) {
        recentDetections.shift();
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HYSTERESIS LAYER 2: Apply stability check with hysteresis
    // ═══════════════════════════════════════════════════════════════════════════
    const stableRegime = checkRegimeStabilityWithHysteresis(detectedRegime, inputs, config);
    
    // Handle regime transition
    const transitionDetected = stableRegime !== currentRegime;
    let previousRegime: RegimeType | undefined;
    
    if (transitionDetected) {
        previousRegime = currentRegime;
        
        // Record transition
        lastTransition = {
            from: currentRegime,
            to: stableRegime,
            timestamp: now,
            reason,
        };
        
        // Update chaos exit time if leaving CHAOS
        if (currentRegime === 'CHAOS') {
            chaosExitTime = now;
        }
        
        currentRegime = stableRegime;
        regimeStartTime = now;
    }
    
    const playbook = getPlaybookForRegime(currentRegime);
    
    return {
        regime: currentRegime,
        confidence,
        playbook,
        reason,
        allowTrading: !playbook.blockEntries,
        timestamp: now,
        transitionDetected,
        previousRegime,
    };
}

/**
 * Check if detected regime is stable enough to transition
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * HYSTERESIS IMPLEMENTATION — Three-layer protection against noisy flips
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Layer 1: Minimum dwell time — Must stay in current regime for minDwellTimeMs
 * Layer 2: Consecutive confirmations — Need N of last M cycles to agree
 * Layer 3: Hysteresis band — New regime must exceed threshold + buffer
 * 
 * RULES:
 * - CHAOS is always immediate (safety override)
 * - All other transitions require all three layers to pass
 * - Does NOT change MHI calculation or regime definitions
 * - Only gates WHEN a switch is allowed
 * 
 * @param detectedRegime - The regime detected this cycle
 * @param inputs - Current market inputs (for hysteresis band check)
 * @param config - Playbook configuration
 * @returns The regime to use (may be current if transition blocked)
 */
function checkRegimeStabilityWithHysteresis(
    detectedRegime: RegimeType,
    inputs: RegimeInputs,
    config: PlaybookConfig
): RegimeType {
    const now = Date.now();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SAFETY OVERRIDE: CHAOS is always immediate
    // ═══════════════════════════════════════════════════════════════════════════
    if (detectedRegime === 'CHAOS') {
        return 'CHAOS';
    }
    
    // If already in this regime, stay there
    if (detectedRegime === currentRegime) {
        return currentRegime;
    }
    
    // Need minimum samples for any detection
    if (recentInputs.length < config.minSamplesForDetection) {
        return currentRegime;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HYSTERESIS LAYER 1: Minimum dwell time
    // Must stay in current regime for minDwellTimeMs before switching
    // ═══════════════════════════════════════════════════════════════════════════
    const regimeDuration = now - regimeStartTime;
    const minDwellTime = config.minDwellTimeMs || 180_000; // Default 3 minutes
    
    if (regimeDuration < minDwellTime) {
        // Log suppressed flip (rate limited)
        if (now - lastRegimeFlipLog > FLIP_LOG_COOLDOWN_MS) {
            // Silently block — don't spam logs
        }
        return currentRegime;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HYSTERESIS LAYER 2: Consecutive confirmations
    // Need consecutiveConfirmations of last confirmationWindowSize to agree
    // ═══════════════════════════════════════════════════════════════════════════
    const requiredConfirmations = config.consecutiveConfirmations || 3;
    const windowSize = config.confirmationWindowSize || 5;
    
    if (recentDetections.length >= windowSize) {
        const confirmations = recentDetections.filter(r => r === detectedRegime).length;
        
        if (confirmations < requiredConfirmations) {
            // Not enough confirmations — block transition
            return currentRegime;
        }
    } else {
        // Not enough history yet — block transition
        return currentRegime;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HYSTERESIS LAYER 3: Hysteresis band check
    // New regime must exceed threshold + buffer (prevents boundary oscillation)
    // ═══════════════════════════════════════════════════════════════════════════
    const buffer = config.hysteresisBuffer || {
        entropy: 0.05,
        velocity: 5,
        slope: 0.005,
        consistency: 0.05,
    };
    
    // Check if the detected regime exceeds threshold + buffer
    // NOTE: CHAOS is already handled above (immediate return) so not in switch
    let passesHysteresisBand = false;
    
    switch (detectedRegime) {
        case 'TREND':
            // Must exceed slope threshold + buffer
            passesHysteresisBand = Math.abs(inputs.velocitySlope) > (config.trendSlopeThreshold + buffer.slope);
            break;
            
        case 'HIGH_VELOCITY':
            // Must exceed velocity threshold + buffer
            passesHysteresisBand = inputs.velocity > (config.highVelocityThreshold + buffer.velocity);
            break;
            
        case 'CHOP':
            // Must be BELOW consistency threshold - buffer
            passesHysteresisBand = inputs.consistency < (config.chopConsistencyThreshold - buffer.consistency);
            break;
            
        case 'NEUTRAL':
            // NEUTRAL is the fallback — always allowed if other conditions pass
            passesHysteresisBand = true;
            break;
    }
    
    if (!passesHysteresisBand) {
        return currentRegime;
    }
    
    // All three layers passed — transition is allowed
    return detectedRegime;
}

/**
 * @deprecated Use checkRegimeStabilityWithHysteresis instead
 * Legacy function kept for backwards compatibility
 */
function checkRegimeStability(
    detectedRegime: RegimeType,
    config: PlaybookConfig
): RegimeType {
    // CHAOS is always immediate (safety first)
    if (detectedRegime === 'CHAOS') {
        return 'CHAOS';
    }
    
    // Need minimum samples for detection
    if (recentInputs.length < config.minSamplesForDetection) {
        return currentRegime;
    }
    
    // Check how many recent detections match
    // (This is a simplified version - could be enhanced with actual detection per sample)
    const now = Date.now();
    const regimeDuration = now - regimeStartTime;
    
    // Require stability period before switching from current regime
    // Note: CHAOS is already handled above, so this check applies to other regimes
    if (regimeDuration < config.stabilityWindowMs) {
        return currentRegime;
    }
    
    return detectedRegime;
}

/**
 * Get current regime without re-detecting
 */
export function getCurrentRegime(): RegimeType {
    return currentRegime;
}

/**
 * Get last regime transition
 */
export function getLastTransition(): RegimeTransition | null {
    return lastTransition;
}

/**
 * Get time since regime started (ms)
 */
export function getRegimeDuration(): number {
    return Date.now() - regimeStartTime;
}

/**
 * Force regime (for testing or emergency override)
 */
export function forceRegime(regime: RegimeType): void {
    if (regime !== currentRegime) {
        lastTransition = {
            from: currentRegime,
            to: regime,
            timestamp: Date.now(),
            reason: 'Forced regime change',
        };
        
        if (currentRegime === 'CHAOS') {
            chaosExitTime = Date.now();
        }
        
        currentRegime = regime;
        regimeStartTime = Date.now();
    }
}

/**
 * Reset regime state (including hysteresis history)
 */
export function resetRegimeState(): void {
    currentRegime = 'NEUTRAL';
    regimeStartTime = Date.now();
    lastTransition = null;
    chaosExitTime = 0;
    recentInputs.length = 0;
    recentDetections.length = 0;
    lastRegimeFlipLog = 0;
}

/**
 * Check if currently in a specific regime
 */
export function isInRegime(regime: RegimeType): boolean {
    return currentRegime === regime;
}

/**
 * Check if in any "danger" regime (CHAOS or CHOP)
 */
export function isInDangerRegime(): boolean {
    return currentRegime === 'CHAOS' || currentRegime === 'CHOP';
}

/**
 * Check if in cooldown after CHAOS
 */
export function isInChaosCooldown(): boolean {
    if (chaosExitTime === 0) return false;
    return Date.now() - chaosExitTime < DEFAULT_CONFIG.chaosCooldownMs;
}

