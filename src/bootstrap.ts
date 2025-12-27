import dotenv from "dotenv";
dotenv.config();

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BOOTSTRAP — SINGLETON FACTORY + ACCOUNTING CORRECTNESS
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
 * ACCOUNTING CORRECTNESS (RUN EPOCHS):
 * - Each startup creates a new run_id (epoch)
 * - All equity calculations are scoped to active run_id
 * - PAPER_CAPITAL provided → Fresh start, no inherited PnL
 * - PAPER_CAPITAL not provided → Continue from prior net equity
 * - Open positions + fresh PAPER_CAPITAL → FATAL ERROR (hybrid blocked)
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
import { initializeSwapStream } from './services/dlmmTelemetry';
import logger from './utils/logger';
import { logRpcEndpoint, getRpcSource, RPC_URL } from './config/rpc';
import { runFullReconciliation, ReconcileSummary } from './services/positionReconciler';
import { sealReconciliation } from './state/reconciliationSeal';
import { verifyDbHealth } from './services/db';
import { 
    validateStartupConditions, 
    initializeRunEpoch,
    getActiveRunId,
} from './services/runEpoch';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const PAPER_CAPITAL_ENV = process.env.PAPER_CAPITAL;

/**
 * PAPER_CAPITAL_PROVIDED is TRUE only if process.env.PAPER_CAPITAL is explicitly defined.
 * NO DEFAULT FALLBACK — undefined/empty means continuation mode.
 */
const PAPER_CAPITAL_PROVIDED = PAPER_CAPITAL_ENV !== undefined && PAPER_CAPITAL_ENV !== '';

/**
 * PAPER_CAPITAL value is ONLY valid when PAPER_CAPITAL_PROVIDED is true.
 * When not provided, this value should NOT be used for startup mode determination.
 */
