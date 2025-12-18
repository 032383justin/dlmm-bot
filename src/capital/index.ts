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
    getExitSuppressionStats,
    resetExitSuppressionStats,
    assertNoRiskExitsSuppressed,
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
    ExitSuppressionStats,
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
    // Tier 5 Telemetry additions
    logTier5Summary,
    recordTier5EntryData,
    updateTier5TrackingPeriodic,
    logTier5ValidationSummary,
    updateTier5SuppressionFlags,
    // Tier 5 Post-Trade Attribution
    recordTier5PostTradeAttribution,
    getTier5AttributionSummary,
    logTier5AttributionSummary,
    getTier5AttributionHistory,
    // PEPF Telemetry
    recordPEPFEntryData,
} from './expectancyTelemetry';

export type {
    TradeTelemetry,
    CycleSummary,
    EntryEvaluation,
    EVVerificationRecord,
    Tier5ValidationInputs,
    Tier5PostTradeAttribution,
    Tier5AttributionSummary,
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

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 5: CONTROLLED AGGRESSION MODULES
// ═══════════════════════════════════════════════════════════════════════════════

// MODULE A: Opportunity Density Detector (ODD)
export {
    computeODS,
    hasActiveSpike,
    getActiveSpike,
    getAllActiveSpikes,
    isRareConvergence,
    getODSSummary,
    clearODDState,
    expireSpike,
    ODD_CONFIG,
} from './opportunityDensity';

export type {
    ODSResult,
    ODSComponents,
} from './opportunityDensity';

// MODULE B: Aggression Ladder (AEL)
export {
    evaluateAggressionLevel,
    getAggressionState,
    getAggressionMultipliers,
    isElevatedAggression,
    getAggressionSummary,
    forceRevertToA0,
    clearAggressionState,
    recordFeeIntensity,
    assertAggressionInvariants,
    AEL_CONFIG,
} from './aggressionLadder';

export type {
    AggressionLevel,
    AggressionMultipliers,
    AggressionState,
} from './aggressionLadder';

// MODULE C: Capital Concentration Engine (CCE)
export {
    updateEquity,
    evaluateConcentration,
    recordDeployment,
    recordExit,
    getPoolDeployedPercentage,
    getTotalDeployedPercentage,
    getDeploymentSummary,
    clearCCEState,
    assertCCEInvariants,
    getTrancheAddStats,
    resetTrancheAddStats,
    getPriorTrancheEV,
    getCurrentTrancheIndex,
    CCE_CONFIG,
} from './capitalConcentration';

export type {
    PoolConcentrationState,
    ConcentrationResult,
    TrancheRecord,
    TrancheGatingInputs,
    TrancheAddStats,
} from './capitalConcentration';

// MODULE D: Volatility Skew Harvester (VSH)
export {
    evaluateVSHEligibility,
    getVSHAdjustments,
    isVSHHarvesting,
    getVSHSummary,
    clearVSHState,
    getVSHBinWidthAdjustment,
    shouldVSHSuppressExit,
    VSH_CONFIG,
} from './volatilitySkew';

export type {
    ExitSuppressionHint,
    VSHEligibility,
    VSHAdjustments,
} from './volatilitySkew';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 5: SIZING TRACE (CANONICAL MULTIPLIER BREAKDOWN)
// ═══════════════════════════════════════════════════════════════════════════════

export {
    computeFinalEntrySizingBreakdown,
    logSizingTrace,
    logSizingBreakdownDebug,
} from './sizingTrace';

export type {
    SizingBreakdown,
} from './sizingTrace';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 5: ODD VALIDATION (HARDENED EXPORTS)
// ═══════════════════════════════════════════════════════════════════════════════

export {
    validateODDInputs,
    getODDValidationStats,
    resetODDValidationStats,
    getSpikeDecayPct,
    isSpikeConfirmed,
} from './opportunityDensity';

export type {
    ODDValidationResult,
    ODDValidationStats,
} from './opportunityDensity';

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-ENTRY PERSISTENCE FILTER (PEPF)
// ═══════════════════════════════════════════════════════════════════════════════

export {
    evaluatePreEntryPersistence,
    recordPersistenceSignal,
    getPersistenceStats,
    resetPersistenceStats,
    getTopRejectReason,
    logPersistenceSummary,
    clearPEPFState,
    getCachedSignals,
    assertPEPFInvariants,
    // Cooldown management
    clearAllCooldowns,
    clearPoolCooldown,
    getPoolCooldownStatus,
} from './preEntryPersistence';

export type {
    PreEntryPersistenceContext,
    PreEntryPersistenceResult,
    PersistenceSignals,
    PersistenceStats,
    PEPFBlockReason,
} from './preEntryPersistence';

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO LEDGER — SINGLE SOURCE OF TRUTH
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // Core functions
    initializeLedger,
    onPositionOpen,
    onPositionUpdate,
    onPositionClose,
    updateTotalCapital,
    updateLockedCapital,
    
    // State accessors
    getLedgerState,
    getOpenPositions,
    getPosition,
    hasPosition,
    getPoolPositions,
    getTierPositions,
    
    // Derived accessors
    getDeployedPct,
    getTierExposurePct,
    getAllTierExposures,
    getPoolExposurePct,
    getTierRemainingCapacity,
    getPortfolioRemainingCapacity,
    
    // Invariants
    checkLedgerInvariants,
    assertLedgerInvariants,
    assertDeployedReflectsPositions,
    
    // Sync & reconciliation
    syncFromExternal,
    
    // Logging
    logLedgerState,
    logDetailedLedgerState,
    
    // State management
    resetLedger,
    isLedgerInitialized,
    
    // Config
    LEDGER_CONFIG,
} from './portfolioLedger';

