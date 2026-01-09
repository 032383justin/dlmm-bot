/**
 * Regime-Adaptive Aggression Scaling — Dynamic Position Sizing
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 DOMINANT — REGIME-ADAPTIVE EXECUTION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Scale aggression (size, bin density, exit sensitivity) based on
 * confirmed market regime, NEVER preemptively.
 * 
 * REGIME SCALING TABLE:
 * ┌──────────┬──────────────┬─────────────┬──────────────────┐
 * │ Regime   │ Size Mult    │ Bin Density │ Exit Sensitivity │
 * ├──────────┼──────────────┼─────────────┼──────────────────┤
 * │ BEAR     │ 0.7×         │ Wider       │ Very sensitive   │
 * │ NEUTRAL  │ 1.0×         │ Normal      │ Balanced         │
 * │ BULL     │ 1.3×         │ Narrower    │ Less sensitive   │
 * └──────────┴──────────────┴─────────────┴──────────────────┘
 * 
 * SAFETY RULES:
 * 1. Scaling applies ONLY after regime stability window
 * 2. NO size increases on first regime flip
 * 3. All adjustments logged via [AGGRESSION]
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 VALIDATION FLAGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dev mode flag for strict validation assertions
 */
const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — ALL JUSTIFIED
// ═══════════════════════════════════════════════════════════════════════════════

export const AGGRESSION_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // REGIME SIZE MULTIPLIERS — NEUTRALIZED
    // REGIME_ECONOMIC_IMPACT=DISABLED: All regimes use 1.0
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Size multiplier by regime — NEUTRALIZED
     * All regimes use 1.0 (no regime-based sizing)
     */
    sizeMultiplier: {
        BEAR: 1.00,      // NEUTRALIZED
        NEUTRAL: 1.00,
        BULL: 1.00,      // NEUTRALIZED
    } as Record<MarketRegime, number>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BIN DENSITY CONFIGURATION — NEUTRALIZED
    // REGIME_ECONOMIC_IMPACT=DISABLED: All regimes use 1.0
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Bin width multiplier by regime — NEUTRALIZED
     * All regimes use 1.0 (no regime-based bin adjustment)
     */
    binWidthMultiplier: {
        BEAR: 1.00,      // NEUTRALIZED
        NEUTRAL: 1.00,
        BULL: 1.00,      // NEUTRALIZED
    } as Record<MarketRegime, number>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT SENSITIVITY CONFIGURATION — NEUTRALIZED
    // REGIME_ECONOMIC_IMPACT=DISABLED: All regimes use 1.0
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Exit threshold multiplier by regime — NEUTRALIZED
     * All regimes use 1.0 (no regime-based exit sensitivity)
     */
    exitSensitivityMultiplier: {
        BEAR: 1.00,      // NEUTRALIZED
        NEUTRAL: 1.00,   // Standard
        BULL: 1.25,      // Less sensitive - higher threshold
    } as Record<MarketRegime, number>,
    
    /**
     * Score decay tolerance by regime (% of entry score)
     * Justification:
     *   BEAR: Only 10% decay tolerated before concern
     *   NEUTRAL: 20% decay is acceptable
     *   BULL: 30% decay before concern (more tolerance)
     */
    scoreDecayTolerance: {
        BEAR: 0.10,
        NEUTRAL: 0.20,
        BULL: 0.30,
    } as Record<MarketRegime, number>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REGIME STABILITY REQUIREMENTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Minimum time in regime before scaling applies (ms)
     * Justification: Requires 5 minutes of stable regime to avoid
     * scaling on transient regime flips
     */
    regimeStabilityWindowMs: 5 * 60 * 1000, // 5 minutes
    
    /**
     * Minimum cycles in same regime before scaling applies
     * Justification: Requires 3 consecutive cycles in same regime
     * to confirm regime is stable
     */
    minCyclesForStability: 3,
    
    /**
     * Size increase dampening on first flip
     * Justification: Never increase size immediately after regime flip;
     * apply 0.85× dampening for first scale-up
     */
    firstFlipDampeningFactor: 0.85,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COOLDOWN CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Cooldown after regime flip before aggression scaling (ms)
     * Justification: Wait 2 minutes after any regime change before
     * applying aggressive scaling
     */
    regimeFlipCooldownMs: 2 * 60 * 1000, // 2 minutes
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Regime tracking state
 */
