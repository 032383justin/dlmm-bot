/**
 * Fee-Harvest Hold Mode — Extract Value from Flat Markets
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 DOMINANT — FEE-HARVEST STATE MACHINE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Convert flat price action into fee profit by suppressing
 * premature exits when fee harvesting remains profitable.
 * 
 * POSITION STATES:
 *   ACTIVE  - Normal position, all exit triggers active
 *   HOLD    - Fee-harvest mode, exit triggers suppressed
 *   EXITING - Position is being exited
 * 
 * HOLD MODE ENTRY CONDITIONS (ALL must be true):
 *   - Price movement < volatility floor (market is flat)
 *   - Migration slope ≈ 0 (no directional liquidity flow)
 *   - Fee intensity remains above threshold (fees still accruing)
 *   - EV remains positive after accounting for fees
 * 
 * HOLD MODE BEHAVIOR:
 *   - Suppresses exit triggers caused by:
 *     • Low price movement
 *     • Minor score decay
 *   - Continues harvesting fees
 *   - Re-evaluates every scan cycle
 * 
 * HOLD MODE EXIT CONDITIONS (ANY triggers immediate exit):
 *   - Migration slope increases (liquidity flowing out)
 *   - EV turns negative
 *   - Regime flips against position
 *   - HOLD duration cap exceeded (regime-dependent)
 * 
 * LOGS:
 *   [HOLD-ENTER] - Position entering hold mode
 *   [HOLD-EXIT]  - Position exiting hold mode
 *   [HOLD-REJECT]- Hold mode rejected (conditions not met)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';
import { computeExpectedValue, EVResult } from './evGating';
import { Tier4EnrichedPool } from '../scoring/microstructureScoring';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 VALIDATION FLAGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dev mode flag for strict validation assertions
 */
const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 2: EXIT CLASSIFICATION (TIER 4 CORRECTNESS PASS)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exit trigger classification for HOLD mode suppression decisions.
 * 
 * NOISE_EXIT: Minor fluctuations that should be suppressed in HOLD mode
 * RISK_EXIT: Critical risk signals that MUST NEVER be suppressed
 */
export type ExitClassification = 'NOISE_EXIT' | 'RISK_EXIT';

/**
 * Specific risk exit types that require immediate action
 */
export type RiskExitType = 
    | 'EV_NEGATIVE'       // Expected value turned negative
    | 'REGIME_FLIP'       // Adverse regime change
    | 'MIGRATION_SPIKE'   // Liquidity exodus
    | 'KILL_SWITCH'       // Emergency system shutdown
    | 'SCORE_CRASH'       // Catastrophic score drop
    | 'EMERGENCY';        // Other emergency conditions

/**
 * Exit classification result with reasoning
 */
export interface ExitClassificationResult {
    classification: ExitClassification;
    riskType?: RiskExitType;
    reason: string;
    canSuppress: boolean;
    
    // Validation metadata
    expectedNetEVUSD?: number;
    currentRegime?: MarketRegime;
    migrationSlope?: number;
}

/**
 * Classify an exit trigger as NOISE or RISK.
 * 
 * HOLD mode suppression rules:
 *   MAY suppress: NOISE_EXIT (minor score decay, flat volatility)
 *   MUST NEVER suppress: RISK_EXIT (migration spike, EV < 0, regime flip, kill-switch)
 */
