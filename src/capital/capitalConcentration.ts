/**
 * Capital Concentration Engine (CCE) — Tier 5 Controlled Aggression
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 5: MODULE C — CAPITAL CONCENTRATION CONTROL
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: When aggression is high, concentrate capital into the best pool(s)
 * rather than spreading thin.
 * 
 * CONSTRAINTS (NEVER VIOLATED):
 *   - Existing total deployed cap remains (e.g., 25%)
 *   - Per-pool hard cap: default 18% of total capital
 *   - Concentration only allowed at aggression levels A2+
 * 
 * CONCENTRATION MULTIPLIERS:
 *   - A2: 1.5x base pool cap
 *   - A3: 2.0x base pool cap
 *   - A4: 2.5x base pool cap
 * 
 * TRANCHING:
 *   - Multiple entries into same pool allowed if ODS remains high and EV positive
 *   - Tranches recorded distinctly in telemetry but tied to same pool
 * 
 * INTEGRATION:
 *   - MHI sizing governor still applies
 *   - Fee-bleed scaling still applies
 *   - Final size = min(basePoolCap * concentrationMultiplier, hardCap, sizing limits)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { AggressionLevel, getAggressionState } from './aggressionLadder';
import { hasActiveSpike } from './opportunityDensity';
import { TIER5_CONFIG } from '../config/constants';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * CCE Configuration
 */
export const CCE_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // HARD CAPS (NEVER EXCEEDED)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Maximum total portfolio deployed (% of equity)
     * Matches existing RISK_MAX_PORTFOLIO_EXPOSURE
     */
    maxTotalDeployedPct: 0.25, // 25%
    
    /**
     * Maximum per-pool deployment (% of equity)
     * Hard cap that cannot be exceeded even with concentration
     */
    maxPerPoolHardCapPct: 0.18, // 18%
    
    /**
     * Base per-pool cap before concentration (% of equity)
     */
    basePerPoolCapPct: 0.075, // 7.5%
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONCENTRATION MULTIPLIERS BY LEVEL
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Concentration cap multipliers by aggression level
     */
    concentrationMultipliers: {
        A0: 1.0,
        A1: 1.0,
        A2: 1.5,
        A3: 2.0,
        A4: 2.5,
    } as Record<AggressionLevel, number>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRANCHING CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Maximum tranches per pool
     */
    maxTranchesPerPool: 3,
    
    /**
     * Minimum time between tranches (ms)
     */
    minTimeBetweenTranchesMs: 5 * 60 * 1000, // 5 minutes
    
    /**
     * Minimum ODS required for additional tranche
     */
    minODSForTranche: 2.0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool concentration state
 */
export interface PoolConcentrationState {
    poolAddress: string;
    currentDeployedPct: number;
    targetCapPct: number;
    hardCapPct: number;
    remainingCapacityPct: number;
    trancheCount: number;
    lastTrancheAt: number;
    canAddTranche: boolean;
    trancheBlockReason?: string;
}

/**
 * Concentration evaluation result
 */
export interface ConcentrationResult {
    // Per-pool state
    poolState: PoolConcentrationState;
    
    // Sizing
    allowedSizeUSD: number;
    concentrationMultiplier: number;
    
    // Flags
    concentrationAllowed: boolean;
    tranchingAllowed: boolean;
    
    // Reasons
    reasons: string[];
}

/**
 * Tranche record for telemetry
 */
