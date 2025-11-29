/**
 * HARD SINGLETON REGISTRY - PROCESS LEVEL
 * 
 * Uses global/process storage to guarantee true singleton behavior
 * even across module re-evaluations.
 * 
 * THROWS FATAL ERROR on any duplicate creation attempt.
 * NO soft fallbacks. NO lazy retry.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL SYMBOL KEY - Ensures same registry even if module is re-evaluated
// ═══════════════════════════════════════════════════════════════════════════════
const REGISTRY_KEY = Symbol.for('__DLMM_BOT_SINGLETON_REGISTRY__');
const INIT_KEY = Symbol.for('__DLMM_BOT_INITIALIZED__');

// Get or create the global registry
function getGlobalRegistry(): Map<string, any> {
    const g = globalThis as any;
    if (!g[REGISTRY_KEY]) {
        g[REGISTRY_KEY] = new Map<string, any>();
    }
    return g[REGISTRY_KEY];
}

// Get or create the global init flag
function getGlobalInit(): { initialized: boolean; timestamp: number } {
    const g = globalThis as any;
    if (!g[INIT_KEY]) {
        g[INIT_KEY] = { initialized: false, timestamp: 0 };
    }
    return g[INIT_KEY];
}

const registry = getGlobalRegistry();
const initState = getGlobalInit();
const creationTimestamps = new Map<string, number>();
const instanceIds = new Map<string, string>();

/**
 * Register a singleton. THROWS if already registered.
 * 
 * @param name - Unique name for the singleton
 * @param instance - The singleton instance
 */
export function register(name: string, instance: any): void {
    if (registry.has(name)) {
        const existingId = instanceIds.get(name) || 'unknown';
        const error = new Error(
            `FATAL: Multiple bootstrap of singleton "${name}". ` +
            `Already registered with ID: ${existingId}`
        );
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`🚨 FATAL: Attempted to register "${name}" twice!`);
        console.error(`🚨 Existing ID: ${existingId}`);
        console.error(`🚨 This is a critical architectural bug.`);
        console.error('═══════════════════════════════════════════════════════════════════');
        throw error;
    }
    
    const id = `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    registry.set(name, instance);
    creationTimestamps.set(name, Date.now());
    instanceIds.set(name, id);
    
    console.log(`[SINGLETON] ✅ Registered: ${name} (ID: ${id})`);
}

/**
 * Get a registered singleton. THROWS if not found.
 */
export function get<T>(name: string): T {
    if (!registry.has(name)) {
        throw new Error(`[SINGLETON] FATAL: "${name}" not registered. Must register at entrypoint.`);
    }
    return registry.get(name) as T;
}

/**
 * Check if a singleton is registered.
 */
export function has(name: string): boolean {
    return registry.has(name);
}

/**
 * Get the ID of a singleton.
 */
export function getId(name: string): string {
    return instanceIds.get(name) || 'NOT_REGISTERED';
}

/**
 * Get the age of a singleton in seconds.
 */
export function getAge(name: string): number {
    const created = creationTimestamps.get(name);
    if (!created) return 0;
    return Math.floor((Date.now() - created) / 1000);
}

/**
 * Mark process as initialized. THROWS if called twice.
 */
export function markInitialized(): void {
    if (initState.initialized) {
        const error = new Error(
            `FATAL: Process reinitialization detected. ` +
            `Already initialized at ${new Date(initState.timestamp).toISOString()}`
        );
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: markInitialized() called twice!');
        console.error(`🚨 First init: ${new Date(initState.timestamp).toISOString()}`);
        console.error('═══════════════════════════════════════════════════════════════════');
        throw error;
    }
    
    initState.initialized = true;
    initState.timestamp = Date.now();
    console.log(`[SINGLETON] ✅ Process marked initialized at ${new Date().toISOString()}`);
}

/**
 * Check if process has been initialized.
 */
export function isInitialized(): boolean {
    return initState.initialized;
}

/**
 * Validate singletons at start of each cycle.
 */
export function validate(): void {
    if (!initState.initialized) {
        throw new Error('[SINGLETON] FATAL: validate() called before initialization');
    }
    
    const engineId = instanceIds.get('ExecutionEngine') || 'NOT_REGISTERED';
    const predatorId = instanceIds.get('PredatorController') || 'NOT_REGISTERED';
    
    // Silent validation - only log every 60s via caller
    console.log(`[SINGLETON] Using persistent engine [${engineId}]`);
    console.log(`[SINGLETON] Using persistent predator [${predatorId}]`);
}

/**
 * Log registry status.
 */
export function logStatus(): void {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 [SINGLETON] REGISTRY STATUS');
    
    if (registry.size === 0) {
        console.log('   No singletons registered');
    } else {
        for (const name of registry.keys()) {
            const id = instanceIds.get(name) || 'unknown';
            const age = getAge(name);
            console.log(`   ${name}: ${id} (age: ${age}s)`);
        }
    }
    
    console.log(`   Initialized: ${initState.initialized}`);
    console.log('═══════════════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAMED EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const Singleton = {
    register,
    get,
    has,
    getId,
    getAge,
    markInitialized,
    isInitialized,
    validate,
    logStatus,
};

export default Singleton;
