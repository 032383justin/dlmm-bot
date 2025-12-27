/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RECONCILIATION SEAL — SINGLE SOURCE OF TRUTH ENFORCEMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides a global, immutable runtime seal that ensures:
 * 1. Reconciliation runs exactly ONCE at startup
 * 2. No component may recompute capital or positions after reconciliation
 * 3. DB truth is frozen into runtime truth at seal time
 * 4. Any attempt to bypass the seal → fatal error
 * 
 * ARCHITECTURAL RULES:
 * - sealReconciliation() is called ONLY after [RECONCILE-SUMMARY] succeeds
 * - assertReconciliationSealed() MUST be called before any capital/position init
 * - getReconciliationSealData() provides frozen state for hydration
 * - Once sealed, the seal data is IMMUTABLE
 * 
 * FAIL CLOSED:
 * - If Ledger/ScanLoop attempt initialization before seal → process.exit(1)
 * - If Engine mode changes after seal → process.exit(1)
 * - No exceptions, no warnings, no auto-correction
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sealed reconciliation data - frozen at seal time
 */
export interface ReconciliationSealData {
    /** Number of open positions after reconciliation */
    readonly openAfter: number;
    
    /** Locked capital after reconciliation (should be 0 if openAfter = 0) */
    readonly lockedCapital: number;
    
    /** Available capital after reconciliation */
    readonly availableCapital: number;
    
    /** Total equity after reconciliation */
    readonly totalEquity: number;
    
    /** Number of positions closed during recovery */
    readonly recoveredCount: number;
    
    /** Reconciliation mode */
    readonly mode: 'fresh_start' | 'continuation';
    
    /** Run ID for this session */
    readonly runId: string | null;
    
    /** Timestamp when seal was created */
    readonly sealedAt: number;
    
    /** Engine mode at seal time (must remain STATEFUL) */
    readonly engineMode: 'STATEFUL';
}

/**
 * Hydration data for positions that must be loaded
 * 
 * CRITICAL: openPositionIds are from the positions table, NOT trades table.
 * Positions table is the SINGLE SOURCE OF TRUTH for open positions.
 */
export interface HydrationRequirement {
    /** 
     * Position IDs (trade_id from positions table) that must be hydrated.
     * AUTHORITATIVE: These are the ONLY IDs that should be loaded.
     * ExecutionEngine and ScanLoop MUST NOT query trades table for open positions.
     */
    readonly openPositionIds: readonly string[];
    
    /** Total locked capital that must be accounted for */
    readonly totalLockedUsd: number;
    
