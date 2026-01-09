/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREDATOR MODE v1 — UNIFIED EXPORT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This file provides a single import point for all Predator Mode v1 components.
 * 
 * Usage:
 * ```typescript
 * import {
 *   PREDATOR_MODE_V1_ENABLED,
 *   logPredatorModeV1Banner,
 *   selectPrey,
 *   determineBinDominanceStrategy,
 *   evaluateRebalance,
 *   evaluateCompoundingExitGate,
 *   isInGlobalBootstrapMode,
 *   getPortfolioState,
 *   evaluateEntryWithRegime,
 *   logFeeVelocityTelemetry,
 * } from './predatorMode';
 * ```
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export {
    PREDATOR_MODE_V1_ENABLED,
    PREY_SELECTION_HARD_FILTERS,
    PREY_SELECTION_SOFT_SCORING,
    HIGH_VALUE_PREY_TOKENS,
    BIN_DOMINANCE_CONFIG,
    REBALANCE_AGGRESSION_CONFIG,
    EXIT_SUPPRESSION_CONFIG,
    BOOTSTRAP_PROBE_CONFIG,
    CAPITAL_CONCENTRATION_CONFIG,
    REGIME_OBSERVATIONAL_CONFIG,
    TELEMETRY_OPTIMIZATION_CONFIG,
    SAFETY_ONLY_CONFIG,
    SUCCESS_CRITERIA,
    // Functions
    isHighValuePrey,
    isValidPredatorExit,
    calculateCostAmortizationRequired,
    hasCostAmortized,
    meetsHardFilters,
    calculatePreyScore,
    getPredatorBinConfig,
    shouldRebalance,
    isInBootstrapMode,
    getRegimeMultipliers,
    logPredatorModeV1Banner,
} from './config/predatorModeV1';

// ═══════════════════════════════════════════════════════════════════════════════
// PREY SELECTION (Pool Discovery)
// ═══════════════════════════════════════════════════════════════════════════════

export {
    PreyCandidate,
    PreySelectionResult,
    PoolMetricsForPrey,
    evaluatePrey,
    selectPrey,
    forceSurfaceHighValuePrey,
    logPreySelectionSummary,
    logPreyCandidate,
} from './discovery/preySelection';

// ═══════════════════════════════════════════════════════════════════════════════
// BIN DOMINANCE STRATEGY
// ═══════════════════════════════════════════════════════════════════════════════

export {
    BinDominanceResult,
    ModalBinAnalysis,
    PriceHistory,
    BinVolumeData,
    analyzeModalBin,
    determineBinDominanceStrategy,
    hasPriceExitedDominance,
    calculateNewModalBin,
    calculateBinLiquidityAmounts,
    getDominantBin,
    recommendsRebalance,
    initializeBinTracking,
    updateBinTracking,
    recordBinRebalance,
    getBinStrategy,
    getRebalanceCount,
    cleanupBinTracking,
    getAllBinStates,
    logBinDominanceStrategy,
    logRebalanceRecommendation,
} from './engine/binDominanceStrategy';

// ═══════════════════════════════════════════════════════════════════════════════
// AGGRESSIVE REBALANCER
// ═══════════════════════════════════════════════════════════════════════════════

export {
    RebalanceEvaluation,
    RebalanceTrigger,
    PositionRebalanceState,
    RebalanceMetrics,
    initializeRebalanceState,
    updateRebalanceState,
    recordRebalanceExecution,
    cleanupRebalanceState,
    evaluateRebalance,
    getPositionsNeedingRebalance,
    resetCycleRebalanceCount,
    getRebalanceCounts,
    getRebalanceDensity,
    logRebalanceEvaluation,
    logRebalanceSummary,
    logAggressiveRebalancerStatus,
} from './engine/aggressiveRebalancer';

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOUNDING EXIT GATE
// ═══════════════════════════════════════════════════════════════════════════════

export {
    ExitGateResult,
    ExitCategory,
    ExitGateDetails,
    ExitEvaluationInput,
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
} from './capital/compoundingExitGate';

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP PROBE MODE
// ═══════════════════════════════════════════════════════════════════════════════

