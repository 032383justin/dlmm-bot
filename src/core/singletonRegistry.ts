/**
 * Singleton Registry - Process-Level Persistent Instances
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * REAL SINGLETON ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides TRULY PERSISTENT singletons at the process level.
 * 
 * Instances are created ONCE and NEVER recreated during runtime.
 * 
 * Usage:
 *   import { getEngine, getPredator, initializeSingletons } from './core/singletonRegistry';
 *   
 *   // At startup (once):
 *   await initializeSingletons(config);
 *   
 *   // In any scan cycle:
 *   const engine = getEngine();      // Returns the SAME instance every time
 *   const predator = getPredator();  // Returns the SAME instance every time
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SingletonConfig {
    paperCapital: number;
    rebalanceInterval: number;
    takeProfit: number;
    stopLoss: number;
    maxConcurrentPools: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS-LEVEL SINGLETON REGISTRY
// These variables persist for the entire lifetime of the Node.js process
// ═══════════════════════════════════════════════════════════════════════════════

// Engine instance - created once, never replaced
let engineInstance: any = null;
let engineId: string = '';
let engineCreatedAt: number = 0;

// Predator instance state - initialized once, never replaced
let predatorInitialized: boolean = false;
let predatorId: string = '';
let predatorCreatedAt: number = 0;

// Global initialization flag
let singletonsInitialized: boolean = false;
let initializationTimestamp: number = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// GUARDS - THROW ON RECREATION ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════════

function guardEngineRecreation(): void {
    if (engineInstance !== null) {
        const error = new Error(
            `ENGINE RECREATE BLOCKED - Engine already exists with ID: ${engineId}. ` +
            `Use getEngine() instead of creating new instance.`
        );
        logger.error('🚨 [SINGLETON] FATAL: Attempted to recreate ExecutionEngine!');
        logger.error(`🚨 [SINGLETON] Existing engine ID: ${engineId}`);
        logger.error('🚨 [SINGLETON] This is an architectural bug. Fix the code.');
        throw error;
    }
}

function guardPredatorRecreation(): void {
    if (predatorInitialized) {
        const error = new Error(
            `ENGINE RECREATE BLOCKED - Predator already initialized with ID: ${predatorId}. ` +
            `Use getPredator functions instead of re-initializing.`
        );
        logger.error('🚨 [SINGLETON] FATAL: Attempted to re-initialize PredatorController!');
        logger.error(`🚨 [SINGLETON] Existing predator ID: ${predatorId}`);
        logger.error('🚨 [SINGLETON] This is an architectural bug. Fix the code.');
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GETTERS - SAFE ACCESS TO SINGLETONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the singleton ExecutionEngine instance.
 * THROWS if not initialized.
 */
export function getEngine(): any {
    if (!engineInstance) {
        throw new Error('[SINGLETON] Engine not initialized. Call initializeSingletons() first.');
    }
    return engineInstance;
}

/**
 * Get the engine ID for logging.
 */
export function getEngineId(): string {
    return engineId;
}

/**
 * Get engine age in seconds.
 */
export function getEngineAge(): number {
    if (!engineCreatedAt) return 0;
    return Math.floor((Date.now() - engineCreatedAt) / 1000);
}

/**
 * Get the predator controller ID for logging.
 */
export function getPredatorId(): string {
    return predatorId;
}

/**
 * Get predator age in seconds.
 */
export function getPredatorAge(): number {
    if (!predatorCreatedAt) return 0;
    return Math.floor((Date.now() - predatorCreatedAt) / 1000);
}

/**
 * Check if singletons have been initialized.
 */
export function areSingletonsInitialized(): boolean {
    return singletonsInitialized;
}

/**
 * Get initialization timestamp.
 */
