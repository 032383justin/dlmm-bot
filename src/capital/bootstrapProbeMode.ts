/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BOOTSTRAP PROBE MODE — PREDATOR MODE v1 INITIALIZATION PHASE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * BOOTSTRAP PURPOSE:
 * - Detect oscillation persistence
 * - Detect rebalance density
 * - Detect bin dominance feasibility
 * 
 * BOOTSTRAP RULES:
 * - Duration: 6 hours (configurable)
 * - EV gate DISABLED
 * - Payback NOT enforced
 * - Aggression capped only by hard safety rules
 * 
 * EXPLICIT: Logs WILL look bad during bootstrap. This is EXPECTED and CORRECT.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    PREDATOR_MODE_V1_ENABLED,
    BOOTSTRAP_PROBE_CONFIG,
    CAPITAL_CONCENTRATION_CONFIG,
} from '../config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BootstrapProbeState {
    poolAddress: string;
    poolName: string;
    probeStartTime: number;
    probeDurationMs: number;
    isActive: boolean;
    
    // Probe metrics
    oscillationCount: number;
    binCrossings: number;
    feeVelocitySamples: number[];
    rebalanceCount: number;
    volumeSamples: number[];
    
    // Graduation status
    graduated: boolean;
    graduatedAt?: number;
    graduationReason?: string;
}

export interface ProbeEvaluationResult {
    isInProbeMode: boolean;
    timeRemainingMs: number;
    timeElapsedMs: number;
    progressPct: number;
    canGraduate: boolean;
    graduationScore: number;
    metrics: ProbeMetrics;
}

export interface ProbeMetrics {
    oscillationCount: number;
    avgBinCrossingsPerHour: number;
    avgFeeVelocity: number;
    rebalanceCount: number;
    avgVolumeUsd: number;
    isHealthy: boolean;
}

export interface ProbeGraduationDecision {
    shouldGraduate: boolean;
    reason: string;
    recommendedCapitalPct: number;
    confidence: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

const probeStates = new Map<string, BootstrapProbeState>();
let globalBootstrapStartTime: number | null = null;

/**
 * Initialize global bootstrap mode (first position ever)
 */
export function initializeGlobalBootstrap(): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    if (globalBootstrapStartTime === null) {
        globalBootstrapStartTime = Date.now();
        logger.info(
            `[BOOTSTRAP] 🚀 Global bootstrap mode STARTED | ` +
            `duration=${BOOTSTRAP_PROBE_CONFIG.DURATION_MS / (60 * 60 * 1000)}h | ` +
            `EV_GATE=DISABLED | PAYBACK=DISABLED`
        );
    }
}

/**
 * Check if we're in global bootstrap mode
 */
export function isInGlobalBootstrapMode(): boolean {
    if (!PREDATOR_MODE_V1_ENABLED || globalBootstrapStartTime === null) {
        return false;
    }
    
    const elapsed = Date.now() - globalBootstrapStartTime;
    return elapsed < BOOTSTRAP_PROBE_CONFIG.DURATION_MS;
}

/**
 * Get global bootstrap progress
 */
export function getGlobalBootstrapProgress(): {
    isActive: boolean;
    elapsedMs: number;
    remainingMs: number;
    progressPct: number;
} {
    if (!PREDATOR_MODE_V1_ENABLED || globalBootstrapStartTime === null) {
        return {
            isActive: false,
            elapsedMs: 0,
            remainingMs: 0,
            progressPct: 100,
        };
    }
    
    const elapsed = Date.now() - globalBootstrapStartTime;
    const duration = BOOTSTRAP_PROBE_CONFIG.DURATION_MS;
    const remaining = Math.max(0, duration - elapsed);
    const progress = Math.min(100, (elapsed / duration) * 100);
    
    return {
        isActive: elapsed < duration,
        elapsedMs: elapsed,
        remainingMs: remaining,
        progressPct: progress,
    };
}

/**
 * Initialize probe mode for a specific position
 */
