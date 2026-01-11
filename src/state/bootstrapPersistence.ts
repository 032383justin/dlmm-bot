/**
 * Bootstrap Persistence — Restart-Safe Bootstrap State Management
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREVENTS: Bootstrap re-triggering on every restart
 * ENABLES: Resume bootstrap state after restart if valid
 * 
 * DECISION RULE:
 *   On process start:
 *   - Load bootstrap state from DB
 *   - If now < bootstrap_ends_at AND cycles_remaining > 0: RESUME
 *   - If sufficient telemetry coverage exists: SKIP bootstrap
 *   - Otherwise: Bootstrap is OFF (or START if explicitly triggered)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { supabase } from '../db/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const BOOTSTRAP_PERSIST_CONFIG = {
    /** Lookback window for telemetry coverage check (hours) */
    WARMUP_LOOKBACK_HOURS: 6,
    
    /** Minimum snapshots in lookback to skip bootstrap */
    SNAPSHOT_MIN_RESUME: 50,
    
    /** Minimum snapshots per pool to consider it ready */
    SNAPSHOT_MIN_RESUME_POOL: 15,
    
    /** Minimum number of pools that must be ready */
    N_POOLS_READY: 3,
    
    /** Bootstrap duration (hours) */
    BOOTSTRAP_DURATION_HOURS: 6,
    
    /** Bootstrap cycles (legacy compatibility) */
    BOOTSTRAP_CYCLES: 12,
    
    /** Runtime state table name */
    RUNTIME_STATE_TABLE: 'runtime_state',
    
    // ═══════════════════════════════════════════════════════════════════════════
    // WARM POOL THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Snapshots required for pool to be "warm" */
    WARM_POOL_SNAPSHOTS: 15,
    
    /** Fast warm path: minimum pool age (minutes) */
    FAST_WARM_AGE_MINUTES: 30,
    
    /** Fast warm path: minimum snapshots (relaxed) */
    FAST_WARM_SNAPSHOTS: 8,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PROBE POSITION LIMITS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Maximum probe size as % of equity */
    PROBE_MAX_SIZE_PCT: 0.005,  // 0.5%
    
    /** Maximum probes per pool */
    PROBE_MAX_PER_POOL: 1,
    
    /** Maximum total concurrent probes */
    PROBE_MAX_CONCURRENT: 2,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BootstrapState {
    active: boolean;
    startedAt: number | null;
    endsAt: number | null;
    cyclesRemaining: number;
    lastEntryAt: number | null;
}

export type BootstrapDecision = 'RESUME' | 'START' | 'OFF' | 'SKIP';

export interface BootstrapInitResult {
    decision: BootstrapDecision;
    reason: string;
    state: BootstrapState;
    warmPools: number;
    snapshotsLookback: number;
}

export interface WarmPoolCheck {
    isWarm: boolean;
    snapshots: number;
    poolAgeMinutes: number;
    warmPath: 'SNAPSHOTS' | 'FAST_WARM' | 'NONE';
}

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════════════════

let currentBootstrapState: BootstrapState = {
    active: false,
    startedAt: null,
    endsAt: null,
    cyclesRemaining: 0,
    lastEntryAt: null,
};

/** Track active probes by pool */
const activeProbes = new Map<string, Set<string>>();  // poolAddress -> Set<tradeId>

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ensure runtime_state table exists
 */
async function ensureRuntimeStateTable(): Promise<void> {
    // Check if table exists by trying to select from it
    const { error } = await supabase
        .from(BOOTSTRAP_PERSIST_CONFIG.RUNTIME_STATE_TABLE)
        .select('key')
        .limit(1);
    
    if (error && error.code === '42P01') {
        // Table doesn't exist - we'll use a simpler approach with settings table
        logger.warn(`[BOOTSTRAP] runtime_state table not found, using fallback storage`);
    }
}

/**
 * Load bootstrap state from DB
 */
