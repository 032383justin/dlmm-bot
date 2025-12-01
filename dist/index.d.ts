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
export declare function main(engine: ExecutionEngine, engineId: string): Promise<void>;
//# sourceMappingURL=index.d.ts.map