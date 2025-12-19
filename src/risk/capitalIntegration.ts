/**
 * Capital Integration — Bridge Between Capital Manager and ScanLoop
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 5 PRODUCTION INTEGRATION LAYER
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides ready-to-use functions for integrating the Adaptive
 * Capital Manager into the existing ScanLoop without requiring extensive
 * refactoring.
 * 
 * USAGE:
 *   1. Call initializeCapitalIntegration() at bot startup
 *   2. Call updateCapitalManagerCycle() at start of each scan cycle
 *   3. Call getAdaptivePositionSize() when sizing new positions
 *   4. Call recordPositionEntry/Exit when positions open/close
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';
import { logPeriodicSummary } from '../utils/rateLimitedLogger';

import {
    // Capital Manager
    updateEquity,
    updateRegime,
    setCooldownState,
    updateConfidence,
    recordDeployment,
    recordExit,
    recordPoolFeeHistory,
    checkCapitalAvailability,
    computePositionSize,
    getCapitalManagerState,
    logCapitalManagerStatus,
    assertCapitalInvariants,
    resetCapitalManager,
    syncDeployments,
    CAPITAL_CONFIG,
    ConfidenceInputs,
    PositionSizingResult,
    CapitalCheckResult,
} from './capitalManager';

import {
    // Confidence Score
    recordExitTriggered,
    recordExitSuppressed,
    recordExitExecuted,
    recordForcedExit,
    recordPositionHealth,
    recordUnrealizedPnl,
    recordMarketMetrics,
    recordRpcError,
    recordApiError,
    recordSuccessfulRequest,
    completeCycle,
    computeConfidenceInputs,
    logConfidenceBreakdown,
    getConfidenceSummary,
} from './confidenceScore';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let initialized = false;
let cycleCount = 0;
let lastStatusLogTime = 0;
const STATUS_LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize capital integration.
 * Call this at bot startup after capital manager is loaded from DB.
 */
export function initializeCapitalIntegration(
    initialEquityUsd: number,
    existingPositions?: Array<{ poolAddress: string; sizeUsd: number }>
): void {
    resetCapitalManager(initialEquityUsd);
    
    if (existingPositions && existingPositions.length > 0) {
        syncDeployments(existingPositions);
    }
    
    initialized = true;
    cycleCount = 0;
    lastStatusLogTime = Date.now();
    
    logger.info(
        `[CAPITAL-INT] Initialized with equity=$${initialEquityUsd.toFixed(2)} ` +
        `positions=${existingPositions?.length ?? 0}`
    );
}

/**
 * Check if capital integration is initialized
 */
