/**
 * Risk Management Module — Unified Exports
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 5 PRODUCTION RISK MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTIVE CAPITAL MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // Core functions
    updateEquity,
    updateRegime,
    setCooldownState,
    updateConfidence,
    recordDeployment,
    recordExit,
    recordPoolFeeHistory,
    
    // Capital checks
    checkCapitalAvailability,
    computePositionSize,
    
    // State accessors
    getCapitalManagerState,
    getDynamicDeployCapPct,
    getPerPoolMaxPct,
    getAvailableCapacityUsd,
    getPoolRemainingCapacityUsd,
    isInStressMode,
    isMaxCapacityUnlocked,
    
    // Logging
    logCapitalManagerStatus,
    logCapitalManagerDebug,
    
    // Invariants
    assertCapitalInvariants,
    
    // Reset / Init
    resetCapitalManager,
    syncDeployments,
    
    // Config
    CAPITAL_CONFIG,
    CONFIDENCE_WEIGHTS,
} from './capitalManager';

export type {
    CapitalManagerState,
    ConfidenceInputs,
    PositionSizingResult,
    CapitalCheckResult,
    PoolFeeHistory,
} from './capitalManager';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE SCORE CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // Sample recording
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
    
    // Cycle management
    completeCycle,
    
    // Computation
    computeConfidenceInputs,
    computeConfidenceScore,
    checkUnlockConditions,
    
    // Logging
    logConfidenceBreakdown,
    
    // Utility
    getMetricsHistoryLength,
    resetConfidenceState,
    getConfidenceSummary,
} from './confidenceScore';

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL INTEGRATION (SCANLOOP BRIDGE)
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // Initialization
    initializeCapitalIntegration,
    isCapitalIntegrationInitialized,
    
    // Cycle updates
    updateCapitalManagerCycle,
    
    // Position sizing
    getAdaptivePositionSize,
    getMinPositionSizeUsd,
    getTargetPositionSizeUsd,
    
    // Position tracking
    recordPositionEntry,
    recordPositionExit,
    
    // Status accessors (renamed to avoid conflicts with capitalManager exports)
    getPerPoolMaxCapPct,
    getConfidenceScore,
    getFullCapitalState,
    logFullCapitalStatus,
    
    // Legacy adapter
    legacyCalculatePositionSize,
} from './capitalIntegration';

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTIVE SIZING MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export {
    getPositionMultiplier,
    createTradingState,
    isTradingBlocked,
    computePositionMultiplier,
    computeMultiplierValue,
    DEFAULT_CONFIG as ADAPTIVE_SIZING_DEFAULT_CONFIG,
    DEFAULT_WEIGHTS as ADAPTIVE_SIZING_DEFAULT_WEIGHTS,
} from './adaptive_sizing';

export type {
    TradingState,
    AdaptiveSizingResult,
    AdaptiveSizingConfig,
    AdaptiveSizingWeights,
} from './adaptive_sizing';

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY VALIDATION MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export {
    runEntryValidation,
    isEntryBlocked,
    getPositionSizing,
    getPositionMultiplierValue,
    areTradingConditionsFavorable,
    getValidationSummary,
    createEntryValidationState,
    validateEntry,
    shouldBlockEntry,
    DEFAULT_CONFIG as ENTRY_VALIDATION_DEFAULT_CONFIG,
    CONSERVATIVE_CONFIG as ENTRY_VALIDATION_CONSERVATIVE_CONFIG,
    AGGRESSIVE_CONFIG as ENTRY_VALIDATION_AGGRESSIVE_CONFIG,
    createConfig as createEntryValidationConfig,
} from './entry_validation';

export type {
    EntryValidationState,
    EntryValidationResult,
    CheckResult,
    PositionSizingResult as EntryPositionSizingResult,
    EntryValidationConfig,
} from './entry_validation';

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION QUALITY MODULE
// ═══════════════════════════════════════════════════════════════════════════════

export {
    getExecutionQuality,
    getExecutionQualityResult,
    isExecutionQualityBlocked,
    getExecutionQualityPositionMultiplier,
    recordExecutionEvent,
    recordSuccessfulExecution,
    recordFailedExecution,
    computeExecutionMetrics,
    getEventsInWindow,
    clearExecutionEvents,
    getEventCount,
    getRecentFailures,
    computeExecutionQuality as computeExecutionQualityFull,
    shouldBlockOnExecutionQuality,
    getExecutionQualityMultiplier,
    DEFAULT_CONFIG as EXECUTION_QUALITY_DEFAULT_CONFIG,
    DEFAULT_WEIGHTS as EXECUTION_QUALITY_DEFAULT_WEIGHTS,
    createConfig as createExecutionQualityConfig,
} from './execution_quality';

export type {
    ExecutionEvent,
    ExecutionMetrics,
    ExecutionQualityResult,
    ExecutionQualityConfig,
    ExecutionQualityWeights,
    TradingStateWithExecution,
} from './execution_quality';