export interface TrancheRecord {
    trancheId: string;
    poolAddress: string;
    poolName: string;
    sizeUSD: number;
    entryTime: number;
    aggressionLevel: AggressionLevel;
    odsAtEntry: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Pool deployment tracking
const poolDeployments = new Map<string, {
    totalDeployedUSD: number;
    tranches: TrancheRecord[];
    lastTrancheAt: number;
}>();

// Global deployment tracking
let totalDeployedUSD = 0;
let totalEquityUSD = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update equity for percentage calculations
 */
export function updateEquity(equityUSD: number): void {
    totalEquityUSD = equityUSD;
}

/**
 * Get current per-pool deployment percentage
 */
function getPoolDeployedPct(poolAddress: string): number {
    if (totalEquityUSD <= 0) return 0;
    
    const deployment = poolDeployments.get(poolAddress);
    if (!deployment) return 0;
    
    return deployment.totalDeployedUSD / totalEquityUSD;
}

/**
 * Get total deployed percentage
 */
function getTotalDeployedPct(): number {
    if (totalEquityUSD <= 0) return 0;
    return totalDeployedUSD / totalEquityUSD;
}

/**
 * Calculate target pool cap based on aggression level
 */
function calculateTargetPoolCap(aggressionLevel: AggressionLevel): number {
    const multiplier = CCE_CONFIG.concentrationMultipliers[aggressionLevel];
    const baseCap = CCE_CONFIG.basePerPoolCapPct;
    const targetCap = baseCap * multiplier;
    
    // Never exceed hard cap
    return Math.min(targetCap, CCE_CONFIG.maxPerPoolHardCapPct);
}

/**
 * Check if additional tranche is allowed
 */
function canAddTranche(
    poolAddress: string,
    aggressionLevel: AggressionLevel,
    odsValue: number
): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const deployment = poolDeployments.get(poolAddress);
    
    // Only allow tranching at A2+
    if (aggressionLevel === 'A0' || aggressionLevel === 'A1') {
        return { allowed: false, reason: 'aggression level < A2' };
    }
    
    // Check max tranches
    if (deployment && deployment.tranches.length >= CCE_CONFIG.maxTranchesPerPool) {
        return { allowed: false, reason: `max tranches (${CCE_CONFIG.maxTranchesPerPool}) reached` };
    }
    
    // Check time between tranches
    if (deployment && (now - deployment.lastTrancheAt) < CCE_CONFIG.minTimeBetweenTranchesMs) {
        const remaining = Math.ceil((CCE_CONFIG.minTimeBetweenTranchesMs - (now - deployment.lastTrancheAt)) / 1000);
        return { allowed: false, reason: `${remaining}s until next tranche allowed` };
    }
    
    // Check ODS threshold for tranching
    if (odsValue < CCE_CONFIG.minODSForTranche) {
        return { allowed: false, reason: `ODS ${odsValue.toFixed(2)} < ${CCE_CONFIG.minODSForTranche} required` };
    }
    
    // Check if ODS spike is still active
    if (!hasActiveSpike(poolAddress)) {
        return { allowed: false, reason: 'ODS spike expired' };
    }
    
    return { allowed: true };
}

/**
 * Evaluate concentration for a pool
 */
