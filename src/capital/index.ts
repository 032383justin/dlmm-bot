/**
 * Capital Management Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unified exports for capital and entry gating functionality.
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

