/**
 * Adaptive Capital Manager — Tier 5 Production Capital Scaling
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * REGIME-AWARE, CONFIDENCE-DRIVEN CAPITAL DEPLOYMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * CORE PRINCIPLES:
 * 1. Never deploy 100% — always maintain hard reserve
 * 2. Adaptive scaling based on measured confidence + market regime
 * 3. Per-pool concentration caps to prevent overexposure
 * 4. Warmup rules after startup and cooldown
 * 5. Position sizing driven by fee amortization economics
 * 
 * CAPITAL ALLOCATION RULES:
 * - MIN_DEPLOY_CAP (25%): Stress/recovery mode
 * - BASE_DEPLOY_CAP (40%): Normal operation
 * - MAX_DEPLOY_CAP (60%): Unlocked when confidence high
 * - HARD_RESERVE (35%): Never deployed under any circumstance
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — PRODUCTION CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const CAPITAL_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // DEPLOYMENT CAPS (as fraction of total equity)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Minimum total deployment cap — stress/recovery mode */
    MIN_TOTAL_DEPLOY_CAP: 0.25,
    
    /** Base total deployment cap — normal operation */
    BASE_TOTAL_DEPLOY_CAP: 0.40,
    
    /** Maximum total deployment cap — high confidence only */
    MAX_TOTAL_DEPLOY_CAP: 0.60,
    
    /** Hard reserve — NEVER deployed (absolute ceiling enforcement) */
    HARD_RESERVE_PCT: 0.35,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // PER-POOL CONCENTRATION CAPS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Maximum per-pool allocation (NEUTRAL/BULL) */
    PER_POOL_MAX_PCT: 0.08,
    
    /** Maximum per-pool allocation (BEAR) */
    PER_POOL_MAX_PCT_BEAR: 0.05,
    
    /** Maximum single position size */
    MAX_SINGLE_POSITION_PCT: 0.06,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // POSITION SIZING (USD)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Minimum position size — avoid tiny positions that cannot amortize fees */
    MIN_POSITION_USD: 400,
    
    /** Target position size (NEUTRAL regime) */
    TARGET_POSITION_USD_NEUTRAL: 900,
    
    /** Target position size (BULL regime) */
    TARGET_POSITION_USD_BULL: 1200,
    
    /** Target position size (BEAR regime) */
    TARGET_POSITION_USD_BEAR: 600,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // WARMUP CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Warmup duration after startup (ms) */
    WARMUP_DURATION_MS: 15 * 60 * 1000, // 15 minutes
    
    /** Warmup duration after cooldown ends (ms) */
    POST_COOLDOWN_WARMUP_MS: 10 * 60 * 1000, // 10 minutes
    
    /** Initial deployment cap during warmup */
    WARMUP_INITIAL_CAP: 0.15,
    
    /** Ramp steps during warmup */
    WARMUP_RAMP_STEPS: 3,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // AMORTIZATION PARAMETERS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Target hours to amortize entry/exit costs */
    TARGET_HOURS_TO_AMORTIZE: 2.5,
    
    /** Maximum hours for amortization (beyond this, skip entry) */
    MAX_HOURS_TO_AMORTIZE: 6.0,
    
    /** Conservative fee rate estimate (USD/hour per $1000 position) */
    CONSERVATIVE_FEE_RATE_PER_1K_USD_HOUR: 0.35,
    
    /** Cost buffer multiplier */
    COST_BUFFER_MULTIPLIER: 0.15,
    
    /** Minimum cost buffer (USD) */
    MIN_COST_BUFFER_USD: 0.50,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIDENCE UNLOCK THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Minimum market health to unlock MAX_CAP */
    UNLOCK_MIN_MARKET_HEALTH: 35,
    
    /** Minimum alive ratio to unlock MAX_CAP */
    UNLOCK_MIN_ALIVE_RATIO: 0.35,
    
    /** Maximum forced exit rate to unlock MAX_CAP */
    UNLOCK_MAX_FORCED_EXIT_RATE: 0.10,
    
    /** Minimum exit suppression rate to unlock MAX_CAP */
    UNLOCK_MIN_EXIT_SUPPRESSION_RATE: 0.60,
    
    /** Minimum avg health score to unlock MAX_CAP */
    UNLOCK_MIN_AVG_HEALTH_SCORE: 0.55,
    
    /** Rolling window for confidence calculation (ms) */
    CONFIDENCE_WINDOW_MS: 45 * 60 * 1000, // 45 minutes
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STRESS DOWNSHIFT THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Market health below this triggers downshift to MIN_CAP */
    STRESS_MARKET_HEALTH_THRESHOLD: 22,
    
    /** Alive ratio below this triggers downshift to MIN_CAP */
    STRESS_ALIVE_RATIO_THRESHOLD: 0.20,
    
    /** Forced exit rate above this triggers downshift */
    STRESS_FORCED_EXIT_RATE_THRESHOLD: 0.25,
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE SCORE WEIGHTS
// ═══════════════════════════════════════════════════════════════════════════════

