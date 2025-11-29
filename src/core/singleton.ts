/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL SINGLETON REGISTRY - ABSOLUTE PROCESS-LEVEL ENFORCEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * ARCHITECTURE FIX: Uses globalThis directly with string key.
 * NOT Symbol.for (can fail across some bundler configurations)
 * NOT module-local variables (reset on hot reload)
 * NOT class static (same issue)
 * 
 * BEHAVIORAL RULES:
 * 1. Registry is GLOBAL - survives hot reload, module re-eval, anything
 * 2. Duplicate registration = FATAL ERROR + process.exit(1)
 * 3. No soft fallbacks, no getOrCreate, no lazy retry
 * 4. If something is wrong, ABORT IMMEDIATELY
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL REGISTRY - SINGLE SOURCE OF TRUTH
// ═══════════════════════════════════════════════════════════════════════════════

// The ONLY pattern that guarantees singleton across ALL scenarios
// Node.js, worker threads, hot reload, module re-evaluation, bundlers, etc.

interface RegistryEntry {
    instance: any;
    id: string;
    createdAt: number;
}

interface GlobalRegistry {
    entries: Map<string, RegistryEntry>;
    initialized: boolean;
    initializedAt: number;
    bootCount: number;
}

// GLOBAL REGISTRY - Attached directly to globalThis with string key
const REGISTRY_KEY = '__DLMM_REGISTRY__';

