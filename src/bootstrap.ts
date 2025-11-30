/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BOOTSTRAP — THE SOLE ENTRYPOINT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This file is the SINGLE ENTRYPOINT for the DLMM bot.
 * 
 * RULES:
 * 1. This file MUST NOT be imported by any other module
 * 2. This file creates ExecutionEngine and PredatorController
 * 3. This file writes to globalThis.__DLMM_SINGLETON__
 * 4. This file starts the runtime loop
 * 5. All other modules use src/state/singleton.ts for readonly access
 * 
 * RUN WITH: node dist/bootstrap.js
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
// BOOTSTRAP FUNCTION — CREATES SINGLETONS ONCE
// ═══════════════════════════════════════════════════════════════════════════════

async function bootstrap(): Promise<BootstrapResult> {
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD: ALREADY INITIALIZED? → FATAL ERROR
    // ═══════════════════════════════════════════════════════════════════════════
    
    const existingStore = (globalThis as any).__DLMM_SINGLETON__;
    
    if (existingStore?.locked) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: BOOTSTRAP CALLED TWICE');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`   Existing Engine: ${existingStore.engineId}`);
        console.error(`   Existing Predator: ${existingStore.predatorId}`);
        console.error('   Bootstrap must only run ONCE. Check for duplicate imports.');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
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
    // STEP 3: Create ExecutionEngine
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] 🔧 Creating ExecutionEngine...');
    const engine = new ExecutionEngine({
        capital: PAPER_CAPITAL,
        rebalanceInterval: 15 * 60 * 1000,
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
    // STEP 4: Create PredatorController
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] 🦅 PredatorController ready');
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
    console.log('   Access via: import { getEngine } from "./state/singleton"');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
    
    return { engine, predator, engineId, predatorId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUNTIME LOOP — KEEPS THE BOT ALIVE AND RUNNING
// ═══════════════════════════════════════════════════════════════════════════════

async function startRuntime(engine: ExecutionEngine) {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🚀 [RUNTIME] STARTING DLMM BOT RUNTIME LOOP');
    console.log('═══════════════════════════════════════════════════════════════════');

    // main update loop - every 30 seconds
    setInterval(async () => {
        try {
            await engine.update();
        } catch (err) {
            console.error('[RUNTIME] Update cycle error:', err);
        }
    }, 30_000);

    // status check - every 15 minutes
    setInterval(async () => {
        try {
            await engine.printStatus();
        } catch (err) {
            console.error('[RUNTIME] Status check error:', err);
        }
    }, 900_000);

    // keep node alive
    process.stdin.resume();
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('✅ [RUNTIME] BOT IS RUNNING');
    console.log('   Update cycle: every 30 seconds');
    console.log('   Status check: every 15 minutes');
    console.log('═══════════════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRYPOINT — AUTO-RUNS WHEN THIS FILE IS EXECUTED
// ═══════════════════════════════════════════════════════════════════════════════

bootstrap()
    .then(({ engine }) => startRuntime(engine))
    .catch(err => {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 BOOTSTRAP FAILED');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(err);
        process.exit(1);
    });