export function evaluateConcentration(
    poolAddress: string,
    poolName: string,
    baseSizeUSD: number,
    evPositive: boolean,
    odsValue: number
): ConcentrationResult {
    const now = Date.now();
    const reasons: string[] = [];
    
    // Get aggression state
    const aggressionState = getAggressionState(poolAddress);
    const aggressionLevel = aggressionState.level;
    
    // Calculate caps
    const targetCapPct = calculateTargetPoolCap(aggressionLevel);
    const hardCapPct = CCE_CONFIG.maxPerPoolHardCapPct;
    const currentDeployedPct = getPoolDeployedPct(poolAddress);
    const remainingCapacityPct = Math.max(0, targetCapPct - currentDeployedPct);
    
    // Get deployment state
    const deployment = poolDeployments.get(poolAddress);
    const trancheCount = deployment?.tranches.length ?? 0;
    const lastTrancheAt = deployment?.lastTrancheAt ?? 0;
    
    // Check if concentration is allowed (A2+ only)
    const concentrationAllowed = aggressionLevel === 'A2' || 
                                  aggressionLevel === 'A3' || 
                                  aggressionLevel === 'A4';
    
    // Check tranching
    const trancheCheck = canAddTranche(poolAddress, aggressionLevel, odsValue);
    const tranchingAllowed = trancheCheck.allowed && evPositive;
    
    if (!trancheCheck.allowed) {
        reasons.push(`tranche blocked: ${trancheCheck.reason}`);
    }
    
    // Calculate allowed size
    let allowedSizeUSD = baseSizeUSD;
    const concentrationMultiplier = CCE_CONFIG.concentrationMultipliers[aggressionLevel];
    
    if (concentrationAllowed) {
        // Apply concentration multiplier to base size
        allowedSizeUSD = baseSizeUSD * concentrationMultiplier;
        reasons.push(`concentration ${concentrationMultiplier.toFixed(1)}x at ${aggressionLevel}`);
    }
    
    // Cap to remaining pool capacity
    const remainingCapacityUSD = remainingCapacityPct * totalEquityUSD;
    if (allowedSizeUSD > remainingCapacityUSD) {
        allowedSizeUSD = remainingCapacityUSD;
        reasons.push(`capped to pool capacity: ${(remainingCapacityPct * 100).toFixed(1)}%`);
    }
    
    // Cap to remaining portfolio capacity
    const totalRemainingPct = Math.max(0, CCE_CONFIG.maxTotalDeployedPct - getTotalDeployedPct());
    const totalRemainingUSD = totalRemainingPct * totalEquityUSD;
    if (allowedSizeUSD > totalRemainingUSD) {
        allowedSizeUSD = totalRemainingUSD;
        reasons.push(`capped to portfolio capacity: ${(totalRemainingPct * 100).toFixed(1)}%`);
    }
    
    // Build pool state
    const poolState: PoolConcentrationState = {
        poolAddress,
        currentDeployedPct,
        targetCapPct,
        hardCapPct,
        remainingCapacityPct,
        trancheCount,
        lastTrancheAt,
        canAddTranche: tranchingAllowed,
        trancheBlockReason: trancheCheck.reason,
    };
    
    // Log state
    logger.debug(
        `[CCE] pool=${poolName} currentPoolDeployed=${(currentDeployedPct * 100).toFixed(1)}% ` +
        `targetCap=${(targetCapPct * 100).toFixed(1)}% level=${aggressionLevel} ` +
        `trancheAllowed=${tranchingAllowed}`
    );
    
    return {
        poolState,
        allowedSizeUSD: Math.floor(allowedSizeUSD),
        concentrationMultiplier,
        concentrationAllowed,
        tranchingAllowed,
        reasons,
    };
}

/**
 * Record a new position/tranche
 */
export function recordDeployment(
    poolAddress: string,
    poolName: string,
    sizeUSD: number,
    aggressionLevel: AggressionLevel,
    odsAtEntry: number,
    trancheId: string
): void {
    const now = Date.now();
    
    let deployment = poolDeployments.get(poolAddress);
    if (!deployment) {
        deployment = {
            totalDeployedUSD: 0,
            tranches: [],
            lastTrancheAt: 0,
        };
        poolDeployments.set(poolAddress, deployment);
    }
    
    // Record tranche
    const tranche: TrancheRecord = {
        trancheId,
        poolAddress,
        poolName,
        sizeUSD,
        entryTime: now,
        aggressionLevel,
        odsAtEntry,
    };
    
    deployment.tranches.push(tranche);
    deployment.totalDeployedUSD += sizeUSD;
    deployment.lastTrancheAt = now;
    
    // Update global tracking
    totalDeployedUSD += sizeUSD;
    
    const deployedPct = totalEquityUSD > 0 ? (deployment.totalDeployedUSD / totalEquityUSD) * 100 : 0;
    
    logger.info(
        `[CCE] pool=${poolName} currentPoolDeployed=${deployedPct.toFixed(1)}% ` +
        `targetCap=${(calculateTargetPoolCap(aggressionLevel) * 100).toFixed(1)}% ` +
        `level=${aggressionLevel} trancheAllowed=${deployment.tranches.length < CCE_CONFIG.maxTranchesPerPool}`
    );
}

