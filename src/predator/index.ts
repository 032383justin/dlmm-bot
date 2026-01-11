/**
 * Predator Module — Advanced Exit & Capital Management
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONTINUOUS BIN PURSUIT — Dominant Liquidity Engine
 * 
 * This is no longer:
 *   - an LP bot
 *   - a yield strategy
 *   - a passive system
 * 
 * This is microstructure exploitation at scale.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Amortization Decay
export {
    computeAmortizationGate,
    formatAmortizationGateLog,
    logAmortDecayOverride,
    AMORT_DECAY_CONFIG,
    AmortDecayConfig,
    type AmortizationGateInput,
    type AmortizationGateResult,
    type AmortizationGateDebug,
} from './amortization_decay';

// Bin Dominance — Position Mode & Dominance Tracking
export {
    PositionMode,
    BIN_DOMINANCE_CONFIG,
    computeBinDominance,
    selectTargetBin,
    evaluateModeSwitch,
    evaluateBullyRebalance,
    getBullySizeMultiplier,
    initializePositionMode,
    switchPositionMode,
    getPositionMode,
    getPositionModeState,
    clearPositionModeState,
    getBullyModePositions,
    getPoolDominanceMetrics,
    logPredatorModeSummary,
    // CBP Integration
    BULLY_IGNORED_GATES,
    shouldBypassGateForPosition,
    evaluateDualProfitPath,
    evaluateForcedBinMigration,
    getBullyBinCount,
    type FlowAlignment,
    type BinDominanceMetrics,
    type TargetBinSelection,
    type PositionModeState,
    type ModeSwitchDecision,
    type BullyRebalanceDecision,
    type DualProfitPathResult,
    type ForcedMigrationResult,
} from './binDominance';

// Continuous Bin Pursuit — CBP Engine
export {
    CBP_CONFIG,
    computeBinPressureScore,
    evaluateBinPressure,
    evaluateForcedMigration,
    evaluateDualProfitPath as evaluateCBPDualProfitPath,
    evaluateCapitalEscalation,
    getBullyBinCount as getCBPBinCount,
    shouldBypassGate,
    getBypassedGates,
    getBinPressureState,
    getEscalationMultiplier,
    clearBinPressureState,
    clearEscalationMultiplier,
    clearAllCBPState,
    logCBPSummary,
    type BinPressureScore,
    type BinPressureState,
    type MigrationDecision,
    type HoldDecision,
    type EscalationDecision,
} from './continuousBinPursuit';
