/**
 * Continuous Bin Pursuit (CBP) — Dominant Liquidity Engine
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * MISSION: Dynamically track, predict, and occupy the most profitable bin at
 * all times, prioritizing MTM dominance and fast compounding over passive fee
 * accrual.
 * 
 * This is no longer:
 *   - an LP bot
 *   - a yield strategy
 *   - a passive system
 * 
 * This is microstructure exploitation at scale.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { PositionMode } from './binDominance';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const CBP_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // FORCED BIN MIGRATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Threshold for forced bin migration: BPS_target > BPS_current × this */
    MIGRATION_THRESHOLD: 1.15,
    
    /** Number of bins to evaluate around current bin */
    BIN_SCAN_RANGE: 10,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DUAL PROFIT PATH
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** MTM time horizon for profit estimation (minutes) */
    MTM_HORIZON_MINUTES: 10,
    
    /** Minimum dominance to stay in BULLY mode even with low MTM */
    MIN_DOMINANCE_TO_HOLD: 0.40,
    
    /** Exit dominance threshold when MTM is negative */
    EXIT_DOMINANCE_THRESHOLD: 0.15,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CAPITAL ESCALATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Minimum dominance for capital escalation */
    ESCALATION_MIN_DOMINANCE: 0.45,
    
    /** Maximum size multiplier with confirmed dominance */
    ESCALATION_MAX_MULTIPLIER: 1.75,
    
    /** Escalation step size (incremental, not all at once) */
    ESCALATION_STEP: 0.10,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BIN WIDTH
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Max bins in BULLY mode */
    BULLY_MAX_BINS: 2,
    
    /** Volatility threshold to allow bin expansion */
    VOLATILITY_EXPLOSION_THRESHOLD: 0.05,  // 5% volatility
    
    // ═══════════════════════════════════════════════════════════════════════════
    // IGNORED GATES IN BULLY MODE
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Gates to ignore in BULLY mode */
    IGNORED_GATES: [
        'MIN_HOLD',
        'COST_NOT_AMORTIZED',
        'SNAPSHOT_MINIMUM',
        'BOOTSTRAP_LENIENCY',
    ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BinPressureScore {
    binId: number;
    swapFlowRate: number;
    swapAcceleration: number;
    directionalBias: number;
    entropyCompression: number;
    bps: number;  // Composite score
}

export interface BinPressureState {
    poolAddress: string;
    currentBin: number;
    targetBin: number;
    bpsCurrent: number;
    bpsTarget: number;
    deltaBPS: number;  // Momentum
    allBinScores: BinPressureScore[];
    lastUpdated: number;
}

export interface MigrationDecision {
    shouldMigrate: boolean;
    fromBin: number;
    toBin: number;
    reason: string;
    bpsRatio: number;
    ignoredGates: string[];
}

export interface HoldDecision {
    shouldHold: boolean;
    reason: string;
    dominanceScore: number;
    expectedMTM10min: number;
    shouldExit: boolean;
}

export interface EscalationDecision {
    shouldEscalate: boolean;
    currentMultiplier: number;
    targetMultiplier: number;
    step: number;
    reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Bin pressure state by pool address */
const binPressureState = new Map<string, BinPressureState>();

/** Current escalation multiplier by tradeId */
const escalationMultipliers = new Map<string, number>();

// ═══════════════════════════════════════════════════════════════════════════════
// BIN PRESSURE SCORE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute Bin Pressure Score (BPS) for a bin
 * 
 * BPS = swapFlowRate × swapAcceleration × directionalBias × entropyCompression
 */
export function computeBinPressureScore(
    binId: number,
    swapFlowRate: number,
    swapAcceleration: number,
    directionalBias: number,
    entropyCompression: number,
): BinPressureScore {
    // All components should be positive for meaningful BPS
    const normalizedFlow = Math.max(0, swapFlowRate);
    const normalizedAccel = Math.max(0.01, swapAcceleration);  // Floor to prevent zero
    const normalizedBias = Math.max(0.01, Math.abs(directionalBias));
    const normalizedEntropy = Math.max(0.01, entropyCompression);
    
    const bps = normalizedFlow * normalizedAccel * normalizedBias * normalizedEntropy;
    
    return {
        binId,
        swapFlowRate: normalizedFlow,
        swapAcceleration: normalizedAccel,
        directionalBias: normalizedBias,
        entropyCompression: normalizedEntropy,
        bps,
    };
}

/**
 * Evaluate all nearby bins and find target
 */
export function evaluateBinPressure(
    poolAddress: string,
    currentBin: number,
    binMetrics: Array<{
        binId: number;
        swapFlowRate: number;
        swapAcceleration: number;
        directionalBias: number;
        entropyCompression: number;
    }>,
): BinPressureState {
    const now = Date.now();
    
    // Compute BPS for all bins
    const allBinScores = binMetrics.map(m => computeBinPressureScore(
        m.binId,
        m.swapFlowRate,
        m.swapAcceleration,
        m.directionalBias,
        m.entropyCompression,
    ));
    
    // Find current bin BPS
    const currentBinScore = allBinScores.find(b => b.binId === currentBin);
    const bpsCurrent = currentBinScore?.bps ?? 0;
    
    // Find target bin (argmax BPS)
    const targetBinScore = allBinScores.reduce(
        (max, bin) => bin.bps > max.bps ? bin : max,
        allBinScores[0] ?? { binId: currentBin, bps: 0 },
    );
    const targetBin = targetBinScore.binId;
    const bpsTarget = targetBinScore.bps;
    
    // Compute momentum (delta BPS from previous)
    const previous = binPressureState.get(poolAddress);
    const deltaBPS = previous ? bpsTarget - previous.bpsTarget : 0;
    
    const state: BinPressureState = {
        poolAddress,
        currentBin,
        targetBin,
        bpsCurrent,
        bpsTarget,
        deltaBPS,
        allBinScores,
        lastUpdated: now,
    };
    
    binPressureState.set(poolAddress, state);
    
    return state;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORCED BIN MIGRATION RULE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate forced bin migration
 * 
 * If BPS_target > BPS_current × 1.15:
 *   - Immediately rebalance into targetBin
 *   - Do NOT wait for exit triggers
 *   - Do NOT wait for cost recovery
 *   - This is a chase, not an exit
 */
export function evaluateForcedMigration(
    poolAddress: string,
    positionMode: PositionMode,
): MigrationDecision {
    const state = binPressureState.get(poolAddress);
    
    if (!state) {
        return {
            shouldMigrate: false,
            fromBin: 0,
            toBin: 0,
            reason: 'NO_STATE',
            bpsRatio: 0,
            ignoredGates: [],
        };
    }
    
    const { currentBin, targetBin, bpsCurrent, bpsTarget } = state;
    
    // No migration if same bin
    if (currentBin === targetBin) {
        return {
            shouldMigrate: false,
            fromBin: currentBin,
            toBin: targetBin,
            reason: 'SAME_BIN',
            bpsRatio: 1.0,
            ignoredGates: [],
        };
    }
    
    // Calculate BPS ratio
    const bpsRatio = bpsCurrent > 0 ? bpsTarget / bpsCurrent : Infinity;
    
    // Check migration threshold
    if (bpsRatio >= CBP_CONFIG.MIGRATION_THRESHOLD) {
        const ignoredGates = positionMode === PositionMode.BULLY 
            ? CBP_CONFIG.IGNORED_GATES 
            : [];
        
        logger.info(
            `[CBP] pool=${poolAddress.slice(0, 8)} fromBin=${currentBin} → toBin=${targetBin} ` +
            `reason=PRESSURE_SHIFT bpsRatio=${bpsRatio.toFixed(2)}`
        );
        
        return {
            shouldMigrate: true,
            fromBin: currentBin,
            toBin: targetBin,
            reason: 'PRESSURE_SHIFT',
            bpsRatio,
            ignoredGates,
        };
    }
    
    return {
        shouldMigrate: false,
        fromBin: currentBin,
        toBin: targetBin,
        reason: `BPS_RATIO_LOW: ${bpsRatio.toFixed(2)} < ${CBP_CONFIG.MIGRATION_THRESHOLD}`,
        bpsRatio,
        ignoredGates: [],
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DUAL PROFIT PATH VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate hold decision using dual profit path
 * 
 * Remain in BULLY mode if either is true:
 *   - expectedMTM_10min >= executionCost
 *   - dominanceScore >= 0.40
 * 
 * Exit fully only if:
 *   - expectedMTM_10min < 0
 *   - AND dominanceScore < 0.15
 */
export function evaluateDualProfitPath(
    poolAddress: string,
    dominanceScore: number,
    expectedMTM10min: number,
    executionCost: number,
): HoldDecision {
    const config = CBP_CONFIG;
    
    // Profit path 1: MTM covers execution cost
    const mtmPathValid = expectedMTM10min >= executionCost;
    
    // Profit path 2: Dominance is strong enough
    const dominancePathValid = dominanceScore >= config.MIN_DOMINANCE_TO_HOLD;
    
    // Hold if either path is valid
    const shouldHold = mtmPathValid || dominancePathValid;
    
    // Exit only if MTM is negative AND dominance collapsed
    const shouldExit = expectedMTM10min < 0 && dominanceScore < config.EXIT_DOMINANCE_THRESHOLD;
    
    let reason: string;
    if (shouldExit) {
        reason = 'DUAL_PATH_FAILED';
        logger.warn(
            `[PREDATOR] ABANDON pool=${poolAddress.slice(0, 8)} ` +
            `dominance=${dominanceScore.toFixed(2)} mtm10m=$${expectedMTM10min.toFixed(4)} ` +
            `reason=dominance_lost`
        );
    } else if (shouldHold) {
        reason = mtmPathValid ? 'MTM_POSITIVE' : 'DOMINANCE_CONFIRMED';
        logger.debug(
            `[PREDATOR] HOLD pool=${poolAddress.slice(0, 8)} ` +
            `dominance=${dominanceScore.toFixed(2)} mtm10m=$${expectedMTM10min.toFixed(4)} ` +
            `reason=${reason}`
        );
    } else {
        reason = 'WEAK_HOLD';
    }
    
    if (shouldHold && dominanceScore >= config.MIN_DOMINANCE_TO_HOLD) {
        logger.info(
            `[DOMINANCE] pool=${poolAddress.slice(0, 8)} ` +
            `score=${dominanceScore.toFixed(2)}`
        );
    }
    
    return {
        shouldHold,
        reason,
        dominanceScore,
        expectedMTM10min,
        shouldExit,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL ESCALATION ON CONFIRMED DOMINANCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate capital escalation
 * 
 * If dominanceScore >= 0.45 AND dominanceSlope > 0:
 *   - Scale position size up to 1.75× base
 *   - Incrementally (not all at once)
 */
export function evaluateCapitalEscalation(
    tradeId: string,
    dominanceScore: number,
    dominanceSlope: number,
): EscalationDecision {
    const config = CBP_CONFIG;
    
    // Get current multiplier (default 1.0)
    const currentMultiplier = escalationMultipliers.get(tradeId) ?? 1.0;
    
    // Check escalation conditions
    const canEscalate = dominanceScore >= config.ESCALATION_MIN_DOMINANCE && dominanceSlope > 0;
    
    if (!canEscalate) {
        // De-escalate if conditions not met
        if (currentMultiplier > 1.0) {
            const targetMultiplier = Math.max(1.0, currentMultiplier - config.ESCALATION_STEP);
            escalationMultipliers.set(tradeId, targetMultiplier);
            
            return {
                shouldEscalate: false,
                currentMultiplier,
                targetMultiplier,
                step: -config.ESCALATION_STEP,
                reason: `DE_ESCALATE: dominance=${dominanceScore.toFixed(2)} slope=${dominanceSlope.toFixed(3)}`,
            };
        }
        
        return {
            shouldEscalate: false,
            currentMultiplier,
            targetMultiplier: currentMultiplier,
            step: 0,
            reason: 'NO_ESCALATION_CONDITIONS',
        };
    }
    
    // Calculate target multiplier (incremental step up)
    const targetMultiplier = Math.min(
        config.ESCALATION_MAX_MULTIPLIER,
        currentMultiplier + config.ESCALATION_STEP,
    );
    
    if (targetMultiplier > currentMultiplier) {
        escalationMultipliers.set(tradeId, targetMultiplier);
        
        logger.info(
            `[CBP-ESCALATE] tradeId=${tradeId.slice(0, 8)} ` +
            `${currentMultiplier.toFixed(2)}× → ${targetMultiplier.toFixed(2)}× ` +
            `dominance=${dominanceScore.toFixed(2)} slope=${dominanceSlope.toFixed(3)}`
        );
        
        return {
            shouldEscalate: true,
            currentMultiplier,
            targetMultiplier,
            step: config.ESCALATION_STEP,
            reason: 'DOMINANCE_CONFIRMED',
        };
    }
    
    return {
        shouldEscalate: false,
        currentMultiplier,
        targetMultiplier: currentMultiplier,
        step: 0,
        reason: 'AT_MAX_ESCALATION',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BIN WIDTH ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get bin count for BULLY mode
 * 
 * In BULLY mode:
 *   - Always use 1-2 bins
 *   - Width expands only when volatility explodes
 *   - Never widen defensively
 */
export function getBullyBinCount(
    volatilityPct: number,
): number {
    const config = CBP_CONFIG;
    
    // Only expand if volatility explodes
    if (volatilityPct >= config.VOLATILITY_EXPLOSION_THRESHOLD) {
        return config.BULLY_MAX_BINS;  // 2 bins
    }
    
    return 1;  // Default: single bin
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATE BYPASS CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a gate should be bypassed in BULLY mode
 */
export function shouldBypassGate(
    positionMode: PositionMode,
    gateName: string,
): boolean {
    if (positionMode !== PositionMode.BULLY) {
        return false;
    }
    
    return CBP_CONFIG.IGNORED_GATES.includes(gateName);
}

/**
 * Get list of bypassed gates for logging
 */
export function getBypassedGates(positionMode: PositionMode): string[] {
    if (positionMode !== PositionMode.BULLY) {
        return [];
    }
    return [...CBP_CONFIG.IGNORED_GATES];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export function getBinPressureState(poolAddress: string): BinPressureState | undefined {
    return binPressureState.get(poolAddress);
}

export function getEscalationMultiplier(tradeId: string): number {
    return escalationMultipliers.get(tradeId) ?? 1.0;
}

export function clearBinPressureState(poolAddress: string): void {
    binPressureState.delete(poolAddress);
}

export function clearEscalationMultiplier(tradeId: string): void {
    escalationMultipliers.delete(tradeId);
}

export function clearAllCBPState(): void {
    binPressureState.clear();
    escalationMultipliers.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logCBPSummary(): void {
    const states = Array.from(binPressureState.values());
    const escalations = Array.from(escalationMultipliers.entries());
    
    if (states.length === 0) {
        return;
    }
    
    const avgBPS = states.reduce((sum, s) => sum + s.bpsCurrent, 0) / states.length;
    const migrationCandidates = states.filter(s => 
        s.bpsCurrent > 0 && s.bpsTarget / s.bpsCurrent >= CBP_CONFIG.MIGRATION_THRESHOLD
    ).length;
    const escalatedPositions = escalations.filter(([, m]) => m > 1.0).length;
    
    logger.info(
        `[CBP-SUMMARY] pools=${states.length} avgBPS=${avgBPS.toFixed(4)} ` +
        `migrationCandidates=${migrationCandidates} escalated=${escalatedPositions}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP BANNER
// ═══════════════════════════════════════════════════════════════════════════════

export function logCBPBanner(): void {
    const config = CBP_CONFIG;
    
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════════════════════════');
    logger.info('     CONTINUOUS BIN PURSUIT (CBP) — DOMINANT LIQUIDITY ENGINE ACTIVATED');
    logger.info('═══════════════════════════════════════════════════════════════════════════════');
    logger.info('');
    logger.info('  MISSION: Dynamically track, predict, and occupy the most profitable bin');
    logger.info('           at all times, prioritizing MTM dominance over passive fee accrual.');
    logger.info('');
    logger.info('  This is no longer:');
    logger.info('    ❌ an LP bot');
    logger.info('    ❌ a yield strategy');
    logger.info('    ❌ a passive system');
    logger.info('');
    logger.info('  This IS:');
    logger.info('    ✅ Microstructure exploitation at scale');
    logger.info('    ✅ Liquidity warfare');
    logger.info('');
    logger.info('  CBP CONFIGURATION:');
    logger.info(`    • Migration Threshold: BPS_target > BPS_current × ${config.MIGRATION_THRESHOLD}`);
    logger.info(`    • MTM Horizon: ${config.MTM_HORIZON_MINUTES} minutes`);
    logger.info(`    • Min Dominance to Hold: ${config.MIN_DOMINANCE_TO_HOLD * 100}%`);
    logger.info(`    • Exit Dominance Threshold: ${config.EXIT_DOMINANCE_THRESHOLD * 100}%`);
    logger.info(`    • Max Capital Escalation: ${config.ESCALATION_MAX_MULTIPLIER}×`);
    logger.info(`    • BULLY Max Bins: ${config.BULLY_MAX_BINS}`);
    logger.info('');
    logger.info('  GATES IGNORED IN BULLY MODE:');
    config.IGNORED_GATES.forEach(gate => {
        logger.info(`    • ${gate}`);
    });
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════════════════════════');
    logger.info('');
}