    /** Must match openAfter from seal */
    readonly expectedCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL STATE — IMMUTABLE AFTER SEAL
// ═══════════════════════════════════════════════════════════════════════════════

let reconciliationSealed: boolean = false;
let sealData: ReconciliationSealData | null = null;
let hydrationRequirement: HydrationRequirement | null = null;
let engineModeAtSeal: 'STATEFUL' | 'STATELESS' | null = null;

// ═══════════════════════════════════════════════════════════════════════════════
// SEAL OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Seal reconciliation state - called ONLY after [RECONCILE-SUMMARY] succeeds
 * 
 * After this call:
 * - No component may recompute capital or positions independently
 * - DB truth is frozen into runtime truth
 * - Engine mode is locked to STATEFUL
 * - openPositionIds become the ONLY authoritative source for position hydration
 * 
 * @param data - Reconciliation summary data to freeze
 * @param hydration - Optional hydration requirements for positions (MUST use openPositionIds)
 */
export function sealReconciliation(
    data: Omit<ReconciliationSealData, 'sealedAt' | 'engineMode'>,
    hydration?: { openPositionIds: string[]; totalLockedUsd: number }
): void {
    // CRITICAL: Can only seal once
    if (reconciliationSealed) {
        logger.error('[RECONCILIATION-SEAL] ❌ Attempted to seal reconciliation twice — FATAL');
        logger.error('   Reconciliation can only be sealed once per process.');
        logger.error('   This indicates a critical bug in the startup sequence.');
        process.exit(1);
    }
    
    // Freeze the seal data
    sealData = Object.freeze({
        ...data,
        sealedAt: Date.now(),
        engineMode: 'STATEFUL' as const,
    });
    
    // Freeze hydration requirements if positions exist
    // CRITICAL: openPositionIds are from positions table - the SINGLE SOURCE OF TRUTH
    if (hydration && data.openAfter > 0) {
        hydrationRequirement = Object.freeze({
            openPositionIds: Object.freeze([...hydration.openPositionIds]),
            totalLockedUsd: hydration.totalLockedUsd,
            expectedCount: data.openAfter,
        });
    }
    
    // Lock engine mode
    engineModeAtSeal = 'STATEFUL';
    
    // Mark as sealed
    reconciliationSealed = true;
    
    // Log seal event
    logger.info('');
    logger.info('════════════════════════════════════════════════════════════════');
    logger.info('🔒 [RECONCILIATION-SEAL] STATE SEALED');
    logger.info('════════════════════════════════════════════════════════════════');
    logger.info(`   Open Positions: ${sealData.openAfter}`);
    logger.info(`   Locked Capital: $${sealData.lockedCapital.toFixed(2)}`);
    logger.info(`   Available Capital: $${sealData.availableCapital.toFixed(2)}`);
    logger.info(`   Total Equity: $${sealData.totalEquity.toFixed(2)}`);
    logger.info(`   Recovered Count: ${sealData.recoveredCount}`);
    logger.info(`   Mode: ${sealData.mode.toUpperCase()}`);
    logger.info(`   Run ID: ${sealData.runId}`);
    logger.info(`   Engine Mode: STATEFUL (LOCKED)`);
    if (hydrationRequirement) {
        logger.info(`   Hydration Required: ${hydrationRequirement.expectedCount} positions`);
    }
    logger.info('════════════════════════════════════════════════════════════════');
    logger.info('');
}

/**
 * Assert that reconciliation has been sealed
 * 
 * MUST be called before:
 * - Ledger initialization
 * - ScanLoop start
 * - Any capital recomputation
 * 
 * FAILS CLOSED: If not sealed, process.exit(1)
 */
export function assertReconciliationSealed(caller: string = 'UNKNOWN'): void {
    if (!reconciliationSealed) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚨 [RECONCILIATION-SEAL] FATAL: Seal not set');
        console.error('════════════════════════════════════════════════════════════════');
        console.error(`   Caller: ${caller}`);
        console.error(`   Component attempted to initialize before reconciliation seal.`);
        console.error('   This is a critical startup sequence error.');
        console.error('');
        console.error('   ARCHITECTURAL RULE:');
        console.error('   - Reconciliation MUST complete before Ledger/ScanLoop init');
        console.error('   - sealReconciliation() MUST be called after [RECONCILE-SUMMARY]');
        console.error('════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
}

/**
 * Assert that engine mode has not changed from sealed value
 * 
 * FAILS CLOSED: If mode changed, process.exit(1)
 */
export function assertEngineModeUnchanged(currentMode: 'STATEFUL' | 'STATELESS'): void {
    if (!reconciliationSealed) {
        // Before seal, engine mode is not locked
        return;
    }
    
    if (engineModeAtSeal !== currentMode) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚨 [RECONCILIATION-SEAL] FATAL: Engine mode changed after seal');
        console.error('════════════════════════════════════════════════════════════════');
        console.error(`   Sealed Mode: ${engineModeAtSeal}`);
        console.error(`   Current Mode: ${currentMode}`);
        console.error('   Engine mode is LOCKED after reconciliation.');
        console.error('   Downgrade from STATEFUL to STATELESS is FORBIDDEN.');
        console.error('════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEAL ACCESSORS (READ-ONLY)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if reconciliation has been sealed
 */
export function isReconciliationSealed(): boolean {
    return reconciliationSealed;
}

/**
 * Get the frozen reconciliation seal data
 * 
 * Returns null if not yet sealed.
 * The returned object is frozen and immutable.
 */
export function getReconciliationSealData(): Readonly<ReconciliationSealData> | null {
    return sealData;
}

/**
 * Get hydration requirements for positions
 * 
 * Returns null if:
 * - Not yet sealed
 * - No positions require hydration (openAfter = 0)
 */
export function getHydrationRequirement(): Readonly<HydrationRequirement> | null {
    return hydrationRequirement;
}

/**
 * Check if position hydration is required
 */
export function isHydrationRequired(): boolean {
    return hydrationRequirement !== null && hydrationRequirement.expectedCount > 0;
}

/**
 * Get expected open position count from seal
 */
export function getSealedOpenPositionCount(): number {
    return sealData?.openAfter ?? 0;
}

/**
 * Get sealed locked capital
 */
export function getSealedLockedCapital(): number {
    return sealData?.lockedCapital ?? 0;
}

/**
 * Get sealed available capital
 */
export function getSealedAvailableCapital(): number {
    return sealData?.availableCapital ?? 0;
}

/**
 * Get sealed total equity
 */
export function getSealedTotalEquity(): number {
    return sealData?.totalEquity ?? 0;
}

/**
 * Get sealed open position IDs
 * 
 * CRITICAL: These IDs are the ONLY authoritative source for position hydration.
 * ExecutionEngine and ScanLoop MUST use these IDs to load positions.
 * They MUST NOT query the trades table to determine open positions.
 * 
 * @returns Array of position IDs (trade_id from positions table) that are sealed as open
 */
export function getSealedOpenPositionIds(): readonly string[] {
    return hydrationRequirement?.openPositionIds ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// HYDRATION VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate that hydration completed correctly
 * 
 * MUST be called after Ledger hydration if hydration was required.
 * 
 * @param hydratedCount - Number of positions actually hydrated
 * @param hydratedLockedUsd - Total locked capital from hydrated positions
 * @returns true if valid, throws if mismatch
 */
export function validateHydration(hydratedCount: number, hydratedLockedUsd: number): boolean {
    if (!hydrationRequirement) {
        // No hydration required - any count is valid
        return true;
    }
    
    const tolerance = 0.01; // $0.01 tolerance for floating point
    
    // Validate position count
    if (hydratedCount !== hydrationRequirement.expectedCount) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚨 [RECONCILIATION-SEAL] FATAL: Hydration count mismatch');
        console.error('════════════════════════════════════════════════════════════════');
        console.error(`   Expected: ${hydrationRequirement.expectedCount} positions`);
        console.error(`   Hydrated: ${hydratedCount} positions`);
        console.error('   Position hydration MUST match reconciliation seal.');
        console.error('════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    
    // Validate locked capital
    const lockedDiff = Math.abs(hydratedLockedUsd - hydrationRequirement.totalLockedUsd);
    if (lockedDiff > tolerance) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚨 [RECONCILIATION-SEAL] FATAL: Hydration capital mismatch');
        console.error('════════════════════════════════════════════════════════════════');
        console.error(`   Expected Locked: $${hydrationRequirement.totalLockedUsd.toFixed(2)}`);
        console.error(`   Hydrated Locked: $${hydratedLockedUsd.toFixed(2)}`);
        console.error(`   Difference: $${lockedDiff.toFixed(2)}`);
        console.error('   Locked capital MUST match reconciliation seal.');
        console.error('════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    
    logger.info(`[RECONCILIATION-SEAL] ✅ Hydration validated: ${hydratedCount} positions, $${hydratedLockedUsd.toFixed(2)} locked`);
    return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL REBUILD GUARD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if capital rebuild is allowed
 * 
 * RULE: Ledger may only rebuild capital if:
 *   positions.length === 0 AND lockedCapital === 0
 * 
 * Otherwise capital MUST be derived from hydrated positions.
 * 
 * @param attemptedPositionCount - Positions attempting to rebuild with
 * @param attemptedLockedCapital - Locked capital attempting to rebuild with
 * @returns true if rebuild is allowed
 */
export function canRebuildCapital(attemptedPositionCount: number, attemptedLockedCapital: number): boolean {
    if (!reconciliationSealed) {
        // Before seal, rebuild is allowed (pre-reconciliation state)
        return true;
    }
    
    const sealed = sealData!;
    
    // Rule: Can only rebuild from scratch if no positions exist
    if (sealed.openAfter === 0 && sealed.lockedCapital < 0.01) {
        // Clean slate - rebuild allowed
        return true;
    }
    
    // Positions exist - must derive capital from positions, not rebuild
    if (attemptedPositionCount === 0 && sealed.openAfter > 0) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚨 [RECONCILIATION-SEAL] FATAL: Capital rebuild without positions');
        console.error('════════════════════════════════════════════════════════════════');
        console.error(`   Sealed Open Positions: ${sealed.openAfter}`);
        console.error(`   Attempted Position Count: ${attemptedPositionCount}`);
        console.error('   Capital CANNOT be rebuilt when positions exist.');
        console.error('   Positions must be hydrated first, then capital derived.');
        console.error('════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
    
    return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reset seal state (FOR TESTING ONLY)
 * 
 * This should NEVER be called in production.
 */
export function __resetSealForTesting(): void {
    if (process.env.NODE_ENV !== 'test') {
        logger.error('[RECONCILIATION-SEAL] __resetSealForTesting called outside test environment');
        return;
    }
    
    reconciliationSealed = false;
    sealData = null;
    hydrationRequirement = null;
    engineModeAtSeal = null;
}

