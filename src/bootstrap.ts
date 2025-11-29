/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BOOTSTRAP — THE ONLY FILE THAT CREATES SINGLETONS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This file is the SINGLE SOURCE OF TRUTH for initialization.
 * 
 * RULES:
 * 1. Only THIS file creates ExecutionEngine
 * 2. Only THIS file creates PredatorController
 * 3. Only THIS file writes to globalThis.__DLMM_SINGLETON__
 * 4. All other modules RECEIVE references, never create them
 * 
 * If any other file tries to create these → it's a bug.
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
// BOOTSTRAP FUNCTION — CALLED EXACTLY ONCE
// ═══════════════════════════════════════════════════════════════════════════════

export interface BootstrapResult {
    engine: ExecutionEngine;
    predator: { initialized: boolean };
    engineId: string;
    predatorId: string;
}

/**
 * Bootstrap the application.
 * Creates all singletons and stores them on globalThis.
 * 
 * MUST be called ONCE at application start.
 * MUST complete BEFORE any scan cycle runs.
 */
export async function bootstrap(): Promise<BootstrapResult> {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK: Already initialized?
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (store?.engine && store?.predator) {
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════════');
        console.log('♻️  [BOOTSTRAP] SINGLETONS ALREADY EXIST — REUSING');
        console.log('═══════════════════════════════════════════════════════════════════');
        console.log(`   Engine: ${store.engineId}`);
        console.log(`   Predator: ${store.predatorId}`);
        console.log(`   Age: ${Math.floor((Date.now() - store.initializedAt) / 1000)}s`);
        console.log('═══════════════════════════════════════════════════════════════════');
        
        return {
            engine: store.engine,
            predator: store.predator,
            engineId: store.engineId,
            predatorId: store.predatorId,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FIRST INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🏭 [BOOTSTRAP] FIRST INITIALIZATION');
    console.log('═══════════════════════════════════════════════════════════════════');
    
    // Generate unique IDs
    const engineId = `engine_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const predatorId = `predator_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Initialize Capital Manager
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] 💰 Initializing capital manager...');
    const capitalReady = await capitalManager.initialize(PAPER_CAPITAL);
    
    if (!capitalReady) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: Capital manager initialization failed');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Handle paper trading reset
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
    
    // Initialize engine async components (DB recovery)
    const engineReady = await engine.initialize();
    if (!engineReady) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: ExecutionEngine initialization failed');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    
    logger.info(`[BOOTSTRAP] ✅ ExecutionEngine created: ${engineId}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Create PredatorController
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] 🦅 Creating PredatorController...');
    const predator = { initialized: true };
    
    // Log predator modules (no actual init needed - they're stateless)
    logger.info('   ✓ Microstructure Health Index (MHI)');
    logger.info('   ✓ Non-Equilibrium Reinjection Engine');
    logger.info('   ✓ Cross-Pool Reflexivity Scoring');
    logger.info('   ✓ Adaptive Snapshot Frequency');
    logger.info('   ✓ Dynamic Stop Harmonics');
    
    logger.info(`[BOOTSTRAP] ✅ PredatorController created: ${predatorId}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: Initialize telemetry
    // ═══════════════════════════════════════════════════════════════════════════
    
    initializeSwapStream();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: Load active trades
    // ═══════════════════════════════════════════════════════════════════════════
    
    const activeTrades = await loadActiveTradesFromDB();
    logger.info(`[BOOTSTRAP] ✅ Recovered ${activeTrades.length} active trades from database`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 7: Store on globalThis and LOCK
    // ═══════════════════════════════════════════════════════════════════════════
    
    (globalThis as any).__DLMM_SINGLETON__ = {
        engine,
        predator,
        engineId,
        predatorId,
        initializedAt: Date.now(),
        locked: true,
    };
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 [BOOTSTRAP] SINGLETONS CREATED AND LOCKED');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`   Engine: ${engineId}`);
    console.log(`   Predator: ${predatorId}`);
    console.log(`   Stored on: globalThis.__DLMM_SINGLETON__`);
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
    
    if (PAPER_TRADING) {
        logger.info('[BOOTSTRAP] 🎮 PAPER TRADING MODE');
    } else {
        logger.info('[BOOTSTRAP] ⚠️  LIVE TRADING MODE - Real money at risk!');
    }
    
    return {
        engine,
        predator,
        engineId,
        predatorId,
    };
}

/**
 * Validate that bootstrap has completed.
 * Call this at the start of scan cycles.
 */
export function validateBootstrap(): void {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    
    if (!store || !store.engine || !store.predator || !store.locked) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: Bootstrap not complete');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('   validateBootstrap() was called but singletons are not ready.');
        console.error('   Ensure bootstrap() completes before starting scan loops.');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
}

/**
 * Guard against illegal initialization attempts.
 * Call this in any module that should NOT create singletons.
 */
export function guardAgainstInit(caller: string): void {
    console.error('');
    console.error('═══════════════════════════════════════════════════════════════════');
    console.error('🚨 FATAL: ILLEGAL INITIALIZATION ATTEMPT');
    console.error('═══════════════════════════════════════════════════════════════════');
    console.error(`   Caller: ${caller}`);
    console.error('   Only bootstrap.ts may create singletons.');
    console.error('   This module should receive references via DI.');
    console.error('═══════════════════════════════════════════════════════════════════');
    process.exit(1);
}