export type {
    TierType,
    LedgerPosition,
    TierAllocation,
    PoolAllocation,
    PortfolioLedgerState,
    InvariantCheckResult,
} from './portfolioLedger';

// ═══════════════════════════════════════════════════════════════════════════════
// MTM VALUATION — CANONICAL SINGLE SOURCE OF TRUTH
// ═══════════════════════════════════════════════════════════════════════════════

export {
    computePositionMtmUsd,
    computeExitMtmUsd,
    estimateAccruedFees,
    logMtmUpdate,
    logPnlUsdWithMtm,
    logTradeExitWithMtm,
    getConsecutiveUnchangedExitCount,
    resetMtmErrorTracking,
    getRecentExitMTMs,
    createDefaultPriceFeed,
    createPositionForMtm,
    MTM_CONFIG,
} from './mtmValuation';

export type {
    PoolStateForMTM,
    PositionForMTM,
    PriceFeed,
    MTMValuation,
    MTMPositionUpdate,
} from './mtmValuation';

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT HYSTERESIS — NON-RISK EXIT SUPPRESSION
// ═══════════════════════════════════════════════════════════════════════════════

export {
    shouldSuppressNoiseExit,
    canExitProceed,
    isRiskExit,
    isNoiseExit,
    classifyExitReason,
    recordSuppressionCheck,
    getSuppressionStats,
    resetSuppressionStats,
    logSuppressionSummary,
    logExitAllowed,
    EXIT_CONFIG,
    RISK_EXIT_TYPES,
    NOISE_EXIT_TYPES,
} from './exitHysteresis';

export type {
    RiskExitType as HysteresisRiskExitType, // Renamed to avoid conflict with feeHarvestHold
    NoiseExitType,
    PositionForSuppression,
    SuppressionResult,
    SuppressReason,
} from './exitHysteresis';

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT-INTENT LATCH — CONTROL-PLANE STABILIZATION
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // Core state management
    hasExitIntent,
    getExitIntent,
    isInCooldown,
    latchExitIntent,
    setSuppressed,
    extendCooldown,
    clearExitIntent,
    clearAllExitIntents,
    
    // Re-evaluation logic
    checkReEvaluationCriteria,
    logReEvaluationResult,
    
    // Summary/monitoring
    getAllExitIntents,
    getExitIntentSummary,
    
    // Helpers
    classifyExitReason as classifyExitReasonCategory,
    getCooldownForCategory,
    
    // Config
    EXIT_INTENT_CONFIG,
} from './exitIntentLatch';

export type {
    ExitIntent,
    ExitIntentMetrics,
    ExitReasonCategory,
    SuppressionType,
    ReEvaluationResult,
} from './exitIntentLatch';

