"use strict";
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
async function main(engine, engineId) {
    logger_1.default.info('');
    logger_1.default.info('═══════════════════════════════════════════════════════════════════');
    logger_1.default.info('🚀 STARTING DLMM BOT MAIN LOOP');
    logger_1.default.info('═══════════════════════════════════════════════════════════════════');
    // Start the scan loop with the provided engine
    await (0, scanLoop_1.startScanLoop)(engine, engineId);
}
// ═══════════════════════════════════════════════════════════════════════════════
// CRASH PREVENTION - Global error handlers
// ═══════════════════════════════════════════════════════════════════════════════
process.on('uncaughtException', (error) => {
    logger_1.default.error(`[FATAL] Uncaught Exception: ${error.message}`, { stack: error.stack });
});
process.on('unhandledRejection', (reason, promise) => {
    logger_1.default.error(`[FATAL] Unhandled Rejection at: ${promise}, reason: ${reason}`);
});
process.on('SIGINT', () => {
    logger_1.default.info('Shutting down...');
    (0, scanLoop_1.cleanup)();
    process.exit(0);
});
process.on('SIGTERM', () => {
    logger_1.default.info('Shutting down...');
    (0, scanLoop_1.cleanup)();
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
//# sourceMappingURL=index.js.map