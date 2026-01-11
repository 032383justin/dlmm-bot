/**
 * Bin Dominance — Real-Time Bin Dominance Scoring System
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREDATOR BIN DOMINANCE: Transform from reactive LP to active bin predator
 * 
 * This module computes:
 *   - dominanceScore = myLiquidity / totalLiquidityInBin
 *   - directionalFlowBias = signedSwapFlowThroughBin / totalSwapFlow
 *   - effectiveDominance = dominanceScore × directionalFlowBias
 *   - dominanceSlope (Δ over last N samples)
 *   - flowAlignment (price movement direction vs swap direction)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION MODE ENUM
// ═══════════════════════════════════════════════════════════════════════════════

export enum PositionMode {
    /** Fee-first, slow rebalance */
    HARVEST = 'HARVEST',
    /** MTM-first, aggressive rebalance */
    BULLY = 'BULLY',
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const BIN_DOMINANCE_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // MODE SWITCHING THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Enter BULLY mode if effectiveDominance >= this */
    BULLY_ENTRY_DOMINANCE: 0.35,
    
    /** Exit BULLY mode if effectiveDominance < this */
    BULLY_EXIT_DOMINANCE: 0.20,
    
    /** Force exit in BULLY mode if effectiveDominance < this */
    BULLY_FORCE_EXIT_DOMINANCE: 0.15,
    
    /** Minimum dominance slope for BULLY entry (positive) */
    BULLY_ENTRY_SLOPE_MIN: 0,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FLOW ALIGNMENT
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Flow alignment threshold for STRONG */
    FLOW_ALIGNMENT_STRONG: 0.60,
    
    /** Flow alignment threshold for WEAK (below this = OPPOSED) */
    FLOW_ALIGNMENT_WEAK: 0.30,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DOMINANCE TRACKING
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Number of samples for slope calculation */
    SLOPE_SAMPLE_COUNT: 5,
    
    /** Entropy expansion threshold for BULLY exit */
    ENTROPY_EXPANSION_THRESHOLD: 0.15,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CAPITAL ESCALATION (CBP DIRECTIVE: Up to 1.75× with confirmed dominance)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Max size multiplier in BULLY mode */
    BULLY_SIZE_MULTIPLIER_MAX: 1.75,
    
    /** Minimum dominance for size escalation */
    SIZE_ESCALATION_MIN_DOMINANCE: 0.45,
    
    /** Escalation step (incremental, not all at once) */
    SIZE_ESCALATION_STEP: 0.10,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REBALANCE
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Max bins in BULLY mode */
    BULLY_MAX_BINS: 2,
    
    /** Max bins in HARVEST mode */
    HARVEST_MAX_BINS: 10,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type FlowAlignment = 'STRONG' | 'WEAK' | 'OPPOSED';

export interface BinDominanceMetrics {
    /** Pool address */
    poolAddress: string;
    
    /** Current bin we're providing liquidity in */
    activeBin: number;
    
    /** myLiquidity / totalLiquidityInBin */
    dominanceScore: number;
    
    /** signedSwapFlowThroughBin / totalSwapFlow */
    directionalFlowBias: number;
    
    /** dominanceScore × directionalFlowBias */
    effectiveDominance: number;
    
    /** Δ effectiveDominance over last N samples */
    dominanceSlope: number;
    
    /** Price movement direction vs swap direction alignment */
    flowAlignment: FlowAlignment;
    
    /** Entropy expansion detected */
    entropyExpansionDetected: boolean;
    
    /** Timestamp of last update */
    updatedAt: number;
}

export interface TargetBinSelection {
    /** Selected target bin */
    targetBin: number;
    
    /** Score of selected bin */
    score: number;
    
    /** Components */
    components: {
        swapFlowRate: number;
        swapAcceleration: number;
        entropyCompression: number;
        directionalBias: number;
    };
    
    /** Is this a shift from current bin? */
    isShift: boolean;
    
