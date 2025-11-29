/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL REGISTRY — JUST GETTERS, NO LOGIC
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This file does NOTHING except:
 * - Define the globalThis structure
 * - Provide getters to access it
 * 
 * NO initialization.
 * NO conditionals.
 * NO instantiation.
 * NO fallbacks.
 * 
 * If singletons don't exist when accessed → CRASH.
 * That's a bug in bootstrap, not here.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL TYPE
// ═══════════════════════════════════════════════════════════════════════════════

export interface DLMMSingleton {
    engine: any;
    predator: any;
    engineId: string;
    predatorId: string;
    initializedAt: number;
    locked: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GETTERS — NO LOGIC, JUST ACCESS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the global singleton store.
 * Returns undefined if not initialized.
 */
export function getStore(): DLMMSingleton | undefined {
    return (globalThis as any).__DLMM_SINGLETON__;
}

/**
 * Get the ExecutionEngine instance.
 * CRASHES if not initialized — that's a bootstrap bug.
 */
export function getEngine<T = any>(): T {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    if (!store || !store.engine) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: getEngine() called but engine not initialized');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('   Bootstrap must run BEFORE any module accesses the engine.');
        console.error('   Check that start.ts runs first.');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    return store.engine as T;
}

/**
 * Get the PredatorController instance.
 * CRASHES if not initialized — that's a bootstrap bug.
 */
export function getPredator<T = any>(): T {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    if (!store || !store.predator) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: getPredator() called but predator not initialized');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('   Bootstrap must run BEFORE any module accesses the predator.');
        console.error('   Check that start.ts runs first.');
        console.error('═══════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    return store.predator as T;
}

/**
 * Get the engine ID.
 */
export function getEngineId(): string {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    return store?.engineId ?? 'NOT_INITIALIZED';
}

/**
 * Get the predator ID.
 */
export function getPredatorId(): string {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    return store?.predatorId ?? 'NOT_INITIALIZED';
}

/**
 * Check if singletons are initialized.
 */
export function isInitialized(): boolean {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    return store?.engine !== undefined && store?.engine !== null &&
           store?.predator !== undefined && store?.predator !== null;
}

/**
 * Check if registry is locked.
 */
export function isLocked(): boolean {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    return store?.locked === true;
}

/**
 * Get uptime in seconds.
 */
export function getUptime(): number {
    const store = (globalThis as any).__DLMM_SINGLETON__;
    if (!store?.initializedAt) return 0;
    return Math.floor((Date.now() - store.initializedAt) / 1000);
}

/**
 * Log current status.
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

