/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * COMPOUNDING EXIT GATE — PREDATOR MODE v1.1 (FIXED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * CHANGES FROM v1:
 * - MIN_HOLD is now TIERED by pool class (A=20m, B=30m, C=10m)
 * - EMERGENCY OVERRIDE bypasses MIN_HOLD after 10 minutes if:
 *   • feeVelocity < 25% of expected
 *   • stableZeroActivity >= 10min
 *   • harmonic.healthScore < 0.42
 * - COST AMORTIZATION is now INFORMATIONAL ONLY, not a blocker
 * - ROTATION is allowed: <0.05% fee accrual after 30min + entropy collapsed + better pool available
 * 
 * CAPITAL MUST NOT BE TRAPPED. If harmonic says exit → we exit.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    PREDATOR_MODE_V1_ENABLED,
    EXIT_SUPPRESSION_CONFIG,
    MIN_HOLD_BY_TIER,
    EMERGENCY_EXIT_OVERRIDE,
    ROTATION_BIAS_CONFIG,
    LOG_THROTTLE_CONFIG,
    isValidPredatorExit,
    calculateCostAmortizationRequired,
    hasCostAmortized,
    isInBootstrapMode,
    checkEmergencyExitOverride,
    shouldForceRotation,
    getMinHoldTime,
} from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ExitGateResult {
    allowed: boolean;
    category: ExitCategory;
    reason: string;
    details: ExitGateDetails;
}

export type ExitCategory = 
    | 'TRUE_EMERGENCY'        // Bypass all gates
    | 'EMERGENCY_OVERRIDE'    // Tiered override (fee velocity, zero activity, health floor)
    | 'ROTATION_REPLACEMENT'  // Aggressive rotation to better pool
    | 'HARMONIC_EXIT'         // Harmonic triggered exit (now allowed)
    | 'COST_AMORTIZED'        // Fees covered costs, exit allowed
    | 'SUPPRESSED_MIN_HOLD'   // Exit blocked (min hold not met, no override)
    | 'SUPPRESSED_NOISE'      // Exit blocked (noise signal)
    | 'SUPPRESSED_BOOTSTRAP'  // Exit blocked (in bootstrap mode)
    | 'ALLOWED'               // General allow
    | 'BLOCKED';              // General block

export type PoolTier = 'A' | 'B' | 'C';

export interface ExitGateDetails {
    exitReason: string;
    entryTime: number;
    holdTimeMinutes: number;
    holdTimeMs: number;
    minHoldMs: number;
    minHoldMet: boolean;
    poolTier: PoolTier;
    feesAccruedUsd: number;
    costAmortizationRequiredUsd: number;
    costAmortizationPct: number;
    rebalanceCount: number;
    isBootstrap: boolean;
    isTrueEmergency: boolean;
    isEmergencyOverride: boolean;
    emergencyOverrideReason?: string;
    isNoiseSignal: boolean;
    isRotationCandidate: boolean;
    volumeCollapsePct?: number;
    feeVelocity?: number;
    harmonicHealthScore?: number;
}