async function loadBootstrapStateFromDB(): Promise<BootstrapState | null> {
    try {
        const { data, error } = await supabase
            .from(BOOTSTRAP_PERSIST_CONFIG.RUNTIME_STATE_TABLE)
            .select('key, value')
            .in('key', [
                'bootstrap_active',
                'bootstrap_started_at',
                'bootstrap_ends_at',
                'bootstrap_cycles_remaining',
                'bootstrap_last_entry_at',
            ]);
        
        if (error) {
            logger.debug(`[BOOTSTRAP] Failed to load state from DB: ${error.message}`);
            return null;
        }
        
        if (!data || data.length === 0) {
            return null;
        }
        
        const stateMap = new Map<string, string>(
            data.map((r: { key: string; value: string }) => [r.key, r.value] as [string, string])
        );
        
        const startedAtStr = stateMap.get('bootstrap_started_at') ?? '';
        const endsAtStr = stateMap.get('bootstrap_ends_at') ?? '';
        const cyclesStr = stateMap.get('bootstrap_cycles_remaining') ?? '';
        const lastEntryStr = stateMap.get('bootstrap_last_entry_at') ?? '';
        
        return {
            active: stateMap.get('bootstrap_active') === 'true',
            startedAt: startedAtStr.length > 0 
                ? parseInt(startedAtStr, 10) 
                : null,
            endsAt: endsAtStr.length > 0 
                ? parseInt(endsAtStr, 10) 
                : null,
            cyclesRemaining: cyclesStr.length > 0 
                ? parseInt(cyclesStr, 10) 
                : 0,
            lastEntryAt: lastEntryStr.length > 0 
                ? parseInt(lastEntryStr, 10) 
                : null,
        };
    } catch (err: any) {
        logger.debug(`[BOOTSTRAP] Error loading state: ${err.message}`);
        return null;
    }
}

/**
 * Save bootstrap state to DB
 */
async function saveBootstrapStateToDB(state: BootstrapState): Promise<void> {
    try {
        const rows = [
            { key: 'bootstrap_active', value: state.active.toString() },
            { key: 'bootstrap_started_at', value: state.startedAt?.toString() ?? '' },
            { key: 'bootstrap_ends_at', value: state.endsAt?.toString() ?? '' },
            { key: 'bootstrap_cycles_remaining', value: state.cyclesRemaining.toString() },
            { key: 'bootstrap_last_entry_at', value: state.lastEntryAt?.toString() ?? '' },
        ];
        
        for (const row of rows) {
            await supabase
                .from(BOOTSTRAP_PERSIST_CONFIG.RUNTIME_STATE_TABLE)
                .upsert({ key: row.key, value: row.value }, { onConflict: 'key' });
        }
    } catch (err: any) {
        logger.debug(`[BOOTSTRAP] Error saving state: ${err.message}`);
    }
}

/**
 * Query telemetry coverage from DB
 */
