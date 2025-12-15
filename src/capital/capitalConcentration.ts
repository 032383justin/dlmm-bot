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
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 5 HARDENING: TRANCHE 2/3 GATING
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Maximum ODS decay from peak to allow tranche 2/3
     * If ODS dropped more than this % from peak, block tranche
     */
    maxODSDecayForTranche: 0.15, // 15%
    
    /**
     * Minimum EV improvement required for tranche 2/3
     * New EV must be >= priorEV * (1 + this)
     */
    minEVImprovementPct: 0.05, // 5% improvement required
    
    /**
     * Maximum adverse selection penalty for tranche 2/3
     * Blocks if adverseSelectionPenalty exceeds this
     */
    maxAdverseSelectionPenalty: 0.08, // 8%
    
    /**
     * Minimum expected fee rate (USD/hour) for tranche 2/3
     */
    minExpectedFeeRateUsdHour: 0.50, // $0.50/hour
    
    /**
     * Minimum fee intensity for tranche 2/3 if not VSH eligible
     */
    minFeeIntensityForTranche: 0.03, // 3%
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

/**
 * Extended tranche record with EV snapshot for Tier 5 hardening
 */
interface ExtendedTrancheRecord extends TrancheRecord {
    evAtEntry: number;
    feeIntensityAtEntry: number;
    odsAtEntry: number;
}

// Pool deployment tracking
const poolDeployments = new Map<string, {
    totalDeployedUSD: number;
    tranches: ExtendedTrancheRecord[];
    lastTrancheAt: number;
    peakODS: number; // Track peak ODS for decay detection
}>();

// Global deployment tracking
let totalDeployedUSD = 0;
let totalEquityUSD = 0;

// Tranche add tracking for telemetry
export interface TrancheAddStats {
    trancheAddsThisCycle: number;
    trancheAddBlockedReasons: Map<string, number>;
    avgEVDeltaTranche1to2: number;
    evDeltaSamples: number[];
}

const trancheAddStats: TrancheAddStats = {
    trancheAddsThisCycle: 0,
    trancheAddBlockedReasons: new Map(),
    avgEVDeltaTranche1to2: 0,
    evDeltaSamples: [],
};

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
 * Extended tranche gating inputs for Tier 5 hardening
 */
export interface TrancheGatingInputs {
    poolAddress: string;
    aggressionLevel: AggressionLevel;
    odsValue: number;
    currentEV: number;
    feeIntensity: number;
    vshEligible: boolean;
    adverseSelectionPenalty: number;
    expectedFeeRateUsdHour: number;
}

/**
 * Check if additional tranche is allowed (TIER 5 HARDENED)
 * 
 * For tranche 2/3, additional requirements:
 * - ODD spike still active AND not decaying
 * - EV improved relative to prior tranche
 * - VSH eligible OR feeIntensity above threshold
 * - adverseSelectionPenalty below max
 * - minimum expected fee rate
 */
