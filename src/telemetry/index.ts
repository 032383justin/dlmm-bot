/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TELEMETRY MODULE — EXECUTION-GRADE RPC HEALTH & GATING
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module exports the public API for execution telemetry.
 * 
 * USAGE:
 * 
 * 1. Strategy modules (read-only):
 *    import { getRpcHealthScore, getConfirmationStats, shouldAllowExecution } from '../telemetry';
 * 
 * 2. RPC instrumentation:
 *    import { getInstrumentedConnection, instrumentExternalCall } from '../telemetry';
 * 
 * 3. Startup/cycle logging:
 *    import { logStartupStatus, logTelemetrySummary } from '../telemetry';
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION TELEMETRY EXPORTS (READ-ONLY FOR STRATEGY)
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // Core APIs for strategy modules
    getRpcHealthScore,
    getConfirmationStats,
    shouldAllowExecution,
    getGatingDecision,
    
    // Telemetry logging
    logTelemetrySummary,
    logStartupStatus,
    
    // Utilities
    getHealthStatus,
    getRawRpcMetrics,
    clearTelemetryData,
    
    // Recording APIs (for instrumentation only)
    recordRpcCall,
    recordConfirmation,
    
    // Types
    type ConfirmationStats,
    type ExecutionKind,
    type GatingDecision,
    
    // Configuration (read-only)
    EXECUTION_TELEMETRY_CONFIG,
} from './executionTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// RPC INSTRUMENTATION EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    // Instrumented connection
    getInstrumentedConnection,
    wrapConnectionWithInstrumentation,
    resetInstrumentedConnection,
    
    // Manual instrumentation for SDK/external calls
    recordExternalRpcCall,
    instrumentExternalCall,
} from './rpcInstrument';