export interface ExitEvaluationInput {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    exitReason: string;
    entryTime: number;
    entrySizeUsd: number;
    feesAccruedUsd: number;
    rebalanceCount: number;
    currentVolumeUsd?: number;
    entryVolumeUsd?: number;
    currentTvlUsd?: number;
    entryTvlUsd?: number;
    // NEW: For emergency override
    poolTier?: PoolTier;
    feeVelocity?: number;
    expectedFeeVelocity?: number;
    zeroActivityDurationMs?: number;
    harmonicHealthScore?: number;
    // NEW: For rotation
    poolRank?: number;
    bestAlternativeRank?: number;
    entropyCollapsed?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRUE EMERGENCY DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

const TRUE_EMERGENCIES = EXIT_SUPPRESSION_CONFIG.VALID_EXIT_CONDITIONS;
const NOISE_SIGNALS = EXIT_SUPPRESSION_CONFIG.FORBIDDEN_EXIT_CONDITIONS;

// ═══════════════════════════════════════════════════════════════════════════════
// LOG THROTTLING STATE
// ═══════════════════════════════════════════════════════════════════════════════

interface LogThrottleEntry {
    lastLogTime: number;
    pattern: string;
}

const logThrottleState = new Map<string, LogThrottleEntry>();

/**
 * Check if a log should be throttled (same trade + same reason)
 */
function shouldThrottleLog(tradeId: string, pattern: string): boolean {
    if (!LOG_THROTTLE_CONFIG.ENABLED) return false;
    
    // Check if pattern matches any throttle pattern
    const matchesPattern = LOG_THROTTLE_CONFIG.THROTTLE_PATTERNS.some(p => 
        pattern.toUpperCase().includes(p)
    );
    if (!matchesPattern) return false;
    
    const key = `${tradeId}:${pattern}`;
    const now = Date.now();
    const entry = logThrottleState.get(key);
    
    if (entry && now - entry.lastLogTime < LOG_THROTTLE_CONFIG.THROTTLE_INTERVAL_MS) {
        return true;  // Throttle
    }
    
    // Update state
    logThrottleState.set(key, { lastLogTime: now, pattern });
    return false;  // Don't throttle
}

/**
 * Throttled logger
 */
function throttledLog(
    level: 'info' | 'warn' | 'debug',
    tradeId: string,
    pattern: string,
    message: string
): void {
    if (shouldThrottleLog(tradeId, pattern)) return;
    logger[level](message);
}

/**
 * Clear throttle state for a trade
 */
export function clearLogThrottle(tradeId: string): void {
    for (const key of logThrottleState.keys()) {
        if (key.startsWith(`${tradeId}:`)) {
            logThrottleState.delete(key);
        }
    }
}

/**
 * Check if exit reason is a TRUE emergency (bypasses all gates)
 */
export function isTrueEmergency(exitReason: string): boolean {
    const normalized = exitReason.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    
    for (const emergency of TRUE_EMERGENCIES) {
        if (normalized.includes(emergency) || emergency.includes(normalized)) {
            return true;
        }
    }
    
    return false;
}

/**
 * Check if exit reason is a noise signal (should be suppressed)
 */
export function isNoiseSignal(exitReason: string): boolean {
    const normalized = exitReason.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    
    for (const noise of NOISE_SIGNALS) {
        if (normalized.includes(noise) || noise.includes(normalized)) {
            return true;
        }
    }
    
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOLUME COLLAPSE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if volume has collapsed enough to warrant exit
 */
export function hasVolumeCollapsed(
    currentVolumeUsd?: number,
    entryVolumeUsd?: number
): { collapsed: boolean; dropPct: number } {
    if (!currentVolumeUsd || !entryVolumeUsd || entryVolumeUsd <= 0) {
        return { collapsed: false, dropPct: 0 };
    }
    
    const dropPct = (entryVolumeUsd - currentVolumeUsd) / entryVolumeUsd;
    const threshold = EXIT_SUPPRESSION_CONFIG.VOLUME_COLLAPSE_THRESHOLD;
    
    return {
        collapsed: dropPct >= threshold,
        dropPct,
    };
}

/**
 * Check if TVL has collapsed
 */
export function hasTvlCollapsed(
    currentTvlUsd?: number,
    entryTvlUsd?: number
): { collapsed: boolean; dropPct: number } {
    if (!currentTvlUsd || !entryTvlUsd || entryTvlUsd <= 0) {
        return { collapsed: false, dropPct: 0 };
    }
    
    const dropPct = (entryTvlUsd - currentTvlUsd) / entryTvlUsd;
    
    // TVL collapse is a true emergency if >50%
    return {
        collapsed: dropPct >= 0.50,
        dropPct,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE EXIT GATE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate if an exit should be allowed
 * 
 * This is the single authority for exit decisions in Predator Mode v1.1 (FIXED)
 * 
 * PRIORITY ORDER:
 * 1. TRUE emergencies bypass all gates
 * 2. Volume/TVL collapse is an emergency
 * 3. EMERGENCY OVERRIDE (after 10min): fee velocity, zero activity, health floor
 * 4. ROTATION REPLACEMENT (after 30min): dead position + better pool available
 * 5. HARMONIC EXIT (now allowed if triggered)
 * 6. Noise signals are suppressed (but NOT harmonic, fee velocity, etc.)
 * 7. Bootstrap mode blocks most exits (but not emergencies)
 * 8. TIERED MIN HOLD (if no override applies)
 * 9. Cost amortization is INFORMATIONAL ONLY
 * 
 * CAPITAL MUST NOT BE TRAPPED.
 */
export function evaluateCompoundingExitGate(
    input: ExitEvaluationInput
): ExitGateResult {
    const now = Date.now();
    const holdTimeMs = now - input.entryTime;
    const holdTimeMinutes = holdTimeMs / (60 * 1000);
    const isBootstrap = isInBootstrapMode(input.entryTime);
    const poolTier: PoolTier = input.poolTier || 'B';
    const minHoldMs = getMinHoldTime(poolTier);
    const minHoldMet = holdTimeMs >= minHoldMs;
    
    // Calculate cost amortization (INFORMATIONAL ONLY)
    const costRequired = calculateCostAmortizationRequired(
        input.entrySizeUsd,
        input.rebalanceCount
    );
    const costAmortizationPct = costRequired > 0 
        ? (input.feesAccruedUsd / costRequired) * 100 
        : 100;
    const costsCovered = hasCostAmortized(
        input.feesAccruedUsd,
        input.entrySizeUsd,
        input.rebalanceCount
    );
    
    // Check for true emergency
    const trueEmergency = isTrueEmergency(input.exitReason);
    const noiseSignal = isNoiseSignal(input.exitReason);
    
    // Check for volume/TVL collapse
    const volumeCheck = hasVolumeCollapsed(input.currentVolumeUsd, input.entryVolumeUsd);
    const tvlCheck = hasTvlCollapsed(input.currentTvlUsd, input.entryTvlUsd);
    
    // Check for emergency override (NEW)
    const emergencyOverride = checkEmergencyExitOverride({
        holdTimeMs,
        feeVelocity: input.feeVelocity || 0,
        expectedFeeVelocity: input.expectedFeeVelocity || 0.001,
        zeroActivityDurationMs: input.zeroActivityDurationMs || 0,
        harmonicHealthScore: input.harmonicHealthScore || 1.0,
    });
    
    // Check for rotation (NEW)
    const feeYield = input.entrySizeUsd > 0 
        ? input.feesAccruedUsd / input.entrySizeUsd 
        : 0;
    const rankDelta = (input.poolRank !== undefined && input.bestAlternativeRank !== undefined)
        ? input.poolRank - input.bestAlternativeRank
        : 0;
    const rotation = shouldForceRotation({
        holdTimeMs,
        feeYield,
        entropyCollapsed: input.entropyCollapsed || false,
        rankDelta,
    });
    
    // Check if exit reason is HARMONIC_EXIT (now allowed!)
    const isHarmonicExit = input.exitReason.toUpperCase().includes('HARMONIC') || 
                           input.exitReason.toUpperCase().includes('EXIT_TRIGGERED');
    
    const details: ExitGateDetails = {
        exitReason: input.exitReason,
        entryTime: input.entryTime,
        holdTimeMinutes,
        holdTimeMs,
        minHoldMs,
        minHoldMet,
        poolTier,
        feesAccruedUsd: input.feesAccruedUsd,
        costAmortizationRequiredUsd: costRequired,
        costAmortizationPct,
        rebalanceCount: input.rebalanceCount,
        isBootstrap,
        isTrueEmergency: trueEmergency,
        isEmergencyOverride: emergencyOverride.shouldOverride,
        emergencyOverrideReason: emergencyOverride.reason,
        isNoiseSignal: noiseSignal,
        isRotationCandidate: rotation.shouldRotate,
        volumeCollapsePct: volumeCheck.dropPct,
        feeVelocity: input.feeVelocity,
        harmonicHealthScore: input.harmonicHealthScore,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 1: TRUE EMERGENCY (bypass all)
    // ═══════════════════════════════════════════════════════════════════════════
    if (trueEmergency) {
        logger.warn(
            `[EXIT-GATE] 🚨 TRUE_EMERGENCY | ${input.poolName} | ` +
            `reason=${input.exitReason} | BYPASS ALL GATES`
        );
        return {
            allowed: true,
            category: 'TRUE_EMERGENCY',
            reason: `TRUE_EMERGENCY: ${input.exitReason}`,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 2: TVL COLLAPSE (emergency)
    // ═══════════════════════════════════════════════════════════════════════════
    if (tvlCheck.collapsed) {
        logger.warn(
            `[EXIT-GATE] 🚨 TVL_COLLAPSE | ${input.poolName} | ` +
            `drop=${(tvlCheck.dropPct * 100).toFixed(0)}% | EMERGENCY EXIT`
        );
        return {
            allowed: true,
            category: 'TRUE_EMERGENCY',
            reason: `TVL_COLLAPSE: ${(tvlCheck.dropPct * 100).toFixed(0)}% drop`,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 3: VOLUME COLLAPSE (emergency if sustained)
    // ═══════════════════════════════════════════════════════════════════════════
    if (volumeCheck.collapsed) {
        logger.warn(
            `[EXIT-GATE] ⚠️ VOLUME_COLLAPSE | ${input.poolName} | ` +
            `drop=${(volumeCheck.dropPct * 100).toFixed(0)}% | EMERGENCY EXIT`
        );
        return {
            allowed: true,
            category: 'TRUE_EMERGENCY',
            reason: `VOLUME_COLLAPSE: ${(volumeCheck.dropPct * 100).toFixed(0)}% drop`,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 4: EMERGENCY OVERRIDE (after 10min) — BYPASSES MIN_HOLD
    // ═══════════════════════════════════════════════════════════════════════════
    if (emergencyOverride.shouldOverride) {
        logger.warn(
            `[EXIT-GATE] ⚡ EMERGENCY_OVERRIDE | ${input.poolName} | ` +
            `${emergencyOverride.reason} | ` +
            `holdTime=${holdTimeMinutes.toFixed(0)}m | BYPASSING MIN_HOLD`
        );
        return {
            allowed: true,
            category: 'EMERGENCY_OVERRIDE',
            reason: emergencyOverride.reason,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 5: ROTATION REPLACEMENT (after 30min) — BYPASSES MIN_HOLD
    // ═══════════════════════════════════════════════════════════════════════════
    if (rotation.shouldRotate) {
        logger.info(
            `[EXIT-GATE] 🔄 ROTATION_REPLACEMENT | ${input.poolName} | ` +
            `${rotation.reason} | ` +
            `feeYield=${(feeYield * 100).toFixed(3)}% | rankDelta=+${rankDelta}`
        );
        return {
            allowed: true,
            category: 'ROTATION_REPLACEMENT',
            reason: rotation.reason,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 6: HARMONIC EXIT (now allowed if min hold met!)
    // ═══════════════════════════════════════════════════════════════════════════
    if (isHarmonicExit && minHoldMet) {
        logger.info(
            `[EXIT-GATE] 🎵 HARMONIC_EXIT | ${input.poolName} | ` +
            `reason=${input.exitReason} | ` +
            `holdTime=${holdTimeMinutes.toFixed(0)}m >= minHold=${(minHoldMs / 60000).toFixed(0)}m | ` +
            `ALLOWED`
        );
        return {
            allowed: true,
            category: 'HARMONIC_EXIT',
            reason: `HARMONIC_EXIT: ${input.exitReason} (min hold met)`,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 7: NOISE SIGNAL SUPPRESSION (reduced list)
    // ═══════════════════════════════════════════════════════════════════════════
    if (noiseSignal && !isHarmonicExit) {
        throttledLog('info', input.tradeId, 'NOISE_SUPPRESSED',
            `[EXIT-GATE] 🔇 NOISE_SUPPRESSED | ${input.poolName} | ` +
            `reason=${input.exitReason} | holdTime=${holdTimeMinutes.toFixed(0)}m`
        );
        return {
            allowed: false,
            category: 'SUPPRESSED_NOISE',
            reason: `NOISE_SIGNAL: ${input.exitReason} is not a valid exit trigger`,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 8: BOOTSTRAP SUPPRESSION (but not for emergencies/overrides)
    // ═══════════════════════════════════════════════════════════════════════════
    if (isBootstrap && !emergencyOverride.shouldOverride && !rotation.shouldRotate) {
        throttledLog('info', input.tradeId, 'BOOTSTRAP_SUPPRESSED',
            `[EXIT-GATE] 🔒 BOOTSTRAP_SUPPRESSED | ${input.poolName} | ` +
            `holdTime=${holdTimeMinutes.toFixed(0)}m | ` +
            `reason=${input.exitReason} | BLOCKED (in probe mode)`
        );
        return {
            allowed: false,
            category: 'SUPPRESSED_BOOTSTRAP',
            reason: `BOOTSTRAP_MODE: Exits suppressed during 6h probe period`,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 9: TIERED MIN HOLD CHECK
    // ═══════════════════════════════════════════════════════════════════════════
    if (!minHoldMet) {
        throttledLog('info', input.tradeId, 'MIN_HOLD_SUPPRESSED',
            `[EXIT-GATE] ⏱️ MIN_HOLD_SUPPRESSED | ${input.poolName} | ` +
            `holdTime=${holdTimeMinutes.toFixed(0)}m < minHold=${(minHoldMs / 60000).toFixed(0)}m (tier=${poolTier}) | ` +
            `reason=${input.exitReason}`
        );
        return {
            allowed: false,
            category: 'SUPPRESSED_MIN_HOLD',
            reason: `MIN_HOLD_NOT_MET: ${holdTimeMinutes.toFixed(0)}m < ${(minHoldMs / 60000).toFixed(0)}m (tier ${poolTier})`,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 10: COST AMORTIZATION (INFORMATIONAL ONLY — does not block)
    // ═══════════════════════════════════════════════════════════════════════════
    // Cost amortization is now logged but does NOT block exits
    if (!costsCovered) {
        logger.debug(
            `[EXIT-GATE] 📊 COST_INFO | ${input.poolName} | ` +
            `fees=$${input.feesAccruedUsd.toFixed(2)} < required=$${costRequired.toFixed(2)} | ` +
            `amortization=${costAmortizationPct.toFixed(0)}% | ` +
            `NOTE: Informational only, NOT blocking`
        );
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 11: VALID EXIT (min hold met)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Final check: is this exit reason valid in predator mode?
    if (!isValidPredatorExit(input.exitReason) && !isHarmonicExit) {
        throttledLog('info', input.tradeId, 'BLOCKED',
            `[EXIT-GATE] ❌ INVALID_EXIT_TYPE | ${input.poolName} | ` +
            `reason=${input.exitReason} | BLOCKED (not valid predator exit)`
        );
        return {
            allowed: false,
            category: 'BLOCKED',
            reason: `INVALID_EXIT_TYPE: ${input.exitReason} is not a valid predator exit`,
            details,
        };
    }
    
    // All gates passed
    logger.info(
        `[EXIT-GATE] ✅ EXIT_ALLOWED | ${input.poolName} | ` +
        `reason=${input.exitReason} | ` +
        `holdTime=${holdTimeMinutes.toFixed(0)}m | ` +
        `tier=${poolTier} | ` +
        `costAmort=${costAmortizationPct.toFixed(0)}%`
    );
    
    return {
        allowed: true,
        category: 'ALLOWED',
        reason: `EXIT_ALLOWED: min hold met (${holdTimeMinutes.toFixed(0)}m >= ${(minHoldMs / 60000).toFixed(0)}m)`,
        details,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

interface PositionFeeState {
    tradeId: string;
    poolName: string;
    entryTime: number;
    entrySizeUsd: number;
    feesAccruedUsd: number;
    rebalanceCount: number;
    lastUpdateMs: number;
}

const positionFeeStates = new Map<string, PositionFeeState>();

let suppressedExitsThisCycle = 0;
let allowedExitsThisCycle = 0;
let emergencyExitsThisCycle = 0;

/**
 * Initialize fee tracking for a new position
 */
export function initializeFeeTracking(
    tradeId: string,
    poolName: string,
    entrySizeUsd: number
): void {
    positionFeeStates.set(tradeId, {
        tradeId,
        poolName,
        entryTime: Date.now(),
        entrySizeUsd,
        feesAccruedUsd: 0,
        rebalanceCount: 0,
        lastUpdateMs: Date.now(),
    });
}

/**
 * Record fees earned
 */
export function recordFeesEarned(tradeId: string, feesUsd: number): void {
    const state = positionFeeStates.get(tradeId);
    if (state) {
        state.feesAccruedUsd += feesUsd;
        state.lastUpdateMs = Date.now();
    }
}

/**
 * Record rebalance
 */
export function recordRebalance(tradeId: string): void {
    const state = positionFeeStates.get(tradeId);
    if (state) {
        state.rebalanceCount++;
        state.lastUpdateMs = Date.now();
    }
}

/**
 * Get fee state for a position
 */
export function getFeeState(tradeId: string): PositionFeeState | undefined {
    return positionFeeStates.get(tradeId);
}

/**
 * Cleanup fee tracking for closed position
 */
export function cleanupFeeTracking(tradeId: string): void {
    positionFeeStates.delete(tradeId);
}

/**
 * Record exit gate result for metrics
 */
export function recordExitGateResult(result: ExitGateResult): void {
    if (result.allowed) {
        if (result.category === 'TRUE_EMERGENCY') {
            emergencyExitsThisCycle++;
        } else {
            allowedExitsThisCycle++;
        }
    } else {
        suppressedExitsThisCycle++;
    }
}

/**
 * Reset cycle counters
 */
export function resetCycleCounters(): void {
    suppressedExitsThisCycle = 0;
    allowedExitsThisCycle = 0;
    emergencyExitsThisCycle = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logCompoundingGateSummary(): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    let totalFees = 0;
    let totalRequired = 0;
    
    for (const state of positionFeeStates.values()) {
        totalFees += state.feesAccruedUsd;
        totalRequired += calculateCostAmortizationRequired(
            state.entrySizeUsd,
            state.rebalanceCount
        );
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('💰 COMPOUNDING EXIT GATE SUMMARY');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`  Tracked Positions: ${positionFeeStates.size}`);
    logger.info(`  Total Fees Accrued: $${totalFees.toFixed(2)}`);
    logger.info(`  Total Cost Required: $${totalRequired.toFixed(2)}`);
    logger.info(`  Amortization: ${totalRequired > 0 ? ((totalFees / totalRequired) * 100).toFixed(0) : 100}%`);
    logger.info('  This Cycle:');
    logger.info(`    Suppressed: ${suppressedExitsThisCycle}`);
    logger.info(`    Allowed: ${allowedExitsThisCycle}`);
    logger.info(`    Emergency: ${emergencyExitsThisCycle}`);
    
    if (positionFeeStates.size > 0) {
        logger.info('  Position Details:');
        for (const state of positionFeeStates.values()) {
            const required = calculateCostAmortizationRequired(
                state.entrySizeUsd,
                state.rebalanceCount
            );
            const pct = required > 0 ? ((state.feesAccruedUsd / required) * 100).toFixed(0) : '100';
            const holdMins = ((Date.now() - state.entryTime) / 60000).toFixed(0);
            
            logger.info(
                `    ${state.poolName}: $${state.feesAccruedUsd.toFixed(2)}/$${required.toFixed(2)} (${pct}%) | ` +
                `rebal=${state.rebalanceCount} | hold=${holdMins}m`
            );
        }
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

export function logExitGateStatus(): void {
    if (!PREDATOR_MODE_V1_ENABLED) {
        logger.info('[EXIT-GATE] Compounding exit gate DISABLED');
        return;
    }
    
    const config = EXIT_SUPPRESSION_CONFIG;
    
    logger.info(
        `[EXIT-GATE] 💰 Compounding exit gate ACTIVE | ` +
        `amortization_multiplier=${config.COST_AMORTIZATION_MULTIPLIER}× | ` +
        `valid_exits=${config.VALID_EXIT_CONDITIONS.length} | ` +
        `blocked_exits=${config.FORBIDDEN_EXIT_CONDITIONS.length} | ` +
        `tracked=${positionFeeStates.size}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    evaluateCompoundingExitGate,
    isTrueEmergency,
    isNoiseSignal,
    hasVolumeCollapsed,
    hasTvlCollapsed,
    initializeFeeTracking,
    recordFeesEarned,
    recordRebalance,
    getFeeState,
    cleanupFeeTracking,
    recordExitGateResult,
    resetCycleCounters,
    logCompoundingGateSummary,
    logExitGateStatus,
};

