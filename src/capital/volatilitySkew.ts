/**
 * Volatility Skew Harvester (VSH) — Tier 5 Controlled Aggression
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 5: MODULE D — VOLATILITY SKEW HARVESTING
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Harvest "churn" environments (high swapping, low directional move)
 * by providing adjustments for bin width and exit suppression.
 * 
 * ELIGIBILITY CONDITIONS (ALL must be true):
 *   - priceVelocity below threshold (flat price action)
 *   - swapVelocity above threshold (active trading)
 *   - migration slope magnitude below threshold (no directional flow)
 *   - feeIntensity rising or above minimum
 *   - EV positive
 *   - NOT under kill-switch
 *   - NOT under fee-bleed defense (or if active, VSH can only REDUCE risk)
 * 
 * OUTPUTS:
 *   - binWidthMultiplier: wider when BEAR/neutral chop, narrower for stable fee harvest
 *   - exitSuppressionHint: advisory only - HOLD module decides
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';
import { Tier4EnrichedPool } from '../scoring/microstructureScoring';
import { getPoolHistory, DLMMTelemetry } from '../services/dlmmTelemetry';
import { isFeeBleedDefenseActive } from './feeBleedFailsafe';
import { TIER5_CONFIG } from '../config/constants';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * VSH Configuration
 */
export const VSH_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // ELIGIBILITY THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Maximum price velocity for eligibility (% per second)
     * Below this = "flat" price action suitable for churn harvesting
     */
    maxPriceVelocity: 0.001, // 0.1% per second
    
    /**
     * Minimum swap velocity for eligibility (swaps per second, normalized)
     * Above this = "active" trading suitable for fee capture
     */
    minSwapVelocity: 0.08, // Normalized 0-1
    
    /**
     * Maximum migration slope magnitude for eligibility
     * Below this = no strong directional liquidity flow
     */
    maxMigrationSlope: 0.10,
    
    /**
     * Minimum fee intensity for eligibility (normalized 0-1)
     */
    minFeeIntensity: 0.05,
    
    /**
     * Fee intensity must be rising OR above this threshold
     */
    feeIntensityRisingThreshold: 0.10,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BIN WIDTH ADJUSTMENTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Bin width multiplier when VSH is harvesting in BEAR/neutral chop
     * Wider bins = more price tolerance, less rebalancing
     */
    binWidthMultiplierChop: 1.25,
    
    /**
     * Bin width multiplier when pure fee harvesting is stable
     * Narrower bins = tighter concentration, higher fee capture
     */
    binWidthMultiplierStable: 0.90,
    
    /**
     * Default bin width multiplier when not harvesting
     */
    binWidthMultiplierDefault: 1.00,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT SUPPRESSION HINTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Minimum churn quality for exit suppression hint
     * Higher churn = more active trading with low price drift
     */
    minChurnForSuppression: 2.0,
    
    /**
     * Types of exits that VSH suggests suppressing
     */
    suppressibleExitTypes: ['NOISE', 'MINOR_DECAY', 'SMALL_LOSS'] as const,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exit suppression hint type
 */
export type ExitSuppressionHint = 'NONE' | 'SUPPRESS_NOISE' | 'HOLD_FOR_CHURN';

/**
 * VSH eligibility result
 */
export interface VSHEligibility {
    eligible: boolean;
    reasons: string[];
    
    // Metrics that determined eligibility
    metrics: {
        priceVelocity: number;
        swapVelocity: number;
        migrationSlope: number;
        feeIntensity: number;
        feeIntensityRising: boolean;
        churnQuality: number;
    };
    
    // Threshold checks
    checks: {
        priceFlat: boolean;
        swapActive: boolean;
        migrationStable: boolean;
        feeHealthy: boolean;
        evPositive: boolean;
        killSwitchSafe: boolean;
        feeBleedSafe: boolean;
    };
}

/**
 * VSH adjustment output
 */
export interface VSHAdjustments {
    // Bin width multiplier
    binWidthMultiplier: number;
    
    // Exit suppression (advisory - HOLD module decides)
    exitSuppressionHint: ExitSuppressionHint;
    exitSuppressionReasons: string[];
    
    // State
    isHarvesting: boolean;
    harvestMode: 'CHOP' | 'STABLE' | 'NONE';
    
    // Eligibility
    eligibility: VSHEligibility;
    