export function initializeProbeMode(
    tradeId: string,
    poolAddress: string,
    poolName: string
): BootstrapProbeState {
    const state: BootstrapProbeState = {
        poolAddress,
        poolName,
        probeStartTime: Date.now(),
        probeDurationMs: BOOTSTRAP_PROBE_CONFIG.DURATION_MS,
        isActive: true,
        oscillationCount: 0,
        binCrossings: 0,
        feeVelocitySamples: [],
        rebalanceCount: 0,
        volumeSamples: [],
        graduated: false,
    };
    
    probeStates.set(tradeId, state);
    
    logger.info(
        `[BOOTSTRAP] 📍 Probe initialized for ${poolName} | ` +
        `duration=${state.probeDurationMs / (60 * 60 * 1000)}h`
    );
    
    return state;
}

/**
 * Record probe metrics
 */
export function recordProbeMetrics(
    tradeId: string,
    metrics: {
        binCrossings?: number;
        feeVelocity?: number;
        volumeUsd?: number;
        oscillation?: boolean;
        rebalance?: boolean;
    }
): void {
    const state = probeStates.get(tradeId);
    if (!state || !state.isActive) return;
    
    if (metrics.binCrossings !== undefined) {
        state.binCrossings += metrics.binCrossings;
    }
    
    if (metrics.feeVelocity !== undefined) {
        state.feeVelocitySamples.push(metrics.feeVelocity);
        // Keep last 100 samples
        if (state.feeVelocitySamples.length > 100) {
            state.feeVelocitySamples = state.feeVelocitySamples.slice(-100);
        }
    }
    
    if (metrics.volumeUsd !== undefined) {
        state.volumeSamples.push(metrics.volumeUsd);
        if (state.volumeSamples.length > 100) {
            state.volumeSamples = state.volumeSamples.slice(-100);
        }
    }
    
    if (metrics.oscillation) {
        state.oscillationCount++;
    }
    
    if (metrics.rebalance) {
        state.rebalanceCount++;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROBE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate current probe status for a position
 */
export function evaluateProbeMode(tradeId: string): ProbeEvaluationResult {
    const state = probeStates.get(tradeId);
    
    if (!state || !PREDATOR_MODE_V1_ENABLED) {
        return {
            isInProbeMode: false,
            timeRemainingMs: 0,
            timeElapsedMs: 0,
            progressPct: 100,
            canGraduate: true,
            graduationScore: 100,
            metrics: {
                oscillationCount: 0,
                avgBinCrossingsPerHour: 0,
                avgFeeVelocity: 0,
                rebalanceCount: 0,
                avgVolumeUsd: 0,
                isHealthy: true,
            },
        };
    }
    
    const now = Date.now();
    const elapsed = now - state.probeStartTime;
    const remaining = Math.max(0, state.probeDurationMs - elapsed);
    const progress = Math.min(100, (elapsed / state.probeDurationMs) * 100);
    const isInProbe = elapsed < state.probeDurationMs && !state.graduated;
    
    // Calculate metrics
    const hoursElapsed = elapsed / (60 * 60 * 1000);
    const avgBinCrossingsPerHour = hoursElapsed > 0 
        ? state.binCrossings / hoursElapsed 
        : 0;
    const avgFeeVelocity = state.feeVelocitySamples.length > 0
        ? state.feeVelocitySamples.reduce((a, b) => a + b, 0) / state.feeVelocitySamples.length
        : 0;
    const avgVolumeUsd = state.volumeSamples.length > 0
        ? state.volumeSamples.reduce((a, b) => a + b, 0) / state.volumeSamples.length
        : 0;
    
    // Health check (minimal - just ensure it's not completely dead)
    const isHealthy = avgFeeVelocity > 0 || state.rebalanceCount > 0 || avgBinCrossingsPerHour > 0;
    
    const metrics: ProbeMetrics = {
        oscillationCount: state.oscillationCount,
        avgBinCrossingsPerHour,
        avgFeeVelocity,
        rebalanceCount: state.rebalanceCount,
        avgVolumeUsd,
        isHealthy,
    };
    
    // Calculate graduation score (0-100)
    // This is informational - we don't gate on it
    const graduationScore = calculateGraduationScore(metrics, hoursElapsed);
    
    return {
        isInProbeMode: isInProbe,
        timeRemainingMs: remaining,
        timeElapsedMs: elapsed,
        progressPct: progress,
        canGraduate: !isInProbe || graduationScore >= 50,
        graduationScore,
        metrics,
    };
}

/**
 * Calculate graduation score (0-100)
 * Higher = more suitable for capital scaling
 */
function calculateGraduationScore(metrics: ProbeMetrics, hoursElapsed: number): number {
    if (hoursElapsed < 0.5) return 0;  // Too early
    
    let score = 0;
    
    // Oscillation count (20 points max)
    score += Math.min(20, metrics.oscillationCount * 2);
    
    // Bin crossings per hour (25 points max)
    score += Math.min(25, metrics.avgBinCrossingsPerHour * 5);
    
    // Fee velocity (25 points max)
    score += Math.min(25, metrics.avgFeeVelocity * 50);
    
    // Rebalance count (15 points max)
    score += Math.min(15, metrics.rebalanceCount * 3);
    
    // Volume (15 points max)
    const volumeScore = metrics.avgVolumeUsd > 100000 ? 15 :
                       metrics.avgVolumeUsd > 50000 ? 10 :
                       metrics.avgVolumeUsd > 10000 ? 5 : 0;
    score += volumeScore;
    
    return Math.min(100, score);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRADUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate if a position should graduate from probe mode
 * and how much capital to allocate post-graduation
 */
export function evaluateGraduation(tradeId: string): ProbeGraduationDecision {
    const probeResult = evaluateProbeMode(tradeId);
    const state = probeStates.get(tradeId);
    
    if (!state || state.graduated) {
        return {
            shouldGraduate: true,
            reason: 'ALREADY_GRADUATED',
            recommendedCapitalPct: CAPITAL_CONCENTRATION_CONFIG.POST_GRADUATION.MAX_PER_POOL_PCT,
            confidence: 1.0,
        };
    }
    
    // Time-based graduation (probe complete)
    if (!probeResult.isInProbeMode) {
        const score = probeResult.graduationScore;
        const confidence = score / 100;
        
        // Scale recommended capital by graduation score
        const baseCapital = CAPITAL_CONCENTRATION_CONFIG.POST_GRADUATION.MAX_PER_POOL_PCT;
        const scaledCapital = baseCapital * confidence;
        
        return {
            shouldGraduate: true,
            reason: `PROBE_COMPLETE: score=${score}`,
            recommendedCapitalPct: Math.max(
                CAPITAL_CONCENTRATION_CONFIG.INITIAL.ALLOCATION_PER_POOL_MIN_PCT,
                scaledCapital
            ),
            confidence,
        };
    }
    
    // Early graduation if metrics are exceptional (>80 score after 2+ hours)
    const hoursElapsed = probeResult.timeElapsedMs / (60 * 60 * 1000);
    if (hoursElapsed >= 2 && probeResult.graduationScore >= 80) {
        return {
            shouldGraduate: true,
            reason: `EARLY_GRADUATION: score=${probeResult.graduationScore} after ${hoursElapsed.toFixed(1)}h`,
            recommendedCapitalPct: CAPITAL_CONCENTRATION_CONFIG.POST_GRADUATION.MAX_PER_POOL_PCT * 0.8,
            confidence: probeResult.graduationScore / 100,
        };
    }
    
    // Still in probe
    return {
        shouldGraduate: false,
        reason: `IN_PROBE: ${probeResult.progressPct.toFixed(0)}% complete, score=${probeResult.graduationScore}`,
        recommendedCapitalPct: CAPITAL_CONCENTRATION_CONFIG.INITIAL.ALLOCATION_PER_POOL_MAX_PCT,
        confidence: probeResult.graduationScore / 100,
    };
}

/**
 * Mark a position as graduated
 */
export function markGraduated(tradeId: string, reason: string): void {
    const state = probeStates.get(tradeId);
    if (!state) return;
    
    state.graduated = true;
    state.graduatedAt = Date.now();
    state.graduationReason = reason;
    state.isActive = false;
    
    const probeResult = evaluateProbeMode(tradeId);
    
    logger.info(
        `[BOOTSTRAP] 🎓 GRADUATED: ${state.poolName} | ` +
        `reason=${reason} | ` +
        `score=${probeResult.graduationScore} | ` +
        `oscillations=${state.oscillationCount} | ` +
        `rebalances=${state.rebalanceCount} | ` +
        `avgFeeVel=${probeResult.metrics.avgFeeVelocity.toFixed(4)}`
    );
}

/**
 * Cleanup probe state for closed position
 */
export function cleanupProbeState(tradeId: string): void {
    probeStates.delete(tradeId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATE BYPASS FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if EV gate should be bypassed (always true during probe)
 */
export function shouldBypassEVGate(tradeId: string): boolean {
    if (!PREDATOR_MODE_V1_ENABLED) return false;
    
    // Global bootstrap mode bypasses EV
    if (isInGlobalBootstrapMode()) return true;
    
    // Position-specific probe bypasses EV
    const result = evaluateProbeMode(tradeId);
    return result.isInProbeMode;
}

/**
 * Check if payback gate should be bypassed (always true during probe)
 */
export function shouldBypassPaybackGate(tradeId: string): boolean {
    if (!PREDATOR_MODE_V1_ENABLED) return false;
    
    // Global bootstrap mode bypasses payback
    if (isInGlobalBootstrapMode()) return true;
    
    // Position-specific probe bypasses payback
    const result = evaluateProbeMode(tradeId);
    return result.isInProbeMode;
}

/**
 * Get sizing for probe mode (conservative initial sizing)
 */
export function getProbeSizing(equity: number): {
    minSizeUsd: number;
    maxSizeUsd: number;
    recommendedPct: number;
} {
    const config = CAPITAL_CONCENTRATION_CONFIG.INITIAL;
    
    return {
        minSizeUsd: equity * config.ALLOCATION_PER_POOL_MIN_PCT,
        maxSizeUsd: equity * config.ALLOCATION_PER_POOL_MAX_PCT,
        recommendedPct: (config.ALLOCATION_PER_POOL_MIN_PCT + config.ALLOCATION_PER_POOL_MAX_PCT) / 2,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logBootstrapProbeStatus(): void {
    if (!PREDATOR_MODE_V1_ENABLED) {
        logger.info('[BOOTSTRAP] Probe mode DISABLED');
        return;
    }
    
    const globalProgress = getGlobalBootstrapProgress();
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('🚀 BOOTSTRAP PROBE MODE STATUS');
    logger.info('═══════════════════════════════════════════════════════════════');
    
    if (globalProgress.isActive) {
        logger.info(
            `  Global Bootstrap: ACTIVE | ` +
            `${globalProgress.progressPct.toFixed(0)}% complete | ` +
            `${(globalProgress.remainingMs / (60 * 60 * 1000)).toFixed(1)}h remaining`
        );
        logger.info('  Gates Bypassed: EV_GATE, PAYBACK_GATE');
        logger.info('  ⚠️ EXPECTED: Logs may look bad during this phase');
    } else {
        logger.info('  Global Bootstrap: COMPLETE');
    }
    
    logger.info(`  Tracked Probes: ${probeStates.size}`);
    
    for (const [tradeId, state] of probeStates) {
        const result = evaluateProbeMode(tradeId);
        const status = state.graduated ? '🎓 GRADUATED' : 
                      result.isInProbeMode ? '🔍 PROBING' : '✅ COMPLETE';
        
        logger.info(
            `    ${status} ${state.poolName} | ` +
            `score=${result.graduationScore} | ` +
            `${result.progressPct.toFixed(0)}% | ` +
            `osc=${state.oscillationCount} | ` +
            `rebal=${state.rebalanceCount}`
        );
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

export function logProbeWarning(): void {
    if (!isInGlobalBootstrapMode()) return;
    
    const progress = getGlobalBootstrapProgress();
    
    logger.warn(
        `[BOOTSTRAP] ⚠️ PROBE MODE ACTIVE (${progress.progressPct.toFixed(0)}%) | ` +
        `EV/Payback gates DISABLED | ` +
        `Expect unusual metrics | ` +
        `${(progress.remainingMs / (60 * 60 * 1000)).toFixed(1)}h remaining`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    initializeGlobalBootstrap,
    isInGlobalBootstrapMode,
    getGlobalBootstrapProgress,
    initializeProbeMode,
    recordProbeMetrics,
    evaluateProbeMode,
    evaluateGraduation,
    markGraduated,
    cleanupProbeState,
    shouldBypassEVGate,
    shouldBypassPaybackGate,
    getProbeSizing,
    logBootstrapProbeStatus,
    logProbeWarning,
};

