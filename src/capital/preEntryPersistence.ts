/**
 * Pre-Entry Persistence Filter (PEPF) — Prevent EV-Positive But Non-Persistent Entries
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 UPGRADE — PERSISTENCE CONFIRMATION LAYER
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Block entries where EV is positive only for a single snapshot/cycle,
 * but edge decays before minimum fee amortization time. This prevents micro-hold
 * fee bleed from short-lived edge opportunities.
 * 
 * POSITION IN ENTRY FLOW:
 *   EV Gate → PEPF → Tier-5 (ODD/AEL/CCE/VSH) → sizing → execute
 * 
 * INPUTS (uses existing data, no new APIs):
 *   - Last N snapshots for the pool (prefer N=20; require N>=15)
 *   - EV breakdown from EV gate
 *   - feeIntensity, swapVelocity, binStability, churnQuality
 *   - Regime + regime stability
 *   - Migration and slope indicators
 * 
 * PERSISTENCE SIGNALS COMPUTED:
 *   - evStreak: consecutive cycles with EV >= 0
 *   - feeIntensityStreak: consecutive cycles with feeIntensity above minimum
 *   - edgeHalfLifeSec: approximate decay time of EV using exponential fit
 *   - expectedAmortizationSec: time to pay expected total costs
 * 
 * PASS CRITERIA:
 *   - evStreak >= MIN_EV_STREAK AND
 *   - feeIntensityStreak >= MIN_FI_STREAK AND
 *   - edgeHalfLifeSec >= amortizationSec * AMORTIZATION_MULT AND
 *   - regime stability requirements met
 * 
 * TIER-5 RELAXATION:
 *   If AEL >= A2 and ODD spike confirmed: allow minEvStreak=2, 
 *   amortizationMultiplier=1.05 (still must not be 1-cycle)
 * 
 * SAFETY:
 *   - Entry-only. No exit behavior changes.
 *   - Never overrides KILL_SWITCH, FEE_BLEED defense, portfolio ledger invariants
 *   - Feature-flagged via ENABLE_PEPF
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';
import { Tier4EnrichedPool } from '../scoring/microstructureScoring';
import { getPoolHistory, DLMMTelemetry } from '../services/dlmmTelemetry';
import { EVResult, EV_CONFIG } from './evGating';
import { hasActiveSpike, isSpikeConfirmed } from './opportunityDensity';
import { getAggressionState, AggressionLevel } from './aggressionLadder';
import { getCurrentRegimeState } from './aggressionScaling';
import { PEPF_CONFIG, ENABLE_PEPF } from '../config/constants';

// ═══════════════════════════════════════════════════════════════════════════════
// DEV MODE FLAG
// ═══════════════════════════════════════════════════════════════════════════════

const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Persistence signals computed for a pool
 */
export interface PersistenceSignals {
    evStreak: number;                    // Consecutive cycles with EV >= 0
    feeIntensityStreak: number;          // Consecutive cycles with feeIntensity above min
    edgeHalfLifeSec: number;             // Approximate decay time of EV
    expectedAmortizationSec: number;     // Time to pay expected total costs
    expectedFeeRateUsdPerSec: number;    // Fee rate in USD/sec
    snapshotsUsed: number;               // Number of snapshots analyzed
    evHistory: number[];                 // Recent EV values for analysis
    feeIntensityHistory: number[];       // Recent feeIntensity values
}

/**
 * Context for PEPF evaluation
 */
export interface PreEntryPersistenceContext {
    pool: Tier4EnrichedPool;
    evResult: EVResult;
    positionSizeUSD: number;
    regime: MarketRegime;
    
    // Optional Tier-5 context for relaxation
    aggressionLevel?: AggressionLevel;
    oddSpikeConfirmed?: boolean;
}

/**
 * Result of PEPF evaluation
 */
export interface PreEntryPersistenceResult {
    // Decision
    pass: boolean;
    blocked: boolean;
    
    // Signals
    signals: PersistenceSignals;
    
    // Requirements
    requirements: {
        minEvStreak: number;
        minFiStreak: number;
        amortizationMultiplier: number;
        requiredHalfLifeSec: number;
    };
    
    // Reason for block
    blockReason?: PEPFBlockReason;
    blockReasonDetail?: string;
    
    // Relaxation applied
    tier5Relaxation: boolean;
    relaxationReason?: string;
    
    // Metadata
    poolAddress: string;
    poolName: string;
    timestamp: number;
}

/**
 * PEPF block reasons (for categorization)
 */
export type PEPFBlockReason = 
    | 'INSUFFICIENT_SNAPSHOTS'
    | 'EV_STREAK_BELOW_MIN'
    | 'FI_STREAK_BELOW_MIN'
    | 'HALFLIFE_LT_AMORTIZATION'
    | 'REGIME_UNSTABLE'
    | 'STALE_DATA'
    | 'SYNTHETIC_TIMESTAMPS'
    | 'COOLDOWN_ACTIVE';

