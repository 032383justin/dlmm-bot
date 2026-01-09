/**
 * Aggression Ladder (AEL) — Tier 5 Controlled Aggression
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 5: MODULE B — CENTRALIZED AGGRESSION CONTROL
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Centralized, stateful escalation control that turns aggression 
 * on/off safely with multi-confirmation requirements.
 * 
 * AGGRESSION LEVELS:
 *   A0 - Default (no aggression)
 *   A1 - Mild (EV + regime stability)
 *   A2 - Spike (ODS spike confirmed)
 *   A3 - Spike + Churn Harvesting (ODS + VSH eligible)
 *   A4 - Rare Convergence (strict multi-confirmation)
 * 
 * ENTRY REQUIREMENTS (HARD RULES):
 *   A1: EV positive AND regime stable (>=3 cycles, >=5 min) AND not fee-bleed
 *   A2: A1 + ODS spike
 *   A3: A2 + VSH eligible
 *   A4: A3 + rare convergence (ODS >= 2.8, top percentile fee, stable migration)
 * 
 * TTL BY LEVEL:
 *   A2: 10-15 min
 *   A3: 5-10 min
 *   A4: 2-5 min
 * 
 * SAFETY:
 *   - No escalation on first regime flip (dampening)
 *   - BEAR regime → immediate revert to A0
 *   - AEL must block escalation for 1-2 cycles after instability
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';
import { getCurrentRegimeState } from './aggressionScaling';
import { isFeeBleedDefenseActive } from './feeBleedFailsafe';
import { hasActiveSpike, getActiveSpike, isRareConvergence, ODSResult } from './opportunityDensity';
import { TIER5_CONFIG } from '../config/constants';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Aggression Ladder Configuration
 */
export const AEL_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // STABILITY REQUIREMENTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Minimum consecutive cycles in same regime for stability
     */
    minCyclesForStability: 3,
    
    /**
     * Minimum time in regime for stability (ms)
     */
    minTimeForStabilityMs: 5 * 60 * 1000, // 5 minutes
    
    /**
     * Cycles to block escalation after regime instability
     */
    escalationBlockCycles: 2,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TTL PER LEVEL
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * TTL for A2 (10-15 min, using 12 min as default)
     */
    ttlA2Ms: 12 * 60 * 1000,
    
    /**
     * TTL for A3 (5-10 min, using 7 min as default)
     */
    ttlA3Ms: 7 * 60 * 1000,
    
    /**
     * TTL for A4 (2-5 min, using 3 min as default)
     */
    ttlA4Ms: 3 * 60 * 1000,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MULTIPLIERS PER LEVEL
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Multipliers for each aggression level
     */
    multipliers: {
        A0: { size: 1.00, binWidth: 1.00, exitSensitivity: 1.00, concentrationCap: 1.00 },
        A1: { size: 1.10, binWidth: 0.95, exitSensitivity: 1.05, concentrationCap: 1.00 },
        A2: { size: 1.35, binWidth: 0.85, exitSensitivity: 1.10, concentrationCap: 1.50 },
        A3: { size: 1.50, binWidth: 0.80, exitSensitivity: 1.15, concentrationCap: 2.00 },
        A4: { size: 1.75, binWidth: 0.75, exitSensitivity: 1.20, concentrationCap: 2.50 },
    } as Record<AggressionLevel, AggressionMultipliers>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RARE CONVERGENCE THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Fee intensity percentile for rare convergence (top 10%)
     */
    rareConvergenceFeePercentile: 0.90,
    
    /**
     * Maximum migration slope magnitude for rare convergence
     */
    rareConvergenceMaxMigration: 0.05,
    
    /**
     * Minimum churn quality for rare convergence
     */
    rareConvergenceMinChurn: 3.0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Aggression levels
 */
export type AggressionLevel = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

/**
 * Multipliers applied at each aggression level
 */
export interface AggressionMultipliers {
    size: number;           // Position size multiplier
    binWidth: number;       // Bin width multiplier (lower = narrower)
    exitSensitivity: number; // Exit threshold multiplier (higher = less sensitive)
    concentrationCap: number; // Per-pool concentration cap multiplier
}

/**
 * Aggression state for a pool
 */
export interface AggressionState {
    level: AggressionLevel;
    ttlRemainingMs: number;
    expiresAt: number;
    multipliers: AggressionMultipliers;
    reasons: string[];
    lastChangeTs: number;
    escalatedAt: number;
    
    // Tracking
    blockedEscalation: boolean;
    blockReason?: string;
}

/**
 * Internal aggression tracking
 */
interface PoolAggressionState {
    level: AggressionLevel;
    escalatedAt: number;
    expiresAt: number;
    reasons: string[];
    lastChangeTs: number;
    