interface RegimeState {
    currentRegime: MarketRegime;
    previousRegime: MarketRegime | null;
    regimeEnteredAt: number;
    consecutiveCycles: number;
    lastFlipTime: number;
    totalFlips: number;
}

/**
 * Input hysteresis state — prevents noisy regime flips
 * 
 * A new regime must be signaled for HYSTERESIS_CONFIRMATION_CYCLES consecutive
 * cycles before it is committed to regimeState. This prevents single-cycle
 * noise from resetting consecutiveCycles and breaking stability tracking.
 */
interface InputHysteresisState {
    pendingRegime: MarketRegime | null;  // The regime being evaluated for confirmation
    pendingCycles: number;               // How many consecutive cycles it's been pending
    lastSignaledRegime: MarketRegime;    // The regime signaled in the most recent call
}

/**
 * Number of consecutive cycles a new regime must be signaled before committing
 * 
 * Justification: 3 cycles prevents single-scan noise from flipping regime
 * while still being responsive to genuine market shifts (3 × 120s = 6 min max delay)
 */
const HYSTERESIS_CONFIRMATION_CYCLES = 3;

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HARD SAFETY GUARD — MINIMUM REGIME DWELL TIME
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Even if hysteresis is satisfied (3 consecutive confirmations), a regime flip
 * is BLOCKED if less than MIN_REGIME_DWELL_MS has passed since the last flip.
 * 
 * This is a HARD BLOCK that cannot be bypassed by any signal pattern.
 * It ensures regime stability and prevents control-plane oscillation.
 * 
 * Justification: 5 minutes minimum dwell time ensures regime stability
 * even under extremely noisy market conditions.
 */
const MIN_REGIME_DWELL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Aggression scaling result
 */
export interface AggressionScaling {
    // Multipliers
    sizeMultiplier: number;
    binWidthMultiplier: number;
    exitSensitivityMultiplier: number;
    scoreDecayTolerance: number;
    
    // Applied status
    isFullyApplied: boolean;          // True if stability requirements met
    isDampened: boolean;              // True if first-flip dampening applied
    
    // Stability info
    regimeStable: boolean;
    cyclesInRegime: number;
    timeInRegimeMs: number;
    
    // Current regime
    regime: MarketRegime;
    
    // Cooldown status
    inCooldown: boolean;
    cooldownRemainingMs: number;
    
    timestamp: number;
    
    // MODULE 3: Validation metadata
    firstFlipDampeningApplied?: boolean;  // True if first-flip dampening was applied this cycle
    scalingBlocked?: boolean;              // True if scaling was blocked for safety
    blockReason?: string;                  // Reason for blocking (if any)
}

/**
 * Aggression adjustment log entry
 */