/**
 * Reasons that trigger cooldown (mirage pool detection)
 */
const COOLDOWN_TRIGGERING_REASONS: PEPFBlockReason[] = [
    'HALFLIFE_LT_AMORTIZATION',
    'EV_STREAK_BELOW_MIN',
    'FI_STREAK_BELOW_MIN',
];

/**
 * Stats tracked per cycle
 */
export interface PersistenceStats {
    totalEvaluations: number;
    passes: number;
    rejects: number;
    rejectsByReason: Record<PEPFBlockReason, number>;
    avgHalfLifeSec: number;
    avgAmortizationSec: number;
    tier5Relaxations: number;
    cooldownSkips: number;
    activeCooldowns: number;
}

/**
 * Cooldown entry for a pool
 */
interface PoolCooldown {
    reason: PEPFBlockReason;
    cooldownUntil: number;
    rejectedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Per-pool persistence signal cache
const poolSignalCache = new Map<string, {
    signals: PersistenceSignals;
    lastUpdate: number;
}>();

// Per-pool cooldown tracking (prevents mirage pool re-evaluation)
const poolCooldowns = new Map<string, PoolCooldown>();

// Per-cycle stats
const cycleStats: PersistenceStats = {
    totalEvaluations: 0,
    passes: 0,
    rejects: 0,
    rejectsByReason: {
        INSUFFICIENT_SNAPSHOTS: 0,
        EV_STREAK_BELOW_MIN: 0,
        FI_STREAK_BELOW_MIN: 0,
        HALFLIFE_LT_AMORTIZATION: 0,
        REGIME_UNSTABLE: 0,
        STALE_DATA: 0,
        SYNTHETIC_TIMESTAMPS: 0,
        COOLDOWN_ACTIVE: 0,
    },
    avgHalfLifeSec: 0,
    avgAmortizationSec: 0,
    tier5Relaxations: 0,
    cooldownSkips: 0,
    activeCooldowns: 0,
};

// For running averages
let totalHalfLifeSec = 0;
let totalAmortizationSec = 0;

// Log rate limiting
const lastLogTime = new Map<string, number>();
const LOG_RATE_LIMIT_MS = 60_000;

// ═══════════════════════════════════════════════════════════════════════════════
// COOLDOWN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get cooldown duration for a reject reason
 */
function getCooldownDuration(reason: PEPFBlockReason): number {
    switch (reason) {
        case 'HALFLIFE_LT_AMORTIZATION':
            return PEPF_CONFIG.cooldownHalfLifeMs;
        case 'EV_STREAK_BELOW_MIN':
            return PEPF_CONFIG.cooldownEvStreakMs;
        case 'FI_STREAK_BELOW_MIN':
            return PEPF_CONFIG.cooldownFiStreakMs;
        default:
            return 0; // No cooldown for other reasons
    }
}

/**
 * Check if a pool is currently in cooldown
 */
function isPoolInCooldown(poolAddress: string): { inCooldown: boolean; remainingMs: number; reason?: PEPFBlockReason } {
    const cooldown = poolCooldowns.get(poolAddress);
    if (!cooldown) {
        return { inCooldown: false, remainingMs: 0 };
    }
    
    const now = Date.now();
    if (now >= cooldown.cooldownUntil) {
        // Cooldown expired, remove it
        poolCooldowns.delete(poolAddress);
        return { inCooldown: false, remainingMs: 0 };
    }
    
    return { 
        inCooldown: true, 
        remainingMs: cooldown.cooldownUntil - now,
        reason: cooldown.reason 
    };
}

/**
 * Set cooldown for a pool after rejection
 */
function setPoolCooldown(poolAddress: string, reason: PEPFBlockReason): void {
    // Only set cooldown for triggering reasons
    if (!COOLDOWN_TRIGGERING_REASONS.includes(reason)) {
        return;
    }
    
    const duration = getCooldownDuration(reason);
    if (duration <= 0) {
        return;
    }
    
    const now = Date.now();
    poolCooldowns.set(poolAddress, {
        reason,
        cooldownUntil: now + duration,
        rejectedAt: now,
    });
    
    logger.debug(
        `[PEPF-COOLDOWN] pool=${poolAddress.slice(0, 8)}... ` +
        `reason=${reason} duration=${Math.floor(duration / 60000)}min`
    );
}

/**
 * Get count of active cooldowns
 */
function getActiveCooldownCount(): number {
    const now = Date.now();
    let count = 0;
    for (const cooldown of poolCooldowns.values()) {
        if (cooldown.cooldownUntil > now) {
            count++;
        }
    }
    return count;
}

/**
 * Clear expired cooldowns (maintenance)
 */
function clearExpiredCooldowns(): void {
    const now = Date.now();
    for (const [addr, cooldown] of poolCooldowns.entries()) {
        if (cooldown.cooldownUntil <= now) {
            poolCooldowns.delete(addr);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Winsorize a value to limit outliers using z-score bounds
 */
function winsorize(values: number[], zMax: number = PEPF_CONFIG.winsorZMax): number[] {
    if (values.length < 3) return values;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stddev = Math.sqrt(variance) || 1;
    
    const lowerBound = mean - zMax * stddev;
    const upperBound = mean + zMax * stddev;
    
    return values.map(v => Math.max(lowerBound, Math.min(upperBound, v)));
}

/**
 * Compute exponential decay half-life from a time series
 * Uses simple linear regression on log-transformed values
 * Returns half-life in seconds
 */
function computeEdgeHalfLife(
    evValues: number[],
    intervalSec: number = 120 // Default 2 min intervals
): number {
    // Need at least 6 values for meaningful fit
    if (evValues.length < 6) {
        return 0;
    }
    
    // Take last K values (6-10)
    const K = Math.min(10, evValues.length);
    const recentEV = evValues.slice(-K);
    
    // Winsorize to handle outliers
    const winsorizedEV = winsorize(recentEV);
    
    // Filter to positive values only (can't log negative)
    const positiveEV = winsorizedEV.filter(v => v > 0);
    if (positiveEV.length < 4) {
        // Not enough positive values - edge is likely already decayed
        return 0;
    }
    
    // Log-transform for exponential fit
    const logEV = positiveEV.map(v => Math.log(v));
    const n = logEV.length;
    
    // Simple linear regression: ln(y) = a + b*t
    // where b is the decay rate
    const times = Array.from({ length: n }, (_, i) => i * intervalSec);
    const sumT = times.reduce((a, b) => a + b, 0);
    const sumLogEV = logEV.reduce((a, b) => a + b, 0);
    const sumT2 = times.reduce((a, b) => a + b * b, 0);
    const sumTLogEV = times.reduce((sum, t, i) => sum + t * logEV[i], 0);
    
    const denominator = n * sumT2 - sumT * sumT;
    if (Math.abs(denominator) < 1e-10) {
        // Perfect horizontal line or insufficient variance
        return Infinity; // No decay
    }
    
    const b = (n * sumTLogEV - sumT * sumLogEV) / denominator;
    
    // Half-life = ln(2) / |b|
    // Negative b means decay (what we expect)
    // Positive b means growth (edge getting stronger)
    if (b >= 0) {
        // Edge is growing or stable - no decay
        return Infinity;
    }
    
    const halfLife = Math.log(2) / Math.abs(b);
    
    // Sanity bounds: 30 seconds to 24 hours
    return Math.max(30, Math.min(86400, halfLife));
}

/**
 * Compute expected amortization time in seconds
 */
function computeAmortizationSec(
    evResult: EVResult,
    windowSec: number = 60 // Scan interval window, fallback 60s
): number {
    const expectedTotalCostsUSD = evResult.costBreakdown.totalCostsUSD;
    const expectedFeeUSD = evResult.expectedFeeRevenueUSD;
    const holdTimeHours = evResult.holdTimeHours;
    const windowSecActual = holdTimeHours * 3600;
    
    // Fee rate in USD per second
    const expectedFeeRateUsdPerSec = expectedFeeUSD / Math.max(windowSecActual, windowSec);
    
    // Amortization time = total costs / fee rate
    const epsilon = 1e-10;
    const amortizationSec = expectedTotalCostsUSD / Math.max(expectedFeeRateUsdPerSec, epsilon);
    
    return amortizationSec;
}

/**
 * Count consecutive positive values from the end of an array
 */
function countStreak(values: number[], threshold: number = 0): number {
    let streak = 0;
    for (let i = values.length - 1; i >= 0; i--) {
        if (values[i] >= threshold) {
            streak++;
        } else {
            break;
        }
    }
    return streak;
}

/**
 * Check for synthetic/stale timestamps
 */
function checkTimestampQuality(
    history: DLMMTelemetry[],
    maxStalenessMs: number,
    maxSyntheticPct: number
): { valid: boolean; reason?: string; repeatedPct: number } {
    if (history.length < 2) {
        return { valid: false, reason: 'insufficient history', repeatedPct: 0 };
    }
    
    const now = Date.now();
    const lastTs = history[history.length - 1].fetchedAt;
    
    // Check staleness
    if (now - lastTs > maxStalenessMs) {
        return { 
            valid: false, 
            reason: `stale data: ${Math.floor((now - lastTs) / 1000)}s > ${maxStalenessMs / 1000}s`,
            repeatedPct: 0 
        };
    }
    
    // Check for repeated timestamps
    let repeatedCount = 0;
    for (let i = 1; i < history.length; i++) {
        if (history[i].fetchedAt === history[i - 1].fetchedAt) {
            repeatedCount++;
        }
    }
    const repeatedPct = repeatedCount / (history.length - 1);
    
    if (repeatedPct > maxSyntheticPct) {
        return { 
            valid: false, 
            reason: `synthetic timestamps: ${(repeatedPct * 100).toFixed(0)}% > ${maxSyntheticPct * 100}%`,
            repeatedPct 
        };
    }
    
    return { valid: true, repeatedPct };
}

/**
 * Compute persistence signals from pool history
 * 
 * Note: DLMMTelemetry contains raw snapshot data without microMetrics.
 * We derive fee intensity proxy from velocity which correlates with fee activity.
 */
function computePersistenceSignals(
    poolAddress: string,
    poolName: string,
    evResult: EVResult,
    pool: Tier4EnrichedPool
): PersistenceSignals | { error: PEPFBlockReason; detail: string } {
    const history = getPoolHistory(poolAddress);
    
    // Check minimum snapshots
    if (history.length < PEPF_CONFIG.minSnapshots) {
        return { 
            error: 'INSUFFICIENT_SNAPSHOTS', 
            detail: `${history.length} < ${PEPF_CONFIG.minSnapshots} required` 
        };
    }
    
    // Check timestamp quality
    const tsCheck = checkTimestampQuality(
        history, 
        PEPF_CONFIG.maxStalenessMs, 
        PEPF_CONFIG.maxSyntheticTimestampPct
    );
    if (!tsCheck.valid) {
        const reason = tsCheck.reason?.includes('stale') ? 'STALE_DATA' : 'SYNTHETIC_TIMESTAMPS';
        return { error: reason, detail: tsCheck.reason || 'unknown' };
    }
    
    // Take last N snapshots
    const recentHistory = history.slice(-20);
    
    // Derive fee intensity proxy from velocity
    // Velocity (bins/sec) correlates with trading activity and thus fee generation
    // Normalize velocity to 0-1 scale (typical range 0-0.5)
    const feeIntensityHistory = recentHistory.map(h => {
        const velocity = h.velocity ?? 0;
        // Convert velocity to fee intensity proxy (higher velocity = higher fee intensity)
        // Typical velocity range is 0-0.3, normalize to match minFeeIntensity scale
        return Math.min(1.0, velocity / 0.3);
    });
    
    // Estimate EV for each snapshot (simplified)
    // Use velocity as proxy for fee intensity in EV estimation
    const evHistory: number[] = [];
    const positionShare = pool.liquidity > 0 ? evResult.positionSizeUSD / pool.liquidity : 0;
    const baseFeeRate = pool.binStep ? pool.binStep / 10000 : 0.002;
    
    for (const snapshot of recentHistory) {
        const velocity = snapshot.velocity ?? 0;
        // Estimate fee intensity from velocity (velocity correlates with volume)
        // Higher velocity means more bin movement = more trading = more fees
        const estimatedFeeIntensity = Math.min(0.1, velocity * 0.2);
        // Rough EV estimate: feeIntensity * hold time * position share * pool liquidity - costs
        const estimatedFeeRevenue = estimatedFeeIntensity * evResult.holdTimeHours * 3600 * positionShare * (snapshot.liquidityUSD || pool.liquidity);
        const estimatedEV = estimatedFeeRevenue - evResult.costBreakdown.totalCostsUSD;
        evHistory.push(estimatedEV);
    }
    
    // Compute streaks
    const evStreak = countStreak(evHistory, 0);
    const feeIntensityStreak = countStreak(feeIntensityHistory, PEPF_CONFIG.minFeeIntensity);
    
    // Compute edge half-life
    const avgIntervalMs = recentHistory.length >= 2 
        ? (recentHistory[recentHistory.length - 1].fetchedAt - recentHistory[0].fetchedAt) / (recentHistory.length - 1)
        : 120000; // Default 2 min
    const intervalSec = avgIntervalMs / 1000;
    const edgeHalfLifeSec = computeEdgeHalfLife(evHistory, intervalSec);
    
    // Compute amortization
    const expectedAmortizationSec = computeAmortizationSec(evResult);
    const expectedFeeRateUsdPerSec = evResult.expectedFeeRevenueUSD / (evResult.holdTimeHours * 3600);
    
    return {
        evStreak,
        feeIntensityStreak,
        edgeHalfLifeSec,
        expectedAmortizationSec,
        expectedFeeRateUsdPerSec,
        snapshotsUsed: recentHistory.length,
        evHistory,
        feeIntensityHistory,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate pre-entry persistence for a candidate pool.
 * 
 * This is called AFTER EV gate passes but BEFORE Tier-5 processing.
 * If PEPF fails, the entry is skipped (no aggression escalation, no tranche adds).
 */
export function evaluatePreEntryPersistence(
    ctx: PreEntryPersistenceContext
): PreEntryPersistenceResult {
    const now = Date.now();
    const { pool, evResult, regime } = ctx;
    const poolAddress = pool.address;
    const poolName = pool.name;
    
    cycleStats.totalEvaluations++;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK IF PEPF IS ENABLED
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (!ENABLE_PEPF) {
        return buildPassResult(ctx, buildDefaultSignals(), false);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK COOLDOWN STATUS (MIRAGE POOL PROTECTION)
    // Pools recently rejected for HALFLIFE or EV_STREAK issues are on cooldown
    // ═══════════════════════════════════════════════════════════════════════════
    
    const cooldownStatus = isPoolInCooldown(poolAddress);
    if (cooldownStatus.inCooldown) {
        cycleStats.rejects++;
        cycleStats.rejectsByReason.COOLDOWN_ACTIVE++;
        cycleStats.cooldownSkips++;
        
        const remainingMin = Math.ceil(cooldownStatus.remainingMs / 60000);
        const detail = `${cooldownStatus.reason} cooldown, ${remainingMin}min remaining`;
        
        // Log with rate limiting (don't spam for every cycle)
        const lastLog = lastLogTime.get(`cooldown_${poolAddress}`) || 0;
        if (now - lastLog >= LOG_RATE_LIMIT_MS) {
            logger.info(`[PEPF-COOLDOWN] pool=${poolName} reason=${cooldownStatus.reason} remaining=${remainingMin}min`);
            lastLogTime.set(`cooldown_${poolAddress}`, now);
        }
        
        return buildRejectResult(ctx, buildDefaultSignals(), 'COOLDOWN_ACTIVE', detail);
    }
    
    // Update active cooldown count for stats
    cycleStats.activeCooldowns = getActiveCooldownCount();
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE PERSISTENCE SIGNALS
    // ═══════════════════════════════════════════════════════════════════════════
    
    const signalsResult = computePersistenceSignals(poolAddress, poolName, evResult, pool);
    
    if ('error' in signalsResult) {
        cycleStats.rejects++;
        cycleStats.rejectsByReason[signalsResult.error]++;
        
        logReject(poolAddress, poolName, signalsResult.error, signalsResult.detail, buildDefaultSignals());
        
        return buildRejectResult(ctx, buildDefaultSignals(), signalsResult.error, signalsResult.detail);
    }
    
    const signals = signalsResult;
    
    // Update running averages
    totalHalfLifeSec += signals.edgeHalfLifeSec === Infinity ? 86400 : signals.edgeHalfLifeSec;
    totalAmortizationSec += signals.expectedAmortizationSec;
    cycleStats.avgHalfLifeSec = totalHalfLifeSec / cycleStats.totalEvaluations;
    cycleStats.avgAmortizationSec = totalAmortizationSec / cycleStats.totalEvaluations;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DETERMINE THRESHOLDS (WITH TIER-5 RELAXATION)
    // ═══════════════════════════════════════════════════════════════════════════
    
    let minEvStreak = PEPF_CONFIG.minEvStreak;
    let minFiStreak = PEPF_CONFIG.minFiStreak;
    let amortizationMultiplier = PEPF_CONFIG.amortizationMultiplier;
    let tier5Relaxation = false;
    let relaxationReason: string | undefined;
    
    // Check for Tier-5 relaxation
    const aggressionLevel = ctx.aggressionLevel ?? getAggressionState(poolAddress)?.level ?? 'A0';
    const oddConfirmed = ctx.oddSpikeConfirmed ?? (hasActiveSpike(poolAddress) && isSpikeConfirmed(poolAddress));
    
    const isA2Plus = aggressionLevel === 'A2' || aggressionLevel === 'A3' || aggressionLevel === 'A4';
    
    if (isA2Plus && oddConfirmed) {
        // Apply Tier-5 relaxation
        minEvStreak = PEPF_CONFIG.tier5MinEvStreak;
        amortizationMultiplier = PEPF_CONFIG.tier5AmortizationMultiplier;
        tier5Relaxation = true;
        relaxationReason = `AEL=${aggressionLevel} + ODD spike confirmed`;
        cycleStats.tier5Relaxations++;
    }
    
    const requiredHalfLifeSec = signals.expectedAmortizationSec * amortizationMultiplier;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK REGIME STABILITY
    // ═══════════════════════════════════════════════════════════════════════════
    
    const regimeState = getCurrentRegimeState();
    const regimeStable = regimeState.consecutiveCycles >= 3 && 
                         (now - regimeState.regimeEnteredAt) >= 5 * 60 * 1000; // 5 min
    
    // Tier-5 relaxation allows unstable regime if A2+ with ODD
    const requireStableRegime = !(tier5Relaxation && isA2Plus && signals.evStreak >= 2);
    
    if (requireStableRegime && !regimeStable) {
        cycleStats.rejects++;
        cycleStats.rejectsByReason.REGIME_UNSTABLE++;
        
        const detail = `cycles=${regimeState.consecutiveCycles} time=${Math.floor((now - regimeState.regimeEnteredAt) / 1000)}s`;
        logReject(poolAddress, poolName, 'REGIME_UNSTABLE', detail, signals);
        
        return buildRejectResult(ctx, signals, 'REGIME_UNSTABLE', detail, tier5Relaxation, relaxationReason);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK PERSISTENCE CRITERIA
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Check EV streak
    if (signals.evStreak < minEvStreak) {
        cycleStats.rejects++;
        cycleStats.rejectsByReason.EV_STREAK_BELOW_MIN++;
        
        const detail = `${signals.evStreak} < ${minEvStreak} required`;
        logReject(poolAddress, poolName, 'EV_STREAK_BELOW_MIN', detail, signals);
        
        // Set cooldown to prevent mirage pool re-evaluation
        setPoolCooldown(poolAddress, 'EV_STREAK_BELOW_MIN');
        
        return buildRejectResult(ctx, signals, 'EV_STREAK_BELOW_MIN', detail, tier5Relaxation, relaxationReason);
    }
    
    // Check fee intensity streak
    if (signals.feeIntensityStreak < minFiStreak) {
        cycleStats.rejects++;
        cycleStats.rejectsByReason.FI_STREAK_BELOW_MIN++;
        
        const detail = `${signals.feeIntensityStreak} < ${minFiStreak} required`;
        logReject(poolAddress, poolName, 'FI_STREAK_BELOW_MIN', detail, signals);
        
        // Set cooldown to prevent mirage pool re-evaluation
        setPoolCooldown(poolAddress, 'FI_STREAK_BELOW_MIN');
        
        return buildRejectResult(ctx, signals, 'FI_STREAK_BELOW_MIN', detail, tier5Relaxation, relaxationReason);
    }
    
    // Check half-life vs amortization
    if (signals.edgeHalfLifeSec !== Infinity && signals.edgeHalfLifeSec < requiredHalfLifeSec) {
        cycleStats.rejects++;
        cycleStats.rejectsByReason.HALFLIFE_LT_AMORTIZATION++;
        
        const detail = `${signals.edgeHalfLifeSec.toFixed(0)}s < ${requiredHalfLifeSec.toFixed(0)}s (amort=${signals.expectedAmortizationSec.toFixed(0)}s × ${amortizationMultiplier})`;
        logReject(poolAddress, poolName, 'HALFLIFE_LT_AMORTIZATION', detail, signals);
        
        // Set cooldown to prevent mirage pool re-evaluation
        setPoolCooldown(poolAddress, 'HALFLIFE_LT_AMORTIZATION');
        
        return buildRejectResult(ctx, signals, 'HALFLIFE_LT_AMORTIZATION', detail, tier5Relaxation, relaxationReason);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ALL CHECKS PASSED
    // ═══════════════════════════════════════════════════════════════════════════
    
    cycleStats.passes++;
    
    logPass(poolAddress, poolName, signals, tier5Relaxation, aggressionLevel);
    
    // Cache signals
    poolSignalCache.set(poolAddress, { signals, lastUpdate: now });
    
    return buildPassResult(ctx, signals, tier5Relaxation, relaxationReason);
}

/**
 * Record persistence signal for a pool (for external tracking)
 */
export function recordPersistenceSignal(pool: string, signals: PersistenceSignals): void {
    poolSignalCache.set(pool, { signals, lastUpdate: Date.now() });
}

/**
 * Get persistence stats for current cycle
 */
export function getPersistenceStats(): PersistenceStats {
    return { ...cycleStats };
}

/**
 * Reset persistence stats (call at start of each cycle)
 */
export function resetPersistenceStats(): void {
    cycleStats.totalEvaluations = 0;
    cycleStats.passes = 0;
    cycleStats.rejects = 0;
    cycleStats.rejectsByReason = {
        INSUFFICIENT_SNAPSHOTS: 0,
        EV_STREAK_BELOW_MIN: 0,
        FI_STREAK_BELOW_MIN: 0,
        HALFLIFE_LT_AMORTIZATION: 0,
        REGIME_UNSTABLE: 0,
        STALE_DATA: 0,
        SYNTHETIC_TIMESTAMPS: 0,
        COOLDOWN_ACTIVE: 0,
    };
    cycleStats.avgHalfLifeSec = 0;
    cycleStats.avgAmortizationSec = 0;
    cycleStats.tier5Relaxations = 0;
    cycleStats.cooldownSkips = 0;
    cycleStats.activeCooldowns = getActiveCooldownCount();
    totalHalfLifeSec = 0;
    totalAmortizationSec = 0;
    
    // Cleanup expired cooldowns
    clearExpiredCooldowns();
}

/**
 * Get top reject reason from stats
 */
export function getTopRejectReason(stats: PersistenceStats): PEPFBlockReason | null {
    let topReason: PEPFBlockReason | null = null;
    let topCount = 0;
    
    for (const [reason, count] of Object.entries(stats.rejectsByReason)) {
        if (count > topCount) {
            topCount = count;
            topReason = reason as PEPFBlockReason;
        }
    }
    
    return topReason;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log PEPF rejection
 */
function logReject(
    poolAddress: string,
    poolName: string,
    reason: PEPFBlockReason,
    detail: string,
    signals: PersistenceSignals
): void {
    const now = Date.now();
    const lastLog = lastLogTime.get(`reject_${poolAddress}`) || 0;
    
    if (now - lastLog < LOG_RATE_LIMIT_MS) return;
    lastLogTime.set(`reject_${poolAddress}`, now);
    
    const aggressionState = getAggressionState(poolAddress);
    const ael = aggressionState?.level ?? 'A0';
    const oddStatus = hasActiveSpike(poolAddress) && isSpikeConfirmed(poolAddress) ? 'confirmed' : 'no';
    
    logger.info(
        `[PEPF-REJECT] pool=${poolName} reason=${reason} ` +
        `evStreak=${signals.evStreak} fiStreak=${signals.feeIntensityStreak} ` +
        `halfLife=${signals.edgeHalfLifeSec === Infinity ? 'INF' : signals.edgeHalfLifeSec.toFixed(0)}s ` +
        `amort=${signals.expectedAmortizationSec.toFixed(0)}s ` +
        `expFee=$${signals.expectedFeeRateUsdPerSec.toFixed(4)}/s ` +
        `ael=${ael} odd=${oddStatus} ` +
        `detail="${detail}"`
    );
}

/**
 * Log PEPF pass
 */
function logPass(
    poolAddress: string,
    poolName: string,
    signals: PersistenceSignals,
    tier5Relaxation: boolean,
    aggressionLevel: AggressionLevel
): void {
    const now = Date.now();
    const lastLog = lastLogTime.get(`pass_${poolAddress}`) || 0;
    
    if (now - lastLog < LOG_RATE_LIMIT_MS) return;
    lastLogTime.set(`pass_${poolAddress}`, now);
    
    const relaxStr = tier5Relaxation ? ' [T5-RELAX]' : '';
    
    logger.info(
        `[PEPF-PASS]${relaxStr} pool=${poolName} ` +
        `evStreak=${signals.evStreak} fiStreak=${signals.feeIntensityStreak} ` +
        `halfLife=${signals.edgeHalfLifeSec === Infinity ? 'INF' : signals.edgeHalfLifeSec.toFixed(0)}s ` +
        `amort=${signals.expectedAmortizationSec.toFixed(0)}s ` +
        `ael=${aggressionLevel}`
    );
}

/**
 * Log PEPF cycle summary
 */
export function logPersistenceSummary(stats: PersistenceStats = cycleStats): void {
    const topReason = getTopRejectReason(stats);
    
    logger.info(
        `[PEPF] summary passes=${stats.passes} rejects=${stats.rejects} ` +
        `topRejectReason=${topReason ?? 'none'} ` +
        `avgHalfLife=${stats.avgHalfLifeSec.toFixed(0)}s avgAmort=${stats.avgAmortizationSec.toFixed(0)}s ` +
        `tier5Relaxations=${stats.tier5Relaxations} ` +
        `cooldownSkips=${stats.cooldownSkips} activeCooldowns=${stats.activeCooldowns}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function buildDefaultSignals(): PersistenceSignals {
    return {
        evStreak: 0,
        feeIntensityStreak: 0,
        edgeHalfLifeSec: 0,
        expectedAmortizationSec: 0,
        expectedFeeRateUsdPerSec: 0,
        snapshotsUsed: 0,
        evHistory: [],
        feeIntensityHistory: [],
    };
}

function buildPassResult(
    ctx: PreEntryPersistenceContext,
    signals: PersistenceSignals,
    tier5Relaxation: boolean,
    relaxationReason?: string
): PreEntryPersistenceResult {
    const minEvStreak = tier5Relaxation ? PEPF_CONFIG.tier5MinEvStreak : PEPF_CONFIG.minEvStreak;
    const amortMult = tier5Relaxation ? PEPF_CONFIG.tier5AmortizationMultiplier : PEPF_CONFIG.amortizationMultiplier;
    
    return {
        pass: true,
        blocked: false,
        signals,
        requirements: {
            minEvStreak,
            minFiStreak: PEPF_CONFIG.minFiStreak,
            amortizationMultiplier: amortMult,
            requiredHalfLifeSec: signals.expectedAmortizationSec * amortMult,
        },
        tier5Relaxation,
        relaxationReason,
        poolAddress: ctx.pool.address,
        poolName: ctx.pool.name,
        timestamp: Date.now(),
    };
}

function buildRejectResult(
    ctx: PreEntryPersistenceContext,
    signals: PersistenceSignals,
    blockReason: PEPFBlockReason,
    blockReasonDetail: string,
    tier5Relaxation: boolean = false,
    relaxationReason?: string
): PreEntryPersistenceResult {
    const minEvStreak = tier5Relaxation ? PEPF_CONFIG.tier5MinEvStreak : PEPF_CONFIG.minEvStreak;
    const amortMult = tier5Relaxation ? PEPF_CONFIG.tier5AmortizationMultiplier : PEPF_CONFIG.amortizationMultiplier;
    
    return {
        pass: false,
        blocked: true,
        signals,
        requirements: {
            minEvStreak,
            minFiStreak: PEPF_CONFIG.minFiStreak,
            amortizationMultiplier: amortMult,
            requiredHalfLifeSec: signals.expectedAmortizationSec * amortMult,
        },
        blockReason,
        blockReasonDetail,
        tier5Relaxation,
        relaxationReason,
        poolAddress: ctx.pool.address,
        poolName: ctx.pool.name,
        timestamp: Date.now(),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEV MODE ASSERTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assert PEPF invariants (DEV_MODE only)
 * PEPF must never override KILL_SWITCH, FEE_BLEED defense, or RISK_EXIT logic
 */
export function assertPEPFInvariants(
    isKillSwitchActive: boolean,
    isFeeBleedDefenseActive: boolean,
    isRiskExit: boolean
): void {
    if (!DEV_MODE) return;
    
    // PEPF is entry-only - these should never be called during PEPF evaluation
    if (isKillSwitchActive) {
        logger.error('[PEPF-ASSERT] PEPF called while KILL_SWITCH active - this is a bug');
    }
    
    // Log warning if fee-bleed is active (PEPF should still work, but be aware)
    if (isFeeBleedDefenseActive) {
        logger.debug('[PEPF-ASSERT] PEPF evaluated while FEE_BLEED defense active');
    }
    
    // PEPF should never be called for exits
    if (isRiskExit) {
        const error = new Error('[PEPF-ASSERT] PEPF called during RISK_EXIT - PEPF is entry-only!');
        logger.error(error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clear all PEPF state (for testing)
 */
export function clearPEPFState(): void {
    poolSignalCache.clear();
    poolCooldowns.clear();
    lastLogTime.clear();
    resetPersistenceStats();
    logger.info('[PEPF] State cleared');
}

/**
 * Clear all cooldowns (useful for testing or manual intervention)
 */
export function clearAllCooldowns(): void {
    const count = poolCooldowns.size;
    poolCooldowns.clear();
    logger.info(`[PEPF] Cleared ${count} cooldowns`);
}

/**
 * Clear cooldown for a specific pool
 */
export function clearPoolCooldown(poolAddress: string): boolean {
    const existed = poolCooldowns.has(poolAddress);
    poolCooldowns.delete(poolAddress);
    if (existed) {
        logger.info(`[PEPF] Cleared cooldown for pool=${poolAddress.slice(0, 8)}...`);
    }
    return existed;
}

/**
 * Get cooldown status for a pool (public API)
 */
export function getPoolCooldownStatus(poolAddress: string): { 
    inCooldown: boolean; 
    remainingMs: number; 
    reason?: PEPFBlockReason;
    expiresAt?: number;
} {
    const status = isPoolInCooldown(poolAddress);
    const cooldown = poolCooldowns.get(poolAddress);
    return {
        ...status,
        expiresAt: cooldown?.cooldownUntil,
    };
}

/**
 * Get cached signals for a pool
 */
export function getCachedSignals(poolAddress: string): PersistenceSignals | null {
    const cached = poolSignalCache.get(poolAddress);
    if (!cached) return null;
    
    // Expire after 5 minutes
    if (Date.now() - cached.lastUpdate > 5 * 60 * 1000) {
        poolSignalCache.delete(poolAddress);
        return null;
    }
    
    return cached.signals;
}