// Initialize or get the global registry
function getRegistry(): GlobalRegistry {
    const g = globalThis as any;
    
    if (!g[REGISTRY_KEY]) {
        g[REGISTRY_KEY] = {
            entries: new Map<string, RegistryEntry>(),
            initialized: false,
            initializedAt: 0,
            bootCount: 0,
        } as GlobalRegistry;
    }
    
    return g[REGISTRY_KEY] as GlobalRegistry;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT COUNT TRACKING - Detect process restarts
// ═══════════════════════════════════════════════════════════════════════════════

// Increment boot count on module load - this detects hot reloads
const registry = getRegistry();
registry.bootCount++;

if (registry.bootCount > 1) {
    console.error('');
    console.error('═══════════════════════════════════════════════════════════════════');
    console.error('🚨🚨🚨 FATAL: SINGLETON MODULE RE-EVALUATED 🚨🚨🚨');
    console.error('═══════════════════════════════════════════════════════════════════');
    console.error(`   Boot count: ${registry.bootCount}`);
    console.error('   This means hot-reload or module re-import occurred.');
    console.error('   Existing singletons:');
    for (const [name, entry] of registry.entries) {
        console.error(`      - ${name}: ${entry.id} (age: ${Math.floor((Date.now() - entry.createdAt) / 1000)}s)`);
    }
    console.error('');
    console.error('   RESOLUTION:');
    console.error('   1. Run with: node dist/index.js (NOT ts-node)');
    console.error('   2. Disable nodemon/watch mode');
    console.error('   3. Do NOT use ts-node-dev');
    console.error('═══════════════════════════════════════════════════════════════════');
    console.error('');
    
    // If singletons exist but module reloaded = FATAL
    if (registry.entries.size > 0) {
        console.error('🔥 ABORTING: Singletons exist but module was re-evaluated');
        console.error('   This will cause duplicate IDs and state corruption.');
        process.exit(1);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRATION - FATAL ON DUPLICATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register a singleton. FATAL ERROR if already registered.
 * NO fallbacks. NO getOrCreate. NO soft handling.
 */
export function register(name: string, instance: any): void {
    const reg = getRegistry();
    
    if (reg.entries.has(name)) {
        const existing = reg.entries.get(name)!;
        
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨🚨🚨 FATAL: DUPLICATE SINGLETON REGISTRATION 🚨🚨🚨');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`   Singleton name: ${name}`);
        console.error(`   Existing ID: ${existing.id}`);
        console.error(`   Created at: ${new Date(existing.createdAt).toISOString()}`);
        console.error(`   Age: ${Math.floor((Date.now() - existing.createdAt) / 1000)} seconds`);
        console.error('');
        console.error('   This is a CRITICAL architectural bug.');
        console.error('   The singleton was already created and someone tried to create it again.');
        console.error('');
        console.error('   RESOLUTION:');
        console.error('   1. Ensure ONLY index.ts creates singletons');
        console.error('   2. Ensure NO module imports trigger singleton creation');
        console.error('   3. Check for multiple entry points');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('');
        
        // FATAL - Abort immediately
        process.exit(1);
    }
    
    // Generate unique ID for tracking
    const id = `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    
    reg.entries.set(name, {
        instance,
        id,
        createdAt: Date.now(),
    });
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`✅ [SINGLETON] REGISTERED: ${name}`);
    console.log(`   ID: ${id}`);
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════════════════════════');
}

/**
 * Get a registered singleton. FATAL ERROR if not found.
 */
export function get<T>(name: string): T {
    const reg = getRegistry();
    
    if (!reg.entries.has(name)) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: SINGLETON NOT FOUND');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`   Requested: ${name}`);
        console.error(`   Registered singletons:`);
        for (const [n, entry] of reg.entries) {
            console.error(`      - ${n}: ${entry.id}`);
        }
        console.error('');
        console.error('   The singleton must be registered at entrypoint before use.');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('');
        
        process.exit(1);
    }
    
    return reg.entries.get(name)!.instance as T;
}

/**
 * Check if a singleton is registered.
 */
export function has(name: string): boolean {
    return getRegistry().entries.has(name);
}

/**
 * Get the ID of a singleton.
 */
export function getId(name: string): string {
    const entry = getRegistry().entries.get(name);
    return entry?.id ?? 'NOT_REGISTERED';
}

/**
 * Get the age of a singleton in seconds.
 */
export function getAge(name: string): number {
    const entry = getRegistry().entries.get(name);
    if (!entry) return 0;
    return Math.floor((Date.now() - entry.createdAt) / 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION LOCK - PREVENTS REINIT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mark process as initialized. FATAL if called twice.
 */
export function markInitialized(): void {
    const reg = getRegistry();
    
    if (reg.initialized) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨🚨🚨 FATAL: PROCESS REINITIALIZATION DETECTED 🚨🚨🚨');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error(`   First initialization: ${new Date(reg.initializedAt).toISOString()}`);
        console.error(`   Age: ${Math.floor((Date.now() - reg.initializedAt) / 1000)} seconds`);
        console.error('');
        console.error('   markInitialized() was called twice.');
        console.error('   This means initializeBot() ran more than once.');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('');
        
        process.exit(1);
    }
    
    reg.initialized = true;
    reg.initializedAt = Date.now();
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 [SINGLETON] PROCESS INITIALIZED AND LOCKED');
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log('   Any further initialization attempts will ABORT the process.');
    console.log('═══════════════════════════════════════════════════════════════════');
}

/**
 * Check if process has been initialized.
 */
export function isInitialized(): boolean {
    return getRegistry().initialized;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION - CYCLE GUARDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate singletons at start of each cycle.
 * FATAL if anything is wrong.
 */
export function validate(): void {
    const reg = getRegistry();
    
    if (!reg.initialized) {
        console.error('');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: validate() called before initialization');
        console.error('═══════════════════════════════════════════════════════════════════');
        console.error('');
        
        process.exit(1);
    }
    
    // Verify all required singletons exist
    const required = ['ExecutionEngine', 'PredatorController'];
    for (const name of required) {
        if (!reg.entries.has(name)) {
            console.error('');
            console.error('═══════════════════════════════════════════════════════════════════');
            console.error(`🚨 FATAL: Required singleton "${name}" missing`);
            console.error('═══════════════════════════════════════════════════════════════════');
            console.error('');
            
            process.exit(1);
        }
    }
    
    // Log current state (silent validation - only log every 60s via caller)
    const engineEntry = reg.entries.get('ExecutionEngine')!;
    const predatorEntry = reg.entries.get('PredatorController')!;
    
    console.log(`[SINGLETON] ✓ Engine: ${engineEntry.id} (age: ${getAge('ExecutionEngine')}s)`);
    console.log(`[SINGLETON] ✓ Predator: ${predatorEntry.id} (age: ${getAge('PredatorController')}s)`);
}

/**
 * Log registry status.
 */
export function logStatus(): void {
    const reg = getRegistry();
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('🔒 SINGLETON REGISTRY STATUS');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`   Boot count: ${reg.bootCount}`);
    console.log(`   Initialized: ${reg.initialized}`);
    
    if (reg.initialized) {
        console.log(`   Initialized at: ${new Date(reg.initializedAt).toISOString()}`);
        console.log(`   Uptime: ${Math.floor((Date.now() - reg.initializedAt) / 1000)}s`);
    }
    
    console.log('');
    console.log('   Registered singletons:');
    
    if (reg.entries.size === 0) {
        console.log('      (none)');
    } else {
        for (const [name, entry] of reg.entries) {
            const age = Math.floor((Date.now() - entry.createdAt) / 1000);
            console.log(`      ${name}: ${entry.id} (age: ${age}s)`);
        }
    }
    
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIRECT GLOBAL ACCESS (for debugging)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the raw global registry (for debugging only)
 */
export function getGlobalRegistry(): GlobalRegistry {
    return getRegistry();
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
    getGlobalRegistry,
};

export default Singleton;
