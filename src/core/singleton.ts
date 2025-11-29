/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL SINGLETON REGISTRY — ATTACHED TO globalThis
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This is the ONLY correct way to maintain singletons across:
 * - Module re-evaluation
 * - Hot reload
 * - ts-node watch
 * - Worker threads sharing globalThis
 * 
 * The actual INSTANCES are stored directly on globalThis.
 * NOT metadata. NOT IDs. The actual objects.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL REGISTRY — DIRECT globalThis ATTACHMENT
// ═══════════════════════════════════════════════════════════════════════════════

interface SingletonStore {
    engine: any | null;
    predator: any | null;
    engineId: string | null;
    predatorId: string | null;
    initializedAt: number | null;
    locked: boolean;
}

// Create or get the global singleton store
if (!(globalThis as any).__DLMM_SINGLETON__) {
    (globalThis as any).__DLMM_SINGLETON__ = {
        engine: null,
        predator: null,
        engineId: null,
        predatorId: null,
        initializedAt: null,
        locked: false,
    } as SingletonStore;
}

// Export the global registry directly
export const SingletonRegistry: SingletonStore = (globalThis as any).__DLMM_SINGLETON__;

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if singletons are already initialized.
 * Use this BEFORE creating any instances.
 */
export function isAlreadyInitialized(): boolean {
    return SingletonRegistry.engine !== null && SingletonRegistry.predator !== null;
}

/**
 * Get existing singletons if they exist.
 * Returns null if not initialized.
 */
export function getExistingSingletons(): { engine: any; predator: any } | null {
    if (SingletonRegistry.engine && SingletonRegistry.predator) {
        return {
            engine: SingletonRegistry.engine,
            predator: SingletonRegistry.predator,
        };
    }
    return null;
}

/**
 * Register the ExecutionEngine singleton.
 * FATAL ERROR if already registered.
 */
export function registerEngine(engine: any): void {
    if (SingletonRegistry.engine !== null) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨🚨🚨 FATAL: ExecutionEngine ALREADY EXISTS 🚨🚨🚨');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`   Existing ID: ${SingletonRegistry.engineId}`);
        console.error(`   Created at: ${new Date(SingletonRegistry.initializedAt || 0).toISOString()}`);
        console.error(`   Age: ${Math.floor((Date.now() - (SingletonRegistry.initializedAt || 0)) / 1000)}s`);
        console.error('');
        console.error('   CAUSE: Module was re-evaluated or hot-reloaded');
        console.error('   FIX: Run with "node dist/index.js" — NOT ts-node');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('');
        process.exit(1);
    }
    
    const id = `engine_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    SingletonRegistry.engine = engine;
    SingletonRegistry.engineId = id;
    SingletonRegistry.initializedAt = Date.now();
    
    console.log(`[SINGLETON] ✅ ExecutionEngine registered: ${id}`);
}

/**
 * Register the PredatorController singleton.
 * FATAL ERROR if already registered.
 */
export function registerPredator(predator: any): void {
    if (SingletonRegistry.predator !== null) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨🚨🚨 FATAL: PredatorController ALREADY EXISTS 🚨🚨🚨');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`   Existing ID: ${SingletonRegistry.predatorId}`);
        console.error(`   Created at: ${new Date(SingletonRegistry.initializedAt || 0).toISOString()}`);
        console.error('');
        console.error('   CAUSE: Module was re-evaluated or hot-reloaded');
        console.error('   FIX: Run with "node dist/index.js" — NOT ts-node');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('');
        process.exit(1);
    }
    
    const id = `predator_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    SingletonRegistry.predator = predator;
    SingletonRegistry.predatorId = id;
    
    console.log(`[SINGLETON] ✅ PredatorController registered: ${id}`);
}

/**
 * Lock the registry — no more registrations allowed.
 */
export function lockRegistry(): void {
    if (SingletonRegistry.locked) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: Registry already locked');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('');
        process.exit(1);
    }
    
    SingletonRegistry.locked = true;
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 [SINGLETON] REGISTRY LOCKED — NO FURTHER REGISTRATION ALLOWED');
    console.log(`   Engine: ${SingletonRegistry.engineId}`);
    console.log(`   Predator: ${SingletonRegistry.predatorId}`);
    console.log(`   Locked at: ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
}

/**
 * Get the ExecutionEngine. FATAL if not registered.
 */
export function getEngine<T>(): T {
    if (SingletonRegistry.engine === null) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: ExecutionEngine not registered');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('   Singletons must be created in index.ts BEFORE any other code runs.');
        console.error('');
        process.exit(1);
    }
    return SingletonRegistry.engine as T;
}

/**
 * Get the PredatorController. FATAL if not registered.
 */
export function getPredator<T>(): T {
    if (SingletonRegistry.predator === null) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: PredatorController not registered');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('   Singletons must be created in index.ts BEFORE any other code runs.');
        console.error('');
        process.exit(1);
    }
    return SingletonRegistry.predator as T;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION & STATUS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate that singletons are properly initialized.
 * Call at start of each scan cycle.
 */
export function validateSingletons(): void {
    if (!SingletonRegistry.locked) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: validateSingletons() called but registry not locked');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('');
        process.exit(1);
    }
    
    if (SingletonRegistry.engine === null || SingletonRegistry.predator === null) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: Singletons missing after lock');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('');
        process.exit(1);
    }
}

/**
 * Log the current singleton status.
 */
export function logSingletonStatus(): void {
    const age = SingletonRegistry.initializedAt 
        ? Math.floor((Date.now() - SingletonRegistry.initializedAt) / 1000)
        : 0;
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 SINGLETON STATUS');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`   Engine: ${SingletonRegistry.engineId || 'NOT REGISTERED'}`);
    console.log(`   Predator: ${SingletonRegistry.predatorId || 'NOT REGISTERED'}`);
    console.log(`   Locked: ${SingletonRegistry.locked}`);
    console.log(`   Uptime: ${age}s`);
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY — Maps to old Singleton.* API
// ═══════════════════════════════════════════════════════════════════════════════

export const Singleton = {
    // Registration
    register: (name: string, instance: any) => {
        if (name === 'ExecutionEngine') {
            registerEngine(instance);
        } else if (name === 'PredatorController') {
            registerPredator(instance);
        } else {
            console.error(`Unknown singleton: ${name}`);
            process.exit(1);
        }
    },
    
    // Getters
    get: <T>(name: string): T => {
        if (name === 'ExecutionEngine') {
            return getEngine<T>();
        } else if (name === 'PredatorController') {
            return getPredator<T>();
        }
        console.error(`Unknown singleton: ${name}`);
        process.exit(1);
    },
    
    // Checks
    has: (name: string): boolean => {
        if (name === 'ExecutionEngine') return SingletonRegistry.engine !== null;
        if (name === 'PredatorController') return SingletonRegistry.predator !== null;
        return false;
    },
    
    getId: (name: string): string => {
        if (name === 'ExecutionEngine') return SingletonRegistry.engineId || 'NOT_REGISTERED';
        if (name === 'PredatorController') return SingletonRegistry.predatorId || 'NOT_REGISTERED';
        return 'UNKNOWN';
    },
    
    getAge: (_name: string): number => {
        if (!SingletonRegistry.initializedAt) return 0;
        return Math.floor((Date.now() - SingletonRegistry.initializedAt) / 1000);
    },
    
    // Lifecycle
    markInitialized: lockRegistry,
    isInitialized: (): boolean => SingletonRegistry.locked,
    validate: validateSingletons,
    logStatus: logSingletonStatus,
};

export default Singleton;
