import 'dotenv/config';


import * as fs from 'fs';
import * as path from 'path';
import { ExecutionEngine } from './engine/ExecutionEngine';
import { ScanLoop } from './runtime/scanLoop';
import { cleanup as cleanupTelemetry } from './services/dlmmTelemetry';
import { clearPredatorState } from './engine/predatorController';
import logger from './utils/logger';
import { closeRunEpoch } from './services/runEpoch';

// ═══════════════════════════════════════════════════════════════════════════════
// LOCKFILE PATH (prevents multiple PM2 instances)
// ═══════════════════════════════════════════════════════════════════════════════
const LOCKFILE_PATH = path.join(process.cwd(), '.dlmm-bot.lock');

// ═══════════════════════════════════════════════════════════════════════════════
// RUNTIME STATE
// ═══════════════════════════════════════════════════════════════════════════════

let scanLoop: ScanLoop | null = null;
let engine: ExecutionEngine | null = null;
let isShuttingDown = false;

// ═══════════════════════════════════════════════════════════════════════════════
// LOCKFILE MANAGEMENT (Cross-process singleton enforcement)
// ═══════════════════════════════════════════════════════════════════════════════

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function acquireProcessLock(): boolean {
    try {
        // Check if lockfile exists
        if (fs.existsSync(LOCKFILE_PATH)) {
            const existingPid = parseInt(fs.readFileSync(LOCKFILE_PATH, 'utf8').trim(), 10);
            
            // Check if the process with that PID is still running
            if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
                // Another instance is running
                return false;
            }
            
            // Stale lockfile - remove it
            console.log(`[STARTUP] Removing stale lockfile (PID ${existingPid} not running)`);
            fs.unlinkSync(LOCKFILE_PATH);
        }
        
        // Create lockfile with our PID
        fs.writeFileSync(LOCKFILE_PATH, process.pid.toString(), 'utf8');
        return true;
        
    } catch (err: any) {
        console.error(`[STARTUP] Failed to acquire process lock: ${err.message}`);
        return false;
    }
}