export function getInitializationTimestamp(): number {
    return initializationTimestamp;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION - CALLED ONCE AT PROCESS START
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize all singletons. MUST be called once at process start.
 * THROWS if called twice.
 */
export async function initializeSingletons(config: SingletonConfig): Promise<boolean> {
    // Guard against re-initialization
    if (singletonsInitialized) {
        const error = new Error(
            `ENGINE RECREATE BLOCKED - Singletons already initialized at ${new Date(initializationTimestamp).toISOString()}`
        );
        logger.error('🚨 [SINGLETON] FATAL: Attempted to re-initialize singletons!');
        logger.error(`🚨 [SINGLETON] Original initialization: ${new Date(initializationTimestamp).toISOString()}`);
        throw error;
    }

    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('🏭 [SINGLETON] INITIALIZING PROCESS-LEVEL SINGLETONS');
    logger.info('═══════════════════════════════════════════════════════════════════');

    try {
        // Create engine ID
        engineId = `engine_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        engineCreatedAt = Date.now();

        // Import and create ExecutionEngine
        // We import here to avoid circular dependencies
        const { ExecutionEngine } = await import('../engine/ExecutionEngine');
        
        guardEngineRecreation();
        engineInstance = new ExecutionEngine({
            capital: config.paperCapital,
            rebalanceInterval: config.rebalanceInterval,
            takeProfit: config.takeProfit,
            stopLoss: config.stopLoss,
            maxConcurrentPools: config.maxConcurrentPools,
            allocationStrategy: 'equal',
        });

        logger.info(`[SINGLETON] ✅ ExecutionEngine created`);
        logger.info(`[SINGLETON]    ID: ${engineId}`);

        // Initialize predator controller
        predatorId = `predator_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        predatorCreatedAt = Date.now();

        const { initializePredatorController } = await import('../engine/predatorController');
        
        guardPredatorRecreation();
        initializePredatorController();
        predatorInitialized = true;

        logger.info(`[SINGLETON] ✅ PredatorController initialized`);
        logger.info(`[SINGLETON]    ID: ${predatorId}`);

        // Mark as initialized
        singletonsInitialized = true;
        initializationTimestamp = Date.now();

        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info('🔒 [SINGLETON] ALL SINGLETONS LOCKED - WILL PERSIST FOR PROCESS LIFETIME');
        logger.info(`   Engine ID: ${engineId}`);
        logger.info(`   Predator ID: ${predatorId}`);
        logger.info('   Any recreation attempt will throw an error.');
        logger.info('═══════════════════════════════════════════════════════════════════');

        return true;

    } catch (error: any) {
        logger.error(`[SINGLETON] ❌ Initialization failed: ${error.message}`);
        throw error;
    }
}

/**
 * Log persistence status - call periodically to verify singletons are persistent.
 */
export function logPersistenceStatus(): void {
    if (!singletonsInitialized) {
        logger.warn('[SINGLETON] ⚠️ Singletons not initialized');
        return;
    }

    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info('🔒 [SINGLETON] PERSISTENCE CHECK - USING EXISTING INSTANCES');
    logger.info(`   Engine ID: ${engineId} (age: ${getEngineAge()}s)`);
    logger.info(`   Predator ID: ${predatorId} (age: ${getPredatorAge()}s)`);
    logger.info(`   Positions: ${engineInstance?.positions?.length ?? 0}`);
    logger.info('═══════════════════════════════════════════════════════════════════');
}

/**
 * Validate that singletons are still the same instances.
 * Call this at the start of each scan cycle for debugging.
 */
export function validateSingletons(): void {
    if (!singletonsInitialized) {
        throw new Error('[SINGLETON] Singletons not initialized. Call initializeSingletons() first.');
    }

    // Log that we're using persistent instances
    logger.debug(`[SINGLETON] Using persistent engine [${engineId}]`);
    logger.debug(`[SINGLETON] Using persistent predator [${predatorId}]`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    getEngine,
    getEngineId,
    getEngineAge,
    getPredatorId,
    getPredatorAge,
    areSingletonsInitialized,
    getInitializationTimestamp,
    initializeSingletons,
    logPersistenceStatus,
    validateSingletons,
};

