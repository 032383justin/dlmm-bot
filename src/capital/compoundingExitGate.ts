/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * COMPOUNDING EXIT GATE — PREDATOR MODE v1 EXIT SUPPRESSION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * ABSOLUTE RULE: NO EXIT before cost amortization, except for emergencies.
 * 
 * EXIT ALLOWED ONLY IF:
 * - Pool migration detected
 * - Volume collapses >70% for sustained window
 * - Structural decay (bins inactive, liquidity disappears)
 * - Decimals / mint corruption
 * - Kill-switch market failure
 * 
 * EXIT FORBIDDEN IF:
 * - Fee velocity is low early
 * - EV is negative during bootstrap
 * - Entropy drops temporarily
 * - Oscillation pauses < multiple windows
 * 
 * Cost amortization includes:
 * - Entry fees
 * - Exit fees
 * - Slippage
 * - Rebalance cost (rolling)
 * 
 * If feesAccrued < totalCost × safetyMultiplier → EXIT MUST BE SUPPRESSED
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    PREDATOR_MODE_V1_ENABLED,
    EXIT_SUPPRESSION_CONFIG,
    isValidPredatorExit,
    calculateCostAmortizationRequired,
    hasCostAmortized,
    isInBootstrapMode,
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
    | 'TRUE_EMERGENCY'      // Bypass all gates
    | 'COST_AMORTIZED'      // Fees covered costs, exit allowed
    | 'SUPPRESSED_NOISE'    // Exit blocked (noise signal)
    | 'SUPPRESSED_COSTS'    // Exit blocked (costs not amortized)
    | 'SUPPRESSED_BOOTSTRAP' // Exit blocked (in bootstrap mode)
    | 'BLOCKED';            // General block

export interface ExitGateDetails {
    exitReason: string;
    entryTime: number;
    holdTimeMinutes: number;
    feesAccruedUsd: number;
    costAmortizationRequiredUsd: number;
    costAmortizationPct: number;
    rebalanceCount: number;
    isBootstrap: boolean;
    isTrueEmergency: boolean;
    isNoiseSignal: boolean;
    volumeCollapsePct?: number;
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRUE EMERGENCY DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

const TRUE_EMERGENCIES = EXIT_SUPPRESSION_CONFIG.VALID_EXIT_CONDITIONS;
const NOISE_SIGNALS = EXIT_SUPPRESSION_CONFIG.FORBIDDEN_EXIT_CONDITIONS;

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
 * This is the single authority for exit decisions in Predator Mode v1.
 * 
 * PRIORITY ORDER:
 * 1. TRUE emergencies bypass all gates
 * 2. Volume/TVL collapse is an emergency
 * 3. Noise signals are always suppressed
 * 4. Bootstrap mode blocks most exits
 * 5. Cost amortization gate
 */
export function evaluateCompoundingExitGate(
    input: ExitEvaluationInput
): ExitGateResult {
    const now = Date.now();
    const holdTimeMs = now - input.entryTime;
    const holdTimeMinutes = holdTimeMs / (60 * 1000);
    const isBootstrap = isInBootstrapMode(input.entryTime);
    
    // Calculate cost amortization
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
    
    const details: ExitGateDetails = {
        exitReason: input.exitReason,
        entryTime: input.entryTime,
        holdTimeMinutes,
        feesAccruedUsd: input.feesAccruedUsd,
        costAmortizationRequiredUsd: costRequired,
        costAmortizationPct,
        rebalanceCount: input.rebalanceCount,
        isBootstrap,
        isTrueEmergency: trueEmergency,
        isNoiseSignal: noiseSignal,
        volumeCollapsePct: volumeCheck.dropPct,
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
    // GATE 4: NOISE SIGNAL SUPPRESSION (always block)
    // ═══════════════════════════════════════════════════════════════════════════
    if (noiseSignal) {
        logger.info(
            `[EXIT-GATE] 🔇 NOISE_SUPPRESSED | ${input.poolName} | ` +
            `reason=${input.exitReason} | fees=$${input.feesAccruedUsd.toFixed(2)} | ` +
            `costCovered=${costAmortizationPct.toFixed(0)}%`
        );
        return {
            allowed: false,
            category: 'SUPPRESSED_NOISE',
            reason: `NOISE_SIGNAL: ${input.exitReason} is not a valid exit trigger`,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 5: BOOTSTRAP SUPPRESSION
    // ═══════════════════════════════════════════════════════════════════════════
    if (isBootstrap) {
        logger.info(
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
    // GATE 6: COST AMORTIZATION
    // ═══════════════════════════════════════════════════════════════════════════
    if (!costsCovered) {
        logger.info(
            `[EXIT-GATE] 💰 COST_SUPPRESSED | ${input.poolName} | ` +
            `fees=$${input.feesAccruedUsd.toFixed(2)} < required=$${costRequired.toFixed(2)} | ` +
            `amortization=${costAmortizationPct.toFixed(0)}% | ` +
            `rebalances=${input.rebalanceCount}`
        );
        return {
            allowed: false,
            category: 'SUPPRESSED_COSTS',
            reason: `COST_NOT_AMORTIZED: fees=$${input.feesAccruedUsd.toFixed(2)} < required=$${costRequired.toFixed(2)} (${costAmortizationPct.toFixed(0)}%)`,
            details,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GATE 7: VALID EXIT (costs amortized)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Final check: is this exit reason valid in predator mode?
    if (!isValidPredatorExit(input.exitReason)) {
        logger.info(
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
        `fees=$${input.feesAccruedUsd.toFixed(2)} >= required=$${costRequired.toFixed(2)} | ` +
        `holdTime=${holdTimeMinutes.toFixed(0)}m`
    );
    
    return {
        allowed: true,
        category: 'COST_AMORTIZED',
        reason: `COST_AMORTIZED: fees=$${input.feesAccruedUsd.toFixed(2)} >= required=$${costRequired.toFixed(2)}`,
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