function releaseProcessLock(): void {
    try {
        if (fs.existsSync(LOCKFILE_PATH)) {
            const storedPid = parseInt(fs.readFileSync(LOCKFILE_PATH, 'utf8').trim(), 10);
            // Only remove if it's our lock
            if (storedPid === process.pid) {
                fs.unlinkSync(LOCKFILE_PATH);
            }
        }
    } catch {
        // Ignore errors during cleanup
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Graceful shutdown sequence
 * 1. Stop scan loop (waits for current cycle)
 * 2. Persist active trades (already saved per-trade)
 * 3. Flush telemetry state
 * 4. Flush predator state
 * 5. Release process lock
 * 6. Exit cleanly
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
        
        // Step 2: Stop engine internal loops
        if (engine) {
            console.log('[SHUTDOWN] Step 2: Stopping engine internal loops...');
            engine.stop();
            console.log('[SHUTDOWN] ✅ Engine stopped');
        }
        
        // Step 3: Persist active trades (trades are already persisted per-entry)
        console.log('[SHUTDOWN] Step 3: Active trades already persisted to database');
        
        // Step 4: Flush telemetry state
        console.log('[SHUTDOWN] Step 4: Flushing telemetry state...');
        cleanupTelemetry();
        console.log('[SHUTDOWN] ✅ Telemetry flushed');
        
        // Step 5: Flush predator state
        console.log('[SHUTDOWN] Step 5: Flushing predator state...');
        clearPredatorState();
        console.log('[SHUTDOWN] ✅ Predator state flushed');
        
        // Step 5.5: Close run epoch (accounting correctness)
        console.log('[SHUTDOWN] Step 5.5: Closing run epoch...');
        await closeRunEpoch();
        console.log('[SHUTDOWN] ✅ Run epoch closed');
        
        // Step 6: Cleanup scan loop resources
        if (scanLoop) {
            console.log('[SHUTDOWN] Step 6: Cleaning up scan loop resources...');
            await scanLoop.cleanup();
            console.log('[SHUTDOWN] ✅ Scan loop cleanup complete');
        }
        
        // Step 7: Flush logs (give logger time to write)
        console.log('[SHUTDOWN] Step 7: Flushing logs...');
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log('[SHUTDOWN] ✅ Logs flushed');
        
        // Step 8: Release process lock
        console.log('[SHUTDOWN] Step 8: Releasing process lock...');
        releaseProcessLock();
        console.log('[SHUTDOWN] ✅ Process lock released');
        
        console.log('');
        console.log('════════════════════════════════════════════════════════════════');
        console.log('✅ [SHUTDOWN] Graceful shutdown complete');
        console.log('════════════════════════════════════════════════════════════════');
        
        process.exit(0);
        
    } catch (error: any) {
        console.error(`[SHUTDOWN] ❌ Error during shutdown: ${error.message}`);
        releaseProcessLock();
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
            releaseProcessLock();
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
    
    // Cleanup on any exit
    process.on('exit', () => {
        releaseProcessLock();
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
    console.log(`   PID: ${process.pid}`);
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log('════════════════════════════════════════════════════════════════');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 0: Acquire process lock (prevents PM2 duplicate instances)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('[STARTUP] Step 0: Checking for existing instance...');
    
    if (!acquireProcessLock()) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚫 A second dlmm-bot instance was prevented from starting.');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('   Another instance is already running.');
        console.error('   Kill the existing process or remove .dlmm-bot.lock manually.');
        console.error('════════════════════════════════════════════════════════════════');
        process.exit(0);
    }
    console.log('[STARTUP] ✅ Process lock acquired');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Attach process handlers FIRST (before any async operations)
    // ═══════════════════════════════════════════════════════════════════════════
    attachProcessHandlers();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Bootstrap singletons
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('[STARTUP] Step 2: Bootstrapping singletons...');
    const { bootstrap } = require('./bootstrap');
    const bootstrapResult = await bootstrap();
    
    // Check if this is a duplicate instance detection
    if (bootstrapResult.duplicateInstance) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚫 A second dlmm-bot instance was prevented from starting.');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('   Bootstrap detected an already-locked singleton.');
        console.error('   This instance will now exit.');
        console.error('════════════════════════════════════════════════════════════════');
        releaseProcessLock();
        process.exit(0);
    }
    
    engine = bootstrapResult.engine;
    const engineId = bootstrapResult.engineId;
    console.log(`[STARTUP] ✅ Singletons created and locked (Engine: ${engineId})`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Verify engine is STATEFUL (internal loops running)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('[STARTUP] Step 3: Verifying engine mode...');
    
    if (!engine || !engine.isStateful) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚫 FATAL: Engine is not in STATEFUL mode.');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('   Engine internal loops are not running.');
        console.error('   This is a critical error - the bot cannot operate correctly.');
        console.error('════════════════════════════════════════════════════════════════');
        releaseProcessLock();
        process.exit(1);
    }
    
    console.log('[STARTUP] ✅ Engine is STATEFUL (internal loops active)');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Start ScanLoop (only after engine is confirmed stateful)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('[STARTUP] Step 4: Starting ScanLoop...');
    const { main } = require('./index');
    scanLoop = await main(engine, engineId);
    
    if (!scanLoop) {
        console.error('[STARTUP] ❌ ScanLoop failed to start');
        releaseProcessLock();
        process.exit(1);
    }
    
    console.log('[STARTUP] ✅ ScanLoop started');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: Block process forever (prevents PM2 from restarting)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('🟢 BOT RUNTIME ACTIVE');
    console.log('════════════════════════════════════════════════════════════════');
    console.log(`   PID: ${process.pid}`);
    console.log(`   Engine ID: ${engineId}`);
    console.log(`   Engine Mode: STATEFUL`);
    console.log('   Internal Loops: 7 active');
    console.log('   ScanLoop: Active (120s interval)');
    console.log('   Telemetry: Active');
    console.log('   PnL Auditor: Active (5m interval)');
    console.log('   Press Ctrl+C for graceful shutdown');
    console.log('════════════════════════════════════════════════════════════════');
    
    // Block forever with a very long interval
    setInterval(() => {}, 1 << 30);
})();
