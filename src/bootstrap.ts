import dotenv from "dotenv";
dotenv.config();

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BOOTSTRAP — SINGLETON FACTORY ONLY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This file creates singletons. NO RUNTIME LOOPS in this file.
 * 
 * RULES:
 * 1. This file creates ExecutionEngine and initializes capital
 * 2. This file writes to globalThis.__DLMM_SINGLETON__
 * 3. Engine.start() is called to start internal loops (STATEFUL MODE)
 * 4. All other modules use src/state/singleton.ts for readonly access
 * 
 * DUPLICATE INSTANCE HANDLING:
 * - If singleton is already locked, returns { duplicateInstance: true }
 * - start.ts MUST check this flag and exit immediately
 * - This prevents corrupted state from PM2 race conditions
 * 
 * If you see "FIRST INITIALIZATION" more than ONCE, there's a bug.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { ExecutionEngine } from './engine/ExecutionEngine';
import { capitalManager } from './services/capitalManager';
import { loadActiveTradesFromDB } from './db/models/Trade';
import { initializeSwapStream } from './services/dlmmTelemetry';
import logger from './utils/logger';
import { logRpcEndpoint, getRpcSource, RPC_URL } from './config/rpc';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const PAPER_CAPITAL = parseFloat(process.env.PAPER_CAPITAL || '10000');
const RESET_PAPER_BALANCE = process.env.RESET_PAPER_BALANCE === 'true';

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP RESULT TYPE
// ═══════════════════════════════════════════════════════════════════════════════

