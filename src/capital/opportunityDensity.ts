/**
 * Opportunity Density Detector (ODD) — Tier 5 Controlled Aggression
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 5: MODULE A — OPPORTUNITY DENSITY DETECTION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Detect rare "edge density spikes" where DLMM fee capture dominates
 * costs and adverse selection risk is low.
 * 
 * INPUTS (from existing Tier-4 modules):
 *   - feeIntensity (from microMetrics)
 *   - volumeInRangeUSD (derivable from volume24h + TVL)
 *   - swapVelocity (from microMetrics)
 *   - binVelocity / migration slope (from momentum)
 *   - priceVelocity (derived from recent price snapshots)
 *   - EV breakdown (from EV module)
 *   - regime (from scoring)
 *   - telemetry snapshots (from dlmmTelemetry)
 * 
 * COMPUTATION:
 *   ODS = 0.35*z_feeIntensity + 0.30*z_volumeInRangeUSD + 0.20*z_binStability + 0.15*z_churnQuality
 * 
 * TRIGGER:
 *   - ODS >= 2.2
 *   - regime in {NEUTRAL, BULL}
 *   - EV gate positive
 *   - NOT in fee-bleed defense
 *   - Portfolio consistency healthy
 * 
 * OUTPUT:
 *   { ods, isSpike, reasons, components, ttlMs }
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';
import { Tier4EnrichedPool } from '../scoring/microstructureScoring';
import { getPoolHistory, DLMMTelemetry } from '../services/dlmmTelemetry';
import { isFeeBleedDefenseActive } from './feeBleedFailsafe';
import { isPortfolioConsistent } from './portfolioConsistency';
import { TIER5_CONFIG } from '../config/constants';
import { isBootstrapModeActive } from './feeVelocityGate';

// ═══════════════════════════════════════════════════════════════════════════════
// DEV MODE FLAG
// ═══════════════════════════════════════════════════════════════════════════════

const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ODD Configuration with justifications
 */
