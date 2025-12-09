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
import { ExecutionEngine } from './engine/ExecutionEngine';
import { ScanLoop } from './runtime/scanLoop';
/**
 * Create and start a ScanLoop instance.
 * Returns the instance for lifecycle management (stop/cleanup).
 */
export declare function main(engine: ExecutionEngine, engineId: string): Promise<ScanLoop>;
//# sourceMappingURL=index.d.ts.map