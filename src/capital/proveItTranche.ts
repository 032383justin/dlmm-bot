/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROVE-IT TRANCHE SYSTEM — Capital Ramp for Fee Predation
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Replace "sit for 6 hours in bootstrap" with a rapid proof mechanism.
 * 
 * MECHANISM:
 * 
 * For ANY pool without enough live evidence:
 * 
 * 1. PROBE TRANCHE — Start small, prove the pool can pay
 *    - Size: min(1.0% equity, $150) (configurable)
 *    - Require proof within T_prove (45-90 minutes)
 *    - Proof criteria:
 *      a) fees_accumulated_usd >= 0.35 * (entryCost + expectedExitCost)
 *      b) OR feeVel >= feeVel_threshold for N consecutive intervals
 * 
 * 2. STEP UP — If proof passes
 *    - Tranche 2: 2.5% equity
 *    - Tranche 3: 5% equity  
 *    - Cap: tierCap (pool-specific max)
 * 
 * 3. FAIL — If proof fails
 *    - Exit immediately
 *    - Cooldown pool for 6 hours
 * 
 * This removes passive waiting while still avoiding instant bleed.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const PROVE_IT_CONFIG = {
    /** Enable prove-it tranche system */
    ENABLED: true,
    
    /** Probe tranche sizing */
    PROBE: {
        /** Maximum as % of equity */
        MAX_EQUITY_PCT: 0.01,         // 1.0%
        
        /** Maximum absolute USD */
        MAX_ABSOLUTE_USD: 150,
        
        /** Minimum absolute USD */
        MIN_ABSOLUTE_USD: 25,
    },
    
    /** Proof time window */
    PROOF_WINDOW: {
        /** Minimum proof time (ms) */
        MIN_MS: 45 * 60 * 1000,       // 45 minutes
        
        /** Maximum proof time (ms) */
        MAX_MS: 90 * 60 * 1000,       // 90 minutes
        
        /** Default proof time (ms) */
        DEFAULT_MS: 60 * 60 * 1000,   // 60 minutes
    },
    
    /** Proof criteria */
    PROOF_CRITERIA: {
        /** Minimum fee ratio vs costs (0.35 = 35% of round-trip costs) */
        MIN_FEE_TO_COST_RATIO: 0.35,
        
        /** Alternative: consecutive intervals with fee velocity above threshold */
        CONSECUTIVE_FEE_VEL_INTERVALS: 3,
        
        /** Fee velocity threshold for interval-based proof ($/hr per $1000 deployed) */
        FEE_VEL_THRESHOLD_PER_1K_HR: 0.10,  // $0.10/hr per $1000
    },
    
    /** Tranche step-up sizes (% of equity) */
    TRANCHES: {
        PROBE: 0.01,      // 1.0% - initial
        TRANCHE_2: 0.025, // 2.5% - after proof
        TRANCHE_3: 0.05,  // 5.0% - after sustained success
        CAP: 0.30,        // 30% - maximum (pool-specific)
    },
    
    /** Step-up requirements */
    STEP_UP: {
        /** Time after proof before eligible for step-up (ms) */
        MIN_TIME_BETWEEN_STEPS_MS: 30 * 60 * 1000,  // 30 minutes
        
        /** Minimum fee velocity to maintain (ratio of proof threshold) */
        MAINTAIN_FEE_VEL_RATIO: 0.80,  // 80% of proof threshold
    },
    
    /** Failure handling */
    FAILURE: {
        /** Cooldown duration for failed pools (ms) */
        COOLDOWN_MS: 6 * 60 * 60 * 1000,  // 6 hours
        
        /** Maximum consecutive failures before blacklist */
        MAX_FAILURES_BEFORE_BLACKLIST: 3,
        
        /** Blacklist duration (ms) */
        BLACKLIST_DURATION_MS: 24 * 60 * 60 * 1000,  // 24 hours
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type TrancheStage = 'PROBE' | 'TRANCHE_2' | 'TRANCHE_3' | 'CAP' | 'FAILED' | 'COOLDOWN';

export interface TrancheState {
    poolAddress: string;
    poolName: string;
    
    /** Current tranche stage */
    stage: TrancheStage;
    
    /** Stage entry timestamp */
    stageEnteredAt: number;
    
    /** Current position size USD */
    currentSizeUsd: number;
    
    /** Total fees accumulated in current stage */
    feesAccumulatedUsd: number;
    
    /** Entry cost for this tranche */
    entryCostUsd: number;
    
    /** Expected exit cost */
    expectedExitCostUsd: number;
    
    /** Fee velocity samples for interval-based proof */
    feeVelocitySamples: number[];
    
    /** Proof status */
    proofPassed: boolean;
    proofPassedAt?: number;
    
    /** Failure tracking */
    consecutiveFailures: number;
    lastFailureAt?: number;
    
    /** Cooldown tracking */
    cooldownUntil?: number;
}

export interface ProofCheckResult {
    passed: boolean;
    reason: string;
    feeToCostratio: number;
    consecutiveAboveThreshold: number;
    timeInStageMs: number;
    recommendation: 'STEP_UP' | 'CONTINUE' | 'EXIT' | 'WAIT';
}

export interface TrancheSizingResult {
    sizeUsd: number;
    sizePct: number;
    stage: TrancheStage;
    reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/** Pool tranche states */
const trancheStates = new Map<string, TrancheState>();

/** Pool cooldowns */
const poolCooldowns = new Map<string, number>();

/** Pool failure counts */
const poolFailures = new Map<string, number>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate probe tranche size for initial entry.
 */
export function calculateProbeTranche(equity: number): TrancheSizingResult {
    const config = PROVE_IT_CONFIG;
    
    // min(1.0% equity, $150)
    const pctBased = equity * config.PROBE.MAX_EQUITY_PCT;
    const sizeUsd = Math.min(pctBased, config.PROBE.MAX_ABSOLUTE_USD);
    
    // Enforce minimum
    if (sizeUsd < config.PROBE.MIN_ABSOLUTE_USD) {
        return {
            sizeUsd: config.PROBE.MIN_ABSOLUTE_USD,
            sizePct: config.PROBE.MIN_ABSOLUTE_USD / equity,
            stage: 'PROBE',
            reason: `Min probe size $${config.PROBE.MIN_ABSOLUTE_USD}`,
        };
    }
    
    return {
        sizeUsd,
        sizePct: sizeUsd / equity,
        stage: 'PROBE',
        reason: `Probe: min(${(config.PROBE.MAX_EQUITY_PCT * 100).toFixed(1)}% equity, $${config.PROBE.MAX_ABSOLUTE_USD})`,
    };
}

/**
 * Get current tranche size based on stage.
 */
export function getTrancheSize(poolAddress: string, equity: number, tierCap: number = 0.30): TrancheSizingResult {
    const state = trancheStates.get(poolAddress);
    const config = PROVE_IT_CONFIG;
    
    // Check cooldown
    if (isPoolOnCooldown(poolAddress)) {
        return {
            sizeUsd: 0,
            sizePct: 0,
            stage: 'COOLDOWN',
            reason: `Pool on cooldown until ${new Date(poolCooldowns.get(poolAddress)!).toISOString()}`,
        };
    }
    
    // No existing state = start with probe
    if (!state) {
        return calculateProbeTranche(equity);
    }
    
    // Determine size based on stage
    let sizePct: number;
    let stage: TrancheStage = state.stage;
    
    switch (state.stage) {
        case 'PROBE':
            sizePct = config.TRANCHES.PROBE;
            break;
        case 'TRANCHE_2':
            sizePct = config.TRANCHES.TRANCHE_2;
            break;
        case 'TRANCHE_3':
            sizePct = config.TRANCHES.TRANCHE_3;
            break;
        case 'CAP':
            sizePct = Math.min(config.TRANCHES.CAP, tierCap);
            break;
        case 'FAILED':
        case 'COOLDOWN':
            return {
                sizeUsd: 0,
                sizePct: 0,
                stage: state.stage,
                reason: `Pool in ${state.stage} state`,
            };
        default:
            sizePct = config.TRANCHES.PROBE;
            stage = 'PROBE';
    }
    
    const sizeUsd = equity * sizePct;
    
    return {
        sizeUsd,
        sizePct,
        stage,
        reason: `${stage}: ${(sizePct * 100).toFixed(1)}% of equity`,
    };
}

/**
 * Initialize tranche state for a new position.
 */
export function initializeTrancheState(
    poolAddress: string,
    poolName: string,
    sizeUsd: number,
    entryCostUsd: number,
    exitCostUsd: number
): TrancheState {
    const state: TrancheState = {
        poolAddress,
        poolName,
        stage: 'PROBE',
        stageEnteredAt: Date.now(),
        currentSizeUsd: sizeUsd,
        feesAccumulatedUsd: 0,
        entryCostUsd,
        expectedExitCostUsd: exitCostUsd,
        feeVelocitySamples: [],
        proofPassed: false,
        consecutiveFailures: poolFailures.get(poolAddress) || 0,
    };
    
    trancheStates.set(poolAddress, state);
    
    logger.info(
        `[PROVE-IT] INITIALIZED | pool=${poolName} stage=PROBE | ` +
        `size=$${sizeUsd.toFixed(0)} entryCost=$${entryCostUsd.toFixed(2)} exitCost=$${exitCostUsd.toFixed(2)} | ` +
        `proofWindow=${PROVE_IT_CONFIG.PROOF_WINDOW.DEFAULT_MS / 60000}m`
    );
    
    return state;
}

/**
 * Update tranche state with accumulated fees.
 */
export function updateTrancheState(
    poolAddress: string,
    feesAccumulatedUsd: number,
    currentFeeVelocityHr: number
): void {
    const state = trancheStates.get(poolAddress);
    if (!state) return;
    
    state.feesAccumulatedUsd = feesAccumulatedUsd;
    
    // Track fee velocity for interval-based proof
    const feeVelPer1kHr = (currentFeeVelocityHr / state.currentSizeUsd) * 1000;
    state.feeVelocitySamples.push(feeVelPer1kHr);
    
    // Keep only last 10 samples
    if (state.feeVelocitySamples.length > 10) {
        state.feeVelocitySamples.shift();
    }
    
    trancheStates.set(poolAddress, state);
}

/**
 * Check if proof criteria are met.
 */
export function checkProofCriteria(poolAddress: string): ProofCheckResult {
    const state = trancheStates.get(poolAddress);
    const config = PROVE_IT_CONFIG;
    
    if (!state) {
        return {
            passed: false,
            reason: 'No tranche state found',
            feeToCostratio: 0,
            consecutiveAboveThreshold: 0,
            timeInStageMs: 0,
            recommendation: 'WAIT',
        };
    }
    
    const now = Date.now();
    const timeInStageMs = now - state.stageEnteredAt;
    const totalCost = state.entryCostUsd + state.expectedExitCostUsd;
    
    // Calculate fee-to-cost ratio
    const feeToCostratio = totalCost > 0 ? state.feesAccumulatedUsd / totalCost : 0;
    
    // Count consecutive intervals above threshold
    const threshold = config.PROOF_CRITERIA.FEE_VEL_THRESHOLD_PER_1K_HR;
    let consecutiveAboveThreshold = 0;
    
    for (let i = state.feeVelocitySamples.length - 1; i >= 0; i--) {
        if (state.feeVelocitySamples[i] >= threshold) {
            consecutiveAboveThreshold++;
        } else {
            break;
        }
    }
    
    // Check proof criteria
    const criteriaA = feeToCostratio >= config.PROOF_CRITERIA.MIN_FEE_TO_COST_RATIO;
    const criteriaB = consecutiveAboveThreshold >= config.PROOF_CRITERIA.CONSECUTIVE_FEE_VEL_INTERVALS;
    
    // Check if within proof window
    const withinWindow = timeInStageMs < config.PROOF_WINDOW.MAX_MS;
    const minTimeElapsed = timeInStageMs >= config.PROOF_WINDOW.MIN_MS;
    
    // Determine result
    if (criteriaA || criteriaB) {
        // Proof passed
        state.proofPassed = true;
        state.proofPassedAt = now;
        trancheStates.set(poolAddress, state);
        
        const reason = criteriaA 
            ? `Fee/cost ratio ${(feeToCostratio * 100).toFixed(1)}% >= ${(config.PROOF_CRITERIA.MIN_FEE_TO_COST_RATIO * 100).toFixed(0)}%`
            : `${consecutiveAboveThreshold} consecutive intervals above fee velocity threshold`;
        
        return {
            passed: true,
            reason,
            feeToCostratio,
            consecutiveAboveThreshold,
            timeInStageMs,
            recommendation: 'STEP_UP',
        };
    }
    
    // Not enough time yet
    if (!minTimeElapsed) {
        return {
            passed: false,
            reason: `Waiting for min proof time (${(config.PROOF_WINDOW.MIN_MS / 60000).toFixed(0)}m)`,
            feeToCostratio,
            consecutiveAboveThreshold,
            timeInStageMs,
            recommendation: 'WAIT',
        };
    }
    
    // Window expired without proof
    if (!withinWindow) {
        return {
            passed: false,
            reason: `Proof window expired (${(config.PROOF_WINDOW.MAX_MS / 60000).toFixed(0)}m)`,
            feeToCostratio,
            consecutiveAboveThreshold,
            timeInStageMs,
            recommendation: 'EXIT',
        };
    }
    
    // Still within window, continue
    return {
        passed: false,
        reason: `Fee/cost ${(feeToCostratio * 100).toFixed(1)}% < ${(config.PROOF_CRITERIA.MIN_FEE_TO_COST_RATIO * 100).toFixed(0)}% | ` +
                `consecutive=${consecutiveAboveThreshold}/${config.PROOF_CRITERIA.CONSECUTIVE_FEE_VEL_INTERVALS}`,
        feeToCostratio,
        consecutiveAboveThreshold,
        timeInStageMs,
        recommendation: 'CONTINUE',
    };
}

/**
 * Step up to next tranche after proof passes.
 */
export function stepUpTranche(poolAddress: string, newSizeUsd: number): TrancheStage {
    const state = trancheStates.get(poolAddress);
    if (!state) return 'PROBE';
    
    const config = PROVE_IT_CONFIG;
    const now = Date.now();
    
    // Check minimum time between steps
    const timeSinceProof = state.proofPassedAt ? now - state.proofPassedAt : Infinity;
    if (timeSinceProof < config.STEP_UP.MIN_TIME_BETWEEN_STEPS_MS) {
        logger.debug(
            `[PROVE-IT] Step-up blocked | pool=${state.poolName} | ` +
            `timeSinceProof=${(timeSinceProof / 60000).toFixed(1)}m < ${(config.STEP_UP.MIN_TIME_BETWEEN_STEPS_MS / 60000).toFixed(0)}m`
        );
        return state.stage;
    }
    
    // Determine next stage
    let nextStage: TrancheStage;
    switch (state.stage) {
        case 'PROBE':
            nextStage = 'TRANCHE_2';
            break;
        case 'TRANCHE_2':
            nextStage = 'TRANCHE_3';
            break;
        case 'TRANCHE_3':
            nextStage = 'CAP';
            break;
        default:
            nextStage = state.stage;
    }
    
    // Update state
    state.stage = nextStage;
    state.stageEnteredAt = now;
    state.currentSizeUsd = newSizeUsd;
    state.feesAccumulatedUsd = 0;  // Reset for new stage
    state.feeVelocitySamples = [];
    trancheStates.set(poolAddress, state);
    
    logger.info(
        `[PROVE-IT] STEP-UP | pool=${state.poolName} | ` +
        `${state.stage} → ${nextStage} | newSize=$${newSizeUsd.toFixed(0)}`
    );
    
    return nextStage;
}

/**
 * Handle proof failure - exit and cooldown.
 */
export function handleProofFailure(poolAddress: string): void {
    const state = trancheStates.get(poolAddress);
    const config = PROVE_IT_CONFIG;
    
    if (state) {
        state.stage = 'FAILED';
        state.consecutiveFailures++;
        state.lastFailureAt = Date.now();
        trancheStates.set(poolAddress, state);
        
        // Update global failure count
        const totalFailures = (poolFailures.get(poolAddress) || 0) + 1;
        poolFailures.set(poolAddress, totalFailures);
        
        logger.warn(
            `[PROVE-IT] PROOF FAILED | pool=${state.poolName} | ` +
            `consecutiveFailures=${state.consecutiveFailures} | ` +
            `Entering ${config.FAILURE.COOLDOWN_MS / (60 * 60 * 1000)}h cooldown`
        );
    }
    
    // Set cooldown
    const cooldownUntil = Date.now() + config.FAILURE.COOLDOWN_MS;
    poolCooldowns.set(poolAddress, cooldownUntil);
}

/**
 * Check if pool is on cooldown.
 */
export function isPoolOnCooldown(poolAddress: string): boolean {
    const cooldownUntil = poolCooldowns.get(poolAddress);
    if (!cooldownUntil) return false;
    
    if (Date.now() >= cooldownUntil) {
        // Cooldown expired, remove it
        poolCooldowns.delete(poolAddress);
        return false;
    }
    
    return true;
}

/**
 * Get cooldown remaining for a pool.
 */
export function getCooldownRemaining(poolAddress: string): number {
    const cooldownUntil = poolCooldowns.get(poolAddress);
    if (!cooldownUntil) return 0;
    
    return Math.max(0, cooldownUntil - Date.now());
}

/**
 * Get tranche state for a pool.
 */
export function getTrancheState(poolAddress: string): TrancheState | undefined {
    return trancheStates.get(poolAddress);
}

/**
 * Clear tranche state on position close.
 */
export function clearTrancheState(poolAddress: string): void {
    trancheStates.delete(poolAddress);
}

/**
 * Check if pool should be blacklisted due to repeated failures.
 */
export function shouldBlacklist(poolAddress: string): boolean {
    const failures = poolFailures.get(poolAddress) || 0;
    return failures >= PROVE_IT_CONFIG.FAILURE.MAX_FAILURES_BEFORE_BLACKLIST;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log prove-it status for a pool.
 */
export function logProveItStatus(poolAddress: string): void {
    const state = trancheStates.get(poolAddress);
    if (!state) return;
    
    const proofCheck = checkProofCriteria(poolAddress);
    const timeInStage = Date.now() - state.stageEnteredAt;
    
    logger.info(
        `[PROVE-IT] STATUS | pool=${state.poolName} stage=${state.stage} | ` +
        `timeInStage=${(timeInStage / 60000).toFixed(0)}m | ` +
        `fees=$${state.feesAccumulatedUsd.toFixed(2)} cost=$${(state.entryCostUsd + state.expectedExitCostUsd).toFixed(2)} | ` +
        `ratio=${(proofCheck.feeToCostratio * 100).toFixed(1)}% | ` +
        `recommendation=${proofCheck.recommendation}`
    );
}

/**
 * Log prove-it summary across all pools.
 */
export function logProveItSummary(): void {
    const pools = Array.from(trancheStates.values());
    
    const byStage = {
        PROBE: pools.filter(p => p.stage === 'PROBE').length,
        TRANCHE_2: pools.filter(p => p.stage === 'TRANCHE_2').length,
        TRANCHE_3: pools.filter(p => p.stage === 'TRANCHE_3').length,
        CAP: pools.filter(p => p.stage === 'CAP').length,
        FAILED: pools.filter(p => p.stage === 'FAILED').length,
    };
    
    const onCooldown = Array.from(poolCooldowns.keys()).filter(k => isPoolOnCooldown(k)).length;
    
    logger.info(
        `[PROVE-IT-SUMMARY] ` +
        `PROBE=${byStage.PROBE} T2=${byStage.TRANCHE_2} T3=${byStage.TRANCHE_3} CAP=${byStage.CAP} | ` +
        `FAILED=${byStage.FAILED} COOLDOWN=${onCooldown}`
    );
}

export default {
    PROVE_IT_CONFIG,
    calculateProbeTranche,
    getTrancheSize,
    initializeTrancheState,
    updateTrancheState,
    checkProofCriteria,
    stepUpTranche,
    handleProofFailure,
    isPoolOnCooldown,
    getCooldownRemaining,
    getTrancheState,
    clearTrancheState,
    shouldBlacklist,
    logProveItStatus,
    logProveItSummary,
};

