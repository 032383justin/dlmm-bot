/**
 * Capital Management Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unified exports for capital and entry gating functionality.
 * 
 * TIER 4 DOMINANT UPGRADE:
 * - EV Gating (expectancy-aware execution)
 * - Fee-Harvest Hold Mode (extract value from flat markets)
 * - Aggression Scaling (regime-adaptive sizing)
 * - Fee-Bleed Failsafe (prevent death by fees)
 * - Expectancy Telemetry (full observability)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Tier 4 Entry Gating
export {
    evaluateEntryGating,
    shouldBlockEntry,
    getCombinedPositionMultiplier,
    shouldForceExitAllPositions,
    getActiveRegimeForLogging,
    createTradingStateFromMetrics,
} from './tier4EntryGating';

export type {
    EntryGatingInputs,
    EntryGatingResult,
} from './tier4EntryGating';

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 1: EXPECTED VALUE (EV) GATING
// ═══════════════════════════════════════════════════════════════════════════════

export {
    computeExpectedValue,
    passesEVGate,
    getMinEVPositiveSize,
    logEVGate,
    logEVGateDebug,
    validateEVInputs,
    assertNoRealizedPnLInEV,
    EV_CONFIG,
} from './evGating';

export type {
    EVResult,
    EVInputs,
} from './evGating';

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 2: FEE-HARVEST HOLD MODE
// ═══════════════════════════════════════════════════════════════════════════════

export {
    evaluateHoldMode,
    enterHoldMode,
    exitHoldMode,
    recordHoldFees,
    getHoldState,
    getPositionState,
    shouldSuppressExit,
    logHoldReject,
    cleanupHoldState,
    getHoldPositions,
    getHoldModeSummary,
    clearHoldState,
    classifyExitTrigger,
    HOLD_CONFIG,
} from './feeHarvestHold';

export type {
    PositionState,
    HoldState,
    HoldEvaluation,
    HoldEvaluationInputs,
    ExitClassification,
    RiskExitType,
    ExitClassificationResult,
} from './feeHarvestHold';

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 3: REGIME-ADAPTIVE AGGRESSION SCALING
// ═══════════════════════════════════════════════════════════════════════════════

export {
    updateRegimeState,
    computeAggressionScaling,
    getRegimeAdjustedSize,
    getRegimeAdjustedExitThreshold,
    getRegimeAdjustedBinWidth,
    isScoreDecayTolerable,
    logAggressionAdjustment,
    logAggressionSummary,
    logAggressionState,
    getCurrentRegimeState,
    getRecentAdjustments,
    resetAggressionState,
    AGGRESSION_CONFIG,
} from './aggressionScaling';

export type {
    AggressionScaling,
    AggressionAdjustment,
} from './aggressionScaling';

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 4: FEE-BLEED FAILSAFE
// ═══════════════════════════════════════════════════════════════════════════════

export {
    recordTradeOutcome,
    recordNoPositiveEVCycle,
    recordPositiveEVTrade,
    recordPositiveExpectedEVTrade,
    analyzeFeeBleed,
    isFeeBleedDefenseActive,
    getFeeBleedMultipliers,
    applyFeeBleedToEVRatio,
    applyFeeBleedToPositionSize,
    logFeeBleedStatus,
    checkDefenseTimeout,
    getRecentTradeOutcomes,
    getFeeBleedState,
    forceActivateDefense,
    forceDeactivateDefense,
    resetFeeBleedState,
    FEE_BLEED_CONFIG,
} from './feeBleedFailsafe';

export type {
    FeeBleedAnalysis,
    DefenseDeactivationReason,
} from './feeBleedFailsafe';

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 5: EXPECTANCY TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════════

export {
    recordTradeEntry,
    recordTradeExit,
    recordEntryEvaluation,
    recordHoldModeFees,
    generateCycleSummary,
    logExpectancySummary,
    getActiveTradeTelemetry,
    getClosedTradeTelemetry,
    getLatestCycleSummary,
    getCycleSummaries,
    getEVAccuracyStats,
    getFeeBreakdownStats,
    verifyEVModelValidity,
    getEVVerificationRecords,
    logEVVerificationSummary,
    clearTelemetry,
    TELEMETRY_CONFIG,
} from './expectancyTelemetry';

export type {
    TradeTelemetry,
    CycleSummary,
    EntryEvaluation,
    EVVerificationRecord,
} from './expectancyTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 6: PORTFOLIO STATE CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════════════

export {
    checkPortfolioConsistency,
    logPortfolioConsistency,
    getConsistencyHistory,
    getLastConsistencyResult,
    getConsecutiveErrorCount,
    resetConsistencyTracking,
    isPortfolioConsistent,
    PORTFOLIO_CONSISTENCY_CONFIG,
} from './portfolioConsistency';

export type {
    PositionForConsistency,
    PortfolioConsistencyResult,
    PortfolioStateSnapshot,
} from './portfolioConsistency';

