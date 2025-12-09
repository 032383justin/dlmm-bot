"use strict";
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * INDEX.TS — PURE ORCHESTRATOR
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file is a minimal orchestration wrapper.
 *
 * RULES:
 * 1. NO runtime logic at import time
 * 2. NO singleton access at import time
 * 3. NO process handlers (those belong in start.ts)
 * 4. Engine is passed as parameter
 * 5. Returns the ScanLoop instance for lifecycle management
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
const scanLoop_1 = require("./runtime/scanLoop");
const logger_1 = __importDefault(require("./utils/logger"));
// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY — CALLED BY start.ts AFTER BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Create and start a ScanLoop instance.
 * Returns the instance for lifecycle management (stop/cleanup).
 */
async function main(engine, engineId) {
    logger_1.default.info('');
    logger_1.default.info('═══════════════════════════════════════════════════════════════════');
    logger_1.default.info('🚀 STARTING DLMM BOT MAIN LOOP');
    logger_1.default.info('═══════════════════════════════════════════════════════════════════');
    // Create and start the scan loop
    const loop = new scanLoop_1.ScanLoop(engine, engineId);
    await loop.start();
    return loop;
}
// ═══════════════════════════════════════════════════════════════════════════════
// NOTE: This file is imported by start.ts — it does NOT auto-run.
// 
// The entrypoint is: node dist/start.js
// 
// EXPORTS:
// - main(engine, engineId) — called by start.ts after bootstrap + startRuntime
// - Returns ScanLoop instance for lifecycle management
// 
// This file NEVER imports bootstrap.ts.
// Engine is passed as parameter, not accessed via singleton.
// NO PROCESS HANDLERS — those are in start.ts
// ═══════════════════════════════════════════════════════════════════════════════
//# sourceMappingURL=index.js.map