export function classifyExitTrigger(
    exitReason: string,
    currentEV: EVResult | null,
    currentRegime: MarketRegime,
    entryRegime: MarketRegime,
    migrationSlope: number,
    currentScore: number,
    entryScore: number
): ExitClassificationResult {
    const reasonLower = exitReason.toLowerCase();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RISK EXIT DETECTION — These MUST NEVER be suppressed
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Check 1: Negative EV
    if (currentEV && currentEV.expectedNetEVUSD < 0) {
        return {
            classification: 'RISK_EXIT',
            riskType: 'EV_NEGATIVE',
            reason: `EV turned negative: $${currentEV.expectedNetEVUSD.toFixed(2)}`,
            canSuppress: false,
            expectedNetEVUSD: currentEV.expectedNetEVUSD,
            currentRegime,
        };
    }
    
    // Check 2: Adverse regime flip
    const adverseFlips: Record<MarketRegime, MarketRegime[]> = {
        BULL: ['BEAR'],
        NEUTRAL: ['BEAR'],
        BEAR: [],
    };
    if (adverseFlips[entryRegime]?.includes(currentRegime)) {
        return {
            classification: 'RISK_EXIT',
            riskType: 'REGIME_FLIP',
            reason: `Regime flipped from ${entryRegime} to ${currentRegime}`,
            canSuppress: false,
            currentRegime,
        };
    }
    
    // Check 3: Migration spike (liquidity exodus)
    const MIGRATION_SPIKE_THRESHOLD = 0.01; // 1% per minute = severe exodus
    if (Math.abs(migrationSlope) > MIGRATION_SPIKE_THRESHOLD) {
        return {
            classification: 'RISK_EXIT',
            riskType: 'MIGRATION_SPIKE',
            reason: `Migration spike detected: slope=${migrationSlope.toFixed(4)}`,
            canSuppress: false,
            migrationSlope,
        };
    }
    
    // Check 4: Kill switch or emergency keywords
    if (reasonLower.includes('kill') || 
        reasonLower.includes('emergency') ||
        reasonLower.includes('crash') ||
        reasonLower.includes('market_crash')) {
        return {
            classification: 'RISK_EXIT',
            riskType: 'KILL_SWITCH',
            reason: `Emergency exit triggered: ${exitReason}`,
            canSuppress: false,
        };
    }
    
    // Check 5: Catastrophic score crash (>50% decay)
    const scoreDecay = entryScore > 0 ? (entryScore - currentScore) / entryScore : 0;
    if (scoreDecay > 0.50 || currentScore < 15) {
        return {
            classification: 'RISK_EXIT',
            riskType: 'SCORE_CRASH',
            reason: `Score crashed: ${entryScore.toFixed(1)} → ${currentScore.toFixed(1)} (${(scoreDecay * 100).toFixed(0)}% decay)`,
            canSuppress: false,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // NOISE EXIT DETECTION — These MAY be suppressed in HOLD mode
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Minor score decay (< 15% decay, score still above threshold)
    if (reasonLower.includes('score') || reasonLower.includes('decay')) {
        if (scoreDecay < HOLD_CONFIG.maxScoreDecayPctInHold && 
            currentScore >= HOLD_CONFIG.absoluteMinScoreInHold) {
            return {
                classification: 'NOISE_EXIT',
                reason: `Minor score decay: ${(scoreDecay * 100).toFixed(1)}% (within tolerance)`,
                canSuppress: true,
            };
        }
    }
    
    // Low movement / stagnant market (flat price action)
    if (reasonLower.includes('movement') || 
        reasonLower.includes('stagnant') ||
        reasonLower.includes('flat')) {
        return {
            classification: 'NOISE_EXIT',
            reason: `Low market movement (flat conditions)`,
            canSuppress: true,
        };
    }
    
    // Minor volatility fluctuations
    if (reasonLower.includes('volatility') && !reasonLower.includes('spike')) {
        return {
            classification: 'NOISE_EXIT',
            reason: `Minor volatility fluctuation`,
            canSuppress: true,
        };
    }
    
    // Default: Treat unknown exits as RISK for safety
    return {
        classification: 'RISK_EXIT',
        riskType: 'EMERGENCY',
        reason: `Unknown exit reason (defaulting to RISK): ${exitReason}`,
        canSuppress: false,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — ALL JUSTIFIED
// ═══════════════════════════════════════════════════════════════════════════════

export const HOLD_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // HOLD MODE ENTRY THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Maximum price movement (% per hour) to enter hold mode
     * Justification: If price is moving <0.5%/hour, market is effectively flat
     * and fee harvesting is the primary value extraction mechanism
     */
    maxPriceMovementPctPerHour: 0.005, // 0.5%
    
    /**
     * Maximum migration slope magnitude to enter hold mode
     * Justification: Migration slope ≈ 0 means liquidity is stable,
     * not flowing in or out, making fee prediction more reliable
     */
    maxMigrationSlopeMagnitude: 0.002, // 0.2% per minute
    
    /**
     * Minimum fee intensity to maintain hold mode
     * Justification: Fee intensity of 0.02 (normalized) indicates
     * meaningful fee accrual worth holding for
     */
    minFeeIntensityForHold: 0.02,
    
    /**
     * Minimum EV (USD) to maintain hold mode
     * Justification: Position must remain EV-positive to justify holding
     */
    minHoldEVUSD: 0.10,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HOLD DURATION CAPS (regime-dependent)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Maximum hold duration by regime (hours)
     * Justification:
     *   BEAR: Short cap (2h) because conditions can deteriorate quickly
     *   NEUTRAL: Moderate cap (4h) for balanced risk
     *   BULL: Longer cap (6h) because favorable conditions persist
     */
    maxHoldDurationHours: {
        BEAR: 2,
        NEUTRAL: 4,
        BULL: 6,
    } as Record<MarketRegime, number>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REGIME FLIP SENSITIVITY
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Regime combinations that force hold exit
     * Justification: If regime flips to adverse, exit immediately
     */
    adverseRegimeFlips: {
        // [entryRegime]: [exitOnRegimes]
        BULL: ['BEAR'],           // If entered in BULL, exit on BEAR
        NEUTRAL: ['BEAR'],        // If entered in NEUTRAL, exit on BEAR  
        BEAR: [],                 // If entered in BEAR, already conservative
    } as Record<MarketRegime, MarketRegime[]>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SCORE DECAY TOLERANCE IN HOLD MODE
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Maximum score decay (%) to tolerate in hold mode
     * Justification: Minor score fluctuations (up to 15%) are normal
     * in flat markets and shouldn't trigger exit while fees accrue
     */
    maxScoreDecayPctInHold: 0.15, // 15%
    
    /**
     * Absolute minimum score in hold mode
     * Justification: Even in hold, score shouldn't drop below exit threshold
     */
    absoluteMinScoreInHold: 18,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Position state for fee-harvest tracking
 */
export type PositionState = 'ACTIVE' | 'HOLD' | 'EXITING';

/**
 * Hold mode state for a position
 */
export interface HoldState {
    positionId: string;
    poolAddress: string;
    state: PositionState;
    
    // Hold mode tracking
    holdEntryTime?: number;
    holdEntryEV?: number;
    holdEntryScore?: number;
    holdEntryRegime?: MarketRegime;
    
    // Accumulated metrics during hold
    accumulatedFeesUSD: number;
    holdCycles: number;
    
    // Last evaluation
    lastEvaluation?: HoldEvaluation;
    
    // Timestamps
    createdAt: number;
    updatedAt: number;
}

/**
 * Hold mode evaluation result
 */
export interface HoldEvaluation {
    // Current conditions
    priceMovementPctPerHour: number;
    migrationSlope: number;
    feeIntensity: number;
    currentEV: EVResult;
    currentScore: number;
    currentRegime: MarketRegime;
    
    // Hold eligibility
    canEnterHold: boolean;
    shouldExitHold: boolean;
    holdRejectReason?: string;
    holdExitReason?: string;
    
    // Suppression status
    suppressLowMovementExit: boolean;
    suppressScoreDecayExit: boolean;
    
    timestamp: number;
}

/**
 * Inputs for hold evaluation
 */
export interface HoldEvaluationInputs {
    pool: Tier4EnrichedPool;
    positionSizeUSD: number;
    currentScore: number;
    entryScore: number;
    entryRegime: MarketRegime;
    currentRegime: MarketRegime;
    holdDurationHours: number;
    priceAtEntry: number;
    currentPrice: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In-memory hold state storage
 * Map: positionId -> HoldState
 */
const holdStateMap = new Map<string, HoldState>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE HOLD EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate if a position should enter/exit hold mode
 */
export function evaluateHoldMode(
    positionId: string,
    inputs: HoldEvaluationInputs
): HoldEvaluation {
    const now = Date.now();
    const { pool, positionSizeUSD, currentScore, entryScore, entryRegime, currentRegime, holdDurationHours, priceAtEntry, currentPrice } = inputs;
    
    // Get or create hold state
    let holdState = holdStateMap.get(positionId);
    if (!holdState) {
        holdState = {
            positionId,
            poolAddress: pool.address,
            state: 'ACTIVE',
            accumulatedFeesUSD: 0,
            holdCycles: 0,
            createdAt: now,
            updatedAt: now,
        };
        holdStateMap.set(positionId, holdState);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE CURRENT CONDITIONS
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Price movement (% per hour)
    const priceDelta = Math.abs(currentPrice - priceAtEntry) / priceAtEntry;
    const priceMovementPctPerHour = holdDurationHours > 0 ? priceDelta / holdDurationHours : 0;
    
    // Migration slope
    const migrationSlope = Math.abs(pool.liquiditySlope ?? 0);
    
    // Fee intensity (normalized 0-1)
    const feeIntensity = (pool.microMetrics?.feeIntensity ?? 0) / 100;
    
    // Current EV
    const currentEV = computeExpectedValue({
        pool,
        positionSizeUSD,
        regime: currentRegime,
        holdTimeHours: 1, // Evaluate for next hour
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EVALUATE HOLD ELIGIBILITY
    // ═══════════════════════════════════════════════════════════════════════════
    
    const isMarketFlat = priceMovementPctPerHour < HOLD_CONFIG.maxPriceMovementPctPerHour;
    const isMigrationStable = migrationSlope < HOLD_CONFIG.maxMigrationSlopeMagnitude;
    const hasFeeIntensity = feeIntensity >= HOLD_CONFIG.minFeeIntensityForHold;
    const hasPositiveEV = currentEV.expectedNetEVUSD >= HOLD_CONFIG.minHoldEVUSD;
    
    const canEnterHold = isMarketFlat && isMigrationStable && hasFeeIntensity && hasPositiveEV;
    
    let holdRejectReason: string | undefined;
    if (!canEnterHold) {
        const reasons: string[] = [];
        if (!isMarketFlat) reasons.push(`price movement ${(priceMovementPctPerHour * 100).toFixed(2)}%/h > ${HOLD_CONFIG.maxPriceMovementPctPerHour * 100}%`);
        if (!isMigrationStable) reasons.push(`migration slope ${migrationSlope.toFixed(4)} > ${HOLD_CONFIG.maxMigrationSlopeMagnitude}`);
        if (!hasFeeIntensity) reasons.push(`fee intensity ${feeIntensity.toFixed(4)} < ${HOLD_CONFIG.minFeeIntensityForHold}`);
        if (!hasPositiveEV) reasons.push(`EV $${currentEV.expectedNetEVUSD.toFixed(2)} < $${HOLD_CONFIG.minHoldEVUSD}`);
        holdRejectReason = reasons.join('; ');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EVALUATE HOLD EXIT CONDITIONS
    // ═══════════════════════════════════════════════════════════════════════════
    
    let shouldExitHold = false;
    let holdExitReason: string | undefined;
    
    if (holdState.state === 'HOLD') {
        const holdDuration = holdState.holdEntryTime 
            ? (now - holdState.holdEntryTime) / (1000 * 3600) 
            : 0;
        const maxHoldDuration = HOLD_CONFIG.maxHoldDurationHours[currentRegime];
        
        // Check hold exit conditions
        if (holdDuration >= maxHoldDuration) {
            shouldExitHold = true;
            holdExitReason = `Hold duration ${holdDuration.toFixed(1)}h >= ${maxHoldDuration}h cap for ${currentRegime}`;
        } else if (migrationSlope > HOLD_CONFIG.maxMigrationSlopeMagnitude * 2) {
            // Migration increasing significantly
            shouldExitHold = true;
            holdExitReason = `Migration slope increased to ${migrationSlope.toFixed(4)}`;
        } else if (currentEV.expectedNetEVUSD < 0) {
            // EV turned negative
            shouldExitHold = true;
            holdExitReason = `EV turned negative: $${currentEV.expectedNetEVUSD.toFixed(2)}`;
        } else if (HOLD_CONFIG.adverseRegimeFlips[entryRegime]?.includes(currentRegime)) {
            // Adverse regime flip
            shouldExitHold = true;
            holdExitReason = `Regime flipped from ${entryRegime} to ${currentRegime}`;
        } else if (currentScore < HOLD_CONFIG.absoluteMinScoreInHold) {
            // Score dropped below absolute minimum
            shouldExitHold = true;
            holdExitReason = `Score ${currentScore.toFixed(1)} < ${HOLD_CONFIG.absoluteMinScoreInHold} absolute min`;
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE EXIT SUPPRESSION
    // ═══════════════════════════════════════════════════════════════════════════
    
    const suppressLowMovementExit = holdState.state === 'HOLD' && isMarketFlat && !shouldExitHold;
    
    const scoreDecayPct = entryScore > 0 ? (entryScore - currentScore) / entryScore : 0;
    const suppressScoreDecayExit = holdState.state === 'HOLD' && 
        scoreDecayPct < HOLD_CONFIG.maxScoreDecayPctInHold &&
        currentScore >= HOLD_CONFIG.absoluteMinScoreInHold &&
        !shouldExitHold;
    
    const evaluation: HoldEvaluation = {
        priceMovementPctPerHour,
        migrationSlope,
        feeIntensity,
        currentEV,
        currentScore,
        currentRegime,
        
        canEnterHold,
        shouldExitHold,
        holdRejectReason,
        holdExitReason,
        
        suppressLowMovementExit,
        suppressScoreDecayExit,
        
        timestamp: now,
    };
    
    // Update hold state
    holdState.lastEvaluation = evaluation;
    holdState.updatedAt = now;
    
    return evaluation;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Transition position to HOLD state
 */
export function enterHoldMode(
    positionId: string,
    currentEV: number,
    currentScore: number,
    currentRegime: MarketRegime,
    poolName: string
): void {
    const holdState = holdStateMap.get(positionId);
    if (!holdState) {
        logger.warn(`[HOLD-ENTER] Position ${positionId.slice(0, 8)}... not found in hold state map`);
        return;
    }
    
    if (holdState.state === 'HOLD') {
        return; // Already in hold
    }
    
    const now = Date.now();
    holdState.state = 'HOLD';
    holdState.holdEntryTime = now;
    holdState.holdEntryEV = currentEV;
    holdState.holdEntryScore = currentScore;
    holdState.holdEntryRegime = currentRegime;
    holdState.holdCycles = 0;
    holdState.updatedAt = now;
    
    logger.info(
        `[HOLD-ENTER] 🔒 ${poolName} entering fee-harvest hold mode | ` +
        `EV=$${currentEV.toFixed(2)} score=${currentScore.toFixed(1)} regime=${currentRegime}`
    );
}

/**
 * Transition position out of HOLD state
 */
export function exitHoldMode(positionId: string, reason: string, poolName: string): void {
    const holdState = holdStateMap.get(positionId);
    if (!holdState) return;
    
    if (holdState.state !== 'HOLD') return;
    
    const holdDuration = holdState.holdEntryTime 
        ? (Date.now() - holdState.holdEntryTime) / (1000 * 3600) 
        : 0;
    
    holdState.state = 'ACTIVE';
    holdState.updatedAt = Date.now();
    
    logger.info(
        `[HOLD-EXIT] 🔓 ${poolName} exiting hold mode after ${holdDuration.toFixed(1)}h | ` +
        `cycles=${holdState.holdCycles} fees=$${holdState.accumulatedFeesUSD.toFixed(2)} | ` +
        `reason: ${reason}`
    );
}

/**
 * Record fees accumulated during hold
 */
export function recordHoldFees(positionId: string, feesUSD: number): void {
    const holdState = holdStateMap.get(positionId);
    if (!holdState) return;
    
    holdState.accumulatedFeesUSD += feesUSD;
    holdState.holdCycles++;
    holdState.updatedAt = Date.now();
}

/**
 * Get current hold state for a position
 */
export function getHoldState(positionId: string): HoldState | undefined {
    return holdStateMap.get(positionId);
}

/**
 * Get position state (ACTIVE/HOLD/EXITING)
 */
export function getPositionState(positionId: string): PositionState {
    return holdStateMap.get(positionId)?.state ?? 'ACTIVE';
}

/**
 * Check if exit should be suppressed for a position in hold mode.
 * 
 * MODULE 2 SAFETY RULES:
 *   - MAY suppress: NOISE_EXIT (minor score decay, flat volatility)
 *   - MUST NEVER suppress: RISK_EXIT (migration spike, EV < 0, regime flip, kill-switch)
 * 
 * @throws Error in dev mode if attempting to suppress a RISK_EXIT with negative EV
 */
export function shouldSuppressExit(
    positionId: string,
    exitReason: string,
    additionalContext?: {
        currentEV?: EVResult | null;
        currentRegime?: MarketRegime;
        migrationSlope?: number;
        currentScore?: number;
    }
): { 
    suppress: boolean; 
    reason?: string;
    classification?: ExitClassification;
    riskType?: RiskExitType;
} {
    const holdState = holdStateMap.get(positionId);
    if (!holdState || holdState.state !== 'HOLD') {
        return { suppress: false };
    }
    
    const evaluation = holdState.lastEvaluation;
    if (!evaluation) {
        return { suppress: false };
    }
    
    // Get context from evaluation or provided context
    const currentEV = additionalContext?.currentEV ?? evaluation.currentEV ?? null;
    const currentRegime = additionalContext?.currentRegime ?? evaluation.currentRegime ?? 'NEUTRAL';
    const entryRegime = holdState.holdEntryRegime ?? 'NEUTRAL';
    const migrationSlope = additionalContext?.migrationSlope ?? evaluation.migrationSlope ?? 0;
    const currentScore = additionalContext?.currentScore ?? evaluation.currentScore ?? 50;
    const entryScore = holdState.holdEntryScore ?? 50;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MODULE 2: CLASSIFY EXIT TRIGGER
    // ═══════════════════════════════════════════════════════════════════════════
    const classification = classifyExitTrigger(
        exitReason,
        currentEV,
        currentRegime,
        entryRegime,
        migrationSlope,
        currentScore,
        entryScore
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL: NEVER suppress RISK_EXIT
    // ═══════════════════════════════════════════════════════════════════════════
    if (classification.classification === 'RISK_EXIT') {
        // Log the forced exit
        logger.warn(
            `[HOLD-EXIT] 🚨 ${holdState.poolAddress.slice(0, 8)}... ` +
            `reason=RISK_EXIT type=${classification.riskType} | ${classification.reason}`
        );
        
        return { 
            suppress: false,
            classification: 'RISK_EXIT',
            riskType: classification.riskType,
            reason: classification.reason,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DEV ASSERTION: Verify we're not suppressing negative EV
    // ═══════════════════════════════════════════════════════════════════════════
    if (DEV_MODE && currentEV && currentEV.expectedNetEVUSD < 0) {
        const error = new Error(
            `[HOLD-SAFETY-VIOLATION] Attempted to suppress exit while EV is negative: ` +
            `expectedNetEVUSD=$${currentEV.expectedNetEVUSD.toFixed(2)}`
        );
        logger.error(error.message);
        throw error;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // NOISE_EXIT: Safe to suppress in HOLD mode
    // ═══════════════════════════════════════════════════════════════════════════
    if (classification.classification === 'NOISE_EXIT' && classification.canSuppress) {
        // Suppress low movement exits in hold mode
        if (evaluation.suppressLowMovementExit || evaluation.suppressScoreDecayExit) {
            logger.info(
                `[HOLD-SUPPRESS] 🔒 reason=NOISE_EXIT | ${classification.reason}`
            );
            
            return { 
                suppress: true, 
                classification: 'NOISE_EXIT',
                reason: `HOLD mode: suppressing NOISE_EXIT - ${classification.reason}`,
            };
        }
    }
    
    return { suppress: false };
}

/**
 * Log hold rejection
 */
export function logHoldReject(poolName: string, reason: string): void {
    logger.info(`[HOLD-REJECT] ${poolName} cannot enter hold: ${reason}`);
}

/**
 * Clean up hold state for closed position
 */
export function cleanupHoldState(positionId: string): void {
    holdStateMap.delete(positionId);
}

/**
 * Get all positions in HOLD state
 */
export function getHoldPositions(): HoldState[] {
    return Array.from(holdStateMap.values()).filter(s => s.state === 'HOLD');
}

/**
 * Get hold mode summary for logging
 */
export function getHoldModeSummary(): {
    activeCount: number;
    holdCount: number;
    totalAccumulatedFees: number;
    avgHoldDuration: number;
} {
    const states = Array.from(holdStateMap.values());
    const holdStates = states.filter(s => s.state === 'HOLD');
    
    const now = Date.now();
    const avgHoldDuration = holdStates.length > 0
        ? holdStates.reduce((sum, s) => {
            const duration = s.holdEntryTime ? (now - s.holdEntryTime) / (1000 * 3600) : 0;
            return sum + duration;
        }, 0) / holdStates.length
        : 0;
    
    return {
        activeCount: states.filter(s => s.state === 'ACTIVE').length,
        holdCount: holdStates.length,
        totalAccumulatedFees: holdStates.reduce((sum, s) => sum + s.accumulatedFeesUSD, 0),
        avgHoldDuration,
    };
}

/**
 * Clear all hold state (for testing/reset)
 */
export function clearHoldState(): void {
    holdStateMap.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// HOLD_CONFIG is already exported at declaration