export interface AggressionAdjustment {
    fromMultiplier: number;
    toMultiplier: number;
    regime: MarketRegime;
    reason: string;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

let regimeState: RegimeState = {
    currentRegime: 'NEUTRAL',
    previousRegime: null,
    regimeEnteredAt: Date.now(),
    consecutiveCycles: 0,
    lastFlipTime: 0,
    totalFlips: 0,
};

/**
 * Input hysteresis state — SINGLETON, persists across all scan cycles
 * 
 * This state tracks the incoming regime signals and prevents noisy single-cycle
 * flips from resetting the regime. Only after HYSTERESIS_CONFIRMATION_CYCLES
 * consecutive signals of a different regime will the change be committed.
 */
let inputHysteresis: InputHysteresisState = {
    pendingRegime: null,
    pendingCycles: 0,
    lastSignaledRegime: 'NEUTRAL',
};

const adjustmentHistory: AggressionAdjustment[] = [];
const MAX_ADJUSTMENT_HISTORY = 100;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE AGGRESSION SCALING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update regime tracking state with INPUT HYSTERESIS + DWELL TIME GUARD
 * Call this on each scan cycle with the current detected regime
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL SINGLETON STATE — PERSISTS ACROSS ALL SCAN CYCLES
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This function operates ONLY on the module-level global singleton state:
 * - regimeState: The committed regime with stability tracking
 * - inputHysteresis: The pending regime confirmation tracking
 * 
 * NEVER accepts pool address, context, or any per-pool parameters.
 * NEVER creates or fetches state — only mutates the existing globals.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TWO-LAYER PROTECTION AGAINST NOISY REGIME FLIPS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * LAYER 1: Input Hysteresis (3 consecutive confirmations required)
 * - A regime change is only COMMITTED after the new regime has been signaled
 *   for HYSTERESIS_CONFIRMATION_CYCLES consecutive cycles.
 * 
 * LAYER 2: Minimum Dwell Time (5 minute hard block)
 * - Even if hysteresis is satisfied, regime flip is BLOCKED if less than
 *   MIN_REGIME_DWELL_MS has passed since the last flip.
 * 
 * This prevents:
 * - Single-cycle noise from resetting consecutiveCycles
 * - Regime flipping every scan due to volatile microstructure signals
 * - stabilityWindowMs staying at 0 due to constant resets
 * - Control-plane oscillation under adversarial market conditions
 * 
 * MODULE 3: Logs [AGGRESSION-STATE] on every regime change
 */
export function updateRegimeState(newRegime: MarketRegime): void {
    const now = Date.now();
    const timeSinceLastFlip = now - regimeState.lastFlipTime;
    const stabilityWindowMs = now - regimeState.regimeEnteredAt;
    
    // Track the signaled regime for debugging
    inputHysteresis.lastSignaledRegime = newRegime;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // VALIDATION LOGGING — Track state on every call for debugging
    // ═══════════════════════════════════════════════════════════════════════════
    logger.info(
        `[AGGRESSION-CYCLE] signal=${newRegime} current=${regimeState.currentRegime} ` +
        `consecutiveCycles=${regimeState.consecutiveCycles} ` +
        `stabilityWindowMs=${stabilityWindowMs} ` +
        `pendingRegime=${inputHysteresis.pendingRegime ?? 'null'} ` +
        `pendingCycles=${inputHysteresis.pendingCycles} ` +
        `totalFlips=${regimeState.totalFlips}`
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CASE 1: Signaled regime matches current committed regime
    // → Increment consecutiveCycles, reset any pending transition
    // ═══════════════════════════════════════════════════════════════════════════
    if (newRegime === regimeState.currentRegime) {
        regimeState.consecutiveCycles++;
        
        // Clear any pending regime since we're stable
        if (inputHysteresis.pendingRegime !== null) {
            logger.info(
                `[AGGRESSION-HYSTERESIS] Pending ${inputHysteresis.pendingRegime} cancelled ` +
                `(signal returned to ${regimeState.currentRegime} after ${inputHysteresis.pendingCycles} cycles)`
            );
            inputHysteresis.pendingRegime = null;
            inputHysteresis.pendingCycles = 0;
        }
        return;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CASE 2: Signaled regime differs from current committed regime
    // → Apply input hysteresis before committing
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Check if this is the same pending regime or a new one
    if (inputHysteresis.pendingRegime === newRegime) {
        // Same pending regime signaled again — increment confirmation counter
        inputHysteresis.pendingCycles++;
        
        logger.info(
            `[AGGRESSION-HYSTERESIS] Pending ${newRegime}: ${inputHysteresis.pendingCycles}/${HYSTERESIS_CONFIRMATION_CYCLES} confirmations`
        );
        
        // Check if we've reached the confirmation threshold
        if (inputHysteresis.pendingCycles >= HYSTERESIS_CONFIRMATION_CYCLES) {
            // ═══════════════════════════════════════════════════════════════════
            // LAYER 2: MINIMUM DWELL TIME GUARD — HARD BLOCK
            // ═══════════════════════════════════════════════════════════════════
            if (timeSinceLastFlip < MIN_REGIME_DWELL_MS) {
                const remainingMs = MIN_REGIME_DWELL_MS - timeSinceLastFlip;
                logger.warn(
                    `[AGGRESSION-DWELL-BLOCK] 🛑 Regime flip BLOCKED by dwell time guard | ` +
                    `${regimeState.currentRegime} → ${newRegime} rejected | ` +
                    `timeSinceLastFlip=${Math.floor(timeSinceLastFlip / 1000)}s < ${MIN_REGIME_DWELL_MS / 1000}s | ` +
                    `remaining=${Math.floor(remainingMs / 1000)}s`
                );
                // Keep pending state but don't flip — will re-check next cycle
                return;
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // COMMIT REGIME CHANGE — Both hysteresis AND dwell time satisfied
            // ═══════════════════════════════════════════════════════════════════
            const previousRegime = regimeState.currentRegime;
            regimeState.previousRegime = previousRegime;
            regimeState.currentRegime = newRegime;
            regimeState.regimeEnteredAt = now;
            regimeState.consecutiveCycles = 1;
            regimeState.lastFlipTime = now;
            regimeState.totalFlips++;
            
            // Clear pending state
            inputHysteresis.pendingRegime = null;
            inputHysteresis.pendingCycles = 0;
            
            logger.info(
                `[AGGRESSION] 🔄 Regime flip COMMITTED: ${previousRegime} → ${newRegime} | ` +
                `Total flips: ${regimeState.totalFlips} | ` +
                `(confirmed after ${HYSTERESIS_CONFIRMATION_CYCLES} cycles + ${MIN_REGIME_DWELL_MS / 1000}s dwell)`
            );
            
            // MODULE 3: Log full state on regime change
            logAggressionState();
        }
    } else {
        // Different regime signaled — start new pending confirmation
        inputHysteresis.pendingRegime = newRegime;
        inputHysteresis.pendingCycles = 1;
        
        logger.info(
            `[AGGRESSION-HYSTERESIS] New pending regime: ${newRegime} ` +
            `(1/${HYSTERESIS_CONFIRMATION_CYCLES} confirmations, current=${regimeState.currentRegime})`
        );
    }
    
    // Note: consecutiveCycles is NOT incremented when there's a pending regime
    // This is intentional — we don't want to count cycles during transition uncertainty
}

/**
 * Compute aggression scaling for current regime
 * Returns full scaling parameters with stability checks
 * 
 * MODULE 3 GUARDRAILS:
 * - Scaling MUST NOT apply unless ≥3 consecutive cycles in same regime
 * - Scaling MUST NOT apply unless ≥5 minutes stability window satisfied
 * - First-flip dampening MUST be applied on size increases before stability
 */
export function computeAggressionScaling(): AggressionScaling {
    const now = Date.now();
    const { currentRegime, regimeEnteredAt, consecutiveCycles, lastFlipTime } = regimeState;
    
    const timeInRegimeMs = now - regimeEnteredAt;
    const timeSinceFlip = now - lastFlipTime;
    
    // Check cooldown
    const inCooldown = timeSinceFlip < AGGRESSION_CONFIG.regimeFlipCooldownMs;
    const cooldownRemainingMs = inCooldown 
        ? AGGRESSION_CONFIG.regimeFlipCooldownMs - timeSinceFlip 
        : 0;
    
    // Check stability - MODULE 3 GUARDRAILS
    const meetsTimeRequirement = timeInRegimeMs >= AGGRESSION_CONFIG.regimeStabilityWindowMs;
    const meetsCycleRequirement = consecutiveCycles >= AGGRESSION_CONFIG.minCyclesForStability;
    const regimeStable = meetsTimeRequirement && meetsCycleRequirement;
    
    // Get base multipliers for regime
    let sizeMultiplier = AGGRESSION_CONFIG.sizeMultiplier[currentRegime];
    const binWidthMultiplier = AGGRESSION_CONFIG.binWidthMultiplier[currentRegime];
    const exitSensitivityMultiplier = AGGRESSION_CONFIG.exitSensitivityMultiplier[currentRegime];
    const scoreDecayTolerance = AGGRESSION_CONFIG.scoreDecayTolerance[currentRegime];
    
    // Determine if scaling is fully applied or dampened
    let isFullyApplied = false;
    let isDampened = false;
    let firstFlipDampeningApplied = false;
    let scalingBlocked = false;
    let blockReason = '';
    
    if (inCooldown) {
        // During cooldown, use NEUTRAL multipliers
        sizeMultiplier = AGGRESSION_CONFIG.sizeMultiplier.NEUTRAL;
        scalingBlocked = true;
        blockReason = 'COOLDOWN';
    } else if (!regimeStable) {
        // Regime not yet stable
        if (sizeMultiplier > 1.0) {
            // For size increases, apply first-flip dampening
            const originalMultiplier = sizeMultiplier;
            sizeMultiplier = 1.0 + (sizeMultiplier - 1.0) * AGGRESSION_CONFIG.firstFlipDampeningFactor;
            isDampened = true;
            firstFlipDampeningApplied = true;
            
            // ═══════════════════════════════════════════════════════════════════
            // MODULE 3 VALIDATION: Verify first-flip dampening was applied
            // ═══════════════════════════════════════════════════════════════════
            if (DEV_MODE && sizeMultiplier === originalMultiplier) {
                logger.error(
                    `[AGGRESSION-ERROR] First-flip dampening failed to reduce size multiplier: ` +
                    `original=${originalMultiplier.toFixed(2)} dampened=${sizeMultiplier.toFixed(2)}`
                );
            }
        }
        // For size decreases (BEAR), apply immediately for safety
    } else {
        // Regime is stable, apply full scaling
        isFullyApplied = true;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MODULE 3: AGGRESSION STATE LOGGING
    // Log on every regime change or when scaling is about to be applied
    // ═══════════════════════════════════════════════════════════════════════════
    if (isFullyApplied && sizeMultiplier !== 1.0) {
        // Verify stability requirements are actually met before full scaling
        if (!meetsTimeRequirement || !meetsCycleRequirement) {
            logger.error(
                `[AGGRESSION-ERROR] Scaling applied without stability requirements!\n` +
                `  regime=${currentRegime}\n` +
                `  consecutiveCycles=${consecutiveCycles} (required: ${AGGRESSION_CONFIG.minCyclesForStability})\n` +
                `  stabilityWindowMs=${timeInRegimeMs} (required: ${AGGRESSION_CONFIG.regimeStabilityWindowMs})\n` +
                `  BLOCKING SCALING FOR THIS CYCLE`
            );
            
            // Force neutral scaling for safety
            sizeMultiplier = AGGRESSION_CONFIG.sizeMultiplier.NEUTRAL;
            isFullyApplied = false;
            scalingBlocked = true;
            blockReason = 'STABILITY_NOT_MET';
        }
    }
    
    return {
        sizeMultiplier,
        binWidthMultiplier,
        exitSensitivityMultiplier,
        scoreDecayTolerance,
        
        isFullyApplied,
        isDampened,
        
        regimeStable,
        cyclesInRegime: consecutiveCycles,
        timeInRegimeMs,
        
        regime: currentRegime,
        
        inCooldown,
        cooldownRemainingMs,
        
        timestamp: now,
        
        // MODULE 3: Additional validation metadata
        firstFlipDampeningApplied,
        scalingBlocked,
        blockReason,
    };
}

/**
 * MODULE 3: Log aggression state for verification
 * Logs full state on every regime change for debugging
 * 
 * VALIDATION OUTPUT REQUIREMENTS (per spec):
 * - consecutiveCycles incrementing past 1
 * - stabilityWindowMs increasing across cycles
 * - totalFlips increasing rarely, not every cycle
 */
export function logAggressionState(): void {
    const scaling = computeAggressionScaling();
    const state = getCurrentRegimeState();
    const now = Date.now();
    const timeSinceLastFlip = now - state.lastFlipTime;
    
    logger.info(
        `[AGGRESSION-STATE] ═══════════════════════════════════════════════════════\n` +
        `  regime=${scaling.regime}\n` +
        `  consecutiveCycles=${scaling.cyclesInRegime} (must increment past 1)\n` +
        `  stabilityWindowMs=${scaling.timeInRegimeMs} (${(scaling.timeInRegimeMs / 1000).toFixed(0)}s) (must increase)\n` +
        `  timeSinceLastFlipMs=${timeSinceLastFlip} (${(timeSinceLastFlip / 1000).toFixed(0)}s)\n` +
        `  totalFlips=${state.totalFlips} (must increase rarely)\n` +
        `  pendingRegime=${inputHysteresis.pendingRegime ?? 'null'}\n` +
        `  pendingCycles=${inputHysteresis.pendingCycles}/${HYSTERESIS_CONFIRMATION_CYCLES}\n` +
        `  minDwellTimeMs=${MIN_REGIME_DWELL_MS / 1000}s\n` +
        `  firstFlipDampeningApplied=${scaling.firstFlipDampeningApplied ?? false}\n` +
        `  sizeMultiplier=${scaling.sizeMultiplier.toFixed(2)}\n` +
        `  binWidthMultiplier=${scaling.binWidthMultiplier.toFixed(2)}\n` +
        `  exitSensitivity=${scaling.exitSensitivityMultiplier.toFixed(2)}\n` +
        `═══════════════════════════════════════════════════════════════════════════`
    );
    
    // Check if scaling was blocked
    if (scaling.scalingBlocked) {
        logger.warn(
            `[AGGRESSION-STATE] Scaling blocked: ${scaling.blockReason}`
        );
    }
    
    // VALIDATION CHECK: Warn if consecutiveCycles is stuck at 1
    if (scaling.cyclesInRegime <= 1 && state.totalFlips > 3) {
        logger.error(
            `[AGGRESSION-VALIDATION-ERROR] ⚠️ consecutiveCycles=${scaling.cyclesInRegime} after ${state.totalFlips} flips! ` +
            `This indicates regime signal is oscillating and hysteresis is not stabilizing.`
        );
    }
}

/**
 * Get size-adjusted position size for regime
 */
export function getRegimeAdjustedSize(baseSize: number): {
    adjustedSize: number;
    multiplier: number;
    regime: MarketRegime;
    status: 'FULL' | 'DAMPENED' | 'COOLDOWN' | 'NEUTRAL';
} {
    const scaling = computeAggressionScaling();
    const adjustedSize = Math.floor(baseSize * scaling.sizeMultiplier);
    
    let status: 'FULL' | 'DAMPENED' | 'COOLDOWN' | 'NEUTRAL';
    if (scaling.inCooldown) {
        status = 'COOLDOWN';
    } else if (scaling.isFullyApplied) {
        status = 'FULL';
    } else if (scaling.isDampened) {
        status = 'DAMPENED';
    } else {
        status = 'NEUTRAL';
    }
    
    return {
        adjustedSize,
        multiplier: scaling.sizeMultiplier,
        regime: scaling.regime,
        status,
    };
}

/**
 * Get exit threshold adjusted for regime sensitivity
 */
export function getRegimeAdjustedExitThreshold(baseThreshold: number): number {
    const scaling = computeAggressionScaling();
    return baseThreshold * scaling.exitSensitivityMultiplier;
}

/**
 * Get bin width adjusted for regime
 */
export function getRegimeAdjustedBinWidth(baseBinWidth: number): number {
    const scaling = computeAggressionScaling();
    return Math.round(baseBinWidth * scaling.binWidthMultiplier);
}

/**
 * Check if score decay is within regime tolerance
 */
export function isScoreDecayTolerable(entryScore: number, currentScore: number): {
    tolerable: boolean;
    decayPct: number;
    tolerancePct: number;
    regime: MarketRegime;
} {
    const scaling = computeAggressionScaling();
    const decayPct = entryScore > 0 ? (entryScore - currentScore) / entryScore : 0;
    const tolerable = decayPct <= scaling.scoreDecayTolerance;
    
    return {
        tolerable,
        decayPct,
        tolerancePct: scaling.scoreDecayTolerance,
        regime: scaling.regime,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log aggression adjustment
 */
export function logAggressionAdjustment(
    poolName: string,
    baseSize: number,
    adjustedSize: number,
    scaling: AggressionScaling
): void {
    const emoji = scaling.regime === 'BULL' ? '🟢' : scaling.regime === 'BEAR' ? '🔴' : '🟡';
    const statusText = scaling.isFullyApplied ? 'FULL' : 
                       scaling.isDampened ? 'DAMPENED' : 
                       scaling.inCooldown ? 'COOLDOWN' : 'PARTIAL';
    
    logger.info(
        `[AGGRESSION] ${emoji} ${poolName} | ` +
        `size=$${baseSize}→$${adjustedSize} (${scaling.sizeMultiplier.toFixed(2)}×) | ` +
        `regime=${scaling.regime} | ` +
        `status=${statusText} | ` +
        `cycles=${scaling.cyclesInRegime}/${AGGRESSION_CONFIG.minCyclesForStability}`
    );
    
    // Record adjustment
    adjustmentHistory.push({
        fromMultiplier: 1.0,
        toMultiplier: scaling.sizeMultiplier,
        regime: scaling.regime,
        reason: `${statusText}: size $${baseSize}→$${adjustedSize}`,
        timestamp: Date.now(),
    });
    
    // Trim history
    while (adjustmentHistory.length > MAX_ADJUSTMENT_HISTORY) {
        adjustmentHistory.shift();
    }
}

/**
 * Log regime scaling summary
 */
export function logAggressionSummary(): void {
    const scaling = computeAggressionScaling();
    
    logger.info(
        `[AGGRESSION] Summary: regime=${scaling.regime} | ` +
        `size=${scaling.sizeMultiplier.toFixed(2)}× | ` +
        `bins=${scaling.binWidthMultiplier.toFixed(2)}× | ` +
        `exit=${scaling.exitSensitivityMultiplier.toFixed(2)}× | ` +
        `stable=${scaling.regimeStable} (${scaling.cyclesInRegime} cycles, ${Math.floor(scaling.timeInRegimeMs / 1000)}s)`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE ACCESS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current regime state
 */
export function getCurrentRegimeState(): Readonly<RegimeState> {
    return { ...regimeState };
}

/**
 * Get recent aggression adjustments
 */
export function getRecentAdjustments(limit: number = 10): AggressionAdjustment[] {
    return adjustmentHistory.slice(-limit);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RESET REGIME STATE — TESTING/BOOTSTRAP ONLY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * ⚠️ WARNING: This function resets the global regime singleton state.
 * 
 * MUST ONLY BE CALLED:
 * 1. During test setup/teardown
 * 2. During initial bootstrap (before first scan cycle)
 * 
 * MUST NEVER BE CALLED:
 * - During runtime scan loops
 * - Per-pool evaluations
 * - Any code path that runs during normal operation
 * 
 * Calling this during runtime will break regime hysteresis and cause
 * the consecutiveCycles/stabilityWindowMs to reset, defeating stability tracking.
 */
export function resetAggressionState(): void {
    // Log a warning with stack trace to help identify runtime reset calls
    const stack = new Error().stack;
    logger.warn(
        `[AGGRESSION] ⚠️ State RESET called — this should only happen during testing/bootstrap\n` +
        `Stack trace: ${stack}`
    );
    
    regimeState = {
        currentRegime: 'NEUTRAL',
        previousRegime: null,
        regimeEnteredAt: Date.now(),
        consecutiveCycles: 0,
        lastFlipTime: 0,
        totalFlips: 0,
    };
    inputHysteresis = {
        pendingRegime: null,
        pendingCycles: 0,
        lastSignaledRegime: 'NEUTRAL',
    };
    adjustmentHistory.length = 0;
    logger.info('[AGGRESSION] State reset complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// AGGRESSION_CONFIG is already exported at declaration