    // Stability tracking
    cyclesSinceLastChange: number;
    lastRegime: MarketRegime;
    regimeFlipCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Per-pool aggression state
const poolAggressionState = new Map<string, PoolAggressionState>();

// Global escalation blocking
let globalEscalationBlockedUntil = 0;
let globalBlockReason = '';

// Fee intensity tracking for percentile calculation
const feeIntensityHistory: number[] = [];
const MAX_FEE_HISTORY = 500;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if regime is stable enough for escalation
 */
function isRegimeStable(): { stable: boolean; reason: string } {
    const regimeState = getCurrentRegimeState();
    
    const meetsTimeReq = (Date.now() - regimeState.regimeEnteredAt) >= AEL_CONFIG.minTimeForStabilityMs;
    const meetsCycleReq = regimeState.consecutiveCycles >= AEL_CONFIG.minCyclesForStability;
    
    if (!meetsTimeReq) {
        return { 
            stable: false, 
            reason: `time in regime ${Math.floor((Date.now() - regimeState.regimeEnteredAt) / 1000)}s < ${AEL_CONFIG.minTimeForStabilityMs / 1000}s required` 
        };
    }
    
    if (!meetsCycleReq) {
        return { 
            stable: false, 
            reason: `cycles in regime ${regimeState.consecutiveCycles} < ${AEL_CONFIG.minCyclesForStability} required` 
        };
    }
    
    return { stable: true, reason: 'stable' };
}

/**
 * Check if escalation is globally blocked
 */
function isEscalationBlocked(): { blocked: boolean; reason: string } {
    const now = Date.now();
    
    if (globalEscalationBlockedUntil > now) {
        return { blocked: true, reason: globalBlockReason };
    }
    
    return { blocked: false, reason: '' };
}

/**
 * Block escalation for N cycles
 */
function blockEscalation(cycles: number, reason: string): void {
    // Assume 2-minute cycles
    const blockTimeMs = cycles * 2 * 60 * 1000;
    globalEscalationBlockedUntil = Date.now() + blockTimeMs;
    globalBlockReason = reason;
    
    logger.warn(`[AGGRESSION-LADDER] BLOCKED reason=${reason} for ${cycles} cycles`);
}

/**
 * Track fee intensity for percentile calculation
 */
export function recordFeeIntensity(feeIntensity: number): void {
    feeIntensityHistory.push(feeIntensity);
    if (feeIntensityHistory.length > MAX_FEE_HISTORY) {
        feeIntensityHistory.shift();
    }
}

/**
 * Check if fee intensity is in top percentile
 */
function isTopPercentileFee(feeIntensity: number): boolean {
    if (feeIntensityHistory.length < 10) {
        return false; // Not enough data
    }
    
    const sorted = [...feeIntensityHistory].sort((a, b) => a - b);
    const percentileIndex = Math.floor(sorted.length * AEL_CONFIG.rareConvergenceFeePercentile);
    const threshold = sorted[percentileIndex];
    
    return feeIntensity >= threshold;
}

/**
 * Evaluate and update aggression level for a pool
 */
export function evaluateAggressionLevel(
    poolAddress: string,
    poolName: string,
    regime: MarketRegime,
    evPositive: boolean,
    odsResult: ODSResult | null,
    vshEligible: boolean,
    migrationSlope: number,
    churnQuality: number,
    feeIntensity: number
): AggressionState {
    const now = Date.now();
    
    // Get or create pool state
    let state = poolAggressionState.get(poolAddress);
    if (!state) {
        state = {
            level: 'A0',
            escalatedAt: 0,
            expiresAt: 0,
            reasons: [],
            lastChangeTs: now,
            cyclesSinceLastChange: 0,
            lastRegime: regime,
            regimeFlipCount: 0,
        };
        poolAggressionState.set(poolAddress, state);
    }
    
    // Track regime changes
    if (state.lastRegime !== regime) {
        state.regimeFlipCount++;
        state.lastRegime = regime;
        
        // Block escalation after regime flip
        blockEscalation(AEL_CONFIG.escalationBlockCycles, 'REGIME_FLIP');
    }
    
    state.cyclesSinceLastChange++;
    
    // Record fee intensity
    recordFeeIntensity(feeIntensity);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BEAR REGIME → IMMEDIATE REVERT TO A0 — NEUTRALIZED
    // REGIME_ECONOMIC_IMPACT=DISABLED: Regime does not affect aggression level
    // ═══════════════════════════════════════════════════════════════════════════
    
    // NEUTRALIZED: BEAR regime no longer forces revert
    // Regime is observation only in fee harvester mode
    // if (regime === 'BEAR') { ... }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK TTL EXPIRY
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (state.expiresAt > 0 && now >= state.expiresAt) {
        logger.info(`[AGGRESSION-LADDER] ↓ A0 revert reason=TTL_EXPIRED pool=${poolName}`);
        state.level = 'A0';
        state.expiresAt = 0;
        state.reasons = ['TTL expired'];
        state.lastChangeTs = now;
        state.cyclesSinceLastChange = 0;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EVALUATE ESCALATION PATH
    // ═══════════════════════════════════════════════════════════════════════════
    
    const newReasons: string[] = [];
    let targetLevel: AggressionLevel = 'A0';
    
    // Check global escalation block
    const blockCheck = isEscalationBlocked();
    if (blockCheck.blocked) {
        return buildAggressionState(poolAddress, state, true, blockCheck.reason);
    }
    
    // Check regime stability
    const stabilityCheck = isRegimeStable();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // A1: EV positive AND regime stable AND not fee-bleed defense
    // ═══════════════════════════════════════════════════════════════════════════
    
    const canA1 = evPositive && stabilityCheck.stable && !isFeeBleedDefenseActive();
    
    if (canA1) {
        targetLevel = 'A1';
        newReasons.push('EV+', 'regime stable', 'no fee-bleed');
        
        // ═══════════════════════════════════════════════════════════════════════
        // A2: A1 + ODS spike
        // ═══════════════════════════════════════════════════════════════════════
        
        if (odsResult?.isSpike) {
            targetLevel = 'A2';
            newReasons.push(`ODS spike: ${odsResult.ods.toFixed(2)}`);
            
            // ═══════════════════════════════════════════════════════════════════
            // A3: A2 + VSH eligible
            // ═══════════════════════════════════════════════════════════════════
            
            if (vshEligible) {
                targetLevel = 'A3';
                newReasons.push('VSH eligible');
                
                // ═══════════════════════════════════════════════════════════════
                // A4: A3 + rare convergence
                // ═══════════════════════════════════════════════════════════════
                
                const isODSRare = odsResult.ods >= 2.8;
                const isTopFee = isTopPercentileFee(feeIntensity);
                const isMigrationStable = Math.abs(migrationSlope) < AEL_CONFIG.rareConvergenceMaxMigration;
                const isHighChurn = churnQuality >= AEL_CONFIG.rareConvergenceMinChurn;
                
                if (isODSRare && isTopFee && isMigrationStable && isHighChurn) {
                    targetLevel = 'A4';
                    newReasons.push('rare convergence');
                }
            }
        }
    } else if (!stabilityCheck.stable) {
        // Log blocked escalation
        if (state.level === 'A0') {
            logger.debug(
                `[AGGRESSION-LADDER] BLOCKED pool=${poolName} reason=${stabilityCheck.reason} ` +
                `consecutive=${getCurrentRegimeState().consecutiveCycles} required=${AEL_CONFIG.minCyclesForStability}`
            );
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // APPLY LEVEL CHANGE
    // ═══════════════════════════════════════════════════════════════════════════
    
    const levelOrder: AggressionLevel[] = ['A0', 'A1', 'A2', 'A3', 'A4'];
    const currentLevelIndex = levelOrder.indexOf(state.level);
    const targetLevelIndex = levelOrder.indexOf(targetLevel);
    
    // Allow escalation or de-escalation
    if (targetLevelIndex !== currentLevelIndex) {
        const isEscalation = targetLevelIndex > currentLevelIndex;
        const direction = isEscalation ? '↑' : '↓';
        
        // Set TTL for new level
        let ttl = 0;
        if (targetLevel === 'A2') ttl = AEL_CONFIG.ttlA2Ms;
        else if (targetLevel === 'A3') ttl = AEL_CONFIG.ttlA3Ms;
        else if (targetLevel === 'A4') ttl = AEL_CONFIG.ttlA4Ms;
        
        state.level = targetLevel;
        state.escalatedAt = now;
        state.expiresAt = ttl > 0 ? now + ttl : 0;
        state.reasons = newReasons;
        state.lastChangeTs = now;
        state.cyclesSinceLastChange = 0;
        
        const multipliers = AEL_CONFIG.multipliers[targetLevel];
        
        logger.info(
            `[AGGRESSION-LADDER] ${direction} ${targetLevel} engaged pool=${poolName} ` +
            `reason=${newReasons.join(',')} ttl=${Math.floor(ttl / 1000)}s ` +
            `mult={size:${multipliers.size.toFixed(2)},bin:${multipliers.binWidth.toFixed(2)},exit:${multipliers.exitSensitivity.toFixed(2)}}`
        );
    }
    
    return buildAggressionState(poolAddress, state, false);
}

/**
 * Build AggressionState output
 */
function buildAggressionState(
    poolAddress: string,
    state: PoolAggressionState,
    blocked: boolean,
    blockReason?: string
): AggressionState {
    const now = Date.now();
    const ttlRemainingMs = state.expiresAt > now ? state.expiresAt - now : 0;
    
    return {
        level: state.level,
        ttlRemainingMs,
        expiresAt: state.expiresAt,
        multipliers: AEL_CONFIG.multipliers[state.level],
        reasons: state.reasons,
        lastChangeTs: state.lastChangeTs,
        escalatedAt: state.escalatedAt,
        blockedEscalation: blocked,
        blockReason,
    };
}

/**
 * Get current aggression state for a pool
 */
export function getAggressionState(poolAddress: string): AggressionState {
    const state = poolAggressionState.get(poolAddress);
    
    if (!state) {
        return {
            level: 'A0',
            ttlRemainingMs: 0,
            expiresAt: 0,
            multipliers: AEL_CONFIG.multipliers.A0,
            reasons: [],
            lastChangeTs: 0,
            escalatedAt: 0,
            blockedEscalation: false,
        };
    }
    
    return buildAggressionState(poolAddress, state, false);
}

/**
 * Get aggression multipliers for a pool
 */
export function getAggressionMultipliers(poolAddress: string): AggressionMultipliers {
    const state = getAggressionState(poolAddress);
    return state.multipliers;
}

/**
 * Check if pool is at elevated aggression
 */
export function isElevatedAggression(poolAddress: string): boolean {
    const state = getAggressionState(poolAddress);
    return state.level !== 'A0';
}

/**
 * Get summary of all aggression states
 */
export function getAggressionSummary(): {
    totalPools: number;
    byLevel: Record<AggressionLevel, number>;
    topAggressionPool: string | null;
} {
    const byLevel: Record<AggressionLevel, number> = { A0: 0, A1: 0, A2: 0, A3: 0, A4: 0 };
    let topLevel: AggressionLevel = 'A0';
    let topPool: string | null = null;
    
    const levelOrder: AggressionLevel[] = ['A0', 'A1', 'A2', 'A3', 'A4'];
    
    for (const [addr, state] of poolAggressionState.entries()) {
        byLevel[state.level]++;
        if (levelOrder.indexOf(state.level) > levelOrder.indexOf(topLevel)) {
            topLevel = state.level;
            topPool = addr;
        }
    }
    
    return {
        totalPools: poolAggressionState.size,
        byLevel,
        topAggressionPool: topPool,
    };
}

/**
 * Force revert pool to A0 (for safety)
 */
export function forceRevertToA0(poolAddress: string, reason: string): void {
    const state = poolAggressionState.get(poolAddress);
    if (state && state.level !== 'A0') {
        logger.warn(`[AGGRESSION-LADDER] ↓ A0 FORCED pool=${poolAddress.slice(0, 8)} reason=${reason}`);
        state.level = 'A0';
        state.expiresAt = 0;
        state.reasons = [`FORCED: ${reason}`];
        state.lastChangeTs = Date.now();
        state.cyclesSinceLastChange = 0;
    }
}

/**
 * Clear all aggression state (for testing)
 */
export function clearAggressionState(): void {
    poolAggressionState.clear();
    feeIntensityHistory.length = 0;
    globalEscalationBlockedUntil = 0;
    globalBlockReason = '';
    logger.info('[AGGRESSION-LADDER] State cleared');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEV ASSERTIONS
// ═══════════════════════════════════════════════════════════════════════════════

const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

/**
 * DEV MODE: Assert aggression invariants
 */
export function assertAggressionInvariants(
    poolAddress: string,
    regime: MarketRegime,
    feeBleedActive: boolean
): void {
    if (!DEV_MODE) return;
    
    const state = getAggressionState(poolAddress);
    const regimeState = getCurrentRegimeState();
    
    // Invariant 1: A2+ not allowed if regime unstable
    if (state.level !== 'A0' && state.level !== 'A1') {
        const isStable = regimeState.consecutiveCycles >= AEL_CONFIG.minCyclesForStability &&
                        (Date.now() - regimeState.regimeEnteredAt) >= AEL_CONFIG.minTimeForStabilityMs;
        
        if (!isStable) {
            const error = new Error(
                `[AGGRESSION-INVARIANT] Level ${state.level} active but regime unstable! ` +
                `cycles=${regimeState.consecutiveCycles} required=${AEL_CONFIG.minCyclesForStability}`
            );
            logger.error(error.message);
            throw error;
        }
    }
    
    // Invariant 2: A2+ not allowed if fee-bleed defense active
    if ((state.level === 'A2' || state.level === 'A3' || state.level === 'A4') && feeBleedActive) {
        const error = new Error(
            `[AGGRESSION-INVARIANT] Level ${state.level} active but fee-bleed defense is active!`
        );
        logger.error(error.message);
        throw error;
    }
}

