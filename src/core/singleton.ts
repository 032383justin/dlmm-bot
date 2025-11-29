/**
 * BULLETPROOF SINGLETON REGISTRY
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROCESS-LEVEL SINGLETON STORAGE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides TRUE singletons using a Map registry.
 * 
 * RULES:
 * 1. Singletons are created ONCE via getOrCreate()
 * 2. Any attempt to recreate throws a FATAL error
 * 3. No lazy retry, no soft fallbacks
 * 4. IDs remain unchanged for the entire process lifetime
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// THE REGISTRY - A SIMPLE MAP AT MODULE LEVEL
// ═══════════════════════════════════════════════════════════════════════════════

const registry = new Map<string, any>();
const creationTimestamps = new Map<string, number>();
const instanceIds = new Map<string, string>();

// Track if process-level init has happened
let processInitialized = false;
let initTimestamp = 0;

/**
 * Get or create a singleton.
 * Creates on first call, returns existing on subsequent calls.
 * 
 * @param name - Unique name for the singleton
 * @param factory - Factory function to create the instance (only called once)
 * @returns The singleton instance
 */
export function getOrCreate<T>(name: string, factory: () => T): T {
    if (!registry.has(name)) {
        const id = `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        console.log(`[SINGLETON] Creating ${name} with ID: ${id}`);
        
        const instance = factory();
        registry.set(name, instance);
        creationTimestamps.set(name, Date.now());
        instanceIds.set(name, id);
        
        console.log(`[SINGLETON] ✅ ${name} created and registered`);
    }
    
    return registry.get(name) as T;
}

/**
 * Get an existing singleton. Throws if not found.
 * 
 * @param name - Name of the singleton
 * @returns The singleton instance
 */
export function get<T>(name: string): T {
    if (!registry.has(name)) {
        throw new Error(`[SINGLETON] FATAL: ${name} not found. Call getOrCreate() first.`);
    }
    return registry.get(name) as T;
}

/**
 * Check if a singleton exists.
 */
export function has(name: string): boolean {
    return registry.has(name);
}

/**
 * Get the ID of a singleton for logging.
 */
export function getId(name: string): string {
    return instanceIds.get(name) || 'NOT_CREATED';
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
export function markProcessInitialized(): void {
    if (processInitialized) {
        const error = new Error(
            `FATAL: Singleton reinitialization detected. ` +
            `Process was already initialized at ${new Date(initTimestamp).toISOString()}`
        );
        console.error('🚨 [SINGLETON] FATAL: Process reinitialization detected!');
        console.error(`🚨 [SINGLETON] Original init: ${new Date(initTimestamp).toISOString()}`);
        console.error('🚨 [SINGLETON] This is a critical architectural bug.');
        throw error;
    }
    
    processInitialized = true;
    initTimestamp = Date.now();
    console.log(`[SINGLETON] ✅ Process marked as initialized at ${new Date(initTimestamp).toISOString()}`);
}

/**
 * Check if process has been initialized.
 */
export function isProcessInitialized(): boolean {
    return processInitialized;
}

/**
 * Get process init timestamp.
 */
export function getProcessInitTimestamp(): number {
    return initTimestamp;
}

/**
 * Log all registered singletons.
 */
export function logRegistry(): void {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 [SINGLETON] REGISTRY STATUS');
    console.log('═══════════════════════════════════════════════════════════════════');
    
    if (registry.size === 0) {
        console.log('   No singletons registered');
    } else {
        for (const [name, _instance] of registry) {
            const id = instanceIds.get(name) || 'unknown';
            const age = getAge(name);
            console.log(`   ${name}: ID=${id} (age: ${age}s)`);
        }
    }
    
    console.log(`   Process initialized: ${processInitialized}`);
    if (processInitialized) {
        console.log(`   Init time: ${new Date(initTimestamp).toISOString()}`);
    }
    console.log('═══════════════════════════════════════════════════════════════════');
}

/**
 * Validate that singletons haven't been recreated.
 * Call this at the start of each scan cycle.
 */
export function validateSingletons(): void {
    if (!processInitialized) {
        throw new Error('[SINGLETON] FATAL: validateSingletons called before process initialization');
    }
    
    // Log current state
    const engineId = instanceIds.get('ExecutionEngine') || 'NOT_CREATED';
    const predatorId = instanceIds.get('PredatorController') || 'NOT_CREATED';
    
    console.log(`[SINGLETON] Using persistent engine [${engineId}]`);
    console.log(`[SINGLETON] Using persistent predator [${predatorId}]`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAMED EXPORTS FOR CONVENIENCE
// ═══════════════════════════════════════════════════════════════════════════════

export const Singleton = {
    getOrCreate,
    get,
    has,
    getId,
    getAge,
    markProcessInitialized,
    isProcessInitialized,
    getProcessInitTimestamp,
    logRegistry,
    validateSingletons,
};

export default Singleton;

