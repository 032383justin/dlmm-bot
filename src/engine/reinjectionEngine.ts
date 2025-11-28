/**
 * Non-Equilibrium Reinjection Engine - Tier 4 Predator Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHILOSOPHY: Exits are not "stops" — they are MICRO-RESETS.
 * The bot waits for structure to heal before re-entering.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * When a trade closes due to:
 * - Harmonic decay
 * - Kill switch
 * - Tier migration drop
 * - Score collapse
 * 
 * Instead of treating exit as "stop," treat it as a micro reset:
 * - Capture the delta (why did we exit?)
 * - Scan for reversion to mean
 * - Scan for bin re-migration
 * - Treat post-exit moment as re-entry candidate if structure stabilizes
 * 
 * RULES:
 * - No reinjection if entropy < baseline
 * - No reinjection if liquidityFlow < 0
 * - No reinjection if swapVelocity is stagnant
 * - Only re-enter if STRUCTURE heals, not price
 * 
 * You are a PREDATOR that waits for prey to stumble.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { 
    computeMicrostructureMetrics, 
    getPoolHistory,
    MicrostructureMetrics,
    DLMMTelemetry,
} from '../services/dlmmTelemetry';
import { getMomentumSlopes, MomentumSlopes } from '../scoring/momentumEngine';
import { computeMHI, MHIResult, MHI_THRESHOLDS } from './microstructureHealthIndex';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exit reason classification
 */
export type ExitReason = 
    | 'HARMONIC_DECAY'
    | 'KILL_SWITCH'
    | 'TIER_MIGRATION'
    | 'SCORE_COLLAPSE'
    | 'FEE_INTENSITY_COLLAPSE'
    | 'LIQUIDITY_DRAIN'
    | 'MARKET_CRASH'
    | 'STRUCTURAL_DECAY'
    | 'MANUAL'
    | 'ROTATION'
    | 'UNKNOWN';

/**
 * Structure state at exit time
 */
export interface ExitStructureSnapshot {
    poolId: string;
    exitTime: number;
    exitReason: ExitReason;
    
    // Exit metrics (what triggered the exit)
    exitMHI: number;
    exitEntropy: number;
    exitLiquidityFlow: number;
    exitSwapVelocity: number;
    exitBinVelocity: number;
    
    // Slopes at exit
    exitVelocitySlope: number;
    exitLiquiditySlope: number;
    exitEntropySlope: number;
    
    // Entry reference (baseline)
    entryMHI: number;
    entryEntropy: number;
    
    // Tracking state
    snapshotsSinceExit: number;
    consecutiveHealingSamples: number;
    lastCheckTime: number;
    
    // P&L context
    exitPnL: number;
    exitPnLPercent: number;
}

/**
 * Reinjection evaluation result
 */
export interface ReinjectionEvaluation {
    poolId: string;
    canReinject: boolean;
    confidence: number;          // 0-1 scale
    blockedReasons: string[];
    healingSignals: string[];
    currentMHI: number;
    structureRecoveryPct: number;
    snapshotsSinceExit: number;
    cooldownRemaining: number;
}

/**
 * Reinjection opportunity
 */