async function queryTelemetryCoverage(): Promise<{ totalSnapshots: number; warmPools: number }> {
    try {
        const lookbackMs = BOOTSTRAP_PERSIST_CONFIG.WARMUP_LOOKBACK_HOURS * 60 * 60 * 1000;
        const cutoffTime = new Date(Date.now() - lookbackMs).toISOString();
        
        // Query snapshot counts per pool in the lookback window
        const { data, error } = await supabase
            .from('pool_snapshots')
            .select('pool_address, created_at')
            .gte('created_at', cutoffTime);
        
        if (error || !data) {
            return { totalSnapshots: 0, warmPools: 0 };
        }
        
        const totalSnapshots = data.length;
        
        // Count snapshots per pool
        const poolCounts = new Map<string, number>();
        for (const snapshot of data) {
            const count = poolCounts.get(snapshot.pool_address) ?? 0;
            poolCounts.set(snapshot.pool_address, count + 1);
        }
        
        // Count pools with sufficient snapshots
        let warmPools = 0;
        for (const count of poolCounts.values()) {
            if (count >= BOOTSTRAP_PERSIST_CONFIG.SNAPSHOT_MIN_RESUME_POOL) {
                warmPools++;
            }
        }
        
        return { totalSnapshots, warmPools };
    } catch (err: any) {
        logger.debug(`[BOOTSTRAP] Error querying telemetry: ${err.message}`);
        return { totalSnapshots: 0, warmPools: 0 };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize bootstrap state on process start
 * 
 * Decision flow:
 *   1. Load state from DB
 *   2. If state exists and still valid (now < endsAt, cycles > 0): RESUME
 *   3. Query telemetry coverage
 *   4. If sufficient coverage: SKIP
 *   5. Otherwise: OFF (or START if triggered by first entry)
 */
export async function initializeBootstrapState(): Promise<BootstrapInitResult> {
    const now = Date.now();
    const config = BOOTSTRAP_PERSIST_CONFIG;
    
    await ensureRuntimeStateTable();
    
    // Step 1: Load existing state from DB
    const savedState = await loadBootstrapStateFromDB();
    
    // Step 2: Check if saved state is still valid
    if (savedState && savedState.active && savedState.endsAt && savedState.cyclesRemaining > 0) {
        if (now < savedState.endsAt) {
            // RESUME: Bootstrap is still active
            currentBootstrapState = savedState;
            
            const result: BootstrapInitResult = {
                decision: 'RESUME',
                reason: `Resuming from saved state (${savedState.cyclesRemaining} cycles remaining)`,
                state: currentBootstrapState,
                warmPools: 0,
                snapshotsLookback: 0,
            };
            
            logBootstrapInit(result);
            return result;
        }
    }
    
    // Step 3: Query telemetry coverage
    const { totalSnapshots, warmPools } = await queryTelemetryCoverage();
    
    // Step 4: Check if sufficient coverage to skip bootstrap
    const hasSufficientCoverage = 
        totalSnapshots >= config.SNAPSHOT_MIN_RESUME ||
        warmPools >= config.N_POOLS_READY;
    
    if (hasSufficientCoverage) {
        // SKIP: Sufficient telemetry exists
        currentBootstrapState = {
            active: false,
            startedAt: null,
            endsAt: null,
            cyclesRemaining: 0,
            lastEntryAt: null,
        };
        
        const result: BootstrapInitResult = {
            decision: 'SKIP',
            reason: `Sufficient recent telemetry (snapshots=${totalSnapshots} warmPools=${warmPools})`,
            state: currentBootstrapState,
            warmPools,
            snapshotsLookback: totalSnapshots,
        };
        
        logBootstrapInit(result);
        return result;
    }
    
    // Step 5: Bootstrap is OFF (will START on first entry if needed)
    currentBootstrapState = {
        active: false,
        startedAt: null,
        endsAt: null,
        cyclesRemaining: 0,
        lastEntryAt: null,
    };
    
    const result: BootstrapInitResult = {
        decision: 'OFF',
        reason: `No saved state, insufficient telemetry (snapshots=${totalSnapshots} warmPools=${warmPools})`,
        state: currentBootstrapState,
        warmPools,
        snapshotsLookback: totalSnapshots,
    };
    
    logBootstrapInit(result);
    return result;
}

/**
 * Start bootstrap (called on first entry when no telemetry exists)
 */
export async function startBootstrap(): Promise<void> {
    const now = Date.now();
    const config = BOOTSTRAP_PERSIST_CONFIG;
    
    // Check if we should actually start bootstrap
    const { totalSnapshots, warmPools } = await queryTelemetryCoverage();
    
    if (totalSnapshots >= config.SNAPSHOT_MIN_RESUME || warmPools >= config.N_POOLS_READY) {
        logger.info(
            `[BOOTSTRAP] SKIP: sufficient recent telemetry ` +
            `(snapshots=${totalSnapshots} poolsReady=${warmPools})`
        );
        return;
    }
    
    currentBootstrapState = {
        active: true,
        startedAt: now,
        endsAt: now + (config.BOOTSTRAP_DURATION_HOURS * 60 * 60 * 1000),
        cyclesRemaining: config.BOOTSTRAP_CYCLES,
        lastEntryAt: now,
    };
    
    await saveBootstrapStateToDB(currentBootstrapState);
    
    logger.info(
        `[BOOTSTRAP] START: No prior telemetry baseline | ` +
        `duration=${config.BOOTSTRAP_DURATION_HOURS}h cycles=${config.BOOTSTRAP_CYCLES}`
    );
}

/**
 * Record entry during bootstrap
 */
export async function recordBootstrapEntry(): Promise<void> {
    if (!currentBootstrapState.active) return;
    
    currentBootstrapState.lastEntryAt = Date.now();
    await saveBootstrapStateToDB(currentBootstrapState);
}

/**
 * Decrement bootstrap cycle count
 */
export async function decrementBootstrapCycle(): Promise<void> {
    if (!currentBootstrapState.active) return;
    
    currentBootstrapState.cyclesRemaining--;
    
    if (currentBootstrapState.cyclesRemaining <= 0) {
        currentBootstrapState.active = false;
        logger.info(`[BOOTSTRAP] COMPLETE: All cycles exhausted`);
    }
    
    await saveBootstrapStateToDB(currentBootstrapState);
}

/**
 * Check if bootstrap should end (time or cycles)
 */
export function checkBootstrapEnd(): boolean {
    if (!currentBootstrapState.active) return true;
    
    const now = Date.now();
    
    if (currentBootstrapState.endsAt && now >= currentBootstrapState.endsAt) {
        currentBootstrapState.active = false;
        logger.info(`[BOOTSTRAP] COMPLETE: Time limit reached`);
        saveBootstrapStateToDB(currentBootstrapState).catch(() => {});
        return true;
    }
    
    if (currentBootstrapState.cyclesRemaining <= 0) {
        currentBootstrapState.active = false;
        logger.info(`[BOOTSTRAP] COMPLETE: All cycles exhausted`);
        saveBootstrapStateToDB(currentBootstrapState).catch(() => {});
        return true;
    }
    
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WARM POOL CHECKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a pool is "warm" (has sufficient telemetry)
 */
export function isPoolWarm(
    poolId: string,
    snapshotsInLookback: number,
    poolAgeMinutes: number,
): WarmPoolCheck {
    const config = BOOTSTRAP_PERSIST_CONFIG;
    
    // Path 1: Full snapshot requirement met
    if (snapshotsInLookback >= config.WARM_POOL_SNAPSHOTS) {
        return {
            isWarm: true,
            snapshots: snapshotsInLookback,
            poolAgeMinutes,
            warmPath: 'SNAPSHOTS',
        };
    }
    
    // Path 2: Fast warm path (older pool with some snapshots)
    if (poolAgeMinutes >= config.FAST_WARM_AGE_MINUTES && 
        snapshotsInLookback >= config.FAST_WARM_SNAPSHOTS) {
        return {
            isWarm: true,
            snapshots: snapshotsInLookback,
            poolAgeMinutes,
            warmPath: 'FAST_WARM',
        };
    }
    
    // Not warm
    return {
        isWarm: false,
        snapshots: snapshotsInLookback,
        poolAgeMinutes,
        warmPath: 'NONE',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROBE POSITION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a probe position is allowed
 */
export function canOpenProbe(poolAddress: string, equity: number, requestedSize: number): {
    allowed: boolean;
    maxSize: number;
    reason: string;
} {
    const config = BOOTSTRAP_PERSIST_CONFIG;
    
    // Check size limit
    const maxSize = equity * config.PROBE_MAX_SIZE_PCT;
    if (requestedSize > maxSize) {
        return {
            allowed: false,
            maxSize,
            reason: `Probe size $${requestedSize.toFixed(0)} > max $${maxSize.toFixed(0)} (${config.PROBE_MAX_SIZE_PCT * 100}% equity)`,
        };
    }
    
    // Check per-pool limit
    const poolProbes = activeProbes.get(poolAddress);
    if (poolProbes && poolProbes.size >= config.PROBE_MAX_PER_POOL) {
        return {
            allowed: false,
            maxSize,
            reason: `Pool already has ${poolProbes.size} probes (max ${config.PROBE_MAX_PER_POOL})`,
        };
    }
    
    // Check total concurrent limit
    let totalProbes = 0;
    for (const probes of activeProbes.values()) {
        totalProbes += probes.size;
    }
    if (totalProbes >= config.PROBE_MAX_CONCURRENT) {
        return {
            allowed: false,
            maxSize,
            reason: `Total probes ${totalProbes} >= max ${config.PROBE_MAX_CONCURRENT}`,
        };
    }
    
    return {
        allowed: true,
        maxSize,
        reason: 'OK',
    };
}

/**
 * Register an active probe
 */
export function registerProbe(poolAddress: string, tradeId: string): void {
    let poolProbes = activeProbes.get(poolAddress);
    if (!poolProbes) {
        poolProbes = new Set();
        activeProbes.set(poolAddress, poolProbes);
    }
    poolProbes.add(tradeId);
    
    logger.info(`[PROBE] Registered probe ${tradeId.slice(0, 8)} for pool ${poolAddress.slice(0, 8)}`);
}

/**
 * Unregister a probe (on exit)
 */
export function unregisterProbe(poolAddress: string, tradeId: string): void {
    const poolProbes = activeProbes.get(poolAddress);
    if (poolProbes) {
        poolProbes.delete(tradeId);
        if (poolProbes.size === 0) {
            activeProbes.delete(poolAddress);
        }
    }
}

/**
 * Check if a trade is a probe
 */
export function isProbePosition(tradeId: string): boolean {
    for (const probes of activeProbes.values()) {
        if (probes.has(tradeId)) {
            return true;
        }
    }
    return false;
}

/**
 * Get total active probe count
 */
export function getActiveProbeCount(): number {
    let total = 0;
    for (const probes of activeProbes.values()) {
        total += probes.size;
    }
    return total;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE ACCESSORS
// ═══════════════════════════════════════════════════════════════════════════════

export function isBootstrapActive(): boolean {
    checkBootstrapEnd();  // Side effect: updates state if ended
    return currentBootstrapState.active;
}

export function getBootstrapState(): BootstrapState {
    return { ...currentBootstrapState };
}

export function getBootstrapTimeRemaining(): number {
    if (!currentBootstrapState.active || !currentBootstrapState.endsAt) {
        return 0;
    }
    return Math.max(0, currentBootstrapState.endsAt - Date.now());
}

export function getBootstrapCyclesRemaining(): number {
    return currentBootstrapState.cyclesRemaining;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

function logBootstrapInit(result: BootstrapInitResult): void {
    const endsAtStr = result.state.endsAt 
        ? new Date(result.state.endsAt).toISOString() 
        : 'N/A';
    
    logger.info(
        `[BOOTSTRAP] state=${result.decision} reason=${result.reason} ` +
        `endsAt=${endsAtStr} cyclesRemaining=${result.state.cyclesRemaining} ` +
        `warmPools=${result.warmPools} snapshotsLookback=${result.snapshotsLookback}`
    );
}