export function isCapitalIntegrationInitialized(): boolean {
    return initialized;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE UPDATES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update capital manager at start of each scan cycle.
 * Call this at the beginning of each scan loop iteration.
 */
export function updateCapitalManagerCycle(
    equity: number,
    regime: MarketRegime,
    killSwitchActive: boolean,
    cooldownEndTimeMs: number,
    marketHealth: number,
    aliveRatio: number
): void {
    if (!initialized) {
        logger.warn('[CAPITAL-INT] Not initialized, skipping cycle update');
        return;
    }
    
    cycleCount++;
    
    // Update equity
    updateEquity(equity);
    
    // Update regime
    updateRegime(regime);
    
    // Update cooldown state from kill switch
    setCooldownState(killSwitchActive, cooldownEndTimeMs);
    
    // Record market metrics for confidence
    recordMarketMetrics(marketHealth, aliveRatio);
    
    // Complete previous confidence cycle and compute new inputs
    completeCycle();
    const confidenceInputs = computeConfidenceInputs();
    updateConfidence(confidenceInputs);
    
    // Periodic logging
    const now = Date.now();
    if (now - lastStatusLogTime >= STATUS_LOG_INTERVAL_MS) {
        logCapitalManagerStatus();
        logConfidenceBreakdown();
        lastStatusLogTime = now;
    }
    
    // Log rate-limited summary periodically
    logPeriodicSummary();
    
    // Run invariant checks
    const invariants = assertCapitalInvariants();
    if (!invariants.valid) {
        logger.error(`[CAPITAL-INT] Invariant violations: ${invariants.errors.join(' | ')}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION SIZING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get adaptive position size using the capital manager.
 * Returns both the recommended size and whether to proceed.
 */
export function getAdaptivePositionSize(
    poolAddress: string,
    poolName: string,
    poolTvl: number,
    entryFeesUsd: number,
    exitFeesUsd: number,
    slippageUsd: number,
    observedFeeRateUsdPerHour?: number
): {
    sizeUsd: number;
    allowed: boolean;
    reason: string;
    sizing: PositionSizingResult;
    check: CapitalCheckResult;
} {
    if (!initialized) {
        return {
            sizeUsd: 0,
            allowed: false,
            reason: 'Capital integration not initialized',
            sizing: {
                recommendedSizeUsd: 0,
                minSizeUsd: CAPITAL_CONFIG.MIN_POSITION_USD,
                maxSizeUsd: 0,
                sizeReason: 'Not initialized',
                expectedFeeRateUsdPerHour: 0,
                estimatedAmortizationHours: 999,
                costTargetUsd: 0,
                isProbeMode: false,
                skipEntry: true,
                skipReason: 'Not initialized',
            },
            check: {
                allowed: false,
                reason: 'Not initialized',
                availableCapacityUsd: 0,
                poolRemainingCapacityUsd: 0,
                adjustedSizeUsd: 0,
            },
        };
    }
    
    // Compute recommended size based on amortization
    const sizing = computePositionSize(
        poolAddress,
        poolName,
        entryFeesUsd,
        exitFeesUsd,
        slippageUsd,
        observedFeeRateUsdPerHour
    );
    
    // Check if entry is allowed (skip entry flag from amortization)
    if (sizing.skipEntry) {
        return {
            sizeUsd: 0,
            allowed: false,
            reason: sizing.skipReason || 'Amortization not viable',
            sizing,
            check: {
                allowed: false,
                reason: sizing.skipReason || 'Skip entry',
                availableCapacityUsd: 0,
                poolRemainingCapacityUsd: 0,
                adjustedSizeUsd: 0,
            },
        };
    }
    
    // Check capital availability
    const check = checkCapitalAvailability(poolAddress, sizing.recommendedSizeUsd);
    
    if (!check.allowed) {
        return {
            sizeUsd: 0,
            allowed: false,
            reason: check.reason,
            sizing,
            check,
        };
    }
    
    // Use adjusted size from capital check (may be capped)
    return {
        sizeUsd: check.adjustedSizeUsd,
        allowed: true,
        reason: check.reason,
        sizing,
        check,
    };
}

/**
 * Get minimum viable position size for current config
 */
export function getMinPositionSizeUsd(): number {
    return CAPITAL_CONFIG.MIN_POSITION_USD;
}

/**
 * Get target position size for regime
 */
export function getTargetPositionSizeUsd(regime: MarketRegime): number {
    switch (regime) {
        case 'BULL':
            return CAPITAL_CONFIG.TARGET_POSITION_USD_BULL;
        case 'BEAR':
            return CAPITAL_CONFIG.TARGET_POSITION_USD_BEAR;
        default:
            return CAPITAL_CONFIG.TARGET_POSITION_USD_NEUTRAL;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a new position entry
 */
export function recordPositionEntry(poolAddress: string, sizeUsd: number): void {
    if (!initialized) return;
    recordDeployment(poolAddress, sizeUsd);
}

/**
 * Record a position exit
 */
export function recordPositionExit(
    poolAddress: string,
    sizeUsd: number,
    feesAccruedUsd: number,
    holdTimeMs: number
): void {
    if (!initialized) return;
    
    recordExit(poolAddress, sizeUsd);
    
    // Record fee history for future amortization estimation
    if (feesAccruedUsd > 0 && holdTimeMs > 0) {
        recordPoolFeeHistory(poolAddress, feesAccruedUsd, holdTimeMs, sizeUsd);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE TRACKING (call these from engine/scanLoop)
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // Re-export for convenience
    recordExitTriggered,
    recordExitSuppressed,
    recordExitExecuted,
    recordForcedExit,
    recordPositionHealth,
    recordUnrealizedPnl,
    recordRpcError,
    recordApiError,
    recordSuccessfulRequest,
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS ACCESSORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get dynamic deployment cap (as percentage)
 */
export function getDynamicDeployCapPct(): number {
    return getCapitalManagerState().dynamicDeployCapPct;
}

/**
 * Get per-pool max cap (as percentage)
 */
export function getPerPoolMaxCapPct(): number {
    return getCapitalManagerState().perPoolMaxPct;
}

/**
 * Check if max capacity is unlocked
 */
export function isMaxCapacityUnlocked(): boolean {
    return getCapitalManagerState().confidenceUnlocked;
}

/**
 * Get confidence score
 */
export function getConfidenceScore(): number {
    return getCapitalManagerState().confidenceScore;
}

/**
 * Get full capital manager state
 */
export function getFullCapitalState() {
    return {
        state: getCapitalManagerState(),
        confidence: getConfidenceSummary(),
        cycleCount,
    };
}

/**
 * Log full capital status (for debugging)
 */
export function logFullCapitalStatus(): void {
    logCapitalManagerStatus();
    logConfidenceBreakdown();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY ADAPTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Legacy position sizing adapter.
 * Wraps the new capital manager for backwards compatibility with existing code.
 * 
 * @deprecated Use getAdaptivePositionSize() directly
 */
export function legacyCalculatePositionSize(
    poolAddress: string,
    poolName: string,
    equity: number,
    balance: number,
    poolTvl: number,
    microScore: number,
    regime: MarketRegime
): { size: number; blocked: boolean; reason: string } {
    // Estimate fees based on typical costs
    const estimatedEntryFees = equity * 0.003; // 0.3%
    const estimatedExitFees = equity * 0.003;  // 0.3%
    const estimatedSlippage = equity * 0.002;  // 0.2%
    
    const result = getAdaptivePositionSize(
        poolAddress,
        poolName,
        poolTvl,
        estimatedEntryFees,
        estimatedExitFees,
        estimatedSlippage
    );
    
    return {
        size: result.sizeUsd,
        blocked: !result.allowed,
        reason: result.reason,
    };
}

