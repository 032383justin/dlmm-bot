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
 * 4. All other modules RECEIVE references via getEngine()/getPredator()
 * 5. NO other module may call any initialize() function
 * 
 * FLOW:
 *   bootstrap() → creates singletons → stores on globalThis → starts scan loop
 *   
 * If "FIRST INITIALIZATION" appears more than ONCE, there's a bug.
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

export interface BootstrapResult {
    engine: ExecutionEngine;
    predator: { initialized: boolean };
    engineId: string;
    predatorId: string;
    alreadyInitialized: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP FUNCTION — CALLED EXACTLY ONCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bootstrap the application.
 * 
 * If already initialized → returns existing singletons immediately.
 * If first time → creates everything and locks.
 * 
 * MUST complete BEFORE any scan cycle runs.
 */
export async function bootstrap(): Promise<BootstrapResult> {
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GUARD: ALREADY LOCKED? → RETURN IMMEDIATELY
    // ═══════════════════════════════════════════════════════════════════════════
    
    const existingStore = (globalThis as any).__DLMM_SINGLETON__;
    
    if (existingStore?.locked) {
        // Already initialized — just return existing references
        console.log(`[BOOTSTRAP] ♻️  Using existing singletons (Engine: ${existingStore.engineId})`);
        
        return {
            engine: existingStore.engine,
            predator: existingStore.predator,
            engineId: existingStore.engineId,
            predatorId: existingStore.predatorId,
            alreadyInitialized: true,
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
    // STEP 1: Initialize Capital Manager (ONLY PLACE THIS HAPPENS)
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
    // STEP 3: Create ExecutionEngine (ONLY PLACE THIS HAPPENS)
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
    // STEP 4: Create PredatorController marker (ONLY PLACE THIS HAPPENS)
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] 🦅 PredatorController ready');
    const predator = { initialized: true, id: predatorId };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: Initialize SDK telemetry
    // ═══════════════════════════════════════════════════════════════════════════
    
    initializeSwapStream();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: LOCK THE REGISTRY — NO MORE INITIALIZATION ALLOWED
    // ═══════════════════════════════════════════════════════════════════════════
    
    (globalThis as any).__DLMM_SINGLETON__ = {
        engine,
        predator,
        engineId,
        predatorId,
        initializedAt: Date.now(),
        locked: true,  // <-- THIS PREVENTS ANY FUTURE INITIALIZATION
    };
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 [BOOTSTRAP] LOCKED — NO REINITIALIZATION POSSIBLE');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`   Engine ID: ${engineId}`);
    console.log(`   Predator ID: ${predatorId}`);
    console.log(`   Mode: ${PAPER_TRADING ? 'PAPER TRADING' : '⚠️ LIVE TRADING'}`);
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
    
    return {
        engine,
        predator,
        engineId,
        predatorId,
        alreadyInitialized: false,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate that bootstrap has completed.
 * CRASHES if not initialized — that's a bug in the startup flow.
 */
export function validateBootstrap(): void {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    
    if (!store?.locked) {
        console.error('🚨 FATAL: validateBootstrap() called but bootstrap not complete');
        process.exit(1);
    }
}

/**
 * Check if already bootstrapped (for guards).
 */
export function isBootstrapped(): boolean {
    return (globalThis as any).__DLMM_SINGLETON__?.locked === true;
}

/**
 * FATAL ERROR if called from anywhere except bootstrap.
 * Add this to any module that should NOT do initialization.
 */
export function throwIfNotBootstrap(caller: string): void {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    
    if (store?.locked) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: ILLEGAL INITIALIZATION AFTER BOOTSTRAP');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`   Caller: ${caller}`);
        console.error('   Bootstrap already completed. No module may reinitialize.');
        console.error('   Use getEngine() / getPredator() to access singletons.');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
}

/**
 * Get engine ID for logging.
 */
export function getBootstrapEngineId(): string {
    return (globalThis as any).__DLMM_SINGLETON__?.engineId ?? 'NOT_INITIALIZED';
}

/**
 * Get predator ID for logging.
 */
export function getBootstrapPredatorId(): string {
    return (globalThis as any).__DLMM_SINGLETON__?.predatorId ?? 'NOT_INITIALIZED';
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
}

bootstrap()
    .then(({ engine }) => startRuntime(engine))
    .catch(err => {
        console.error('🚨 BOOTSTRAP FAILED:', err);
        process.exit(1);
    });
