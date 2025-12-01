/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BOOTSTRAP — SINGLETON FACTORY ONLY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This file creates singletons. NO RUNTIME LOOPS.
 * 
 * RULES:
 * 1. This file creates ExecutionEngine and initializes capital
 * 2. This file writes to globalThis.__DLMM_SINGLETON__
 * 3. NO timers, NO intervals, NO runtime loops
 * 4. All other modules use src/state/singleton.ts for readonly access
 * 
 * ScanLoop.start() is the ONLY runtime driver.
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP FUNCTION — CREATES SINGLETONS ONCE (NO RUNTIME LOOPS)
// ═══════════════════════════════════════════════════════════════════════════════

export async function bootstrap(): Promise<BootstrapResult> {
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD: ALREADY BOOTSTRAPPED? → SKIP SILENTLY
    // ═══════════════════════════════════════════════════════════════════════════
    
    if ((global as any).__BOOTSTRAPPED__) {
        console.log("⚠️ bootstrap() called twice — skipping re-initialization");
        const store = (globalThis as any).__DLMM_SINGLETON__;
        return {
            engine: store.engine,
            predator: store.predator,
            engineId: store.engineId,
            predatorId: store.predatorId,
        };
    }
    (global as any).__BOOTSTRAPPED__ = true;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD: SINGLETON ALREADY LOCKED? → RETURN EXISTING
    // ═══════════════════════════════════════════════════════════════════════════
    
    const existingStore = (globalThis as any).__DLMM_SINGLETON__;
    
    if (existingStore?.locked) {
        console.log("⚠️ Singleton already locked — returning existing");
        return {
            engine: existingStore.engine,
            predator: existingStore.predator,
            engineId: existingStore.engineId,
            predatorId: existingStore.predatorId,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FIRST INITIALIZATION — THIS SHOULD ONLY HAPPEN ONCE EVER
    // ═══════════════════════════════════════════════════════════════════════════
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🏭 [BOOTSTRAP] FIRST INITIALIZATION');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('   If you see this message more than ONCE, there is a bug.');
    console.log('═══════════════════════════════════════════════════════════════════');
    
    // Generate unique IDs for tracking
    const engineId = `engine_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const predatorId = `predator_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Initialize Capital Manager
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] 💰 Initializing capital manager...');
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
        logger.info('[BOOTSTRAP] 🔄 Resetting paper balance...');
        const resetResult = await capitalManager.resetCapital(PAPER_CAPITAL);
        if (resetResult.success) {
            logger.info(`[BOOTSTRAP] ✅ Paper balance reset to $${resetResult.newBalance.toFixed(2)}`);
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Create ExecutionEngine (STATELESS — NO RUNTIME LOOPS)
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] 🔧 Creating ExecutionEngine (STATELESS MODE)...');
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
    // STEP 4: PredatorController (ADVISORY ONLY — NO EXECUTION)
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] 🦅 PredatorController ready (ADVISORY MODE)');
    const predator = { initialized: true, id: predatorId };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: Initialize SDK telemetry
    // ═══════════════════════════════════════════════════════════════════════════
    
    initializeSwapStream();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: LOCK THE SINGLETON — NO MORE WRITES ALLOWED
    // ═══════════════════════════════════════════════════════════════════════════
    
    (globalThis as any).__DLMM_SINGLETON__ = Object.freeze({
        engine,
        predator,
        engineId,
        predatorId,
        initializedAt: Date.now(),
        locked: true,
    });
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 [BOOTSTRAP] SINGLETON LOCKED — READONLY ACCESS ONLY');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`   Engine ID: ${engineId}`);
    console.log(`   Predator ID: ${predatorId}`);
    console.log(`   Mode: ${PAPER_TRADING ? 'PAPER TRADING' : '⚠️ LIVE TRADING'}`);
    console.log('   Engine Mode: STATELESS (no timers, no intervals)');
    console.log('   Runtime Driver: ScanLoop.start() ONLY');
    console.log('   Access via: import { getEngine } from "./state/singleton"');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
    
    return { engine, predator, engineId, predatorId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTE: startRuntime() HAS BEEN REMOVED
// 
// The ExecutionEngine is now a STATELESS EXECUTOR.
// ScanLoop.start() is the SOLE runtime driver.
// 
// NO TIMERS. NO INTERVALS. NO BACKGROUND LOOPS IN ENGINE.
// ═══════════════════════════════════════════════════════════════════════════════
