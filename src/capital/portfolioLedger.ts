/**
 * Portfolio Ledger — Single Source of Truth for Capital State
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * ARCHITECTURAL BACKBONE — ALL CAPITAL STATE MUST FLOW THROUGH THIS MODULE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Eliminate deployed-capital, tier-allocation, and risk-reporting
 * inconsistencies by providing ONE authoritative definition of portfolio state.
 * 
 * INVARIANTS (HARD RULES):
 *   1. deployedUsd === sum(open positions notionalUsd)
 *   2. availableUsd + deployedUsd + lockedUsd === totalCapitalUsd
 *   3. Tier allocations exactly match open positions
 *   4. Per-pool totals match sum of pool positions
 * 
 * VIOLATIONS:
 *   - DEV_MODE: throw Error immediately
 *   - PROD: log [LEDGER-ERROR] with full breakdown
 * 
 * INTEGRATION:
 *   - All modules MUST consume getLedgerState(), not re-derive state
 *   - Capital debits/credits MUST call onPositionOpen/Update/Close
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

export const LEDGER_CONFIG = {
    /**
     * Tolerance for invariant checks (accounts for floating point)
     */
    invariantToleranceUsd: 0.01,
    
    /**
     * Log prefix for ledger operations
     */
    logPrefix: '[LEDGER]',
    
    /**
     * Enable verbose logging
     */
    verboseLogging: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type TierType = 'A' | 'B' | 'C' | 'D';

/**
 * Individual position tracked by the ledger
 */
export interface LedgerPosition {
    tradeId: string;
    pool: string;
    poolName: string;
    tier: TierType;
    notionalUsd: number;
    openedAt: number;
}

/**
 * Per-tier aggregation
 */
export interface TierAllocation {
    positions: number;
    deployedUsd: number;
}

/**
 * Per-pool aggregation
 */
export interface PoolAllocation {
    deployedUsd: number;
    positions: number;
}

/**
 * Complete portfolio ledger state
 */
export interface PortfolioLedgerState {
    // Core capital
    totalCapitalUsd: number;
    deployedUsd: number;
    availableUsd: number;
    lockedUsd: number;
    
    // Aggregations
    perTier: Record<TierType, TierAllocation>;
    perPool: Record<string, PoolAllocation>;
    
    // Meta
    positionCount: number;
    lastUpdated: number;
}

/**
 * Invariant check result
 */