function canAddTranche(
    poolAddress: string,
    aggressionLevel: AggressionLevel,
    odsValue: number,
    extendedInputs?: Partial<TrancheGatingInputs>
): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const deployment = poolDeployments.get(poolAddress);
    const trancheCount = deployment?.tranches.length ?? 0;
    
    // Only allow tranching at A2+
    if (aggressionLevel === 'A0' || aggressionLevel === 'A1') {
        recordTrancheBlockReason('aggression_level_low');
        return { allowed: false, reason: 'aggression level < A2' };
    }
    
    // Check max tranches
    if (deployment && deployment.tranches.length >= CCE_CONFIG.maxTranchesPerPool) {
        recordTrancheBlockReason('max_tranches');
        return { allowed: false, reason: `max tranches (${CCE_CONFIG.maxTranchesPerPool}) reached` };
    }
    
    // Check time between tranches
    if (deployment && (now - deployment.lastTrancheAt) < CCE_CONFIG.minTimeBetweenTranchesMs) {
        const remaining = Math.ceil((CCE_CONFIG.minTimeBetweenTranchesMs - (now - deployment.lastTrancheAt)) / 1000);
        recordTrancheBlockReason('time_between_tranches');
        return { allowed: false, reason: `${remaining}s until next tranche allowed` };
    }
    
    // Check ODS threshold for tranching
    if (odsValue < CCE_CONFIG.minODSForTranche) {
        recordTrancheBlockReason('ods_below_threshold');
        return { allowed: false, reason: `ODS ${odsValue.toFixed(2)} < ${CCE_CONFIG.minODSForTranche} required` };
    }
    
    // Check if ODS spike is still active
    if (!hasActiveSpike(poolAddress)) {
        recordTrancheBlockReason('spike_expired');
        return { allowed: false, reason: 'ODS spike expired' };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 5 HARDENING: TRANCHE 2/3 ADDITIONAL REQUIREMENTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (trancheCount >= 1 && deployment) {
        // Check 1: ODS not decaying from peak
        if (deployment.peakODS > 0) {
            const odsDecay = (deployment.peakODS - odsValue) / deployment.peakODS;
            if (odsDecay > CCE_CONFIG.maxODSDecayForTranche) {
                recordTrancheBlockReason('ods_decaying');
                return { 
                    allowed: false, 
                    reason: `ODS decaying: ${(odsDecay * 100).toFixed(0)}% drop from peak > ${CCE_CONFIG.maxODSDecayForTranche * 100}% max` 
                };
            }
        }
        
        if (extendedInputs) {
            const lastTranche = deployment.tranches[deployment.tranches.length - 1];
            
            // Check 2: EV improved relative to prior tranche
            if (extendedInputs.currentEV !== undefined && lastTranche?.evAtEntry !== undefined) {
                const priorEV = lastTranche.evAtEntry;
                const minRequiredEV = priorEV * (1 + CCE_CONFIG.minEVImprovementPct);
                
                if (extendedInputs.currentEV < minRequiredEV) {
                    recordTrancheBlockReason('ev_not_improving');
                    
                    // Track EV delta for telemetry
                    const evDelta = extendedInputs.currentEV - priorEV;
                    trancheAddStats.evDeltaSamples.push(evDelta);
                    
                    return { 
                        allowed: false, 
                        reason: `EV not improving: $${extendedInputs.currentEV.toFixed(2)} < $${minRequiredEV.toFixed(2)} (${CCE_CONFIG.minEVImprovementPct * 100}% improvement required)` 
                    };
                }
            }
            
            // Check 3: VSH eligible OR feeIntensity above threshold
            const hasVSH = extendedInputs.vshEligible ?? false;
            const hasFeeIntensity = (extendedInputs.feeIntensity ?? 0) >= CCE_CONFIG.minFeeIntensityForTranche;
            
            if (!hasVSH && !hasFeeIntensity) {
                recordTrancheBlockReason('no_vsh_or_fee_intensity');
                return { 
                    allowed: false, 
                    reason: `neither VSH eligible nor feeIntensity ${((extendedInputs.feeIntensity ?? 0) * 100).toFixed(1)}% >= ${CCE_CONFIG.minFeeIntensityForTranche * 100}%` 
                };
            }
            
            // Check 4: Adverse selection penalty below max
            if (extendedInputs.adverseSelectionPenalty !== undefined) {
                if (extendedInputs.adverseSelectionPenalty > CCE_CONFIG.maxAdverseSelectionPenalty) {
                    recordTrancheBlockReason('adverse_selection');
                    return { 
                        allowed: false, 
                        reason: `adverseSelection ${(extendedInputs.adverseSelectionPenalty * 100).toFixed(1)}% > ${CCE_CONFIG.maxAdverseSelectionPenalty * 100}% max` 
                    };
                }
            }
            
            // Check 5: Minimum expected fee rate
            if (extendedInputs.expectedFeeRateUsdHour !== undefined) {
                if (extendedInputs.expectedFeeRateUsdHour < CCE_CONFIG.minExpectedFeeRateUsdHour) {
                    recordTrancheBlockReason('low_fee_rate');
                    return { 
                        allowed: false, 
                        reason: `expectedFeeRate $${extendedInputs.expectedFeeRateUsdHour.toFixed(2)}/h < $${CCE_CONFIG.minExpectedFeeRateUsdHour}/h min` 
                    };
                }
            }
        }
    }
    
    return { allowed: true };
}

/**
 * Record tranche block reason for telemetry
 */
function recordTrancheBlockReason(reason: string): void {
    const current = trancheAddStats.trancheAddBlockedReasons.get(reason) ?? 0;
    trancheAddStats.trancheAddBlockedReasons.set(reason, current + 1);
}

/**
 * Evaluate concentration for a pool
 */
