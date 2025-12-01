/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * START.TS — THE SOLE ENTRYPOINT & RUNTIME CONTROLLER
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Run with: node dist/start.js
 * 
 * FLOW:
 * 1. bootstrap() → creates singletons and locks them (NO runtime loops)
 * 2. main(engine) → starts ScanLoop (THE ONLY runtime loop)
 * 3. Attach signal handlers for graceful shutdown
 * 4. Block process forever
 * 
 * ARCHITECTURAL RULE:
 * - ScanLoop.start() is the ONLY runtime driver
 * - ExecutionEngine is a STATELESS executor invoked by ScanLoop
 * - NO timers, intervals, or background loops in Engine
 * 
 * RESPONSIBILITIES:
 * - All process handlers (SIGINT, SIGTERM, uncaughtException, unhandledRejection)
 * - Graceful shutdown sequence
 * - Lifecycle management of ScanLoop
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { ExecutionEngine } from './engine/ExecutionEngine';
import { ScanLoop } from './runtime/scanLoop';
import { cleanup as cleanupTelemetry } from './services/dlmmTelemetry';
import { clearPredatorState } from './engine/predatorController';
import logger from './utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// RUNTIME STATE
// ═══════════════════════════════════════════════════════════════════════════════

let scanLoop: ScanLoop | null = null;
let engine: ExecutionEngine | null = null;
let isShuttingDown = false;

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Graceful shutdown sequence
 * 1. Stop scan loop (waits for current cycle)
 * 2. Persist active trades (already saved per-trade)
 * 3. Flush telemetry state
 * 4. Flush predator state
 * 5. Exit cleanly
 */
async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
        console.log(`[SHUTDOWN] Already shutting down, ignoring ${signal}`);
        return;
    }
    
    isShuttingDown = true;
    
    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log(`🛑 [SHUTDOWN] Received ${signal} — initiating graceful shutdown...`);
    console.log('════════════════════════════════════════════════════════════════');
    
    try {
        // Step 1: Stop scan loop
        if (scanLoop) {
            console.log('[SHUTDOWN] Step 1: Stopping scan loop...');
            await scanLoop.stop();
            console.log('[SHUTDOWN] ✅ Scan loop stopped');
        }
        
        // Step 2: Persist active trades (trades are already persisted per-entry)
        console.log('[SHUTDOWN] Step 2: Active trades already persisted to database');
        
        // Step 3: Flush telemetry state
        console.log('[SHUTDOWN] Step 3: Flushing telemetry state...');
        cleanupTelemetry();
        console.log('[SHUTDOWN] ✅ Telemetry flushed');
        
        // Step 4: Flush predator state
        console.log('[SHUTDOWN] Step 4: Flushing predator state...');
        clearPredatorState();
        console.log('[SHUTDOWN] ✅ Predator state flushed');
        
        // Step 5: Cleanup scan loop resources
        if (scanLoop) {
            console.log('[SHUTDOWN] Step 5: Cleaning up scan loop resources...');
            await scanLoop.cleanup();
            console.log('[SHUTDOWN] ✅ Scan loop cleanup complete');
        }
        
        // Step 6: Flush logs (give logger time to write)
        console.log('[SHUTDOWN] Step 6: Flushing logs...');
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log('[SHUTDOWN] ✅ Logs flushed');
        
        console.log('');
        console.log('════════════════════════════════════════════════════════════════');
        console.log('✅ [SHUTDOWN] Graceful shutdown complete');
        console.log('════════════════════════════════════════════════════════════════');
        
        process.exit(0);
        
    } catch (error: any) {
        console.error(`[SHUTDOWN] ❌ Error during shutdown: ${error.message}`);
        process.exit(1);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

function attachProcessHandlers(): void {
    // Graceful termination signals
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    
    // Uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error(`🚨 [FATAL] Uncaught Exception: ${error.message}`);
        console.error('════════════════════════════════════════════════════════════════');
        console.error(error.stack);
        
        // Attempt graceful shutdown
        gracefulShutdown('uncaughtException').catch(() => {
            process.exit(1);
        });
    });
    
    // Unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error(`🚨 [FATAL] Unhandled Rejection`);
        console.error('════════════════════════════════════════════════════════════════');
        console.error(`   Promise: ${promise}`);
        console.error(`   Reason: ${reason}`);
        
        // Log but don't exit - allow the process to continue
        logger.error(`Unhandled rejection: ${reason}`);
    });
    
    console.log('[STARTUP] ✅ Process handlers attached');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRYPOINT
// ═══════════════════════════════════════════════════════════════════════════════

(async () => {
    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('🔧 DLMM BOT — STARTING');
    console.log('════════════════════════════════════════════════════════════════');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 0: Attach process handlers FIRST (before any async operations)
    // ═══════════════════════════════════════════════════════════════════════════
    attachProcessHandlers();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Bootstrap singletons (NO RUNTIME LOOPS)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('📦 Step 1: Bootstrapping singletons...');
    const { bootstrap } = require('./bootstrap');
    const bootstrapResult = await bootstrap();
    engine = bootstrapResult.engine;
    const engineId = bootstrapResult.engineId;
    console.log(`✅ Singletons created and locked (Engine: ${engineId})`);
    console.log('   Engine Mode: STATELESS (no timers, no intervals)');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // NOTE: startRuntime() HAS BEEN REMOVED
    // ExecutionEngine is now a STATELESS executor.
    // ScanLoop.start() is the SOLE runtime driver.
    // ═══════════════════════════════════════════════════════════════════════════
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Start ScanLoop (THE ONLY RUNTIME LOOP)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('🚀 Step 2: Starting scan loop (SOLE RUNTIME DRIVER)...');
    const { main } = require('./index');
    scanLoop = await main(engine, engineId);
    console.log('✅ Scan loop started');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Block process forever (prevents PM2 from restarting)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('🟢 BOT RUNTIME ACTIVE — BLOCKING MAIN THREAD');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('   Runtime Driver: ScanLoop (recursive async loop)');
    console.log('   Engine Mode: STATELESS (invoked by ScanLoop only)');
    console.log('   Press Ctrl+C for graceful shutdown');
    console.log('════════════════════════════════════════════════════════════════');
    
    // Block forever with a very long interval
    setInterval(() => {}, 1 << 30);
})();