export {
    BootstrapProbeState,
    ProbeEvaluationResult,
    ProbeMetrics,
    ProbeGraduationDecision,
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
} from './capital/bootstrapProbeMode';

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL CONCENTRATION
// ═══════════════════════════════════════════════════════════════════════════════

export {
    CapitalAllocation,
    PortfolioState,
    PoolPosition,
    AllocationDecision,
    ScalingDecision,
    initializeCapitalConcentration,
    updateEquity,
    registerPosition,
    updatePosition,
    markPositionGraduated,
    removePosition,
    getPortfolioState,
    calculateInitialAllocation,
    evaluateDeploymentDecision,
    evaluateScalingDecisions,
    isIdleCapitalAcceptable,
    logCapitalConcentrationStatus,
    logAllocationDecision,
} from './capital/predatorCapitalConcentration';

// ═══════════════════════════════════════════════════════════════════════════════
// OBSERVATIONAL REGIME
// ═══════════════════════════════════════════════════════════════════════════════

export {
    RegimeType,
    RegimeState,
    RegimeAdjustments,
    RegimeDecision,
    RegimeInputs,
    detectRegime,
    updateRegimeState,
    getCurrentRegime,
    evaluateEntryWithRegime,
    evaluateExitWithRegime,
    evaluateAggressionWithRegime,
    getRegimeAdjustments,
    adjustRebalanceCadence,
    adjustBinTightness,
    getOverrideStats,
    resetOverrideStats,
    logRegimeObservationalStatus,
    logRegimeAssertion,
} from './regimes/observationalRegime';

// ═══════════════════════════════════════════════════════════════════════════════
// FEE VELOCITY TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════════

export {
    FeeVelocityMetrics,
    DailyPerformance,
    PortfolioMetrics,
    PositionTelemetry,
    initializePositionTelemetry,
    recordFees,
    recordRebalanceCost,
    recordBinDominance,
    getPositionTelemetry,
    cleanupPositionTelemetry,
    recordDailyPerformance,
    getPortfolioMetrics,
    calculateFeeVelocityMetrics,
    evaluateSuccessCriteria,
    logFeeVelocityTelemetry,
    logPositionTelemetrySummary,
} from './telemetry/feeVelocityTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

import { logPredatorModeV1Banner } from './config/predatorModeV1';
import { initializeGlobalBootstrap, logBootstrapProbeStatus } from './capital/bootstrapProbeMode';
import { logRegimeAssertion } from './regimes/observationalRegime';
import { logExitGateStatus } from './capital/compoundingExitGate';
import { logAggressiveRebalancerStatus } from './engine/aggressiveRebalancer';
import { initializeCapitalConcentration, logCapitalConcentrationStatus } from './capital/predatorCapitalConcentration';
import { PREDATOR_MODE_V1_ENABLED } from './config/predatorModeV1';

/**
 * Initialize Predator Mode v1
 * Call this at startup to enable all predator features
 */
export function initializePredatorModeV1(equity: number): void {
    if (!PREDATOR_MODE_V1_ENABLED) {
        console.log('[PREDATOR-V1] Mode DISABLED - running in standard mode');
        return;
    }
    
    // Log the banner
    logPredatorModeV1Banner();
    
    // Initialize components
    initializeGlobalBootstrap();
    initializeCapitalConcentration(equity);
    
    // Log component status
    logRegimeAssertion();
    logExitGateStatus();
    logAggressiveRebalancerStatus();
    logBootstrapProbeStatus();
    logCapitalConcentrationStatus();
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('🦅 PREDATOR MODE v1 INITIALIZATION COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('');
}

/**
 * Log full predator mode status summary
 */
export function logPredatorModeStatus(totalDeployedUsd: number): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    logCapitalConcentrationStatus();
    logBootstrapProbeStatus();
    logRegimeObservationalStatus();
    logFeeVelocityTelemetry(totalDeployedUsd);
    logRebalanceSummary();
    logCompoundingGateSummary();
}

// Re-export for convenience
import { logRebalanceSummary } from './engine/aggressiveRebalancer';
import { logCompoundingGateSummary } from './capital/compoundingExitGate';
import { logRegimeObservationalStatus } from './regimes/observationalRegime';
import { logFeeVelocityTelemetry } from './telemetry/feeVelocityTelemetry';

