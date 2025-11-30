/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SINGLETON STATE — READONLY ACCESS ONLY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides READONLY access to the global singleton state.
 * 
 * RULES:
 * 1. This file NEVER creates singletons
 * 2. This file NEVER imports bootstrap.ts
 * 3. This file ONLY reads from globalThis.__DLMM_SINGLETON__
 * 4. All modules that need engine/predator access MUST use these getters
 * 
 * The singleton is created ONLY by bootstrap.ts (the entrypoint).
 * No other module may write to globalThis.__DLMM_SINGLETON__.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export interface DLMMSingleton {
    readonly engine: any;
    readonly predator: any;
    readonly engineId: string;
    readonly predatorId: string;
    readonly initializedAt: number;
    readonly locked: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// READONLY GETTERS — NO LOGIC, NO INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the ExecutionEngine instance.
 * CRASHES if not initialized — bootstrap must run first.
 */
export function getEngine<T = any>(): T {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    
    if (!store?.engine) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: getEngine() called but engine not initialized');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('   The bootstrap entrypoint must run before accessing singletons.');
        console.error('   Ensure you are running: node dist/bootstrap.js');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    
    return store.engine as T;
}

/**
 * Get the PredatorController instance.
 * CRASHES if not initialized — bootstrap must run first.
 */
export function getPredator<T = any>(): T {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    
    if (!store?.predator) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: getPredator() called but predator not initialized');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('   The bootstrap entrypoint must run before accessing singletons.');
        console.error('   Ensure you are running: node dist/bootstrap.js');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    
    return store.predator as T;
}

/**
 * Get the engine ID for logging.
 */
export function getEngineId(): string {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    return store?.engineId ?? 'NOT_INITIALIZED';
}

/**
 * Get the predator ID for logging.
 */
export function getPredatorId(): string {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    return store?.predatorId ?? 'NOT_INITIALIZED';
}

/**
 * Check if singletons are initialized and locked.
 */
export function isInitialized(): boolean {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    return store?.locked === true && store?.engine != null && store?.predator != null;
}

/**
 * Get uptime in seconds since bootstrap.
 */
export function getUptime(): number {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    if (!store?.initializedAt) return 0;
    return Math.floor((Date.now() - store.initializedAt) / 1000);
}

/**
 * Validate that singletons are ready.
 * CRASHES if not ready — prevents modules from running without bootstrap.
 */
export function requireInitialized(): void {
    if (!isInitialized()) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: Singletons not initialized');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('   requireInitialized() was called but bootstrap has not completed.');
        console.error('   Ensure you are running: node dist/bootstrap.js');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
}

/**
 * Log current singleton status.
 */
export function logStatus(): void {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 SINGLETON STATUS');
    console.log('═══════════════════════════════════════════════════════════════════');
    
    if (!store) {
        console.log('   ❌ NOT INITIALIZED');
    } else {
        console.log(`   Engine: ${store.engineId || 'NOT SET'}`);
        console.log(`   Predator: ${store.predatorId || 'NOT SET'}`);
        console.log(`   Locked: ${store.locked}`);
        console.log(`   Uptime: ${getUptime()}s`);
    }
    
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
}