export const ODD_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // INPUT VALIDATION (TIER 5 HARDENING)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Minimum snapshots required before ODD is valid
     * Prevents synthetic spikes from tiny sample windows
     */
    minValidationSnapshots: 15,
    
    /**
     * Maximum staleness threshold (ms) for telemetry data
     * Rejects if last timestamp delta exceeds this
     */
    maxStalenessMs: 5 * 60 * 1000, // 5 minutes
    
    /**
     * Maximum z-score magnitude (winsorization)
     * Prevents single-burst domination
     */
    maxZScoreMagnitude: 4.0,
    
    /**
     * Consecutive cycles required for spike confirmation
     * ODS must be >= threshold for N consecutive cycles
     */
    sustainedConfirmationCycles: 2,
    
    /**
     * Maximum % of repeated identical timestamps allowed
     * Detects stale/synthetic telemetry
     */
    maxRepeatedTimestampPct: 0.3, // 30%
    
    // ═══════════════════════════════════════════════════════════════════════════
    // Z-SCORE NORMALIZATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Minimum snapshots required for z-score calculation
     * Justification: Need enough history for meaningful statistical analysis
     * 
     * REDUCED during bootstrap mode (5 instead of 30)
     */
    minSnapshotsForZScore: 30,
    
    /**
     * Minimum snapshots during BOOTSTRAP mode
     * Lower threshold allows faster cold-start
     */
    minSnapshotsForZScoreBootstrap: 5,
    
    /**
     * Maximum snapshots in rolling window (60-180 range)
     * Justification: 120 snapshots at 2-min intervals = 4 hours of history
     */
    maxSnapshotsInWindow: 120,
    
    /**
     * Default window size for new pools without history
     * Justification: Start with 60 snapshots = 2 hours minimum
     */
    defaultWindowSize: 60,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ODS COMPONENT WEIGHTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * ODS formula weights (DOCUMENTED)
     * ODS = 0.35*z_feeIntensity + 0.30*z_volumeInRangeUSD + 0.20*z_binStability + 0.15*z_churnQuality
     */
    weights: {
        feeIntensity: 0.35,
        volumeInRange: 0.30,
        binStability: 0.20,
        churnQuality: 0.15,
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SPIKE THRESHOLD
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Minimum ODS for spike detection
     * Justification: 2.2 sigma is rare (~1.4% of normal distribution)
     */
    spikeThreshold: 2.2,
    
    /**
     * Rare convergence ODS threshold (for A4 escalation)
     * Justification: 2.8 sigma is very rare (~0.3% of normal distribution)
     */
    rareConvergenceThreshold: 2.8,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TTL CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Default TTL for ODS spike (10-15 minutes)
     * Justification: Spikes are transient; 15 min default with decay
     */
    defaultTTLMs: 15 * 60 * 1000,
    
    /**
     * Minimum TTL after decay
     * Justification: Allow at least 5 minutes before full decay
     */
    minTTLMs: 5 * 60 * 1000,
    
    /**
     * ODS drop threshold for early decay (% drop from spike value)
     * Justification: If ODS drops 30%+, conditions have materially changed
     */
    decayDropThreshold: 0.30,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BIN STABILITY THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Maximum migration slope magnitude for "stable" classification
     * Justification: Low slope = bins not moving aggressively
     */
    maxStableMigrationSlope: 0.15,
    
    /**
     * Maximum bin velocity for "stable" classification
     * Justification: Low bin velocity = price range is stable
     */
    maxStableBinVelocity: 0.02,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LOGGING
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Rate limit for spike logs (ms between logs per pool)
     */
    logRateLimitMs: 60_000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Z-score normalized components
 */
export interface ODSComponents {
    z_feeIntensity: number;
    z_volumeInRangeUSD: number;
    z_binStability: number;
    z_churnQuality: number;
    
    // Raw values for debugging
    raw_feeIntensity: number;
    raw_volumeInRangeUSD: number;
    raw_binStability: number;
    raw_churnQuality: number;
    
    // Stats used for z-score
    mean_feeIntensity: number;
    stddev_feeIntensity: number;
}

/**
 * ODS evaluation result
 */
export interface ODSResult {
    // Core metrics
    ods: number;
    isSpike: boolean;
    
    // Components
    components: ODSComponents;
    
    // Reasons for spike (or why not)
    reasons: string[];
    
    // TTL
    ttlMs: number;
    expiresAt: number;
    
    // Eligibility checks
    regimeEligible: boolean;
    evPositive: boolean;
    feeBleedSafe: boolean;
    portfolioHealthy: boolean;
    allConditionsMet: boolean;
    
    // Metadata
    poolAddress: string;
    poolName: string;
    regime: MarketRegime;
    snapshotsUsed: number;
    timestamp: number;
}

/**
 * Rolling statistics for z-score computation
 */
interface RollingStats {
    values: number[];
    mean: number;
    stddev: number;
    count: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Per-pool rolling statistics for z-score calculation
const poolRollingStats = new Map<string, {
    feeIntensity: RollingStats;
    volumeInRange: RollingStats;
    binStability: RollingStats;
    churnQuality: RollingStats;
    lastUpdate: number;
    timestamps: number[]; // Track timestamps for staleness detection
}>();

// Active spikes with TTL
const activeSpikes = new Map<string, {
    ods: number;
    startedAt: number;
    expiresAt: number;
    peakOds: number;
}>();

// Sustained confirmation tracking
const sustainedConfirmation = new Map<string, {
    consecutiveAboveThreshold: number;
    lastODS: number;
    confirmed: boolean;
    confirmedAt: number;
}>();

// Logging rate limiter
const lastLogTime = new Map<string, number>();

// Tier 5 validation tracking
export interface ODDValidationStats {
    rejectsByReason: Map<string, number>;
    confirmedSpikes: number;
    totalEvaluations: number;
}

const validationStats: ODDValidationStats = {
    rejectsByReason: new Map(),
    confirmedSpikes: 0,
    totalEvaluations: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION (TIER 5 HARDENING)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ODD Input Validation Result
 */
export interface ODDValidationResult {
    valid: boolean;
    reason?: string;
    isSynthetic: boolean;
    isStale: boolean;
    snapshotCount: number;
    repeatedTimestampPct: number;
}

/**
 * Validate ODD inputs to prevent synthetic spikes.
 * 
 * Checks:
 * 1. Minimum snapshots (configurable)
 * 2. Staleness: reject if lastTsDelta > threshold
 * 3. Repeated identical timestamps (indicates stale data)
 * 4. Fallback/synthetic data detection
 */
export function validateODDInputs(
    poolAddress: string,
    feeIntensity: number,
    volumeInRangeUSD: number,
    microMetrics: any
): ODDValidationResult {
    const stats = poolRollingStats.get(poolAddress);
    const now = Date.now();
    
    // Check 1: Minimum snapshots
    const snapshotCount = stats?.feeIntensity.count ?? 0;
    if (snapshotCount < ODD_CONFIG.minValidationSnapshots) {
        const reason = `insufficient snapshots: ${snapshotCount} < ${ODD_CONFIG.minValidationSnapshots}`;
        recordODDReject(reason);
        return {
            valid: false,
            reason,
            isSynthetic: false,
            isStale: false,
            snapshotCount,
            repeatedTimestampPct: 0,
        };
    }
    
    // Check 2: Staleness
    const lastUpdate = stats?.lastUpdate ?? 0;
    const stalenessDelta = now - lastUpdate;
    if (stalenessDelta > ODD_CONFIG.maxStalenessMs) {
        const reason = `stale telemetry: ${Math.floor(stalenessDelta / 1000)}s > ${ODD_CONFIG.maxStalenessMs / 1000}s`;
        recordODDReject(reason);
        return {
            valid: false,
            reason,
            isSynthetic: false,
            isStale: true,
            snapshotCount,
            repeatedTimestampPct: 0,
        };
    }
    
    // Check 3: Repeated identical timestamps
    const timestamps = stats?.timestamps ?? [];
    let repeatedCount = 0;
    if (timestamps.length >= 2) {
        for (let i = 1; i < timestamps.length; i++) {
            if (timestamps[i] === timestamps[i - 1]) {
                repeatedCount++;
            }
        }
    }
    const repeatedPct = timestamps.length > 1 ? repeatedCount / (timestamps.length - 1) : 0;
    if (repeatedPct > ODD_CONFIG.maxRepeatedTimestampPct) {
        const reason = `repeated timestamps: ${(repeatedPct * 100).toFixed(0)}% > ${ODD_CONFIG.maxRepeatedTimestampPct * 100}%`;
        recordODDReject(reason);
        return {
            valid: false,
            reason,
            isSynthetic: true,
            isStale: false,
            snapshotCount,
            repeatedTimestampPct: repeatedPct,
        };
    }
    
    // Check 4: Fallback/synthetic data detection
    // feeIntensity of exactly 0 or volumeInRange of exactly 0 with snapshots suggests fallback
    const isFeeIntensityNaive = feeIntensity === 0 && snapshotCount > ODD_CONFIG.minValidationSnapshots;
    const isVolumeInRangeMissing = volumeInRangeUSD === 0 && snapshotCount > ODD_CONFIG.minValidationSnapshots;
    
    if (isFeeIntensityNaive && isVolumeInRangeMissing) {
        const reason = 'synthetic data: feeIntensity=0 AND volumeInRange=0 with sufficient snapshots';
        recordODDReject(reason);
        return {
            valid: false,
            reason,
            isSynthetic: true,
            isStale: false,
            snapshotCount,
            repeatedTimestampPct: repeatedPct,
        };
    }
    
    // Check 5: microMetrics existence
    if (!microMetrics) {
        const reason = 'missing microMetrics';
        recordODDReject(reason);
        return {
            valid: false,
            reason,
            isSynthetic: true,
            isStale: false,
            snapshotCount,
            repeatedTimestampPct: repeatedPct,
        };
    }
    
    return {
        valid: true,
        isSynthetic: false,
        isStale: false,
        snapshotCount,
        repeatedTimestampPct: repeatedPct,
    };
}

/**
 * Winsorize z-score to prevent extreme outliers
 */
function winsorizeZScore(z: number): number {
    const maxMag = ODD_CONFIG.maxZScoreMagnitude;
    return Math.max(-maxMag, Math.min(maxMag, z));
}

/**
 * Record ODD rejection for validation tracking
 */
function recordODDReject(reason: string): void {
    const category = reason.split(':')[0].trim();
    const current = validationStats.rejectsByReason.get(category) ?? 0;
    validationStats.rejectsByReason.set(category, current + 1);
}

/**
 * Update sustained confirmation state for a pool
 * Returns true if spike is confirmed (sustained for required cycles)
 */
function updateSustainedConfirmation(
    poolAddress: string,
    poolName: string,
    ods: number,
    meetsThreshold: boolean
): boolean {
    let state = sustainedConfirmation.get(poolAddress);
    
    if (!state) {
        state = {
            consecutiveAboveThreshold: 0,
            lastODS: 0,
            confirmed: false,
            confirmedAt: 0,
        };
        sustainedConfirmation.set(poolAddress, state);
    }
    
    if (meetsThreshold) {
        state.consecutiveAboveThreshold++;
        state.lastODS = ods;
        
        if (!state.confirmed && state.consecutiveAboveThreshold >= ODD_CONFIG.sustainedConfirmationCycles) {
            state.confirmed = true;
            state.confirmedAt = Date.now();
            validationStats.confirmedSpikes++;
            
            logger.info(
                `[ODD-CONFIRM] ✅ pool=${poolName} ods=${ods.toFixed(2)} ` +
                `sustained for ${state.consecutiveAboveThreshold} cycles → SPIKE ACTIVE`
            );
        }
    } else {
        // Reset if ODS drops below threshold
        if (state.confirmed) {
            logger.info(
                `[ODD-CONFIRM] ↓ pool=${poolName} ods=${ods.toFixed(2)} ` +
                `dropped below threshold → SPIKE ENDED`
            );
        }
        state.consecutiveAboveThreshold = 0;
        state.confirmed = false;
        state.confirmedAt = 0;
    }
    
    return state.confirmed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute rolling statistics for z-score normalization
 */
function computeRollingStats(values: number[]): RollingStats {
    const count = values.length;
    if (count === 0) {
        return { values: [], mean: 0, stddev: 1, count: 0 };
    }
    
    const mean = values.reduce((a, b) => a + b, 0) / count;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / count;
    const stddev = Math.sqrt(variance) || 1; // Avoid division by zero
    
    return { values, mean, stddev, count };
}

/**
 * Compute z-score with safe fallback
 * 
 * UPDATED: Uses lower snapshot threshold during bootstrap mode
 */
function computeZScore(value: number, stats: RollingStats): number {
    // Use lower threshold during bootstrap for faster cold-start
    const minSnapshots = isBootstrapModeActive() 
        ? ODD_CONFIG.minSnapshotsForZScoreBootstrap 
        : ODD_CONFIG.minSnapshotsForZScore;
    
    if (stats.count < minSnapshots || stats.stddev === 0) {
        // Not enough data or no variance - return neutral z-score
        return 0;
    }
    return (value - stats.mean) / stats.stddev;
}

/**
 * Update rolling statistics for a pool
 */
function updatePoolStats(
    poolAddress: string,
    feeIntensity: number,
    volumeInRange: number,
    binStability: number,
    churnQuality: number
): void {
    const now = Date.now();
    let stats = poolRollingStats.get(poolAddress);
    
    if (!stats) {
        stats = {
            feeIntensity: { values: [], mean: 0, stddev: 1, count: 0 },
            volumeInRange: { values: [], mean: 0, stddev: 1, count: 0 },
            binStability: { values: [], mean: 0, stddev: 1, count: 0 },
            churnQuality: { values: [], mean: 0, stddev: 1, count: 0 },
            lastUpdate: now,
            timestamps: [],
        };
    }
    
    // Add new values
    stats.feeIntensity.values.push(feeIntensity);
    stats.volumeInRange.values.push(volumeInRange);
    stats.binStability.values.push(binStability);
    stats.churnQuality.values.push(churnQuality);
    stats.timestamps.push(now);
    
    // Trim to max window size
    const maxLen = ODD_CONFIG.maxSnapshotsInWindow;
    if (stats.feeIntensity.values.length > maxLen) {
        stats.feeIntensity.values = stats.feeIntensity.values.slice(-maxLen);
        stats.volumeInRange.values = stats.volumeInRange.values.slice(-maxLen);
        stats.binStability.values = stats.binStability.values.slice(-maxLen);
        stats.churnQuality.values = stats.churnQuality.values.slice(-maxLen);
        stats.timestamps = stats.timestamps.slice(-maxLen);
    }
    
    // Recompute stats
    stats.feeIntensity = computeRollingStats(stats.feeIntensity.values);
    stats.volumeInRange = computeRollingStats(stats.volumeInRange.values);
    stats.binStability = computeRollingStats(stats.binStability.values);
    stats.churnQuality = computeRollingStats(stats.churnQuality.values);
    stats.lastUpdate = now;
    
    poolRollingStats.set(poolAddress, stats);
}

/**
 * Derive bin stability score
 * Higher = more stable (low migration slope, low bin velocity)
 */
function computeBinStability(
    migrationSlope: number,
    binVelocity: number
): number {
    // Normalize: 0 = unstable, 1 = very stable
    const slopeStability = Math.max(0, 1 - Math.abs(migrationSlope) / ODD_CONFIG.maxStableMigrationSlope);
    const binVelStability = Math.max(0, 1 - Math.abs(binVelocity) / ODD_CONFIG.maxStableBinVelocity);
    
    // Combined stability (weighted average)
    return slopeStability * 0.6 + binVelStability * 0.4;
}

/**
 * Compute churn quality
 * churnQuality = abs(swapVelocity) / max(priceVelocity, eps)
 * Higher = lots of swapping with low price drift
 */
function computeChurnQuality(
    swapVelocity: number,
    priceVelocity: number
): number {
    const eps = 0.0001; // Avoid division by zero
    const rawChurn = Math.abs(swapVelocity) / Math.max(Math.abs(priceVelocity), eps);
    
    // Normalize to reasonable range (0-10 typical, cap at 50)
    return Math.min(rawChurn, 50);
}

/**
 * Derive price velocity from recent price snapshots
 */
function derivePriceVelocity(poolAddress: string): number {
    const history = getPoolHistory(poolAddress);
    if (history.length < 2) {
        return 0;
    }
    
    // Get last 10 snapshots for velocity
    const recentHistory = history.slice(-10);
    if (recentHistory.length < 2) {
        return 0;
    }
    
    const firstSnapshot = recentHistory[0];
    const lastSnapshot = recentHistory[recentHistory.length - 1];
    
    // Derive price from active bin (approximate)
    // Price change per second
    const timeDeltaSec = (lastSnapshot.fetchedAt - firstSnapshot.fetchedAt) / 1000;
    if (timeDeltaSec <= 0) {
        return 0;
    }
    
    const binDelta = lastSnapshot.activeBin - firstSnapshot.activeBin;
    // Each bin step is roughly 0.01-0.5% price change depending on pool
    // Approximate as 0.1% per bin step
    const priceChangePct = binDelta * 0.001;
    
    return priceChangePct / timeDeltaSec; // Price velocity per second
}

/**
 * Compute Opportunity Density Score (ODS)
 */
export function computeODS(
    pool: Tier4EnrichedPool,
    evPositive: boolean
): ODSResult {
    const now = Date.now();
    const poolAddress = pool.address;
    const poolName = pool.name;
    const regime = pool.regime || 'NEUTRAL';
    
    // Track total evaluations
    validationStats.totalEvaluations++;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXTRACT RAW METRICS
    // ═══════════════════════════════════════════════════════════════════════════
    
    const microMetrics = pool.microMetrics;
    const feeIntensity = (microMetrics?.feeIntensity ?? 0) / 100; // Normalize from 0-100
    const swapVelocity = (microMetrics?.swapVelocity ?? 0) / 100;
    const binVelocity = (microMetrics?.binVelocity ?? 0) / 100;
    
    // Volume in range: use volume24h proportional to position share
    const poolTVL = pool.liquidity || 0;
    const volume24h = pool.volume24h || 0;
    const volumeInRangeUSD = poolTVL > 0 ? (volume24h / 24) : 0; // Hourly volume
    
    // Migration slope from pool data
    const migrationSlope = (pool as any).liquiditySlope ?? 0;
    
    // Derive price velocity
    const priceVelocity = derivePriceVelocity(poolAddress);
    
    // Compute derived metrics
    const binStability = computeBinStability(migrationSlope, binVelocity);
    const churnQuality = computeChurnQuality(swapVelocity, priceVelocity);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // UPDATE ROLLING STATS
    // ═══════════════════════════════════════════════════════════════════════════
    
    updatePoolStats(poolAddress, feeIntensity, volumeInRangeUSD, binStability, churnQuality);
    
    const stats = poolRollingStats.get(poolAddress)!;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 5 HARDENING: INPUT VALIDATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    const validation = validateODDInputs(poolAddress, feeIntensity, volumeInRangeUSD, microMetrics);
    
    if (!validation.valid) {
        // Log rejection with rate limiting
        const lastLog = lastLogTime.get(`reject_${poolAddress}`) || 0;
        if (now - lastLog >= ODD_CONFIG.logRateLimitMs) {
            logger.info(
                `[ODD-REJECT] pool=${poolName} reason=${validation.reason} ` +
                `snapshots=${validation.snapshotCount} synthetic=${validation.isSynthetic} stale=${validation.isStale}`
            );
            lastLogTime.set(`reject_${poolAddress}`, now);
        }
        
        // Return neutral ODS (no spike)
        return buildNeutralODSResult(pool, poolAddress, poolName, regime, stats, validation.reason || 'validation failed');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE Z-SCORES (WITH WINSORIZATION)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const z_feeIntensity = winsorizeZScore(computeZScore(feeIntensity, stats.feeIntensity));
    const z_volumeInRangeUSD = winsorizeZScore(computeZScore(volumeInRangeUSD, stats.volumeInRange));
    const z_binStability = winsorizeZScore(computeZScore(binStability, stats.binStability));
    const z_churnQuality = winsorizeZScore(computeZScore(churnQuality, stats.churnQuality));
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE ODS
    // ═══════════════════════════════════════════════════════════════════════════
    
    const { weights } = ODD_CONFIG;
    const ods = weights.feeIntensity * z_feeIntensity +
                weights.volumeInRange * z_volumeInRangeUSD +
                weights.binStability * z_binStability +
                weights.churnQuality * z_churnQuality;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK SPIKE CONDITIONS
    // ═══════════════════════════════════════════════════════════════════════════
    
    const reasons: string[] = [];
    
    // ODS threshold
    const meetsODSThreshold = ods >= ODD_CONFIG.spikeThreshold;
    if (meetsODSThreshold) {
        reasons.push(`ODS=${ods.toFixed(2)} >= ${ODD_CONFIG.spikeThreshold}`);
    }
    
    // Regime check
    const regimeEligible = regime === 'NEUTRAL' || regime === 'BULL';
    if (!regimeEligible) {
        reasons.push(`regime=${regime} not eligible (need NEUTRAL/BULL)`);
    }
    
    // EV check (passed in)
    if (!evPositive) {
        reasons.push('EV not positive');
    }
    
    // Fee-bleed defense check
    const feeBleedSafe = !isFeeBleedDefenseActive();
    if (!feeBleedSafe) {
        reasons.push('fee-bleed defense active');
    }
    
    // Portfolio consistency check
    const portfolioHealthy = isPortfolioConsistent();
    if (!portfolioHealthy) {
        reasons.push('portfolio inconsistent');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 5 HARDENING: SUSTAINED CONFIRMATION
    // Spike requires ODS >= threshold for N consecutive cycles
    // ═══════════════════════════════════════════════════════════════════════════
    
    const baseConditionsMet = meetsODSThreshold && regimeEligible && evPositive && feeBleedSafe && portfolioHealthy;
    
    // Update sustained confirmation tracking
    const isSustained = updateSustainedConfirmation(poolAddress, poolName, ods, baseConditionsMet);
    
    // Only allow spike if sustained confirmation achieved
    const allConditionsMet = baseConditionsMet && isSustained;
    const isSpike = allConditionsMet;
    
    // Add sustained status to reasons
    if (baseConditionsMet && !isSustained) {
        const confirmState = sustainedConfirmation.get(poolAddress);
        reasons.push(`awaiting sustained confirmation: ${confirmState?.consecutiveAboveThreshold ?? 0}/${ODD_CONFIG.sustainedConfirmationCycles} cycles`);
    } else if (isSustained) {
        reasons.push('sustained confirmation achieved');
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TTL MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════
    
    let ttlMs = ODD_CONFIG.defaultTTLMs;
    let expiresAt = now + ttlMs;
    
    // Check for existing spike and decay
    const existingSpike = activeSpikes.get(poolAddress);
    if (existingSpike) {
        if (isSpike) {
            // Update peak ODS if higher
            if (ods > existingSpike.peakOds) {
                existingSpike.peakOds = ods;
            }
            
            // Check for decay (ODS dropped significantly from peak)
            const dropFromPeak = (existingSpike.peakOds - ods) / existingSpike.peakOds;
            if (dropFromPeak >= ODD_CONFIG.decayDropThreshold) {
                // Accelerate decay
                ttlMs = Math.max(ODD_CONFIG.minTTLMs, existingSpike.expiresAt - now - 5 * 60 * 1000);
                expiresAt = now + ttlMs;
                reasons.push(`decay: ODS dropped ${(dropFromPeak * 100).toFixed(0)}% from peak`);
            } else {
                // Maintain existing expiry
                expiresAt = existingSpike.expiresAt;
                ttlMs = expiresAt - now;
            }
        } else {
            // Spike ended
            activeSpikes.delete(poolAddress);
            ttlMs = 0;
            expiresAt = now;
        }
    } else if (isSpike) {
        // New spike
        activeSpikes.set(poolAddress, {
            ods,
            startedAt: now,
            expiresAt,
            peakOds: ods,
        });
    }
    
    // Cleanup expired spikes
    for (const [addr, spike] of activeSpikes.entries()) {
        if (spike.expiresAt <= now) {
            activeSpikes.delete(addr);
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BUILD RESULT
    // ═══════════════════════════════════════════════════════════════════════════
    
    const components: ODSComponents = {
        z_feeIntensity,
        z_volumeInRangeUSD,
        z_binStability,
        z_churnQuality,
        
        raw_feeIntensity: feeIntensity,
        raw_volumeInRangeUSD: volumeInRangeUSD,
        raw_binStability: binStability,
        raw_churnQuality: churnQuality,
        
        mean_feeIntensity: stats.feeIntensity.mean,
        stddev_feeIntensity: stats.feeIntensity.stddev,
    };
    
    const result: ODSResult = {
        ods,
        isSpike,
        components,
        reasons,
        ttlMs,
        expiresAt,
        regimeEligible,
        evPositive,
        feeBleedSafe,
        portfolioHealthy,
        allConditionsMet,
        poolAddress,
        poolName,
        regime,
        snapshotsUsed: stats.feeIntensity.count,
        timestamp: now,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LOGGING (RATE LIMITED)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const lastLog = lastLogTime.get(poolAddress) || 0;
    if (now - lastLog >= ODD_CONFIG.logRateLimitMs) {
        if (isSpike) {
            logger.info(
                `[ODD] ⚡ spike pool=${poolName} ods=${ods.toFixed(2)} ttl=${Math.floor(ttlMs / 1000)}s ` +
                `comps={fee:${z_feeIntensity.toFixed(2)}, vol:${z_volumeInRangeUSD.toFixed(2)}, ` +
                `stability:${z_binStability.toFixed(2)}, churn:${z_churnQuality.toFixed(2)}} regime=${regime}`
            );
            lastLogTime.set(poolAddress, now);
        } else if (existingSpike && !isSpike) {
            // Log decay
            logger.info(
                `[ODD] decay pool=${poolName} ods=${ods.toFixed(2)} ` +
                `drop=${((existingSpike.peakOds - ods) / existingSpike.peakOds * 100).toFixed(0)}% -> disabling spike`
            );
            lastLogTime.set(poolAddress, now);
        }
    }
    
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a pool currently has an active spike
 */
export function hasActiveSpike(poolAddress: string): boolean {
    const spike = activeSpikes.get(poolAddress);
    if (!spike) return false;
    return spike.expiresAt > Date.now();
}

/**
 * Get active spike for a pool
 */
export function getActiveSpike(poolAddress: string): {
    ods: number;
    ttlRemainingMs: number;
    peakOds: number;
} | null {
    const spike = activeSpikes.get(poolAddress);
    if (!spike || spike.expiresAt <= Date.now()) {
        return null;
    }
    return {
        ods: spike.ods,
        ttlRemainingMs: spike.expiresAt - Date.now(),
        peakOds: spike.peakOds,
    };
}

/**
 * Get all active spikes
 */
export function getAllActiveSpikes(): Map<string, { ods: number; ttlRemainingMs: number }> {
    const now = Date.now();
    const result = new Map<string, { ods: number; ttlRemainingMs: number }>();
    
    for (const [addr, spike] of activeSpikes.entries()) {
        if (spike.expiresAt > now) {
            result.set(addr, {
                ods: spike.ods,
                ttlRemainingMs: spike.expiresAt - now,
            });
        }
    }
    
    return result;
}

/**
 * Check if ODS meets rare convergence threshold
 */
export function isRareConvergence(ods: number): boolean {
    return ods >= ODD_CONFIG.rareConvergenceThreshold;
}

/**
 * Get ODS stats summary
 */
export function getODSSummary(): {
    activeSpikes: number;
    poolsTracked: number;
} {
    const now = Date.now();
    let activeCount = 0;
    for (const spike of activeSpikes.values()) {
        if (spike.expiresAt > now) activeCount++;
    }
    
    return {
        activeSpikes: activeCount,
        poolsTracked: poolRollingStats.size,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clear all ODD state (for testing)
 */
export function clearODDState(): void {
    poolRollingStats.clear();
    activeSpikes.clear();
    lastLogTime.clear();
    sustainedConfirmation.clear();
    validationStats.rejectsByReason.clear();
    validationStats.confirmedSpikes = 0;
    validationStats.totalEvaluations = 0;
    logger.info('[ODD] State cleared');
}

/**
 * Force expire a spike (for testing/manual intervention)
 */
export function expireSpike(poolAddress: string): void {
    activeSpikes.delete(poolAddress);
}

/**
 * Build a neutral ODS result (no spike, used when validation fails)
 */
function buildNeutralODSResult(
    pool: Tier4EnrichedPool,
    poolAddress: string,
    poolName: string,
    regime: MarketRegime,
    stats: typeof poolRollingStats extends Map<string, infer V> ? V : never,
    reason: string
): ODSResult {
    const components: ODSComponents = {
        z_feeIntensity: 0,
        z_volumeInRangeUSD: 0,
        z_binStability: 0,
        z_churnQuality: 0,
        raw_feeIntensity: 0,
        raw_volumeInRangeUSD: 0,
        raw_binStability: 0,
        raw_churnQuality: 0,
        mean_feeIntensity: stats?.feeIntensity?.mean ?? 0,
        stddev_feeIntensity: stats?.feeIntensity?.stddev ?? 1,
    };
    
    return {
        ods: 0,
        isSpike: false,
        components,
        reasons: [reason],
        ttlMs: 0,
        expiresAt: Date.now(),
        regimeEligible: false,
        evPositive: false,
        feeBleedSafe: true,
        portfolioHealthy: true,
        allConditionsMet: false,
        poolAddress,
        poolName,
        regime,
        snapshotsUsed: stats?.feeIntensity?.count ?? 0,
        timestamp: Date.now(),
    };
}

/**
 * Get ODD validation statistics for Tier 5 validation summary
 */
export function getODDValidationStats(): {
    rejectsByReason: Record<string, number>;
    confirmedSpikes: number;
    totalEvaluations: number;
} {
    const rejectsByReason: Record<string, number> = {};
    for (const [reason, count] of validationStats.rejectsByReason.entries()) {
        rejectsByReason[reason] = count;
    }
    
    return {
        rejectsByReason,
        confirmedSpikes: validationStats.confirmedSpikes,
        totalEvaluations: validationStats.totalEvaluations,
    };
}

/**
 * Reset ODD validation stats (call at start of cycle for accurate per-cycle tracking)
 */
export function resetODDValidationStats(): void {
    validationStats.rejectsByReason.clear();
    validationStats.confirmedSpikes = 0;
    validationStats.totalEvaluations = 0;
}

/**
 * Check if spike is decaying (ODS dropped from peak)
 * Returns decay percentage (0 = no decay, 1 = fully decayed)
 */
export function getSpikeDecayPct(poolAddress: string): number {
    const spike = activeSpikes.get(poolAddress);
    if (!spike) return 1.0; // No spike = fully decayed
    
    if (spike.peakOds <= 0) return 0;
    
    const currentOds = spike.ods;
    const decay = (spike.peakOds - currentOds) / spike.peakOds;
    return Math.max(0, Math.min(1, decay));
}

/**
 * Check if sustained confirmation is active for a pool
 */
export function isSpikeConfirmed(poolAddress: string): boolean {
    const state = sustainedConfirmation.get(poolAddress);
    return state?.confirmed ?? false;
}