const PAPER_CAPITAL = PAPER_CAPITAL_PROVIDED ? parseFloat(PAPER_CAPITAL_ENV!) : 0;

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
    // STEP 0.5: Verify Database Health (CRITICAL - must pass before anything else)
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 0.5: Verifying database health...');
    try {
        await verifyDbHealth();
        logger.info('[BOOTSTRAP] ✅ Database health check passed');
    } catch (dbError: unknown) {
        const errorMsg = dbError instanceof Error ? dbError.message : String(dbError);
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: Database health check failed');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`   Error: ${errorMsg}`);
        console.error('   The bot cannot run without a working database connection.');
        console.error('   Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Validate Startup Conditions (ACCOUNTING CORRECTNESS)
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 1: Validating startup conditions...');
    logger.info(
        `[BOOTSTRAP] PAPER_CAPITAL: ${PAPER_CAPITAL_PROVIDED 
            ? `EXPLICITLY SET = $${PAPER_CAPITAL}` 
            : 'NOT SET (continuation mode)'}`
    );
    
    const startupValidation = await validateStartupConditions(PAPER_CAPITAL_PROVIDED, PAPER_CAPITAL);
    
    if (!startupValidation.valid) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: STARTUP VALIDATION FAILED — HYBRID STATE BLOCKED');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`   ${startupValidation.error}`);
        console.error('');
        console.error('   To fix this:');
        console.error('   1. Remove PAPER_CAPITAL from .env to continue the previous run');
        console.error('   OR');
        console.error('   2. Close all open positions before starting a fresh run');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    
    logger.info(`[BOOTSTRAP] ✅ Startup validation passed: ${startupValidation.mode}`);
    logger.info(`[BOOTSTRAP] Run ID: ${startupValidation.run_id}`);
    logger.info(`[BOOTSTRAP] Starting Capital: $${startupValidation.starting_capital?.toFixed(2)}`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1.5: Initialize Run Epoch
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 1.5: Initializing run epoch...');
    await initializeRunEpoch(
        startupValidation.run_id!,
        startupValidation.starting_capital!,
        PAPER_CAPITAL_PROVIDED,
        startupValidation.prior_run_id ?? null
    );
    logger.info('[BOOTSTRAP] ✅ Run epoch initialized');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Initialize Capital Manager with Run Epoch
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 2: Initializing capital manager...');
    const capitalReady = await capitalManager.initialize(startupValidation.starting_capital);
    
    if (!capitalReady) {
        console.error('🚨 FATAL: Capital manager initialization failed');
        process.exit(1);
    }
    
    // Set run epoch in capital manager
    if (startupValidation.mode === 'fresh_start') {
        // Fresh start: reset everything to PAPER_CAPITAL
        await capitalManager.initializeFreshRun(
            startupValidation.starting_capital!,
            startupValidation.run_id!
        );
        logger.info('[BOOTSTRAP] ✅ Capital manager initialized (FRESH START)');
    } else {
        // Continuation: inherit prior equity
        await capitalManager.initializeContinuationRun(startupValidation.run_id!);
        logger.info('[BOOTSTRAP] ✅ Capital manager initialized (CONTINUATION)');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2.1: Handle legacy paper trading reset (deprecated, for backwards compat)
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (PAPER_TRADING && RESET_PAPER_BALANCE && startupValidation.mode !== 'fresh_start') {
        logger.info('[BOOTSTRAP] Step 2.1: Legacy paper balance reset requested...');
        const resetResult = await capitalManager.resetCapital(PAPER_CAPITAL);
        if (resetResult.success) {
            logger.info(`[BOOTSTRAP] ✅ Paper balance reset to $${resetResult.newBalance.toFixed(2)}`);
        }
    } else {
        logger.info('[BOOTSTRAP] Step 2.1: No legacy reset needed');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2.5: Full Capital Reconciliation — CRASH-SAFE RECOVERY
    // ═══════════════════════════════════════════════════════════════════════════
    // 
    // CRITICAL: This runs BEFORE scanLoop or any trading:
    //   - All open positions without live execution context → CLOSED_RECOVERED
    //   - Capital is DERIVED from database ground truth
    //   - Invariants are validated (fail closed on violation)
    // 
    // This ensures:
    // - No capital inflation on restart
    // - Stale positions are closed with RECOVERY_EXIT reason
    // - Capital conservation invariant is enforced
    // - If invariants fail → ABORT STARTUP (fail closed)
    // 
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 2.5: Running crash-safe capital reconciliation...');
    const reconcileSummary = await runFullReconciliation(
        startupValidation.mode === 'fresh_start' ? 'fresh_start' : 'continuation',
        startupValidation.starting_capital!
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL: Abort startup if reconciliation failed or invariants invalid
    // ═══════════════════════════════════════════════════════════════════════════
    if (reconcileSummary.status === 'ERROR' || !reconcileSummary.invariantsValid) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: RECONCILIATION FAILED — CAPITAL INVARIANTS VIOLATED');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('   The bot cannot safely recover capital state.');
        console.error('   Trading is blocked to prevent capital corruption.');
        console.error('');
        console.error('   To fix this:');
        console.error('   1. Check the [RECONCILE-ERROR] logs above for details');
        console.error('   2. Manually verify capital_state in database');
        console.error('   3. Close any orphaned positions/locks');
        console.error('   4. Restart the bot');
        console.error('═══════════════════════════════════════════════════════════════════');
        // Exit with error code - process lock will be released by exit handler in start.ts
        process.exit(1);
    }
    
    logger.info(
        `[BOOTSTRAP] ✅ Reconciliation complete: ` +
        `${reconcileSummary.closedOnRestart} positions recovered | ` +
        `released=$${reconcileSummary.releasedCapital.toFixed(2)} | ` +
        `equity=$${reconcileSummary.totalEquity.toFixed(2)} | ` +
        `available=$${reconcileSummary.availableBalance.toFixed(2)} | ` +
        `locked=$${reconcileSummary.lockedBalance.toFixed(2)}`
    );
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // STEP 2.6: SEAL RECONCILIATION STATE — CRITICAL
    // After this point:
    //   - No component may recompute capital or positions independently
    //   - DB truth is frozen into runtime truth
    //   - Engine mode is locked to STATEFUL
    //   - Ledger initialization will enforce this seal
    // ═══════════════════════════════════════════════════════════════════════════════
    logger.info('[BOOTSTRAP] Step 2.6: Sealing reconciliation state...');
    
    sealReconciliation(
        {
            openAfter: reconcileSummary.openPositions,
            lockedCapital: reconcileSummary.lockedBalance,
            availableCapital: reconcileSummary.availableBalance,
            totalEquity: reconcileSummary.totalEquity,
            recoveredCount: reconcileSummary.closedOnRestart,
            mode: reconcileSummary.reconciliationMode,
            runId: reconcileSummary.runId,
        },
        reconcileSummary.openPositions > 0 ? {
            openPositionIds: reconcileSummary.openPositionIds,
            totalLockedUsd: reconcileSummary.lockedBalance,
        } : undefined
    );
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // [PORTFOLIO-SOURCE] — Confirm portfolio counts/values are from DB
    // ═══════════════════════════════════════════════════════════════════════════════
    logger.info('[PORTFOLIO-SOURCE] Portfolio counts and capital values are DB-ground-truth derived (SEALED)');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Create ExecutionEngine
    // ═══════════════════════════════════════════════════════════════════════════
    
    logger.info('[BOOTSTRAP] Step 3: Creating ExecutionEngine...');
    
    // Use validated starting_capital (either from PAPER_CAPITAL or inherited equity)
    // NEVER use raw PAPER_CAPITAL here — it may be 0 in continuation mode
    const engineCapital = startupValidation.starting_capital!;
    
    const engine = new ExecutionEngine({
        capital: engineCapital,
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
    console.log(`   Run ID: ${getActiveRunId()}`);
    console.log(`   Starting Capital: $${startupValidation.starting_capital?.toFixed(2)}`);
    console.log(`   Run Mode: ${startupValidation.mode === 'fresh_start' ? 'FRESH START' : 'CONTINUATION'}`);
    console.log(`   Predator ID: ${predatorId}`);
    console.log(`   Trading Mode: ${PAPER_TRADING ? 'PAPER TRADING' : '⚠️ LIVE TRADING'}`);
    console.log('   Engine Mode: STATEFUL');
    console.log('   Internal Loops: 7 active');
    console.log('     - Price watcher (4s)');
    console.log('     - Exit watcher (8s)');
    console.log('     - Snapshot timer (45s)');
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
// - Price watching (4s)
// - Exit evaluation (8s)
// - Snapshot writing (45s)
// - PnL drift updates (15s)
// - Regime updates (30s)
// - Bin tracking (5s)
// 
// ScanLoop runs every 120s and coordinates with the engine.
// ═══════════════════════════════════════════════════════════════════════════════