    // Metadata
    poolAddress: string;
    poolName: string;
    regime: MarketRegime;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

// Track fee intensity history for "rising" detection
const feeIntensityHistory = new Map<string, { values: number[]; lastUpdate: number }>();
const MAX_FEE_HISTORY = 20;

// Track active harvesting pools
const activeHarvestingPools = new Set<string>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Derive price velocity from recent snapshots
 */
function derivePriceVelocity(poolAddress: string): number {
    const history = getPoolHistory(poolAddress);
    if (history.length < 2) return 0;
    
    const recentHistory = history.slice(-10);
    if (recentHistory.length < 2) return 0;
    
    const firstSnapshot = recentHistory[0];
    const lastSnapshot = recentHistory[recentHistory.length - 1];
    
    const timeDeltaSec = (lastSnapshot.fetchedAt - firstSnapshot.fetchedAt) / 1000;
    if (timeDeltaSec <= 0) return 0;
    
    const binDelta = lastSnapshot.activeBin - firstSnapshot.activeBin;
    // Approximate price change: each bin step ~0.1% price change
    const priceChangePct = Math.abs(binDelta) * 0.001;
    
    return priceChangePct / timeDeltaSec;
}

/**
 * Check if fee intensity is rising
 */
function isFeeIntensityRising(poolAddress: string, currentFeeIntensity: number): boolean {
    const now = Date.now();
    let history = feeIntensityHistory.get(poolAddress);
    
    if (!history) {
        history = { values: [], lastUpdate: now };
        feeIntensityHistory.set(poolAddress, history);
    }
    
    // Add current value
    history.values.push(currentFeeIntensity);
    history.lastUpdate = now;
    
    // Trim to max
    if (history.values.length > MAX_FEE_HISTORY) {
        history.values.shift();
    }
    
    // Need at least 3 values to determine trend
    if (history.values.length < 3) return false;
    
    // Compare current to average of first half
    const halfLen = Math.floor(history.values.length / 2);
    const oldAvg = history.values.slice(0, halfLen).reduce((a, b) => a + b, 0) / halfLen;
    const newAvg = history.values.slice(-halfLen).reduce((a, b) => a + b, 0) / halfLen;
    
    return newAvg > oldAvg * 1.05; // Rising if 5%+ higher
}

/**
 * Compute churn quality
 * Higher = lots of swapping with low price drift
 */
function computeChurnQuality(swapVelocity: number, priceVelocity: number): number {
    const eps = 0.0001;
    return Math.abs(swapVelocity) / Math.max(Math.abs(priceVelocity), eps);
}

/**
 * Evaluate VSH eligibility for a pool
 */
export function evaluateVSHEligibility(
    pool: Tier4EnrichedPool,
    evPositive: boolean,
    killSwitchActive: boolean = false
): VSHEligibility {
    const poolAddress = pool.address;
    const microMetrics = pool.microMetrics;
    
    // Extract metrics
    const swapVelocity = (microMetrics?.swapVelocity ?? 0) / 100; // Normalize from 0-100
    const feeIntensity = (microMetrics?.feeIntensity ?? 0) / 100; // Normalize from 0-100
    const migrationSlope = Math.abs((pool as any).liquiditySlope ?? 0);
    const priceVelocity = derivePriceVelocity(poolAddress);
    const feeRising = isFeeIntensityRising(poolAddress, feeIntensity);
    const churnQuality = computeChurnQuality(swapVelocity, priceVelocity);
    
    // Fee-bleed defense state
    const feeBleedActive = isFeeBleedDefenseActive();
    
    // Eligibility checks
    const priceFlat = priceVelocity <= VSH_CONFIG.maxPriceVelocity;
    const swapActive = swapVelocity >= VSH_CONFIG.minSwapVelocity;
    const migrationStable = migrationSlope <= VSH_CONFIG.maxMigrationSlope;
    const feeHealthy = feeIntensity >= VSH_CONFIG.minFeeIntensity || 
                       (feeRising && feeIntensity >= VSH_CONFIG.minFeeIntensity / 2);
    const killSwitchSafe = !killSwitchActive;
    const feeBleedSafe = !feeBleedActive; // If fee-bleed active, VSH can only reduce risk (handled elsewhere)
    
    const reasons: string[] = [];
    
    if (!priceFlat) reasons.push(`price velocity ${(priceVelocity * 100).toFixed(3)}% > ${(VSH_CONFIG.maxPriceVelocity * 100).toFixed(3)}%`);
    if (!swapActive) reasons.push(`swap velocity ${swapVelocity.toFixed(2)} < ${VSH_CONFIG.minSwapVelocity}`);
    if (!migrationStable) reasons.push(`migration slope ${migrationSlope.toFixed(2)} > ${VSH_CONFIG.maxMigrationSlope}`);
    if (!feeHealthy) reasons.push(`fee intensity ${feeIntensity.toFixed(2)} < ${VSH_CONFIG.minFeeIntensity}`);
    if (!evPositive) reasons.push('EV not positive');
    if (!killSwitchSafe) reasons.push('kill switch active');
    if (!feeBleedSafe) reasons.push('fee-bleed defense active');
    
    const eligible = priceFlat && swapActive && migrationStable && feeHealthy && 
                     evPositive && killSwitchSafe && feeBleedSafe;
    
    return {
        eligible,
        reasons,
        metrics: {
            priceVelocity,
            swapVelocity,
            migrationSlope,
            feeIntensity,
            feeIntensityRising: feeRising,
            churnQuality,
        },
        checks: {
            priceFlat,
            swapActive,
            migrationStable,
            feeHealthy,
            evPositive,
            killSwitchSafe,
            feeBleedSafe,
        },
    };
}

/**
 * Get VSH adjustments for a pool
 */
export function getVSHAdjustments(
    pool: Tier4EnrichedPool,
    evPositive: boolean,
    killSwitchActive: boolean = false
): VSHAdjustments {
    const now = Date.now();
    const poolAddress = pool.address;
    const poolName = pool.name;
    const regime = pool.regime || 'NEUTRAL';
    
    // Evaluate eligibility
    const eligibility = evaluateVSHEligibility(pool, evPositive, killSwitchActive);
    
    // Initialize outputs
    let binWidthMultiplier = VSH_CONFIG.binWidthMultiplierDefault;
    let exitSuppressionHint: ExitSuppressionHint = 'NONE';
    const exitSuppressionReasons: string[] = [];
    let isHarvesting = false;
    let harvestMode: 'CHOP' | 'STABLE' | 'NONE' = 'NONE';
    
    if (eligibility.eligible) {
        isHarvesting = true;
        activeHarvestingPools.add(poolAddress);
        
        // Determine harvest mode based on regime and conditions
        if (regime === 'BEAR' || regime === 'NEUTRAL') {
            // CHOP mode: wider bins for volatile/neutral conditions
            harvestMode = 'CHOP';
            binWidthMultiplier = VSH_CONFIG.binWidthMultiplierChop;
        } else {
            // STABLE mode: narrower bins for bullish stable conditions
            harvestMode = 'STABLE';
            binWidthMultiplier = VSH_CONFIG.binWidthMultiplierStable;
        }
        
        // Exit suppression hint based on churn quality
        if (eligibility.metrics.churnQuality >= VSH_CONFIG.minChurnForSuppression) {
            exitSuppressionHint = 'SUPPRESS_NOISE';
            exitSuppressionReasons.push(`churn quality ${eligibility.metrics.churnQuality.toFixed(2)} >= ${VSH_CONFIG.minChurnForSuppression}`);
        }
        
        // High fee intensity + rising = strong hold signal
        if (eligibility.metrics.feeIntensity >= VSH_CONFIG.feeIntensityRisingThreshold && 
            eligibility.metrics.feeIntensityRising) {
            exitSuppressionHint = 'HOLD_FOR_CHURN';
            exitSuppressionReasons.push('fee intensity rising above threshold');
        }
        
        // Log eligible state
        logger.info(
            `[VSH] eligible pool=${poolName} pv=${(eligibility.metrics.priceVelocity * 100).toFixed(3)}% ` +
            `sv=${eligibility.metrics.swapVelocity.toFixed(2)} mig=${eligibility.metrics.migrationSlope.toFixed(2)} ` +
            `feeInt=${eligibility.metrics.feeIntensity.toFixed(2)} ev=+ -> binMult=${binWidthMultiplier.toFixed(2)} ` +
            `exitHint=${exitSuppressionHint}`
        );
    } else {
        // Remove from active harvesting
        activeHarvestingPools.delete(poolAddress);
    }
    
    return {
        binWidthMultiplier,
        exitSuppressionHint,
        exitSuppressionReasons,
        isHarvesting,
        harvestMode,
        eligibility,
        poolAddress,
        poolName,
        regime,
        timestamp: now,
    };
}

/**
 * Check if pool is currently being harvested by VSH
 */
export function isVSHHarvesting(poolAddress: string): boolean {
    return activeHarvestingPools.has(poolAddress);
}

/**
 * Get VSH summary
 */
export function getVSHSummary(): {
    harvestingPools: number;
    poolAddresses: string[];
} {
    return {
        harvestingPools: activeHarvestingPools.size,
        poolAddresses: Array.from(activeHarvestingPools),
    };
}

/**
 * Clear all VSH state (for testing)
 */
export function clearVSHState(): void {
    feeIntensityHistory.clear();
    activeHarvestingPools.clear();
    logger.info('[VSH] State cleared');
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get combined bin width adjustment (for use with existing regime adjustments)
 */
export function getVSHBinWidthAdjustment(
    pool: Tier4EnrichedPool,
    evPositive: boolean,
    baseBinWidth: number,
    killSwitchActive: boolean = false
): number {
    const adjustments = getVSHAdjustments(pool, evPositive, killSwitchActive);
    return Math.round(baseBinWidth * adjustments.binWidthMultiplier);
}

/**
 * Check if VSH suggests suppressing a specific exit type
 * Returns true if suppression is suggested (HOLD module makes final decision)
 */
export function shouldVSHSuppressExit(
    poolAddress: string,
    exitType: string
): { suggest: boolean; reason: string } {
    if (!activeHarvestingPools.has(poolAddress)) {
        return { suggest: false, reason: 'pool not in VSH harvesting' };
    }
    
    // Check if exit type is suppressible
    const normalizedExitType = exitType.toUpperCase();
    const suppressible = VSH_CONFIG.suppressibleExitTypes.some(
        t => normalizedExitType.includes(t)
    );
    
    if (suppressible) {
        return { 
            suggest: true, 
            reason: `VSH harvesting suggests suppressing ${exitType}` 
        };
    }
    
    return { suggest: false, reason: 'exit type not suppressible by VSH' };
}