interface BootstrapResult {
    engine: ExecutionEngine;
    predator: { initialized: boolean; id: string };
    engineId: string;
    predatorId: string;
    duplicateInstance: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP FUNCTION — CREATES SINGLETONS ONCE
// ═══════════════════════════════════════════════════════════════════════════════

export async function bootstrap(): Promise<BootstrapResult> {
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD: SINGLETON ALREADY LOCKED? → RETURN DUPLICATE FLAG
    // This is the CRITICAL check for preventing PM2 race conditions
    // ═══════════════════════════════════════════════════════════════════════════
    
    const existingStore = (globalThis as any).__DLMM_SINGLETON__;
    
    if (existingStore?.locked) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚫 [BOOTSTRAP] DUPLICATE INSTANCE DETECTED');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('   Singleton is already locked by another initialization.');
        console.error('   This instance must exit immediately.');
        console.error('════════════════════════════════════════════════════════════════');
        
        return {
            engine: existingStore.engine,
            predator: existingStore.predator,
            engineId: existingStore.engineId,
            predatorId: existingStore.predatorId,
            duplicateInstance: true,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD: ALREADY BOOTSTRAPPED FLAG SET? → RETURN DUPLICATE FLAG
    // ═══════════════════════════════════════════════════════════════════════════
    
    if ((global as any).__BOOTSTRAPPED__) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚫 [BOOTSTRAP] bootstrap() called twice');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('   __BOOTSTRAPPED__ flag is already set.');
        console.error('   This instance must exit immediately.');
        console.error('════════════════════════════════════════════════════════════════');
        
        const store = (globalThis as any).__DLMM_SINGLETON__;
        if (store) {
            return {
                engine: store.engine,
                predator: store.predator,
                engineId: store.engineId,
                predatorId: store.predatorId,
                duplicateInstance: true,
            };
        }
        
        // If no store exists but flag is set, something is very wrong
        console.error('🚨 FATAL: __BOOTSTRAPPED__ set but no singleton store found');
        process.exit(1);
    }
    
    // Set bootstrap flag IMMEDIATELY to prevent any race conditions
    (global as any).__BOOTSTRAPPED__ = true;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FIRST INITIALIZATION — THIS SHOULD ONLY HAPPEN ONCE EVER
    // ═══════════════════════════════════════════════════════════════════════════
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🏭 [BOOTSTRAP] FIRST INITIALIZATION');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`   PID: ${process.pid}`);
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log('   If you see this message more than ONCE, there is a bug.');
    console.log('═══════════════════════════════════════════════════════════════════');
    
    // Generate unique IDs for tracking
    const engineId = `engine_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const predatorId = `predator_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Initialize Capital Manager
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 1: Initializing capital manager...');
    const capitalReady = await capitalManager.initialize(PAPER_CAPITAL);
    
    if (!capitalReady) {
        console.error('🚨 FATAL: Capital manager initialization failed');
        process.exit(1);
    }
    logger.info('[BOOTSTRAP] ✅ Capital manager ready');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Handle paper trading reset (if requested)
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (PAPER_TRADING && RESET_PAPER_BALANCE) {
        logger.info('[BOOTSTRAP] Step 2: Resetting paper balance...');
        const resetResult = await capitalManager.resetCapital(PAPER_CAPITAL);
        if (resetResult.success) {
            logger.info(`[BOOTSTRAP] ✅ Paper balance reset to $${resetResult.newBalance.toFixed(2)}`);
        }
    } else {
        logger.info('[BOOTSTRAP] Step 2: Paper balance reset not requested');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Create ExecutionEngine
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 3: Creating ExecutionEngine...');
    const engine = new ExecutionEngine({
        capital: PAPER_CAPITAL,
        takeProfit: 0.04,
        stopLoss: -0.02,
        maxConcurrentPools: 3,
        allocationStrategy: 'equal',
    });
    
    // Initialize engine (recovers positions from DB)
    const engineReady = await engine.initialize();
    if (!engineReady) {
        console.error('🚨 FATAL: ExecutionEngine initialization failed');
        process.exit(1);
    }
    logger.info(`[BOOTSTRAP] ✅ ExecutionEngine created: ${engineId}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Start Engine Internal Loops (STATEFUL MODE)
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 4: Starting engine internal loops...');
    engine.start();
    
    // Verify engine is actually stateful
    if (!engine.isStateful) {
        console.error('🚨 FATAL: Engine failed to enter STATEFUL mode');
        console.error('   engine.start() was called but isStateful is still false');
        process.exit(1);
    }
    logger.info('[BOOTSTRAP] ✅ Engine is STATEFUL (internal loops active)');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: PredatorController (ADVISORY ONLY — NO EXECUTION)
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 5: Initializing PredatorController...');
    const predator = { initialized: true, id: predatorId };
    logger.info('[BOOTSTRAP] ✅ PredatorController ready (ADVISORY MODE)');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: Initialize SDK telemetry
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 6: Initializing telemetry...');
    initializeSwapStream();
    logger.info('[BOOTSTRAP] ✅ Telemetry initialized');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6.5: Log RPC Configuration
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 6.5: Verifying RPC configuration...');
    logRpcEndpoint();
    logger.info(`[BOOTSTRAP] ✅ RPC source: ${getRpcSource()}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 7: LOCK THE SINGLETON — NO MORE WRITES ALLOWED
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 7: Locking singleton...');
    
    (globalThis as any).__DLMM_SINGLETON__ = Object.freeze({
        engine,
        predator,
        engineId,
        predatorId,
        initializedAt: Date.now(),
        pid: process.pid,
        locked: true,
    });
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 [BOOTSTRAP] SINGLETON LOCKED — READONLY ACCESS ONLY');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`   PID: ${process.pid}`);
    console.log(`   Engine ID: ${engineId}`);
    console.log(`   Predator ID: ${predatorId}`);
    console.log(`   Mode: ${PAPER_TRADING ? 'PAPER TRADING' : '⚠️ LIVE TRADING'}`);
    console.log('   Engine Mode: STATEFUL');
    console.log('   Internal Loops: 7 active');
    console.log('     - Price watcher (5s)');
    console.log('     - Exit watcher (10s)');
    console.log('     - Snapshot timer (60s)');
    console.log('     - PnL drift updater (15s)');
    console.log('     - Regime updater (30s)');
    console.log('     - Bin tracker (5s)');
    console.log('     - PnL auditor (5m)');
    console.log(`   RPC: ${getRpcSource()}`);
    console.log('   Access via: import { getEngine } from "./state/singleton"');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
    
    return { 
        engine, 
        predator, 
        engineId, 
        predatorId,
        duplicateInstance: false,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTE: ExecutionEngine is STATEFUL
// 
// The ExecutionEngine runs internal loops for:
// - Price watching (5s)
// - Exit evaluation (10s)
// - Snapshot writing (60s)
// - PnL drift updates (15s)
// - Regime updates (30s)
// - Bin tracking (5s)
// 
// ScanLoop runs every 120s and coordinates with the engine.
// ═══════════════════════════════════════════════════════════════════════════════