export interface InvariantCheckResult {
    valid: boolean;
    errors: string[];
    computed: {
        sumPositions: number;
        sumTierDeployed: number;
        sumPoolDeployed: number;
        capitalEquation: number; // available + deployed + locked
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEDGER STATE (SINGLE SOURCE OF TRUTH)
// ═══════════════════════════════════════════════════════════════════════════════

// Core state
let totalCapitalUsd: number = 0;
let lockedUsd: number = 0;

// Position storage
const positions = new Map<string, LedgerPosition>();

// Derived caches (recomputed on every mutation)
let cachedState: PortfolioLedgerState | null = null;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the portfolio ledger with total capital
 * 
 * MUST be called before any other ledger operations.
 * Clears any existing positions and resets state.
 * 
 * @param capital - Total capital available for trading
 */
export function initializeLedger(capital: number): void {
    if (capital <= 0) {
        throw new Error(`[LEDGER] Invalid capital: $${capital} - must be positive`);
    }
    
    totalCapitalUsd = capital;
    lockedUsd = 0;
    positions.clear();
    cachedState = null;
    
    logger.info(
        `${LEDGER_CONFIG.logPrefix} initialized totalCapital=$${capital.toFixed(2)} ` +
        `available=$${capital.toFixed(2)} positions=0`
    );
    
    // Verify invariants after init
    assertLedgerInvariants();
}

/**
 * Record a new position opening
 * 
 * MUST be called when a trade is opened.
 * Updates deployed and available capital.
 * 
 * @param position - The position being opened
 */
export function onPositionOpen(position: LedgerPosition): void {
    // Validate input
    if (!position.tradeId) {
        throw new Error(`[LEDGER] Position missing tradeId`);
    }
    if (position.notionalUsd <= 0) {
        throw new Error(`[LEDGER] Invalid notional: $${position.notionalUsd}`);
    }
    
    // Check for duplicate
    if (positions.has(position.tradeId)) {
        logger.warn(`${LEDGER_CONFIG.logPrefix} Duplicate position open for ${position.tradeId} - updating instead`);
        onPositionUpdate(position.tradeId, position.notionalUsd);
        return;
    }
    
    // Check available capital
    const state = getLedgerState();
    if (position.notionalUsd > state.availableUsd + LEDGER_CONFIG.invariantToleranceUsd) {
        const error = `[LEDGER] Insufficient capital: trying to deploy $${position.notionalUsd.toFixed(2)} but only $${state.availableUsd.toFixed(2)} available`;
        logger.error(error);
        if (DEV_MODE) {
            throw new Error(error);
        }
        // In PROD, still record but log error
    }
    
    // Record position
    positions.set(position.tradeId, { ...position });
    cachedState = null; // Invalidate cache
    
    // Log
    logger.info(
        `${LEDGER_CONFIG.logPrefix} OPEN tradeId=${position.tradeId.slice(0, 8)}... ` +
        `pool=${position.poolName} tier=${position.tier} notional=$${position.notionalUsd.toFixed(2)}`
    );
    
    // Log sync summary
    logSyncSummary();
    
    // Verify invariants
    assertLedgerInvariants();
}

/**
 * Update an existing position's notional value
 * 
 * Use for partial closes or position adjustments.
 * 
 * @param tradeId - The trade ID to update
 * @param newNotionalUsd - New notional value
 */
export function onPositionUpdate(tradeId: string, newNotionalUsd: number): void {
    const position = positions.get(tradeId);
    if (!position) {
        logger.warn(`${LEDGER_CONFIG.logPrefix} Update for unknown position ${tradeId}`);
        return;
    }
    
    const delta = newNotionalUsd - position.notionalUsd;
    
    // Update position
    position.notionalUsd = newNotionalUsd;
    cachedState = null; // Invalidate cache
    
    if (LEDGER_CONFIG.verboseLogging) {
        logger.debug(
            `${LEDGER_CONFIG.logPrefix} UPDATE tradeId=${tradeId.slice(0, 8)}... ` +
            `newNotional=$${newNotionalUsd.toFixed(2)} delta=${delta >= 0 ? '+' : ''}$${delta.toFixed(2)}`
        );
    }
    
    // Verify invariants
    assertLedgerInvariants();
}

/**
 * Record a position closing
 * 
 * MUST be called when a trade is closed.
 * Releases deployed capital back to available.
 * 
 * @param tradeId - The trade ID being closed
 */
export function onPositionClose(tradeId: string): void {
    const position = positions.get(tradeId);
    if (!position) {
        logger.warn(`${LEDGER_CONFIG.logPrefix} Close for unknown position ${tradeId}`);
        return;
    }
    
    // Remove position
    positions.delete(tradeId);
    cachedState = null; // Invalidate cache
    
    // Log
    logger.info(
        `${LEDGER_CONFIG.logPrefix} CLOSE tradeId=${tradeId.slice(0, 8)}... ` +
        `pool=${position.poolName} tier=${position.tier} released=$${position.notionalUsd.toFixed(2)}`
    );
    
    // Log sync summary
    logSyncSummary();
    
    // Verify invariants
    assertLedgerInvariants();
}

/**
 * Update total capital (e.g., after P&L realization)
 * 
 * @param newTotalCapital - New total capital value
 */
export function updateTotalCapital(newTotalCapital: number): void {
    if (newTotalCapital <= 0) {
        logger.error(`${LEDGER_CONFIG.logPrefix} Invalid total capital update: $${newTotalCapital}`);
        return;
    }
    
    const delta = newTotalCapital - totalCapitalUsd;
    totalCapitalUsd = newTotalCapital;
    cachedState = null; // Invalidate cache
    
    if (Math.abs(delta) > 0.01) {
        logger.info(
            `${LEDGER_CONFIG.logPrefix} CAPITAL UPDATE total=$${newTotalCapital.toFixed(2)} ` +
            `delta=${delta >= 0 ? '+' : ''}$${delta.toFixed(2)}`
        );
    }
    
    // Verify invariants
    assertLedgerInvariants();
}

/**
 * Update locked capital (capital not available for trading)
 * 
 * @param newLockedUsd - New locked capital value
 */
export function updateLockedCapital(newLockedUsd: number): void {
    if (newLockedUsd < 0) {
        logger.error(`${LEDGER_CONFIG.logPrefix} Invalid locked capital: $${newLockedUsd}`);
        return;
    }
    
    lockedUsd = newLockedUsd;
    cachedState = null; // Invalidate cache
    
    // Verify invariants
    assertLedgerInvariants();
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE ACCESSORS (READ-ONLY)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the authoritative portfolio ledger state
 * 
 * THIS IS THE ONLY WAY TO ACCESS PORTFOLIO STATE.
 * All modules must use this function, not re-derive state.
 * 
 * @returns Complete portfolio state snapshot
 */
export function getLedgerState(): PortfolioLedgerState {
    // Return cached state if available
    if (cachedState) {
        return cachedState;
    }
    
    // Compute aggregations
    const perTier: Record<TierType, TierAllocation> = {
        A: { positions: 0, deployedUsd: 0 },
        B: { positions: 0, deployedUsd: 0 },
        C: { positions: 0, deployedUsd: 0 },
        D: { positions: 0, deployedUsd: 0 },
    };
    
    const perPool: Record<string, PoolAllocation> = {};
    
    let deployedUsd = 0;
    
    for (const position of positions.values()) {
        // Sum deployed
        deployedUsd += position.notionalUsd;
        
        // Per-tier aggregation
        perTier[position.tier].positions++;
        perTier[position.tier].deployedUsd += position.notionalUsd;
        
        // Per-pool aggregation
        if (!perPool[position.pool]) {
            perPool[position.pool] = { deployedUsd: 0, positions: 0 };
        }
        perPool[position.pool].deployedUsd += position.notionalUsd;
        perPool[position.pool].positions++;
    }
    
    // Compute available
    const availableUsd = totalCapitalUsd - deployedUsd - lockedUsd;
    
    // Build state
    cachedState = {
        totalCapitalUsd,
        deployedUsd,
        availableUsd,
        lockedUsd,
        perTier,
        perPool,
        positionCount: positions.size,
        lastUpdated: Date.now(),
    };
    
    return cachedState;
}

/**
 * Get all open positions
 * 
 * @returns Array of all open positions
 */
export function getOpenPositions(): LedgerPosition[] {
    return Array.from(positions.values());
}

/**
 * Get a specific position by trade ID
 * 
 * @param tradeId - The trade ID to look up
 * @returns The position or undefined if not found
 */
export function getPosition(tradeId: string): LedgerPosition | undefined {
    return positions.get(tradeId);
}

/**
 * Check if a position exists
 * 
 * @param tradeId - The trade ID to check
 * @returns True if position exists
 */
export function hasPosition(tradeId: string): boolean {
    return positions.has(tradeId);
}

/**
 * Get positions for a specific pool
 * 
 * @param poolAddress - The pool address
 * @returns Array of positions in the pool
 */
export function getPoolPositions(poolAddress: string): LedgerPosition[] {
    return Array.from(positions.values()).filter(p => p.pool === poolAddress);
}

/**
 * Get positions for a specific tier
 * 
 * @param tier - The tier to filter by
 * @returns Array of positions in the tier
 */
export function getTierPositions(tier: TierType): LedgerPosition[] {
    return Array.from(positions.values()).filter(p => p.tier === tier);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVED ACCESSORS (CONVENIENCE)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get deployed percentage of total capital
 */
export function getDeployedPct(): number {
    const state = getLedgerState();
    return state.totalCapitalUsd > 0 
        ? state.deployedUsd / state.totalCapitalUsd 
        : 0;
}

/**
 * Get tier exposure as percentage of total capital
 */
export function getTierExposurePct(tier: TierType): number {
    const state = getLedgerState();
    return state.totalCapitalUsd > 0
        ? state.perTier[tier].deployedUsd / state.totalCapitalUsd
        : 0;
}

/**
 * Get all tier exposures as percentages
 */
export function getAllTierExposures(): Record<TierType, number> {
    const state = getLedgerState();
    const equity = state.totalCapitalUsd;
    
    return {
        A: equity > 0 ? state.perTier.A.deployedUsd / equity : 0,
        B: equity > 0 ? state.perTier.B.deployedUsd / equity : 0,
        C: equity > 0 ? state.perTier.C.deployedUsd / equity : 0,
        D: equity > 0 ? state.perTier.D.deployedUsd / equity : 0,
    };
}

/**
 * Get pool exposure as percentage of total capital
 */
export function getPoolExposurePct(poolAddress: string): number {
    const state = getLedgerState();
    const poolAlloc = state.perPool[poolAddress];
    return (state.totalCapitalUsd > 0 && poolAlloc)
        ? poolAlloc.deployedUsd / state.totalCapitalUsd
        : 0;
}

/**
 * Get remaining capacity for a tier (before hitting cap)
 * 
 * @param tier - The tier to check
 * @param tierCapPct - The tier's cap as a percentage (e.g., 0.10 for 10%)
 * @returns Remaining capacity in USD
 */
export function getTierRemainingCapacity(tier: TierType, tierCapPct: number): number {
    const state = getLedgerState();
    const currentExposure = state.perTier[tier].deployedUsd;
    const maxExposure = state.totalCapitalUsd * tierCapPct;
    return Math.max(0, maxExposure - currentExposure);
}

/**
 * Get remaining portfolio capacity (before hitting total cap)
 * 
 * @param maxDeployedPct - Maximum deployed percentage (e.g., 0.25 for 25%)
 * @returns Remaining capacity in USD
 */
export function getPortfolioRemainingCapacity(maxDeployedPct: number): number {
    const state = getLedgerState();
    const maxDeployed = state.totalCapitalUsd * maxDeployedPct;
    return Math.max(0, maxDeployed - state.deployedUsd);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVARIANT ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check all ledger invariants
 * 
 * @returns Detailed check result
 */
export function checkLedgerInvariants(): InvariantCheckResult {
    const state = getLedgerState();
    const errors: string[] = [];
    
    // Compute sums from positions
    let sumPositions = 0;
    let sumTierDeployed = 0;
    let sumPoolDeployed = 0;
    
    for (const position of positions.values()) {
        sumPositions += position.notionalUsd;
    }
    
    for (const tier of Object.values(state.perTier)) {
        sumTierDeployed += tier.deployedUsd;
    }
    
    for (const pool of Object.values(state.perPool)) {
        sumPoolDeployed += pool.deployedUsd;
    }
    
    const capitalEquation = state.availableUsd + state.deployedUsd + state.lockedUsd;
    const tolerance = LEDGER_CONFIG.invariantToleranceUsd;
    
    // INVARIANT 1: deployedUsd === sum(positions.notionalUsd)
    if (Math.abs(state.deployedUsd - sumPositions) > tolerance) {
        errors.push(
            `INVARIANT 1 VIOLATED: deployedUsd ($${state.deployedUsd.toFixed(2)}) !== ` +
            `sum(positions) ($${sumPositions.toFixed(2)})`
        );
    }
    
    // INVARIANT 2: available + deployed + locked === totalCapital
    if (Math.abs(capitalEquation - state.totalCapitalUsd) > tolerance) {
        errors.push(
            `INVARIANT 2 VIOLATED: available ($${state.availableUsd.toFixed(2)}) + ` +
            `deployed ($${state.deployedUsd.toFixed(2)}) + ` +
            `locked ($${state.lockedUsd.toFixed(2)}) = $${capitalEquation.toFixed(2)} !== ` +
            `totalCapital ($${state.totalCapitalUsd.toFixed(2)})`
        );
    }
    
    // INVARIANT 3: Tier allocations match positions
    if (Math.abs(sumTierDeployed - state.deployedUsd) > tolerance) {
        errors.push(
            `INVARIANT 3 VIOLATED: sum(tierDeployed) ($${sumTierDeployed.toFixed(2)}) !== ` +
            `deployedUsd ($${state.deployedUsd.toFixed(2)})`
        );
    }
    
    // INVARIANT 4: Pool allocations match positions
    if (Math.abs(sumPoolDeployed - state.deployedUsd) > tolerance) {
        errors.push(
            `INVARIANT 4 VIOLATED: sum(poolDeployed) ($${sumPoolDeployed.toFixed(2)}) !== ` +
            `deployedUsd ($${state.deployedUsd.toFixed(2)})`
        );
    }
    
    // Additional check: No position with zero notional
    for (const [tradeId, position] of positions.entries()) {
        if (position.notionalUsd <= 0) {
            errors.push(`Position ${tradeId} has invalid notional: $${position.notionalUsd}`);
        }
    }
    
    return {
        valid: errors.length === 0,
        errors,
        computed: {
            sumPositions,
            sumTierDeployed,
            sumPoolDeployed,
            capitalEquation,
        },
    };
}

/**
 * Assert all ledger invariants hold
 * 
 * In DEV_MODE: throws Error on violation
 * In PROD: logs [LEDGER-ERROR] with full breakdown
 */
export function assertLedgerInvariants(): void {
    const check = checkLedgerInvariants();
    
    if (!check.valid) {
        const state = getLedgerState();
        const errorMsg = 
            `[LEDGER-ERROR] Invariant violation detected!\n` +
            `  Errors:\n${check.errors.map(e => `    - ${e}`).join('\n')}\n` +
            `  State Breakdown:\n` +
            `    totalCapital=$${state.totalCapitalUsd.toFixed(2)}\n` +
            `    deployed=$${state.deployedUsd.toFixed(2)}\n` +
            `    available=$${state.availableUsd.toFixed(2)}\n` +
            `    locked=$${state.lockedUsd.toFixed(2)}\n` +
            `    positionCount=${state.positionCount}\n` +
            `  Computed:\n` +
            `    sumPositions=$${check.computed.sumPositions.toFixed(2)}\n` +
            `    sumTierDeployed=$${check.computed.sumTierDeployed.toFixed(2)}\n` +
            `    sumPoolDeployed=$${check.computed.sumPoolDeployed.toFixed(2)}\n` +
            `    capitalEquation=$${check.computed.capitalEquation.toFixed(2)}`;
        
        if (DEV_MODE) {
            throw new Error(errorMsg);
        } else {
            logger.error(errorMsg);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC & RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sync ledger with external position data
 * 
 * Use this to reconcile with database positions on startup or after errors.
 * 
 * @param externalPositions - Positions from external source (e.g., DB)
 * @param newTotalCapital - Total capital from external source
 * @param newLockedCapital - Locked capital from external source
 */
export function syncFromExternal(
    externalPositions: LedgerPosition[],
    newTotalCapital: number,
    newLockedCapital: number = 0
): void {
    // Clear current state
    positions.clear();
    totalCapitalUsd = newTotalCapital;
    lockedUsd = newLockedCapital;
    cachedState = null;
    
    // Add all external positions
    for (const pos of externalPositions) {
        positions.set(pos.tradeId, { ...pos });
    }
    
    // Log sync
    const state = getLedgerState();
    logger.info(
        `${LEDGER_CONFIG.logPrefix} SYNCED from external ` +
        `positions=${externalPositions.length} ` +
        `deployed=$${state.deployedUsd.toFixed(2)} ` +
        `available=$${state.availableUsd.toFixed(2)} ` +
        `total=$${state.totalCapitalUsd.toFixed(2)}`
    );
    
    // Log tier breakdown
    logger.info(
        `${LEDGER_CONFIG.logPrefix} tierA=$${state.perTier.A.deployedUsd.toFixed(2)} ` +
        `tierB=$${state.perTier.B.deployedUsd.toFixed(2)} ` +
        `tierC=$${state.perTier.C.deployedUsd.toFixed(2)} ` +
        `tierD=$${state.perTier.D.deployedUsd.toFixed(2)}`
    );
    
    // Verify invariants
    assertLedgerInvariants();
}

/**
 * Log a sync summary (called after open/close)
 */
function logSyncSummary(): void {
    const state = getLedgerState();
    
    logger.info(
        `${LEDGER_CONFIG.logPrefix} synced positions=${state.positionCount} ` +
        `deployed=$${state.deployedUsd.toFixed(2)} ` +
        `available=$${state.availableUsd.toFixed(2)} ` +
        `tierA=$${state.perTier.A.deployedUsd.toFixed(2)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log the complete portfolio ledger state
 * 
 * Format matches spec:
 * PORTFOLIO LEDGER STATE
 * Total Capital:     $X
 * Available:         $Y
 * Locked:            $Z
 * Deployed:          $D (D / X %)
 * Remaining Capacity: $(maxDeploy - D)
 * 
 * TIER ALLOCATIONS
 * Tier A: n / cap | $X deployed
 * ...
 */
export function logLedgerState(
    tierCaps: Record<TierType, { maxPositions: number; capPct: number }>,
    maxDeployedPct: number
): void {
    const state = getLedgerState();
    const deployedPct = state.totalCapitalUsd > 0 
        ? (state.deployedUsd / state.totalCapitalUsd) * 100 
        : 0;
    
    const maxDeploy = state.totalCapitalUsd * maxDeployedPct;
    const remainingCapacity = Math.max(0, maxDeploy - state.deployedUsd);
    
    // Portfolio state
    logger.info(
        `[RISK] Portfolio: ${deployedPct.toFixed(1)}%/${(maxDeployedPct * 100).toFixed(0)}% deployed | ` +
        `Balance: $${state.availableUsd.toFixed(0)} | ` +
        `Equity: $${state.totalCapitalUsd.toFixed(0)}`
    );
    
    // Tier allocations
    const tierA = state.perTier.A;
    const tierB = state.perTier.B;
    const tierC = state.perTier.C;
    const tierD = state.perTier.D;
    
    const tierAExp = state.totalCapitalUsd > 0 ? (tierA.deployedUsd / state.totalCapitalUsd) * 100 : 0;
    const tierBExp = state.totalCapitalUsd > 0 ? (tierB.deployedUsd / state.totalCapitalUsd) * 100 : 0;
    const tierCExp = state.totalCapitalUsd > 0 ? (tierC.deployedUsd / state.totalCapitalUsd) * 100 : 0;
    
    logger.info(
        `[RISK] Tier exposure: ` +
        `A=${tierAExp.toFixed(1)}%/${(tierCaps.A.capPct * 100).toFixed(0)}% ` +
        `B=${tierBExp.toFixed(1)}%/${(tierCaps.B.capPct * 100).toFixed(0)}% ` +
        `C=${tierCExp.toFixed(1)}%/${(tierCaps.C.capPct * 100).toFixed(0)}%`
    );
}

/**
 * Log detailed ledger breakdown (for debugging)
 */
export function logDetailedLedgerState(): void {
    const state = getLedgerState();
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('PORTFOLIO LEDGER STATE');
    logger.info(`  Total Capital:      $${state.totalCapitalUsd.toFixed(2)}`);
    logger.info(`  Available:          $${state.availableUsd.toFixed(2)}`);
    logger.info(`  Locked:             $${state.lockedUsd.toFixed(2)}`);
    logger.info(`  Deployed:           $${state.deployedUsd.toFixed(2)} (${(getDeployedPct() * 100).toFixed(1)}%)`);
    logger.info(`  Positions:          ${state.positionCount}`);
    logger.info('');
    logger.info('TIER ALLOCATIONS');
    logger.info(`  Tier A: ${state.perTier.A.positions} positions | $${state.perTier.A.deployedUsd.toFixed(2)} deployed`);
    logger.info(`  Tier B: ${state.perTier.B.positions} positions | $${state.perTier.B.deployedUsd.toFixed(2)} deployed`);
    logger.info(`  Tier C: ${state.perTier.C.positions} positions | $${state.perTier.C.deployedUsd.toFixed(2)} deployed`);
    logger.info(`  Tier D: ${state.perTier.D.positions} positions | $${state.perTier.D.deployedUsd.toFixed(2)} deployed`);
    logger.info('');
    
    if (Object.keys(state.perPool).length > 0) {
        logger.info('POOL ALLOCATIONS');
        for (const [pool, alloc] of Object.entries(state.perPool)) {
            logger.info(`  ${pool.slice(0, 8)}...: ${alloc.positions} positions | $${alloc.deployedUsd.toFixed(2)}`);
        }
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reset the ledger (for testing)
 */
export function resetLedger(): void {
    totalCapitalUsd = 0;
    lockedUsd = 0;
    positions.clear();
    cachedState = null;
    logger.info(`${LEDGER_CONFIG.logPrefix} Reset complete`);
}

/**
 * Check if ledger has been initialized
 */
export function isLedgerInitialized(): boolean {
    return totalCapitalUsd > 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// LEDGER_CONFIG is already exported at declaration

