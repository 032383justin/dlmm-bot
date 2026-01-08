/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BOOTSTRAP SCORING — ELIMINATES SCORE=0/MHI=0 DEADLOCK
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * On first-run or when no snapshots exist, this module computes a BOOTSTRAP_SCORE
 * derived from live metrics:
 *   - 24h Volume
 *   - TVL (liquidity depth)
 *   - Estimated swap activity proxy
 *   - Bin activity / spread proxy
 *   - Fee tier
 * 
 * This ensures:
 * 1. Avg MHI / Avg Score in logs are never stuck at 0
 * 2. Pools can be entered on first run
 * 3. Capital starts working immediately
 * 
 * Bootstrap scores are labeled [BOOTSTRAP] in logs to distinguish from
 * telemetry-derived scores.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    BOOTSTRAP_SCORING,
    FEE_BULLY_MODE_ENABLED,
    FEE_BULLY_TAGS,
} from '../config/feeBullyConfig';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BootstrapScoreInputs {
    poolAddress: string;
    poolName: string;
    volume24h: number;
    tvl: number;
    feeRate: number;      // e.g., 0.003 for 0.3%
    binStep: number;      // Bin step in basis points
    tokenX: string;
    tokenY: string;
}

export interface BootstrapScoreResult {
    score: number;
    isBootstrap: boolean;
    components: {
        volumeScore: number;
        tvlScore: number;
        feeRateScore: number;
        binStepScore: number;
        tokenQualityScore: number;
    };
    label: string;
}

