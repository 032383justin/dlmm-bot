/**
 * Predator Module — Advanced Exit & Capital Management
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXPORTS
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