export function evaluateConcentration(
    poolAddress: string,
    poolName: string,
    baseSizeUSD: number,
    evPositive: boolean,
    odsValue: number,
    extendedInputs?: {
        currentEV?: number;
        feeIntensity?: number;
        vshEligible?: boolean;
        adverseSelectionPenalty?: number;
        expectedFeeRateUsdHour?: number;
    }
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
    
    // Check tranching (with extended inputs for Tier 5 hardening)
    const trancheCheck = canAddTranche(poolAddress, aggressionLevel, odsValue, extendedInputs);
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
    trancheId: string,
    extendedData?: {
        evAtEntry?: number;
        feeIntensityAtEntry?: number;
    }
): void {
    const now = Date.now();
    
    let deployment = poolDeployments.get(poolAddress);
    if (!deployment) {
        deployment = {
            totalDeployedUSD: 0,
            tranches: [],
            lastTrancheAt: 0,
            peakODS: odsAtEntry,
        };
        poolDeployments.set(poolAddress, deployment);
    }
    
    // Track peak ODS for decay detection
    if (odsAtEntry > deployment.peakODS) {
        deployment.peakODS = odsAtEntry;
    }
    
    // Record tranche with extended data
    const tranche: ExtendedTrancheRecord = {
        trancheId,
        poolAddress,
        poolName,
        sizeUSD,
        entryTime: now,
        aggressionLevel,
        odsAtEntry,
        evAtEntry: extendedData?.evAtEntry ?? 0,
        feeIntensityAtEntry: extendedData?.feeIntensityAtEntry ?? 0,
    };
    
    // Track EV delta for telemetry (tranche 1 to 2)
    const trancheIndex = deployment.tranches.length + 1;
    if (trancheIndex === 2 && deployment.tranches.length >= 1) {
        const priorEV = deployment.tranches[0].evAtEntry;
        const currentEV = extendedData?.evAtEntry ?? 0;
        const evDelta = currentEV - priorEV;
        trancheAddStats.evDeltaSamples.push(evDelta);
        trancheAddStats.trancheAddsThisCycle++;
        
        // Update average
        const samples = trancheAddStats.evDeltaSamples;
        trancheAddStats.avgEVDeltaTranche1to2 = samples.length > 0 
            ? samples.reduce((a, b) => a + b, 0) / samples.length 
            : 0;
    }
    
    deployment.tranches.push(tranche);
    deployment.totalDeployedUSD += sizeUSD;
    deployment.lastTrancheAt = now;
    
    // Update global tracking
    totalDeployedUSD += sizeUSD;
    
    const deployedPct = totalEquityUSD > 0 ? (deployment.totalDeployedUSD / totalEquityUSD) * 100 : 0;
    
    logger.info(
        `[CCE] pool=${poolName} tranche=${trancheIndex} deployed=${deployedPct.toFixed(1)}% ` +
        `targetCap=${(calculateTargetPoolCap(aggressionLevel) * 100).toFixed(1)}% ` +
        `level=${aggressionLevel} ev=$${(extendedData?.evAtEntry ?? 0).toFixed(2)}`
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
    trancheAddStats.trancheAddsThisCycle = 0;
    trancheAddStats.trancheAddBlockedReasons.clear();
    trancheAddStats.avgEVDeltaTranche1to2 = 0;
    trancheAddStats.evDeltaSamples = [];
    logger.info('[CCE] State cleared');
}

/**
 * Get tranche add statistics for Tier 5 validation summary
 */
export function getTrancheAddStats(): {
    trancheAddsThisCycle: number;
    blockedReasons: Record<string, number>;
    avgEVDeltaTranche1to2: number;
} {
    const blockedReasons: Record<string, number> = {};
    for (const [reason, count] of trancheAddStats.trancheAddBlockedReasons.entries()) {
        blockedReasons[reason] = count;
    }
    
    return {
        trancheAddsThisCycle: trancheAddStats.trancheAddsThisCycle,
        blockedReasons,
        avgEVDeltaTranche1to2: trancheAddStats.avgEVDeltaTranche1to2,
    };
}

/**
 * Reset tranche stats (call at start of each cycle)
 */
export function resetTrancheAddStats(): void {
    trancheAddStats.trancheAddsThisCycle = 0;
    trancheAddStats.trancheAddBlockedReasons.clear();
}

/**
 * Get prior tranche EV for a pool
 */
export function getPriorTrancheEV(poolAddress: string): number | null {
    const deployment = poolDeployments.get(poolAddress);
    if (!deployment || deployment.tranches.length === 0) {
        return null;
    }
    
    const lastTranche = deployment.tranches[deployment.tranches.length - 1];
    return lastTranche.evAtEntry;
}

/**
 * Get current tranche index for a pool (1-based)
 */
export function getCurrentTrancheIndex(poolAddress: string): number {
    const deployment = poolDeployments.get(poolAddress);
    return (deployment?.tranches.length ?? 0) + 1;
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