export interface BootstrapMHIResult {
    mhi: number;
    isBootstrap: boolean;
    label: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLUE CHIP TOKENS — Get bonus for quality tokens
// ═══════════════════════════════════════════════════════════════════════════════

const BLUE_CHIP_TOKENS = new Set([
    'SOL', 'WSOL',
    'BTC', 'WBTC',
    'ETH', 'WETH',
    'USDC', 'USDT',
    'JLP', 'JUP',
    'JITOSOL', 'MSOL', 'BSOL',
    'RAY', 'ORCA',
]);

function isBlueChipToken(symbol: string): boolean {
    return BLUE_CHIP_TOKENS.has(symbol.toUpperCase());
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP SCORE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute bootstrap score from live metrics.
 * Used when no telemetry snapshots are available.
 */
export function computeBootstrapScore(inputs: BootstrapScoreInputs): BootstrapScoreResult {
    if (!BOOTSTRAP_SCORING.ENABLED) {
        return {
            score: 0,
            isBootstrap: false,
            components: {
                volumeScore: 0,
                tvlScore: 0,
                feeRateScore: 0,
                binStepScore: 0,
                tokenQualityScore: 0,
            },
            label: 'DISABLED',
        };
    }
    
    const weights = BOOTSTRAP_SCORING.WEIGHTS;
    const norms = BOOTSTRAP_SCORING.NORMALIZATION;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 1: Volume Score (25%)
    // Higher volume = more trading activity = more fees
    // ═══════════════════════════════════════════════════════════════════════════
    const volumeScore = Math.min(100, (inputs.volume24h / norms.VOLUME_24H_MAX) * 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 2: TVL Score (20%)
    // Higher TVL = better liquidity depth = more stable
    // ═══════════════════════════════════════════════════════════════════════════
    const tvlScore = Math.min(100, (inputs.tvl / norms.TVL_MAX) * 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 3: Fee Rate Score (25%)
    // Higher fee tier = more fee revenue per trade
    // ═══════════════════════════════════════════════════════════════════════════
    const feeRateScore = Math.min(100, (inputs.feeRate / norms.FEE_RATE_MAX) * 100);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 4: Bin Step Score (15%)
    // Tighter bin steps indicate more active, competitive pools
    // Optimal bin step is around 10-50 bps
    // ═══════════════════════════════════════════════════════════════════════════
    let binStepScore: number;
    if (inputs.binStep <= 10) {
        binStepScore = 100; // Very tight = very active
    } else if (inputs.binStep <= 25) {
        binStepScore = 90;
    } else if (inputs.binStep <= 50) {
        binStepScore = 75;
    } else if (inputs.binStep <= 100) {
        binStepScore = 50;
    } else {
        binStepScore = 25; // Wide bins = less active
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 5: Token Quality Score (15%)
    // Blue chip pairs get bonus for stability
    // ═══════════════════════════════════════════════════════════════════════════
    const isTokenXBlueChip = isBlueChipToken(inputs.tokenX);
    const isTokenYBlueChip = isBlueChipToken(inputs.tokenY);
    
    let tokenQualityScore: number;
    if (isTokenXBlueChip && isTokenYBlueChip) {
        tokenQualityScore = 100; // Both blue chip
    } else if (isTokenXBlueChip || isTokenYBlueChip) {
        tokenQualityScore = 70; // One blue chip
    } else {
        tokenQualityScore = 40; // No blue chips (meme pair)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // WEIGHTED COMPOSITE SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    const score = 
        volumeScore * weights.VOLUME_24H +
        tvlScore * weights.TVL +
        feeRateScore * weights.FEE_RATE +
        binStepScore * weights.BIN_STEP +
        tokenQualityScore * weights.TOKEN_QUALITY;
    
    return {
        score: Math.round(score),
        isBootstrap: true,
        components: {
            volumeScore: Math.round(volumeScore),
            tvlScore: Math.round(tvlScore),
            feeRateScore: Math.round(feeRateScore),
            binStepScore: Math.round(binStepScore),
            tokenQualityScore: Math.round(tokenQualityScore),
        },
        label: BOOTSTRAP_SCORING.LABEL,
    };
}

/**
 * Compute bootstrap MHI (Microstructure Health Index) from live metrics.
 * Used when no telemetry history exists.
 */
export function computeBootstrapMHI(inputs: BootstrapScoreInputs): BootstrapMHIResult {
    if (!BOOTSTRAP_SCORING.ENABLED) {
        return {
            mhi: 0,
            isBootstrap: false,
            label: 'DISABLED',
        };
    }
    
    // Bootstrap MHI is derived from bootstrap score
    // Normalize to 0-1 range (score is 0-100)
    const bootstrapScore = computeBootstrapScore(inputs);
    const mhi = bootstrapScore.score / 100;
    
    return {
        mhi: Math.min(1, Math.max(0, mhi)),
        isBootstrap: true,
        label: BOOTSTRAP_SCORING.LABEL,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AVERAGING UTILITIES — For non-zero Avg MHI / Avg Score logs
// ═══════════════════════════════════════════════════════════════════════════════

export interface PoolScoreData {
    poolAddress: string;
    score: number;
    isBootstrap: boolean;
}

/**
 * Calculate average score across pools, using bootstrap scores when needed.
 * Ensures the average is never stuck at 0.
 */
export function calculateAverageScore(pools: PoolScoreData[]): { avg: number; bootstrapCount: number; telemetryCount: number } {
    if (pools.length === 0) {
        return { avg: 0, bootstrapCount: 0, telemetryCount: 0 };
    }
    
    let sum = 0;
    let bootstrapCount = 0;
    let telemetryCount = 0;
    
    for (const pool of pools) {
        sum += pool.score;
        if (pool.isBootstrap) {
            bootstrapCount++;
        } else {
            telemetryCount++;
        }
    }
    
    return {
        avg: sum / pools.length,
        bootstrapCount,
        telemetryCount,
    };
}

/**
 * Log bootstrap scoring summary.
 */
export function logBootstrapSummary(
    avgScore: number,
    avgMHI: number,
    bootstrapCount: number,
    telemetryCount: number
): void {
    if (!FEE_BULLY_MODE_ENABLED) return;
    
    const totalPools = bootstrapCount + telemetryCount;
    const bootstrapPct = totalPools > 0 ? (bootstrapCount / totalPools * 100).toFixed(0) : '0';
    
    const label = bootstrapCount > 0 ? ` (${bootstrapPct}% ${BOOTSTRAP_SCORING.LABEL})` : '';
    
    logger.info(
        `${FEE_BULLY_TAGS.BOOTSTRAP} Avg Score: ${avgScore.toFixed(1)}${label} | ` +
        `Avg MHI: ${avgMHI.toFixed(3)} | ` +
        `pools: ${telemetryCount} telemetry + ${bootstrapCount} bootstrap`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY ELIGIBILITY WITH BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a pool meets minimum entry requirements.
 * Allows entry based on bootstrap score when no telemetry exists.
 */
export function meetsBootstrapEntryThreshold(
    hasValidTelemetry: boolean,
    telemetryScore: number,
    bootstrapScore: number
): { eligible: boolean; score: number; isBootstrap: boolean; reason: string } {
    // If we have valid telemetry, use telemetry score
    if (hasValidTelemetry && telemetryScore > 0) {
        return {
            eligible: telemetryScore >= BOOTSTRAP_SCORING.MIN_BOOTSTRAP_SCORE,
            score: telemetryScore,
            isBootstrap: false,
            reason: telemetryScore >= BOOTSTRAP_SCORING.MIN_BOOTSTRAP_SCORE 
                ? 'Telemetry score meets threshold'
                : `Telemetry score ${telemetryScore.toFixed(1)} < ${BOOTSTRAP_SCORING.MIN_BOOTSTRAP_SCORE}`,
        };
    }
    
    // Fall back to bootstrap score
    if (BOOTSTRAP_SCORING.ENABLED && bootstrapScore > 0) {
        return {
            eligible: bootstrapScore >= BOOTSTRAP_SCORING.MIN_BOOTSTRAP_SCORE,
            score: bootstrapScore,
            isBootstrap: true,
            reason: bootstrapScore >= BOOTSTRAP_SCORING.MIN_BOOTSTRAP_SCORE
                ? `Bootstrap score ${bootstrapScore} meets threshold`
                : `Bootstrap score ${bootstrapScore} < ${BOOTSTRAP_SCORING.MIN_BOOTSTRAP_SCORE}`,
        };
    }
    
    // No valid score available
    return {
        eligible: false,
        score: 0,
        isBootstrap: false,
        reason: 'No valid score (telemetry or bootstrap)',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    BOOTSTRAP_SCORING,
    BLUE_CHIP_TOKENS,
};