export const CONFIDENCE_WEIGHTS = {
    /** Higher exit suppression rate = better (avoiding churn) */
    exitSuppressionRate: 0.20,
    
    /** Lower forced exit rate = better */
    forcedExitRate: 0.15,
    
    /** Higher avg health score = better */
    avgHealthScore: 0.20,
    
    /** Lower PnL stability (variance) = better */
    pnlStability: 0.10,
    
    /** Market health from kill switch */
    marketHealth: 0.20,
    
    /** Alive ratio from kill switch */
    aliveRatio: 0.10,
    
    /** Data quality (fewer RPC errors, etc.) */
    dataQuality: 0.05,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface CapitalManagerState {
    // Current caps
    dynamicDeployCapPct: number;
    perPoolMaxPct: number;
    
    // Confidence
    confidenceScore: number;
    confidenceUnlocked: boolean;
    
    // Warmup
    isInWarmup: boolean;
    warmupProgress: number; // 0-1
    warmupStartTime: number;
    
    // Cooldown integration
    isInCooldown: boolean;
    cooldownEndTime: number;
    postCooldownWarmupActive: boolean;
    
    // Regime
    currentRegime: MarketRegime;
    
    // Metrics (for display)
    deployedPct: number;
    reservePct: number;
    availableCapacityPct: number;
    
    // Timestamp
    lastUpdateTime: number;
}

export interface ConfidenceInputs {
    exitSuppressionRate: number;      // 0-1, higher = better
    forcedExitRate: number;           // 0-1, lower = better
    avgHealthScore: number;           // 0-1, higher = better
    pnlStabilityInverse: number;      // 0-1, higher = lower variance = better
    marketHealth: number;             // 0-100 from kill switch
    aliveRatio: number;               // 0-1 from kill switch
    dataQuality: number;              // 0-1, higher = better
}

export interface PositionSizingResult {
    recommendedSizeUsd: number;
    minSizeUsd: number;
    maxSizeUsd: number;
    sizeReason: string;
    
    // Amortization info
    expectedFeeRateUsdPerHour: number;
    estimatedAmortizationHours: number;
    costTargetUsd: number;
    
    // Flags
    isProbeMode: boolean;
    skipEntry: boolean;
    skipReason?: string;
}

export interface CapitalCheckResult {
    allowed: boolean;
    reason: string;
    availableCapacityUsd: number;
    poolRemainingCapacityUsd: number;
    adjustedSizeUsd: number;
}

export interface PoolFeeHistory {
    poolAddress: string;
    samples: Array<{
        feesAccruedUsd: number;
        holdTimeMs: number;
        positionSizeUsd: number;
        timestamp: number;
    }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const state: CapitalManagerState = {
    dynamicDeployCapPct: CAPITAL_CONFIG.WARMUP_INITIAL_CAP,
    perPoolMaxPct: CAPITAL_CONFIG.PER_POOL_MAX_PCT,
    confidenceScore: 0.5,
    confidenceUnlocked: false,
    isInWarmup: true,
    warmupProgress: 0,
    warmupStartTime: Date.now(),
    isInCooldown: false,
    cooldownEndTime: 0,
    postCooldownWarmupActive: false,
    currentRegime: 'NEUTRAL',
    deployedPct: 0,
    reservePct: CAPITAL_CONFIG.HARD_RESERVE_PCT,
    availableCapacityPct: CAPITAL_CONFIG.WARMUP_INITIAL_CAP,
    lastUpdateTime: Date.now(),
};

// Confidence metrics history (rolling window)
const confidenceHistory: Array<{
    inputs: ConfidenceInputs;
    timestamp: number;
}> = [];

// Pool fee history for amortization estimation
const poolFeeHistoryMap = new Map<string, PoolFeeHistory>();

// Deployed capital tracking
const poolDeployments = new Map<string, number>();
let totalDeployedUsd = 0;
let totalEquityUsd = 10000; // Default, updated externally

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize or update total equity
 */
export function updateEquity(equityUsd: number): void {
    totalEquityUsd = Math.max(1, equityUsd);
    recalculateState();
}

/**
 * Update regime
 */
export function updateRegime(regime: MarketRegime): void {
    state.currentRegime = regime;
    
    // Adjust per-pool cap based on regime
    if (regime === 'BEAR') {
        state.perPoolMaxPct = CAPITAL_CONFIG.PER_POOL_MAX_PCT_BEAR;
    } else {
        state.perPoolMaxPct = CAPITAL_CONFIG.PER_POOL_MAX_PCT;
    }
    
    recalculateState();
}

/**
 * Set cooldown state (integrates with kill switch)
 */
export function setCooldownState(isActive: boolean, endTimeMs: number = 0): void {
    const wasInCooldown = state.isInCooldown;
    state.isInCooldown = isActive;
    state.cooldownEndTime = endTimeMs;
    
    // If exiting cooldown, start post-cooldown warmup
    if (wasInCooldown && !isActive) {
        state.postCooldownWarmupActive = true;
        state.warmupStartTime = Date.now();
        state.warmupProgress = 0;
        logger.info('[CAPITAL-MGR] Post-cooldown warmup started');
    }
    
    recalculateState();
}

/**
 * Update confidence inputs (call each cycle)
 */
export function updateConfidence(inputs: ConfidenceInputs): void {
    const now = Date.now();
    
    // Add to history
    confidenceHistory.push({ inputs, timestamp: now });
    
    // Prune old entries
    const cutoff = now - CAPITAL_CONFIG.CONFIDENCE_WINDOW_MS;
    while (confidenceHistory.length > 0 && confidenceHistory[0].timestamp < cutoff) {
        confidenceHistory.shift();
    }
    
    // Compute rolling confidence score
    state.confidenceScore = computeConfidenceScore();
    
    // Check unlock conditions
    state.confidenceUnlocked = checkConfidenceUnlock(inputs);
    
    recalculateState();
}

/**
 * Record position deployment
 */
export function recordDeployment(poolAddress: string, sizeUsd: number): void {
    const current = poolDeployments.get(poolAddress) || 0;
    poolDeployments.set(poolAddress, current + sizeUsd);
    totalDeployedUsd += sizeUsd;
    recalculateState();
}

/**
 * Record position exit
 */
export function recordExit(poolAddress: string, sizeUsd: number): void {
    const current = poolDeployments.get(poolAddress) || 0;
    const newAmount = Math.max(0, current - sizeUsd);
    
    if (newAmount <= 0) {
        poolDeployments.delete(poolAddress);
    } else {
        poolDeployments.set(poolAddress, newAmount);
    }
    
    totalDeployedUsd = Math.max(0, totalDeployedUsd - sizeUsd);
    recalculateState();
}

/**
 * Record fee history for a pool (for amortization estimation)
 */
export function recordPoolFeeHistory(
    poolAddress: string,
    feesAccruedUsd: number,
    holdTimeMs: number,
    positionSizeUsd: number
): void {
    let history = poolFeeHistoryMap.get(poolAddress);
    if (!history) {
        history = { poolAddress, samples: [] };
        poolFeeHistoryMap.set(poolAddress, history);
    }
    
    history.samples.push({
        feesAccruedUsd,
        holdTimeMs,
        positionSizeUsd,
        timestamp: Date.now(),
    });
    
    // Keep only last 20 samples
    while (history.samples.length > 20) {
        history.samples.shift();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a new position can be opened with given size
 */
export function checkCapitalAvailability(
    poolAddress: string,
    requestedSizeUsd: number
): CapitalCheckResult {
    const config = CAPITAL_CONFIG;
    
    // Calculate available capacity
    const maxDeployableUsd = totalEquityUsd * state.dynamicDeployCapPct;
    const availableCapacityUsd = Math.max(0, maxDeployableUsd - totalDeployedUsd);
    
    // Calculate pool remaining capacity
    const poolCurrentUsd = poolDeployments.get(poolAddress) || 0;
    const poolMaxUsd = totalEquityUsd * state.perPoolMaxPct;
    const poolRemainingCapacityUsd = Math.max(0, poolMaxUsd - poolCurrentUsd);
    
    // Enforce hard reserve
    const hardReserveUsd = totalEquityUsd * config.HARD_RESERVE_PCT;
    const availableAfterReserve = totalEquityUsd - hardReserveUsd - totalDeployedUsd;
    
    // Calculate adjusted size
    let adjustedSizeUsd = Math.min(
        requestedSizeUsd,
        availableCapacityUsd,
        poolRemainingCapacityUsd,
        availableAfterReserve,
        totalEquityUsd * config.MAX_SINGLE_POSITION_PCT
    );
    
    // Check minimum viable size
    if (adjustedSizeUsd < config.MIN_POSITION_USD) {
        return {
            allowed: false,
            reason: `Adjusted size $${adjustedSizeUsd.toFixed(0)} < min $${config.MIN_POSITION_USD}`,
            availableCapacityUsd,
            poolRemainingCapacityUsd,
            adjustedSizeUsd: 0,
        };
    }
    
    // Check cooldown
    if (state.isInCooldown) {
        return {
            allowed: false,
            reason: 'Capital manager in cooldown mode',
            availableCapacityUsd,
            poolRemainingCapacityUsd,
            adjustedSizeUsd: 0,
        };
    }
    
    // Build reason string
    let reason = 'OK';
    if (adjustedSizeUsd < requestedSizeUsd) {
        const caps: string[] = [];
        if (adjustedSizeUsd === availableCapacityUsd) caps.push('portfolio cap');
        if (adjustedSizeUsd === poolRemainingCapacityUsd) caps.push('pool cap');
        if (adjustedSizeUsd === availableAfterReserve) caps.push('reserve');
        reason = `Capped by ${caps.join(', ')}`;
    }
    
    return {
        allowed: true,
        reason,
        availableCapacityUsd,
        poolRemainingCapacityUsd,
        adjustedSizeUsd,
    };
}

/**
 * Compute recommended position size for a pool
 */
export function computePositionSize(
    poolAddress: string,
    poolName: string,
    entryFeesUsd: number,
    exitFeesUsd: number,
    slippageUsd: number,
    observedFeeRateUsdPerHour?: number
): PositionSizingResult {
    const config = CAPITAL_CONFIG;
    const regime = state.currentRegime;
    
    // Get base target size for regime
    let targetSizeUsd: number;
    switch (regime) {
        case 'BULL':
            targetSizeUsd = config.TARGET_POSITION_USD_BULL;
            break;
        case 'BEAR':
            targetSizeUsd = config.TARGET_POSITION_USD_BEAR;
            break;
        default:
            targetSizeUsd = config.TARGET_POSITION_USD_NEUTRAL;
    }
    
    // Calculate cost target with buffer
    const baseCosts = entryFeesUsd + exitFeesUsd + slippageUsd;
    const buffer = Math.max(config.MIN_COST_BUFFER_USD, baseCosts * config.COST_BUFFER_MULTIPLIER);
    const costTargetUsd = baseCosts + buffer;
    
    // Estimate fee rate
    const expectedFeeRateUsdPerHour = observedFeeRateUsdPerHour 
        ?? estimatePoolFeeRate(poolAddress, targetSizeUsd);
    
    // Calculate required position size for amortization
    let requiredSizeForAmortization: number;
    let estimatedAmortizationHours: number;
    
    if (expectedFeeRateUsdPerHour > 0.01) {
        // Fee rate is per $1000 position, scale to target
        const feeRateForTargetSize = expectedFeeRateUsdPerHour * (targetSizeUsd / 1000);
        estimatedAmortizationHours = costTargetUsd / feeRateForTargetSize;
        
        // Calculate size needed for target amortization time
        requiredSizeForAmortization = (costTargetUsd * 1000) / 
            (expectedFeeRateUsdPerHour * config.TARGET_HOURS_TO_AMORTIZE);
    } else {
        // Very low fee rate — use conservative estimate
        estimatedAmortizationHours = config.MAX_HOURS_TO_AMORTIZE + 1;
        requiredSizeForAmortization = targetSizeUsd;
    }
    
    // Determine final size
    let recommendedSizeUsd = Math.max(targetSizeUsd, requiredSizeForAmortization);
    let isProbeMode = false;
    let skipEntry = false;
    let skipReason: string | undefined;
    
    // Cap to maximum allowed
    const maxAllowedUsd = totalEquityUsd * config.MAX_SINGLE_POSITION_PCT;
    recommendedSizeUsd = Math.min(recommendedSizeUsd, maxAllowedUsd);
    
    // Apply warmup scaling
    if (state.isInWarmup || state.postCooldownWarmupActive) {
        const warmupMultiplier = Math.min(1, 0.5 + (state.warmupProgress * 0.5));
        recommendedSizeUsd *= warmupMultiplier;
    }
    
    // Apply regime scaling
    if (regime === 'BEAR') {
        recommendedSizeUsd *= 0.75;
    } else if (regime === 'BULL' && state.confidenceUnlocked) {
        recommendedSizeUsd *= 1.15;
    }
    
    // Check if amortization is possible
    if (estimatedAmortizationHours > config.MAX_HOURS_TO_AMORTIZE) {
        if (recommendedSizeUsd >= config.MIN_POSITION_USD) {
            // Use minimum size as probe
            recommendedSizeUsd = config.MIN_POSITION_USD;
            isProbeMode = true;
        } else {
            // Skip entry entirely
            skipEntry = true;
            skipReason = `Amortization ${estimatedAmortizationHours.toFixed(1)}h > max ${config.MAX_HOURS_TO_AMORTIZE}h`;
        }
    }
    
    // Ensure minimum viable size
    if (recommendedSizeUsd < config.MIN_POSITION_USD && !skipEntry) {
        recommendedSizeUsd = config.MIN_POSITION_USD;
        isProbeMode = true;
    }
    
    // Build size reason
    let sizeReason = `Target ${targetSizeUsd} | Regime ${regime}`;
    if (isProbeMode) sizeReason += ' | PROBE';
    if (state.isInWarmup) sizeReason += ` | Warmup ${(state.warmupProgress * 100).toFixed(0)}%`;
    
    return {
        recommendedSizeUsd: Math.floor(recommendedSizeUsd),
        minSizeUsd: config.MIN_POSITION_USD,
        maxSizeUsd: Math.floor(maxAllowedUsd),
        sizeReason,
        expectedFeeRateUsdPerHour,
        estimatedAmortizationHours,
        costTargetUsd,
        isProbeMode,
        skipEntry,
        skipReason,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE SCORE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

function computeConfidenceScore(): number {
    if (confidenceHistory.length === 0) return 0.5;
    
    // Compute weighted average of recent inputs
    let totalWeight = 0;
    let weightedSum = 0;
    
    const now = Date.now();
    const windowMs = CAPITAL_CONFIG.CONFIDENCE_WINDOW_MS;
    
    for (const entry of confidenceHistory) {
        // Time-based weighting (more recent = higher weight)
        const age = now - entry.timestamp;
        const timeWeight = 1 - (age / windowMs);
        if (timeWeight <= 0) continue;
        
        const inputs = entry.inputs;
        
        // Compute single-entry score
        let entryScore = 0;
        entryScore += CONFIDENCE_WEIGHTS.exitSuppressionRate * inputs.exitSuppressionRate;
        entryScore += CONFIDENCE_WEIGHTS.forcedExitRate * (1 - inputs.forcedExitRate);
        entryScore += CONFIDENCE_WEIGHTS.avgHealthScore * inputs.avgHealthScore;
        entryScore += CONFIDENCE_WEIGHTS.pnlStability * inputs.pnlStabilityInverse;
        entryScore += CONFIDENCE_WEIGHTS.marketHealth * (inputs.marketHealth / 100);
        entryScore += CONFIDENCE_WEIGHTS.aliveRatio * inputs.aliveRatio;
        entryScore += CONFIDENCE_WEIGHTS.dataQuality * inputs.dataQuality;
        
        weightedSum += entryScore * timeWeight;
        totalWeight += timeWeight;
    }
    
    if (totalWeight === 0) return 0.5;
    return Math.min(1, Math.max(0, weightedSum / totalWeight));
}

function checkConfidenceUnlock(inputs: ConfidenceInputs): boolean {
    const config = CAPITAL_CONFIG;
    
    // All conditions must be met
    return (
        inputs.marketHealth >= config.UNLOCK_MIN_MARKET_HEALTH &&
        inputs.aliveRatio >= config.UNLOCK_MIN_ALIVE_RATIO &&
        inputs.forcedExitRate <= config.UNLOCK_MAX_FORCED_EXIT_RATE &&
        inputs.exitSuppressionRate >= config.UNLOCK_MIN_EXIT_SUPPRESSION_RATE &&
        inputs.avgHealthScore >= config.UNLOCK_MIN_AVG_HEALTH_SCORE
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEE RATE ESTIMATION
// ═══════════════════════════════════════════════════════════════════════════════

function estimatePoolFeeRate(poolAddress: string, positionSizeUsd: number): number {
    const history = poolFeeHistoryMap.get(poolAddress);
    
    if (history && history.samples.length >= 3) {
        // Calculate observed fee rate from history
        let totalFeeRatePerHour = 0;
        let validSamples = 0;
        
        for (const sample of history.samples) {
            if (sample.holdTimeMs > 30 * 60 * 1000 && sample.positionSizeUsd > 0) { // 30 min minimum
                const hoursFraction = sample.holdTimeMs / (60 * 60 * 1000);
                const feeRatePer1kPerHour = (sample.feesAccruedUsd / sample.positionSizeUsd) * 1000 / hoursFraction;
                totalFeeRatePerHour += feeRatePer1kPerHour;
                validSamples++;
            }
        }
        
        if (validSamples >= 2) {
            return totalFeeRatePerHour / validSamples;
        }
    }
    
    // Fall back to conservative estimate
    return CAPITAL_CONFIG.CONSERVATIVE_FEE_RATE_PER_1K_USD_HOUR;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE RECALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

function recalculateState(): void {
    const config = CAPITAL_CONFIG;
    const now = Date.now();
    
    // Update warmup progress
    if (state.isInWarmup || state.postCooldownWarmupActive) {
        const warmupDuration = state.postCooldownWarmupActive 
            ? config.POST_COOLDOWN_WARMUP_MS 
            : config.WARMUP_DURATION_MS;
        const elapsed = now - state.warmupStartTime;
        state.warmupProgress = Math.min(1, elapsed / warmupDuration);
        
        if (state.warmupProgress >= 1) {
            state.isInWarmup = false;
            state.postCooldownWarmupActive = false;
            logger.info('[CAPITAL-MGR] Warmup complete');
        }
    }
    
    // Determine dynamic cap based on conditions
    let targetCapPct: number;
    
    if (state.isInCooldown) {
        // During cooldown: use minimum cap
        targetCapPct = config.MIN_TOTAL_DEPLOY_CAP;
    } else if (state.isInWarmup || state.postCooldownWarmupActive) {
        // During warmup: ramp from initial to base
        const rampProgress = state.warmupProgress;
        targetCapPct = config.WARMUP_INITIAL_CAP + 
            (config.BASE_TOTAL_DEPLOY_CAP - config.WARMUP_INITIAL_CAP) * rampProgress;
    } else if (state.confidenceUnlocked) {
        // High confidence: allow up to max cap
        targetCapPct = config.MAX_TOTAL_DEPLOY_CAP;
    } else if (state.confidenceScore < 0.35) {
        // Low confidence / stress: drop to minimum
        targetCapPct = config.MIN_TOTAL_DEPLOY_CAP;
    } else {
        // Normal operation: base cap
        targetCapPct = config.BASE_TOTAL_DEPLOY_CAP;
    }
    
    // Apply regime adjustment
    if (state.currentRegime === 'BEAR') {
        targetCapPct = Math.min(targetCapPct, config.BASE_TOTAL_DEPLOY_CAP);
    }
    
    // Ensure we respect hard reserve
    const maxAllowedCap = 1 - config.HARD_RESERVE_PCT;
    targetCapPct = Math.min(targetCapPct, maxAllowedCap);
    
    state.dynamicDeployCapPct = targetCapPct;
    
    // Update derived metrics
    state.deployedPct = totalEquityUsd > 0 ? totalDeployedUsd / totalEquityUsd : 0;
    state.reservePct = config.HARD_RESERVE_PCT;
    state.availableCapacityPct = Math.max(0, targetCapPct - state.deployedPct);
    state.lastUpdateTime = now;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE ACCESSORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current capital manager state
 */
export function getCapitalManagerState(): Readonly<CapitalManagerState> {
    return { ...state };
}

/**
 * Get dynamic deployment cap (as fraction)
 */
export function getDynamicDeployCapPct(): number {
    return state.dynamicDeployCapPct;
}

/**
 * Get per-pool max (as fraction)
 */
export function getPerPoolMaxPct(): number {
    return state.perPoolMaxPct;
}

/**
 * Get available capacity in USD
 */
export function getAvailableCapacityUsd(): number {
    const maxDeployable = totalEquityUsd * state.dynamicDeployCapPct;
    return Math.max(0, maxDeployable - totalDeployedUsd);
}

/**
 * Get pool remaining capacity in USD
 */
export function getPoolRemainingCapacityUsd(poolAddress: string): number {
    const poolCurrent = poolDeployments.get(poolAddress) || 0;
    const poolMax = totalEquityUsd * state.perPoolMaxPct;
    return Math.max(0, poolMax - poolCurrent);
}

/**
 * Check if capital manager is in stress mode
 */
export function isInStressMode(): boolean {
    return state.confidenceScore < 0.35 || 
           state.isInCooldown || 
           state.dynamicDeployCapPct <= CAPITAL_CONFIG.MIN_TOTAL_DEPLOY_CAP;
}

/**
 * Check if capital manager has unlocked max capacity
 */
export function isMaxCapacityUnlocked(): boolean {
    return state.confidenceUnlocked && 
           state.dynamicDeployCapPct >= CAPITAL_CONFIG.MAX_TOTAL_DEPLOY_CAP;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log capital manager status (call periodically)
 */
export function logCapitalManagerStatus(): void {
    const s = state;
    const config = CAPITAL_CONFIG;
    
    const statusEmoji = s.isInCooldown ? '🔒' : 
                        s.isInWarmup ? '🌡️' :
                        s.confidenceUnlocked ? '🟢' : 
                        s.confidenceScore < 0.35 ? '🔴' : '🟡';
    
    logger.info(
        `[CAPITAL-MGR] ${statusEmoji} ` +
        `cap=${(s.dynamicDeployCapPct * 100).toFixed(0)}% ` +
        `deployed=${(s.deployedPct * 100).toFixed(1)}% ` +
        `avail=${(s.availableCapacityPct * 100).toFixed(1)}% ` +
        `reserve=${(s.reservePct * 100).toFixed(0)}% ` +
        `conf=${(s.confidenceScore * 100).toFixed(0)}% ` +
        `regime=${s.currentRegime} ` +
        `poolCap=${(s.perPoolMaxPct * 100).toFixed(0)}%` +
        (s.isInWarmup ? ` warmup=${(s.warmupProgress * 100).toFixed(0)}%` : '') +
        (s.confidenceUnlocked ? ' UNLOCKED' : '')
    );
}

/**
 * Log detailed breakdown (for debugging)
 */
export function logCapitalManagerDebug(): void {
    const s = state;
    
    logger.debug('[CAPITAL-MGR-DEBUG] ' + JSON.stringify({
        dynamicCapPct: s.dynamicDeployCapPct,
        deployedPct: s.deployedPct,
        confidenceScore: s.confidenceScore,
        confidenceUnlocked: s.confidenceUnlocked,
        regime: s.currentRegime,
        isWarmup: s.isInWarmup,
        isCooldown: s.isInCooldown,
        poolCount: poolDeployments.size,
        totalDeployedUsd,
        totalEquityUsd,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVARIANT ASSERTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assert capital manager invariants (for safety checks)
 */
export function assertCapitalInvariants(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const config = CAPITAL_CONFIG;
    
    // Invariant 1: Deployed never exceeds dynamic cap
    const deployedPct = totalEquityUsd > 0 ? totalDeployedUsd / totalEquityUsd : 0;
    if (deployedPct > state.dynamicDeployCapPct + 0.01) {
        errors.push(`Deployed ${(deployedPct * 100).toFixed(1)}% > cap ${(state.dynamicDeployCapPct * 100).toFixed(1)}%`);
    }
    
    // Invariant 2: Reserve always maintained
    const reserveActual = 1 - deployedPct;
    if (reserveActual < config.HARD_RESERVE_PCT - 0.01) {
        errors.push(`Reserve ${(reserveActual * 100).toFixed(1)}% < hard reserve ${(config.HARD_RESERVE_PCT * 100).toFixed(0)}%`);
    }
    
    // Invariant 3: No pool exceeds per-pool cap
    for (const [poolAddr, deployed] of poolDeployments) {
        const poolPct = deployed / totalEquityUsd;
        if (poolPct > state.perPoolMaxPct + 0.01) {
            errors.push(`Pool ${poolAddr.slice(0, 8)} at ${(poolPct * 100).toFixed(1)}% > max ${(state.perPoolMaxPct * 100).toFixed(0)}%`);
        }
    }
    
    // Invariant 4: Dynamic cap never exceeds 1 - reserve
    if (state.dynamicDeployCapPct > 1 - config.HARD_RESERVE_PCT + 0.001) {
        errors.push(`Dynamic cap ${(state.dynamicDeployCapPct * 100).toFixed(1)}% exceeds allowed max`);
    }
    
    if (errors.length > 0) {
        for (const err of errors) {
            logger.error(`[CAPITAL-MGR-INVARIANT] ${err}`);
        }
    }
    
    return { valid: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESET / INIT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reset capital manager state (for testing or restart)
 */
export function resetCapitalManager(initialEquityUsd?: number): void {
    poolDeployments.clear();
    poolFeeHistoryMap.clear();
    confidenceHistory.length = 0;
    
    totalDeployedUsd = 0;
    totalEquityUsd = initialEquityUsd ?? 10000;
    
    state.dynamicDeployCapPct = CAPITAL_CONFIG.WARMUP_INITIAL_CAP;
    state.perPoolMaxPct = CAPITAL_CONFIG.PER_POOL_MAX_PCT;
    state.confidenceScore = 0.5;
    state.confidenceUnlocked = false;
    state.isInWarmup = true;
    state.warmupProgress = 0;
    state.warmupStartTime = Date.now();
    state.isInCooldown = false;
    state.cooldownEndTime = 0;
    state.postCooldownWarmupActive = false;
    state.currentRegime = 'NEUTRAL';
    state.deployedPct = 0;
    state.reservePct = CAPITAL_CONFIG.HARD_RESERVE_PCT;
    state.availableCapacityPct = CAPITAL_CONFIG.WARMUP_INITIAL_CAP;
    state.lastUpdateTime = Date.now();
    
    logger.info(`[CAPITAL-MGR] Reset complete. Equity: $${totalEquityUsd.toFixed(2)}`);
}

/**
 * Sync deployments from external source (e.g., database)
 */
export function syncDeployments(positions: Array<{ poolAddress: string; sizeUsd: number }>): void {
    poolDeployments.clear();
    totalDeployedUsd = 0;
    
    for (const pos of positions) {
        const current = poolDeployments.get(pos.poolAddress) || 0;
        poolDeployments.set(pos.poolAddress, current + pos.sizeUsd);
        totalDeployedUsd += pos.sizeUsd;
    }
    
    recalculateState();
    logger.info(`[CAPITAL-MGR] Synced ${positions.length} positions, total deployed: $${totalDeployedUsd.toFixed(2)}`);
}

