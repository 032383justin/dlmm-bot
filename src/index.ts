/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * INDEX.TS — THIN ORCHESTRATION LAYER
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This file is a minimal orchestration wrapper.
 * 
 * RULES:
 * 1. NO runtime logic at import time
 * 2. NO singleton access at import time
 * 3. Engine is passed as parameter
 * 4. All logic is in src/runtime/scanLoop.ts
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { ExecutionEngine } from './engine/ExecutionEngine';
import { startScanLoop, cleanup } from './runtime/scanLoop';
import logger from './utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY — CALLED BY start.ts AFTER BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

export async function main(engine: ExecutionEngine, engineId: string): Promise<void> {
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('🚀 STARTING DLMM BOT MAIN LOOP');
    logger.info('═══════════════════════════════════════════════════════════════════');
    
    // Start the scan loop with the provided engine
    await startScanLoop(engine, engineId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRASH PREVENTION - Global error handlers
// ═══════════════════════════════════════════════════════════════════════════════

process.on('uncaughtException', (error) => {
    logger.error(`[FATAL] Uncaught Exception: ${error.message}`, { stack: error.stack });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`[FATAL] Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('SIGINT', () => {
    logger.info('Shutting down...');
    cleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    cleanup();
    process.exit(0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// NOTE: This file is imported by start.ts — it does NOT auto-run.
// 
// The entrypoint is: node dist/start.js
// 
// EXPORTS:
// - main(engine, engineId) — called by start.ts after bootstrap + startRuntime
// 
// This file NEVER imports bootstrap.ts.
// Engine is passed as parameter, not accessed via singleton.
// ═══════════════════════════════════════════════════════════════════════════════