export interface ReinjectionOpportunity {
    poolId: string;
    poolName: string;
    confidence: number;
    currentMHI: number;
    recoveryPct: number;
    timeSinceExit: number;
    suggestedSizeMultiplier: number;  // 0.5 - 1.0 based on confidence
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reinjection configuration
 */
export const REINJECTION_CONFIG = {
    // Minimum time before considering reinjection (ms)
    minCooldownMs: 2 * 60 * 1000,  // 2 minutes
    
    // Maximum time to track a pool for reinjection
    maxTrackingTimeMs: 30 * 60 * 1000,  // 30 minutes
    
    // Snapshots required for structure assessment
    minSnapshotsForEval: 2,
    maxSnapshotsToWait: 5,
    
    // Healing thresholds
    minHealingMHI: 0.55,           // MHI must be above this
    minEntropyRecovery: 0.80,      // Entropy must recover to 80% of exit value
    minLiquidityFlowRecovery: 0,   // Must be non-negative
    minSwapVelocityRecovery: 0.50, // Must recover to 50% of baseline
    
    // Confidence thresholds
    minConfidenceToReinject: 0.65,
    
    // Consecutive healing samples required
    minConsecutiveHealing: 2,
    
    // Size adjustment based on confidence
    confidenceToSizeMapping: {
        high: { minConfidence: 0.85, sizeMultiplier: 1.0 },
        medium: { minConfidence: 0.70, sizeMultiplier: 0.75 },
        low: { minConfidence: 0.55, sizeMultiplier: 0.50 },
    },
    
    // Blacklist duration for severe exits
    severeExitBlacklistMs: 60 * 60 * 1000,  // 1 hour for severe exits
};

// Exit reasons considered "severe" (longer cooldown)
const SEVERE_EXIT_REASONS: ExitReason[] = [
    'KILL_SWITCH',
    'MARKET_CRASH',
    'LIQUIDITY_DRAIN',
];

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Pool exit snapshots - tracks recently exited positions for potential reinjection
const exitSnapshots: Map<string, ExitStructureSnapshot> = new Map();

// Blacklisted pools (temporary, from severe exits)
const blacklistedPools: Map<string, number> = new Map();  // poolId -> blacklist expiry

// Pool name cache
const poolNameCache: Map<string, string> = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register an exit for potential reinjection tracking.
 * Called when any position is closed.
 */
export function registerExit(
    poolId: string,
    poolName: string,
    exitReason: string,
    exitPnL: number,
    exitPnLPercent: number,
    entryMHI?: number,
    entryEntropy?: number
): void {
    const now = Date.now();
    
    // Classify exit reason
    const classifiedReason = classifyExitReason(exitReason);
    
    // Check if severe exit - add to blacklist
    if (SEVERE_EXIT_REASONS.includes(classifiedReason)) {
        blacklistedPools.set(poolId, now + REINJECTION_CONFIG.severeExitBlacklistMs);
        logger.info(
            `[REINJECTION] Blacklisted ${poolName} for ${REINJECTION_CONFIG.severeExitBlacklistMs / 60000}m ` +
            `due to severe exit: ${classifiedReason}`
        );
        return;
    }
    
    // Get current structure state
    const metrics = computeMicrostructureMetrics(poolId);
    const slopes = getMomentumSlopes(poolId);
    const mhiResult = computeMHI(poolId);
    
    if (!metrics || !mhiResult) {
        logger.debug(`[REINJECTION] Cannot track ${poolName} - no telemetry`);
        return;
    }
    
    // Create exit snapshot
    const snapshot: ExitStructureSnapshot = {
        poolId,
        exitTime: now,
        exitReason: classifiedReason,
        
        // Exit metrics
        exitMHI: mhiResult.mhi,
        exitEntropy: metrics.poolEntropy,
        exitLiquidityFlow: metrics.liquidityFlow / 100,
        exitSwapVelocity: metrics.swapVelocity / 100,
        exitBinVelocity: metrics.binVelocity / 100,
        
        // Slopes at exit
        exitVelocitySlope: slopes?.velocitySlope ?? 0,
        exitLiquiditySlope: slopes?.liquiditySlope ?? 0,
        exitEntropySlope: slopes?.entropySlope ?? 0,
        
        // Entry reference
        entryMHI: entryMHI ?? mhiResult.mhi,
        entryEntropy: entryEntropy ?? metrics.poolEntropy,
        
        // Tracking state
        snapshotsSinceExit: 0,
        consecutiveHealingSamples: 0,
        lastCheckTime: now,
        
        // P&L context
        exitPnL,
        exitPnLPercent,
    };
    
    exitSnapshots.set(poolId, snapshot);
    poolNameCache.set(poolId, poolName);
    
    logger.info(
        `[REINJECTION] Tracking ${poolName} for potential re-entry | ` +
        `reason=${classifiedReason} | ` +
        `exitMHI=${mhiResult.mhi.toFixed(2)} | ` +
        `entropy=${metrics.poolEntropy.toFixed(4)} | ` +
        `pnl=${exitPnL >= 0 ? '+' : ''}$${exitPnL.toFixed(2)}`
    );
}

/**
 * Classify exit reason string into enum
 */
function classifyExitReason(reason: string): ExitReason {
    const r = reason.toUpperCase();
    
    if (r.includes('HARMONIC')) return 'HARMONIC_DECAY';
    if (r.includes('KILL')) return 'KILL_SWITCH';
    if (r.includes('MIGRATION')) return 'TIER_MIGRATION';
    if (r.includes('SCORE') && r.includes('COLLAPSE')) return 'SCORE_COLLAPSE';
    if (r.includes('FEE') && r.includes('COLLAPSE')) return 'FEE_INTENSITY_COLLAPSE';
    if (r.includes('LIQUIDITY') && (r.includes('DRAIN') || r.includes('OUTFLOW'))) return 'LIQUIDITY_DRAIN';
    if (r.includes('MARKET') && r.includes('CRASH')) return 'MARKET_CRASH';
    if (r.includes('STRUCTURAL') || r.includes('DECAY')) return 'STRUCTURAL_DECAY';
    if (r.includes('MANUAL')) return 'MANUAL';
    if (r.includes('ROTATION')) return 'ROTATION';
    
    return 'UNKNOWN';
}

/**
 * Update tracking state for all exit snapshots.
 * Called on each telemetry refresh cycle.
 */
export function updateReinjectionTracking(): void {
    const now = Date.now();
    const toRemove: string[] = [];
    
    // Clean up blacklist
    for (const [poolId, expiry] of blacklistedPools) {
        if (now > expiry) {
            blacklistedPools.delete(poolId);
            logger.debug(`[REINJECTION] Removed ${poolId.slice(0, 8)}... from blacklist`);
        }
    }
    
    // Update each tracked exit
    for (const [poolId, snapshot] of exitSnapshots) {
        const timeSinceExit = now - snapshot.exitTime;
        
        // Remove if tracking expired
        if (timeSinceExit > REINJECTION_CONFIG.maxTrackingTimeMs) {
            toRemove.push(poolId);
            continue;
        }
        
        // Skip if still in cooldown
        if (timeSinceExit < REINJECTION_CONFIG.minCooldownMs) {
            continue;
        }
        
        // Increment snapshot counter
        snapshot.snapshotsSinceExit++;
        snapshot.lastCheckTime = now;
        
        // Check for healing
        const healingCheck = checkStructureHealing(snapshot);
        
        if (healingCheck.isHealing) {
            snapshot.consecutiveHealingSamples++;
        } else {
            snapshot.consecutiveHealingSamples = 0;
        }
    }
    
    // Remove expired entries
    for (const poolId of toRemove) {
        exitSnapshots.delete(poolId);
        const name = poolNameCache.get(poolId) || poolId.slice(0, 8);
        logger.debug(`[REINJECTION] Stopped tracking ${name} - timeout`);
    }
}

/**
 * Check if structure is healing for a pool
 */
function checkStructureHealing(snapshot: ExitStructureSnapshot): {
    isHealing: boolean;
    signals: string[];
    blockers: string[];
} {
    const metrics = computeMicrostructureMetrics(snapshot.poolId);
    const mhiResult = computeMHI(snapshot.poolId);
    const slopes = getMomentumSlopes(snapshot.poolId);
    
    const signals: string[] = [];
    const blockers: string[] = [];
    
    if (!metrics || !mhiResult) {
        return { isHealing: false, signals: [], blockers: ['No telemetry'] };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RULE 1: No reinjection if entropy < baseline
    // ═══════════════════════════════════════════════════════════════════════════
    const entropyRecovery = snapshot.entryEntropy > 0 
        ? metrics.poolEntropy / snapshot.entryEntropy 
        : 0;
    
    if (entropyRecovery < REINJECTION_CONFIG.minEntropyRecovery) {
        blockers.push(`Entropy below baseline (${(entropyRecovery * 100).toFixed(1)}%)`);
    } else {
        signals.push(`Entropy recovered (${(entropyRecovery * 100).toFixed(1)}%)`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RULE 2: No reinjection if liquidityFlow < 0
    // ═══════════════════════════════════════════════════════════════════════════
    const currentLiquidityFlow = metrics.liquidityFlow / 100;  // Normalize from 0-100
    
    if (currentLiquidityFlow < REINJECTION_CONFIG.minLiquidityFlowRecovery) {
        blockers.push(`Liquidity still draining (${(currentLiquidityFlow * 100).toFixed(2)}%)`);
    } else {
        signals.push(`Liquidity flow stable/positive`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RULE 3: No reinjection if swapVelocity is stagnant
    // ═══════════════════════════════════════════════════════════════════════════
    const swapVelocityRecovery = snapshot.exitSwapVelocity > 0
        ? (metrics.swapVelocity / 100) / snapshot.exitSwapVelocity
        : 0;
    
    if (swapVelocityRecovery < REINJECTION_CONFIG.minSwapVelocityRecovery) {
        blockers.push(`Swap velocity stagnant (${(swapVelocityRecovery * 100).toFixed(1)}% of exit)`);
    } else {
        signals.push(`Swap velocity recovered`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RULE 4: MHI must be above threshold
    // ═══════════════════════════════════════════════════════════════════════════
    if (mhiResult.mhi < REINJECTION_CONFIG.minHealingMHI) {
        blockers.push(`MHI too low (${mhiResult.mhi.toFixed(2)} < ${REINJECTION_CONFIG.minHealingMHI})`);
    } else {
        signals.push(`MHI healthy (${mhiResult.mhi.toFixed(2)})`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RULE 5: Slopes should not be severely negative
    // ═══════════════════════════════════════════════════════════════════════════
    if (slopes && slopes.valid) {
        const allSlopesNegative = slopes.velocitySlope < 0 && 
                                   slopes.liquiditySlope < 0 && 
                                   slopes.entropySlope < 0;
        
        if (allSlopesNegative) {
            blockers.push('All slopes still negative');
        } else if (slopes.liquiditySlope >= 0 && slopes.entropySlope >= 0) {
            signals.push('Slopes recovering');
        }
    }
    
    // Healing = no blockers
    const isHealing = blockers.length === 0;
    
    return { isHealing, signals, blockers };
}

/**
 * Evaluate a pool for reinjection opportunity.
 */
export function evaluateReinjection(poolId: string): ReinjectionEvaluation {
    const now = Date.now();
    const snapshot = exitSnapshots.get(poolId);
    
    // Default blocked response
    const blocked: ReinjectionEvaluation = {
        poolId,
        canReinject: false,
        confidence: 0,
        blockedReasons: [],
        healingSignals: [],
        currentMHI: 0,
        structureRecoveryPct: 0,
        snapshotsSinceExit: 0,
        cooldownRemaining: 0,
    };
    
    // Check if pool is tracked
    if (!snapshot) {
        blocked.blockedReasons.push('Pool not tracked for reinjection');
        return blocked;
    }
    
    // Check blacklist
    const blacklistExpiry = blacklistedPools.get(poolId);
    if (blacklistExpiry && now < blacklistExpiry) {
        blocked.blockedReasons.push(`Blacklisted for ${Math.ceil((blacklistExpiry - now) / 60000)}m`);
        blocked.cooldownRemaining = blacklistExpiry - now;
        return blocked;
    }
    
    // Check cooldown
    const timeSinceExit = now - snapshot.exitTime;
    if (timeSinceExit < REINJECTION_CONFIG.minCooldownMs) {
        const cooldownRemaining = REINJECTION_CONFIG.minCooldownMs - timeSinceExit;
        blocked.blockedReasons.push(`Cooldown active (${Math.ceil(cooldownRemaining / 1000)}s remaining)`);
        blocked.cooldownRemaining = cooldownRemaining;
        return blocked;
    }
    
    // Check minimum snapshots
    if (snapshot.snapshotsSinceExit < REINJECTION_CONFIG.minSnapshotsForEval) {
        blocked.blockedReasons.push(
            `Insufficient snapshots (${snapshot.snapshotsSinceExit}/${REINJECTION_CONFIG.minSnapshotsForEval})`
        );
        return blocked;
    }
    
    // Get current state
    const metrics = computeMicrostructureMetrics(poolId);
    const mhiResult = computeMHI(poolId);
    
    if (!metrics || !mhiResult) {
        blocked.blockedReasons.push('No current telemetry');
        return blocked;
    }
    
    // Check structure healing
    const healingCheck = checkStructureHealing(snapshot);
    
    // Calculate structure recovery percentage
    const mhiRecovery = snapshot.entryMHI > 0 ? mhiResult.mhi / snapshot.entryMHI : 0;
    const entropyRecovery = snapshot.entryEntropy > 0 
        ? metrics.poolEntropy / snapshot.entryEntropy 
        : 0;
    const structureRecoveryPct = (mhiRecovery + entropyRecovery) / 2;
    
    // Calculate confidence score
    let confidence = 0;
    
    if (healingCheck.blockers.length === 0) {
        // Base confidence from MHI
        confidence = Math.min(mhiResult.mhi / 0.8, 1.0) * 0.4;
        
        // Add confidence from consecutive healing samples
        const healingBonus = Math.min(snapshot.consecutiveHealingSamples / 3, 1.0) * 0.3;
        confidence += healingBonus;
        
        // Add confidence from structure recovery
        confidence += Math.min(structureRecoveryPct, 1.0) * 0.3;
    }
    
    // Build result
    const result: ReinjectionEvaluation = {
        poolId,
        canReinject: confidence >= REINJECTION_CONFIG.minConfidenceToReinject &&
                     healingCheck.blockers.length === 0 &&
                     snapshot.consecutiveHealingSamples >= REINJECTION_CONFIG.minConsecutiveHealing,
        confidence,
        blockedReasons: healingCheck.blockers,
        healingSignals: healingCheck.signals,
        currentMHI: mhiResult.mhi,
        structureRecoveryPct,
        snapshotsSinceExit: snapshot.snapshotsSinceExit,
        cooldownRemaining: 0,
    };
    
    return result;
}

/**
 * Get all current reinjection opportunities.
 * Returns pools that are ready for re-entry.
 */
export function getReinjectionOpportunities(): ReinjectionOpportunity[] {
    const opportunities: ReinjectionOpportunity[] = [];
    
    for (const [poolId] of exitSnapshots) {
        const evaluation = evaluateReinjection(poolId);
        
        if (evaluation.canReinject) {
            const snapshot = exitSnapshots.get(poolId)!;
            const poolName = poolNameCache.get(poolId) || poolId.slice(0, 8);
            
            // Calculate size multiplier based on confidence
            let sizeMultiplier = REINJECTION_CONFIG.confidenceToSizeMapping.low.sizeMultiplier;
            if (evaluation.confidence >= REINJECTION_CONFIG.confidenceToSizeMapping.high.minConfidence) {
                sizeMultiplier = REINJECTION_CONFIG.confidenceToSizeMapping.high.sizeMultiplier;
            } else if (evaluation.confidence >= REINJECTION_CONFIG.confidenceToSizeMapping.medium.minConfidence) {
                sizeMultiplier = REINJECTION_CONFIG.confidenceToSizeMapping.medium.sizeMultiplier;
            }
            
            opportunities.push({
                poolId,
                poolName,
                confidence: evaluation.confidence,
                currentMHI: evaluation.currentMHI,
                recoveryPct: evaluation.structureRecoveryPct,
                timeSinceExit: Date.now() - snapshot.exitTime,
                suggestedSizeMultiplier: sizeMultiplier,
            });
        }
    }
    
    // Sort by confidence descending
    opportunities.sort((a, b) => b.confidence - a.confidence);
    
    return opportunities;
}

/**
 * Consume a reinjection opportunity (remove from tracking after re-entry).
 */
export function consumeReinjection(poolId: string): void {
    exitSnapshots.delete(poolId);
    logger.info(`[REINJECTION] Consumed opportunity for ${poolNameCache.get(poolId) || poolId.slice(0, 8)}`);
}

/**
 * Check if a pool is being tracked for reinjection.
 */
export function isTrackingReinjection(poolId: string): boolean {
    return exitSnapshots.has(poolId);
}

/**
 * Check if a pool is blacklisted.
 */
export function isBlacklisted(poolId: string): boolean {
    const expiry = blacklistedPools.get(poolId);
    if (!expiry) return false;
    
    if (Date.now() > expiry) {
        blacklistedPools.delete(poolId);
        return false;
    }
    
    return true;
}

/**
 * Get tracking stats for logging.
 */
export function getReinjectionStats(): {
    trackedPools: number;
    blacklistedPools: number;
    readyForReinjection: number;
} {
    const opportunities = getReinjectionOpportunities();
    
    return {
        trackedPools: exitSnapshots.size,
        blacklistedPools: blacklistedPools.size,
        readyForReinjection: opportunities.length,
    };
}

/**
 * Log reinjection opportunities for debugging.
 */
export function logReinjectionOpportunities(): void {
    const opportunities = getReinjectionOpportunities();
    
    if (opportunities.length === 0) {
        logger.debug('[REINJECTION] No reinjection opportunities');
        return;
    }
    
    logger.info(`[REINJECTION] ${opportunities.length} pools ready for re-entry:`);
    
    for (const opp of opportunities.slice(0, 5)) {
        logger.info(
            `  → ${opp.poolName} | ` +
            `confidence=${(opp.confidence * 100).toFixed(1)}% | ` +
            `MHI=${opp.currentMHI.toFixed(2)} | ` +
            `recovery=${(opp.recoveryPct * 100).toFixed(1)}% | ` +
            `sizeMultiplier=${opp.suggestedSizeMultiplier.toFixed(2)}`
        );
    }
}

/**
 * Clear all reinjection state (for reset/cleanup).
 */
export function clearReinjectionState(): void {
    exitSnapshots.clear();
    blacklistedPools.clear();
    poolNameCache.clear();
    logger.info('[REINJECTION] Cleared all reinjection state');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    ExitStructureSnapshot,
    REINJECTION_CONFIG,
};