/**
 * Record position exit
 */
export function recordExit(
    poolAddress: string,
    sizeUSD: number,
    trancheId?: string
): void {
    const deployment = poolDeployments.get(poolAddress);
    if (!deployment) return;
    
    // Remove specific tranche or reduce total
    if (trancheId) {
        const trancheIndex = deployment.tranches.findIndex(t => t.trancheId === trancheId);
        if (trancheIndex >= 0) {
            const tranche = deployment.tranches[trancheIndex];
            deployment.totalDeployedUSD -= tranche.sizeUSD;
            deployment.tranches.splice(trancheIndex, 1);
        }
    } else {
        deployment.totalDeployedUSD -= sizeUSD;
    }
    
    // Update global tracking
    totalDeployedUSD -= sizeUSD;
    
    // Cleanup if no more deployment
    if (deployment.totalDeployedUSD <= 0 || deployment.tranches.length === 0) {
        poolDeployments.delete(poolAddress);
    }
}

/**
 * Get pool deployed percentage
 */
export function getPoolDeployedPercentage(poolAddress: string): number {
    return getPoolDeployedPct(poolAddress) * 100;
}

/**
 * Get total deployed percentage
 */
export function getTotalDeployedPercentage(): number {
    return getTotalDeployedPct() * 100;
}

/**
 * Get deployment summary
 */
export function getDeploymentSummary(): {
    totalDeployedPct: number;
    totalDeployedUSD: number;
    poolCount: number;
    trancheCount: number;
    topPool: { address: string; deployedPct: number } | null;
} {
    const totalPct = getTotalDeployedPct();
    let topPool: { address: string; deployedPct: number } | null = null;
    let totalTranches = 0;
    
    for (const [addr, deployment] of poolDeployments.entries()) {
        totalTranches += deployment.tranches.length;
        const pct = totalEquityUSD > 0 ? deployment.totalDeployedUSD / totalEquityUSD : 0;
        if (!topPool || pct > topPool.deployedPct) {
            topPool = { address: addr, deployedPct: pct };
        }
    }
    
    return {
        totalDeployedPct: totalPct,
        totalDeployedUSD,
        poolCount: poolDeployments.size,
        trancheCount: totalTranches,
        topPool,
    };
}

/**
 * Clear all CCE state (for testing)
 */
export function clearCCEState(): void {
    poolDeployments.clear();
    totalDeployedUSD = 0;
    totalEquityUSD = 0;
    logger.info('[CCE] State cleared');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEV ASSERTIONS
// ═══════════════════════════════════════════════════════════════════════════════

const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

/**
 * DEV MODE: Assert CCE invariants
 */
export function assertCCEInvariants(poolAddress: string): void {
    if (!DEV_MODE) return;
    
    const poolDeployedPct = getPoolDeployedPct(poolAddress);
    const totalPct = getTotalDeployedPct();
    
    // Invariant 1: No pool exceeds hard per-pool cap
    if (poolDeployedPct > CCE_CONFIG.maxPerPoolHardCapPct + 0.001) { // 0.1% tolerance
        const error = new Error(
            `[CCE-INVARIANT] Pool ${poolAddress.slice(0, 8)} exceeds hard cap! ` +
            `deployed=${(poolDeployedPct * 100).toFixed(2)}% > max=${(CCE_CONFIG.maxPerPoolHardCapPct * 100).toFixed(1)}%`
        );
        logger.error(error.message);
        throw error;
    }
    
    // Invariant 2: Total deployed cannot exceed portfolio cap
    if (totalPct > CCE_CONFIG.maxTotalDeployedPct + 0.001) { // 0.1% tolerance
        const error = new Error(
            `[CCE-INVARIANT] Total deployed exceeds portfolio cap! ` +
            `deployed=${(totalPct * 100).toFixed(2)}% > max=${(CCE_CONFIG.maxTotalDeployedPct * 100).toFixed(1)}%`
        );
        logger.error(error.message);
        throw error;
    }
}