    /** Shift magnitude (bins) */
    shiftMagnitude: number;
}

export interface PositionModeState {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    mode: PositionMode;
    enteredModeAt: number;
    lastModeChangeAt: number;
    dominanceHistory: number[];
    currentMetrics: BinDominanceMetrics | null;
}

export interface ModeSwitchDecision {
    shouldSwitch: boolean;
    newMode: PositionMode;
    reason: string;
    forceExit: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Position mode state by tradeId */
const positionModeState = new Map<string, PositionModeState>();

/** Dominance metrics by poolAddress */
const poolDominanceMetrics = new Map<string, BinDominanceMetrics>();

// ═══════════════════════════════════════════════════════════════════════════════
// DOMINANCE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute bin dominance metrics for a pool
 */
export function computeBinDominance(
    poolAddress: string,
    activeBin: number,
    myLiquidity: number,
    totalBinLiquidity: number,
    signedSwapFlow: number,
    totalSwapFlow: number,
    priceDirection: number,  // +1 up, -1 down, 0 neutral
    swapDirection: number,   // +1 buy, -1 sell, 0 neutral
    currentEntropy: number,
    previousEntropy: number,
): BinDominanceMetrics {
    const now = Date.now();
    
    // Compute dominance score
    const dominanceScore = totalBinLiquidity > 0 
        ? Math.min(1.0, myLiquidity / totalBinLiquidity) 
        : 0;
    
    // Compute directional flow bias
    const directionalFlowBias = totalSwapFlow > 0 
        ? signedSwapFlow / totalSwapFlow 
        : 0;
    
    // Compute effective dominance
    const effectiveDominance = dominanceScore * Math.abs(directionalFlowBias);
    
    // Get previous metrics for slope calculation
    const previous = poolDominanceMetrics.get(poolAddress);
    const state = Array.from(positionModeState.values()).find(s => s.poolAddress === poolAddress);
    
    // Calculate dominance slope
    let dominanceSlope = 0;
    if (state && state.dominanceHistory.length > 0) {
        const history = [...state.dominanceHistory, effectiveDominance];
        const recent = history.slice(-BIN_DOMINANCE_CONFIG.SLOPE_SAMPLE_COUNT);
        if (recent.length >= 2) {
            dominanceSlope = (recent[recent.length - 1] - recent[0]) / recent.length;
        }
    }
    
    // Compute flow alignment
    let flowAlignment: FlowAlignment;
    const alignmentScore = priceDirection * swapDirection;
    if (alignmentScore >= BIN_DOMINANCE_CONFIG.FLOW_ALIGNMENT_STRONG) {
        flowAlignment = 'STRONG';
    } else if (alignmentScore >= BIN_DOMINANCE_CONFIG.FLOW_ALIGNMENT_WEAK) {
        flowAlignment = 'WEAK';
    } else {
        flowAlignment = 'OPPOSED';
    }
    
    // Detect entropy expansion
    const entropyExpansionDetected = currentEntropy - previousEntropy > 
        BIN_DOMINANCE_CONFIG.ENTROPY_EXPANSION_THRESHOLD;
    
    const metrics: BinDominanceMetrics = {
        poolAddress,
        activeBin,
        dominanceScore,
        directionalFlowBias,
        effectiveDominance,
        dominanceSlope,
        flowAlignment,
        entropyExpansionDetected,
        updatedAt: now,
    };
    
    // Store metrics
    poolDominanceMetrics.set(poolAddress, metrics);
    
    // Log
    logger.info(
        `[BIN-DOMINANCE] pool=${poolAddress.slice(0, 8)} bin=${activeBin} ` +
        `dominance=${effectiveDominance.toFixed(2)} slope=${dominanceSlope >= 0 ? '+' : ''}${dominanceSlope.toFixed(3)} ` +
        `flow=${flowAlignment}`
    );
    
    return metrics;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREDICTIVE TARGET BIN SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Select target bin cluster using predictive signals (NOT reactive)
 * 
 * targetBin = argmax(swapFlowRate × swapAcceleration × entropyCompression × directionalBias)
 */
export function selectTargetBin(
    poolAddress: string,
    currentBin: number,
    binMetrics: Array<{
        binId: number;
        swapFlowRate: number;
        swapAcceleration: number;
        entropyCompression: number;
        directionalBias: number;
    }>,
): TargetBinSelection {
    if (binMetrics.length === 0) {
        return {
            targetBin: currentBin,
            score: 0,
            components: {
                swapFlowRate: 0,
                swapAcceleration: 0,
                entropyCompression: 0,
                directionalBias: 0,
            },
            isShift: false,
            shiftMagnitude: 0,
        };
    }
    
    // Score each bin
    const scoredBins = binMetrics.map(bin => ({
        ...bin,
        score: bin.swapFlowRate * 
               bin.swapAcceleration * 
               bin.entropyCompression * 
               bin.directionalBias,
    }));
    
    // Find argmax
    const best = scoredBins.reduce((max, bin) => 
        bin.score > max.score ? bin : max, 
        scoredBins[0]
    );
    
    const isShift = best.binId !== currentBin;
    const shiftMagnitude = Math.abs(best.binId - currentBin);
    
    return {
        targetBin: best.binId,
        score: best.score,
        components: {
            swapFlowRate: best.swapFlowRate,
            swapAcceleration: best.swapAcceleration,
            entropyCompression: best.entropyCompression,
            directionalBias: best.directionalBias,
        },
        isShift,
        shiftMagnitude,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODE SWITCHING LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate mode switch for a position
 */
export function evaluateModeSwitch(
    tradeId: string,
    metrics: BinDominanceMetrics,
): ModeSwitchDecision {
    const state = positionModeState.get(tradeId);
    const currentMode = state?.mode ?? PositionMode.HARVEST;
    const config = BIN_DOMINANCE_CONFIG;
    
    // Update state metrics
    if (state) {
        state.currentMetrics = metrics;
        state.dominanceHistory.push(metrics.effectiveDominance);
        if (state.dominanceHistory.length > config.SLOPE_SAMPLE_COUNT * 2) {
            state.dominanceHistory.shift();
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BULLY MODE ENTRY CONDITIONS (ALL must be true)
    // ═══════════════════════════════════════════════════════════════════════════
    const canEnterBully = 
        metrics.effectiveDominance >= config.BULLY_ENTRY_DOMINANCE &&
        metrics.dominanceSlope > config.BULLY_ENTRY_SLOPE_MIN &&
        metrics.flowAlignment === 'STRONG';
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BULLY MODE EXIT CONDITIONS (ANY triggers exit)
    // ═══════════════════════════════════════════════════════════════════════════
    const shouldExitBully = 
        metrics.effectiveDominance < config.BULLY_EXIT_DOMINANCE ||
        metrics.dominanceSlope < 0 ||
        metrics.entropyExpansionDetected;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FORCE EXIT CHECK (BULLY mode only)
    // ═══════════════════════════════════════════════════════════════════════════
    const forceExit = 
        currentMode === PositionMode.BULLY &&
        metrics.effectiveDominance < config.BULLY_FORCE_EXIT_DOMINANCE;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DECISION
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (currentMode === PositionMode.HARVEST) {
        if (canEnterBully) {
            logger.info(
                `[PREDATOR-MODE] ENTER BULLY pool=${metrics.poolAddress.slice(0, 8)} ` +
                `reason=DOMINANCE dominance=${metrics.effectiveDominance.toFixed(2)} ` +
                `slope=${metrics.dominanceSlope.toFixed(3)} flow=${metrics.flowAlignment}`
            );
            return {
                shouldSwitch: true,
                newMode: PositionMode.BULLY,
                reason: 'DOMINANCE',
                forceExit: false,
            };
        }
    } else {
        // Currently in BULLY mode
        if (forceExit) {
            logger.warn(
                `[PREDATOR-MODE] FORCE EXIT pool=${metrics.poolAddress.slice(0, 8)} ` +
                `reason=DOMINANCE_COLLAPSE dominance=${metrics.effectiveDominance.toFixed(2)}`
            );
            return {
                shouldSwitch: true,
                newMode: PositionMode.HARVEST,
                reason: 'DOMINANCE_COLLAPSE',
                forceExit: true,
            };
        }
        
        if (shouldExitBully) {
            let reason = 'DOMINANCE_DECAY';
            if (metrics.dominanceSlope < 0) reason = 'SLOPE_NEGATIVE';
            if (metrics.entropyExpansionDetected) reason = 'ENTROPY_EXPANSION';
            
            logger.info(
                `[PREDATOR-MODE] EXIT BULLY pool=${metrics.poolAddress.slice(0, 8)} ` +
                `reason=${reason} dominance=${metrics.effectiveDominance.toFixed(2)}`
            );
            return {
                shouldSwitch: true,
                newMode: PositionMode.HARVEST,
                reason,
                forceExit: false,
            };
        }
    }
    
    return {
        shouldSwitch: false,
        newMode: currentMode,
        reason: 'NO_CHANGE',
        forceExit: false,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REBALANCE DECISION
// ═══════════════════════════════════════════════════════════════════════════════

export interface BullyRebalanceDecision {
    shouldRebalance: boolean;
    targetBin: number;
    binCount: number;
    reason: string;
    ignoredGates: string[];
}

/**
 * Evaluate rebalance in BULLY mode (fast path)
 * 
 * In BULLY mode:
 *   - Ignore MIN_HOLD
 *   - Ignore amortization gates
 *   - Ignore snapshot minimums
 *   - Allow rebalance every scan cycle
 */
export function evaluateBullyRebalance(
    tradeId: string,
    currentBin: number,
    targetBin: TargetBinSelection,
    mtmEV: number,
    executionCost: number,
): BullyRebalanceDecision {
    const state = positionModeState.get(tradeId);
    const mode = state?.mode ?? PositionMode.HARVEST;
    
    if (mode !== PositionMode.BULLY) {
        return {
            shouldRebalance: false,
            targetBin: currentBin,
            binCount: BIN_DOMINANCE_CONFIG.HARVEST_MAX_BINS,
            reason: 'NOT_BULLY_MODE',
            ignoredGates: [],
        };
    }
    
    // In BULLY mode, allow rebalance if target bin shifted
    if (!targetBin.isShift) {
        return {
            shouldRebalance: false,
            targetBin: currentBin,
            binCount: BIN_DOMINANCE_CONFIG.BULLY_MAX_BINS,
            reason: 'NO_TARGET_SHIFT',
            ignoredGates: [],
        };
    }
    
    // Check MTM condition: allowExit = MTM_EV > -executionCost
    const mtmCondition = mtmEV > -executionCost;
    if (!mtmCondition) {
        return {
            shouldRebalance: false,
            targetBin: targetBin.targetBin,
            binCount: BIN_DOMINANCE_CONFIG.BULLY_MAX_BINS,
            reason: `MTM_NEGATIVE: ${mtmEV.toFixed(4)} < ${(-executionCost).toFixed(4)}`,
            ignoredGates: [],
        };
    }
    
    // BULLY REBALANCE: Ignore all gates
    logger.info(
        `[BULLY-REBALANCE] pool=${state?.poolAddress?.slice(0, 8)} ` +
        `oldBin=${currentBin} newBin=${targetBin.targetBin} ` +
        `shift=${targetBin.shiftMagnitude} mtmEV=$${mtmEV.toFixed(4)}`
    );
    
    return {
        shouldRebalance: true,
        targetBin: targetBin.targetBin,
        binCount: BIN_DOMINANCE_CONFIG.BULLY_MAX_BINS,
        reason: 'BULLY_TARGET_SHIFT',
        ignoredGates: ['MIN_HOLD', 'AMORTIZATION', 'SNAPSHOTS'],
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIZE ESCALATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get size multiplier for BULLY mode
 */
export function getBullySizeMultiplier(
    tradeId: string,
    baseSize: number,
): { multiplier: number; reason: string } {
    const state = positionModeState.get(tradeId);
    const mode = state?.mode ?? PositionMode.HARVEST;
    const metrics = state?.currentMetrics;
    const config = BIN_DOMINANCE_CONFIG;
    
    if (mode !== PositionMode.BULLY) {
        return { multiplier: 1.0, reason: 'HARVEST_MODE' };
    }
    
    if (!metrics) {
        return { multiplier: 1.0, reason: 'NO_METRICS' };
    }
    
    if (metrics.effectiveDominance < config.SIZE_ESCALATION_MIN_DOMINANCE) {
        return { 
            multiplier: 1.0, 
            reason: `DOMINANCE_LOW: ${metrics.effectiveDominance.toFixed(2)} < ${config.SIZE_ESCALATION_MIN_DOMINANCE}`,
        };
    }
    
    // Scale multiplier based on dominance (0.45 → 1.0x, 1.0 → 1.5x)
    const dominanceRange = 1.0 - config.SIZE_ESCALATION_MIN_DOMINANCE;
    const dominanceExcess = metrics.effectiveDominance - config.SIZE_ESCALATION_MIN_DOMINANCE;
    const multiplierRange = config.BULLY_SIZE_MULTIPLIER_MAX - 1.0;
    const multiplier = 1.0 + (dominanceExcess / dominanceRange) * multiplierRange;
    
    return {
        multiplier: Math.min(config.BULLY_SIZE_MULTIPLIER_MAX, multiplier),
        reason: `DOMINANCE_HIGH: ${metrics.effectiveDominance.toFixed(2)}`,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize position mode state
 */
export function initializePositionMode(
    tradeId: string,
    poolAddress: string,
    poolName: string,
    initialMode: PositionMode = PositionMode.HARVEST,
): PositionModeState {
    const now = Date.now();
    
    const state: PositionModeState = {
        tradeId,
        poolAddress,
        poolName,
        mode: initialMode,
        enteredModeAt: now,
        lastModeChangeAt: now,
        dominanceHistory: [],
        currentMetrics: null,
    };
    
    positionModeState.set(tradeId, state);
    
    logger.info(
        `[PREDATOR-MODE] INIT pool=${poolName} tradeId=${tradeId.slice(0, 8)} mode=${initialMode}`
    );
    
    return state;
}

/**
 * Switch position mode
 */
export function switchPositionMode(tradeId: string, newMode: PositionMode): void {
    const state = positionModeState.get(tradeId);
    if (!state) return;
    
    const now = Date.now();
    state.mode = newMode;
    state.lastModeChangeAt = now;
    
    positionModeState.set(tradeId, state);
}

/**
 * Get position mode
 */
export function getPositionMode(tradeId: string): PositionMode {
    return positionModeState.get(tradeId)?.mode ?? PositionMode.HARVEST;
}

/**
 * Get position mode state
 */
export function getPositionModeState(tradeId: string): PositionModeState | undefined {
    return positionModeState.get(tradeId);
}

/**
 * Clear position mode state
 */
export function clearPositionModeState(tradeId: string): void {
    positionModeState.delete(tradeId);
}

/**
 * Get all positions in BULLY mode
 */
export function getBullyModePositions(): PositionModeState[] {
    return Array.from(positionModeState.values())
        .filter(state => state.mode === PositionMode.BULLY);
}

/**
 * Get dominance metrics for a pool
 */
export function getPoolDominanceMetrics(poolAddress: string): BinDominanceMetrics | undefined {
    return poolDominanceMetrics.get(poolAddress);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTINUOUS BIN PURSUIT INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gates that are ignored in BULLY mode (CBP directive)
 * 
 * When PositionMode === BULLY:
 *   - Ignore MIN_HOLD
 *   - Ignore COST_NOT_AMORTIZED
 *   - Ignore snapshot minimums
 *   - Ignore bootstrap leniency logic
 */
export const BULLY_IGNORED_GATES = [
    'MIN_HOLD',
    'COST_NOT_AMORTIZED',
    'SNAPSHOT_MINIMUM',
    'BOOTSTRAP_LENIENCY',
] as const;

/**
 * Check if a gate should be bypassed for a position in BULLY mode
 */
export function shouldBypassGateForPosition(tradeId: string, gateName: string): boolean {
    const state = positionModeState.get(tradeId);
    if (!state || state.mode !== PositionMode.BULLY) {
        return false;
    }
    return (BULLY_IGNORED_GATES as readonly string[]).includes(gateName);
}

/**
 * CBP Dual Profit Path Validation
 * 
 * Remain in BULLY mode if EITHER is true:
 *   - expectedMTM_10min >= executionCost
 *   - dominanceScore >= 0.40
 * 
 * Exit fully only if:
 *   - expectedMTM_10min < 0
 *   - AND dominanceScore < 0.15
 */
export interface DualProfitPathResult {
    shouldHold: boolean;
    shouldExit: boolean;
    reason: string;
    mtmPathValid: boolean;
    dominancePathValid: boolean;
}

export function evaluateDualProfitPath(
    tradeId: string,
    expectedMTM10min: number,
    executionCost: number,
): DualProfitPathResult {
    const state = positionModeState.get(tradeId);
    const metrics = state?.currentMetrics;
    
    if (!metrics || state?.mode !== PositionMode.BULLY) {
        return {
            shouldHold: true,
            shouldExit: false,
            reason: 'NOT_BULLY_MODE',
            mtmPathValid: false,
            dominancePathValid: false,
        };
    }
    
    const dominanceScore = metrics.effectiveDominance;
    
    // Path 1: MTM covers execution cost
    const mtmPathValid = expectedMTM10min >= executionCost;
    
    // Path 2: Dominance is strong enough (>= 0.40)
    const dominancePathValid = dominanceScore >= 0.40;
    
    // Hold if either path valid
    const shouldHold = mtmPathValid || dominancePathValid;
    
    // Exit only if MTM negative AND dominance collapsed (<0.15)
    const shouldExit = expectedMTM10min < 0 && dominanceScore < BIN_DOMINANCE_CONFIG.BULLY_FORCE_EXIT_DOMINANCE;
    
    let reason: string;
    if (shouldExit) {
        reason = 'DUAL_PATH_FAILED';
        logger.warn(
            `[PREDATOR] ABANDON pool=${metrics.poolAddress.slice(0, 8)} ` +
            `dominance=${dominanceScore.toFixed(2)} mtm10m=$${expectedMTM10min.toFixed(4)} ` +
            `reason=dominance_lost`
        );
    } else if (shouldHold) {
        reason = mtmPathValid ? 'MTM_POSITIVE' : 'DOMINANCE_CONFIRMED';
        logger.debug(
            `[PREDATOR] HOLD pool=${metrics.poolAddress.slice(0, 8)} ` +
            `dominance=${dominanceScore.toFixed(2)} mtm10m=$${expectedMTM10min.toFixed(4)} ` +
            `reason=${reason}`
        );
    } else {
        reason = 'WEAK_HOLD';
    }
    
    if (shouldHold && dominanceScore >= 0.40) {
        logger.info(
            `[DOMINANCE] pool=${metrics.poolAddress.slice(0, 8)} ` +
            `dominance_confirmed score=${dominanceScore.toFixed(2)}`
        );
    }
    
    return {
        shouldHold,
        shouldExit,
        reason,
        mtmPathValid,
        dominancePathValid,
    };
}

/**
 * CBP Forced Bin Migration Check
 * 
 * If BPS_target > BPS_current × 1.15:
 *   - Immediately rebalance into targetBin
 *   - Do NOT wait for exit triggers
 *   - Do NOT wait for cost recovery
 *   - This is a chase, not an exit
 */
export interface ForcedMigrationResult {
    shouldMigrate: boolean;
    fromBin: number;
    toBin: number;
    reason: string;
    bpsRatio: number;
}

const MIGRATION_THRESHOLD = 1.15;

export function evaluateForcedBinMigration(
    tradeId: string,
    currentBin: number,
    targetBinSelection: TargetBinSelection,
    currentBinBPS: number,
    targetBinBPS: number,
): ForcedMigrationResult {
    const state = positionModeState.get(tradeId);
    
    if (!state || state.mode !== PositionMode.BULLY) {
        return {
            shouldMigrate: false,
            fromBin: currentBin,
            toBin: currentBin,
            reason: 'NOT_BULLY_MODE',
            bpsRatio: 0,
        };
    }
    
    // Same bin = no migration
    if (currentBin === targetBinSelection.targetBin) {
        return {
            shouldMigrate: false,
            fromBin: currentBin,
            toBin: currentBin,
            reason: 'SAME_BIN',
            bpsRatio: 1.0,
        };
    }
    
    // Calculate BPS ratio
    const bpsRatio = currentBinBPS > 0 ? targetBinBPS / currentBinBPS : Infinity;
    
    // Check migration threshold
    if (bpsRatio >= MIGRATION_THRESHOLD) {
        logger.info(
            `[CBP] pool=${state.poolAddress.slice(0, 8)} fromBin=${currentBin} → toBin=${targetBinSelection.targetBin} ` +
            `reason=PRESSURE_SHIFT bpsRatio=${bpsRatio.toFixed(2)}`
        );
        
        return {
            shouldMigrate: true,
            fromBin: currentBin,
            toBin: targetBinSelection.targetBin,
            reason: 'PRESSURE_SHIFT',
            bpsRatio,
        };
    }
    
    return {
        shouldMigrate: false,
        fromBin: currentBin,
        toBin: targetBinSelection.targetBin,
        reason: `BPS_RATIO_LOW: ${bpsRatio.toFixed(2)} < ${MIGRATION_THRESHOLD}`,
        bpsRatio,
    };
}

/**
 * Get bin count for BULLY mode
 * 
 * In BULLY mode:
 *   - Always use 1–2 bins
 *   - Width expands only when volatility explodes
 *   - Never widen defensively
 */
export function getBullyBinCount(volatilityPct: number): number {
    const VOLATILITY_EXPLOSION_THRESHOLD = 0.05;  // 5%
    
    // Only expand if volatility explodes
    if (volatilityPct >= VOLATILITY_EXPLOSION_THRESHOLD) {
        return BIN_DOMINANCE_CONFIG.BULLY_MAX_BINS;  // 2 bins
    }
    
    return 1;  // Default: single bin
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logPredatorModeSummary(): void {
    const positions = Array.from(positionModeState.values());
    
    if (positions.length === 0) {
        return;
    }
    
    const bullyCount = positions.filter(p => p.mode === PositionMode.BULLY).length;
    const harvestCount = positions.filter(p => p.mode === PositionMode.HARVEST).length;
    
    const avgDominance = positions
        .filter(p => p.currentMetrics)
        .reduce((sum, p) => sum + (p.currentMetrics?.effectiveDominance ?? 0), 0) / 
        Math.max(1, positions.filter(p => p.currentMetrics).length);
    
    logger.info(
        `[PREDATOR-SUMMARY] positions=${positions.length} ` +
        `BULLY=${bullyCount} HARVEST=${harvestCount} ` +
        `avgDominance=${avgDominance.toFixed(2)}`
    );
}
