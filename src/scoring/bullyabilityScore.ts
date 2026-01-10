/**
 * Bullyability Score — Predator Pool Ranking System
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREDATOR MODE: Rank pools by how "bullyable" they are for bin dominance
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * A pool is predator-eligible if ALL are true:
 *   - age_days >= 5
 *   - rolling_volume_24h >= MIN_VOL
 *   - bin_revisit_rate >= threshold
 *   - price_escape_ratio <= threshold
 *   - tvl <= MAX_TVL (avoid deep pro pools)
 * 
 * BULLY SCORE FORMULA:
 *   BullyScore = 
 *     (bin_reuse_rate * 0.35) +
 *     (fees_per_bin_per_min * 0.30) +
 *     (swap_density * 0.20) +
 *     (liquidity_fragmentation * 0.10) +
 *     (volatility_inside_range * 0.05)
 * 
 * ⚠️ Raw volume alone is insufficient.
 * We want volume that REVISITS the same bins.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const BULLY_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // ELIGIBILITY THRESHOLDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Minimum pool age in days */
    MIN_AGE_DAYS: 5,
    
    /** Minimum 24h volume (USD) */
    MIN_VOLUME_24H: 50_000,
    
    /** Maximum TVL - avoid deep pro pools */
    MAX_TVL: 500_000,
    
    /** Minimum bin revisit rate (0-1) */
    MIN_BIN_REVISIT_RATE: 0.30,
    
    /** Maximum price escape ratio (0-1) */
    MAX_PRICE_ESCAPE_RATIO: 0.40,
    
    /** Minimum bully score to qualify */
    MIN_BULLY_SCORE: 0.40,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SCORE COMPONENT WEIGHTS
    // ═══════════════════════════════════════════════════════════════════════════
    
    WEIGHTS: {
        binReuseRate: 0.35,
        feesPerBinPerMin: 0.30,
        swapDensity: 0.20,
        liquidityFragmentation: 0.10,
        volatilityInsideRange: 0.05,
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // NORMALIZATION BOUNDS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Max fees per bin per minute for normalization (USD) */
    MAX_FEES_PER_BIN_PER_MIN: 0.10,
    
    /** Max swap density for normalization (swaps/min) */
    MAX_SWAP_DENSITY: 5.0,
    
    /** Max liquidity fragmentation for normalization */
    MAX_LIQUIDITY_FRAG: 0.80,
    
    /** Max volatility inside range for normalization */
    MAX_VOL_INSIDE_RANGE: 0.30,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BullyInput {
    poolAddress: string;
    poolName: string;
    
    // Basic metrics
    ageDays: number;
    volume24h: number;
    tvl: number;
    fees24h: number;
    
    // Bin metrics
    activeBins: number;
    binStep: number;
    
    // Derived metrics (from telemetry)
    binReuseRate: number;       // % of swaps that revisit same bins
    priceEscapeRatio: number;   // % of time price escapes active range
    swapsPerMinute: number;
    volatilityPctPerHour: number;
    
    // Optional: more granular
    avgBinHoldTime?: number;    // seconds price stays in bin
    liquidityFragmentation?: number;  // 0-1, higher = more fragmented
}

export interface BullyResult {
    poolAddress: string;
    poolName: string;
    
    // Eligibility
    eligible: boolean;
    eligibilityReasons: string[];
    
    // Score components (normalized 0-1)
    components: {
        binReuseRate: number;
        feesPerBinPerMin: number;
        swapDensity: number;
        liquidityFragmentation: number;
        volatilityInsideRange: number;
    };
    
    // Final score
    bullyScore: number;
    
    // Classification
    tier: 'S' | 'A' | 'B' | 'C' | 'INELIGIBLE';
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE SCORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check pool eligibility for predator mode
 */
function checkEligibility(input: BullyInput): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];
    
    if (input.ageDays < BULLY_CONFIG.MIN_AGE_DAYS) {
        reasons.push(`age ${input.ageDays}d < ${BULLY_CONFIG.MIN_AGE_DAYS}d`);
    }
    
    if (input.volume24h < BULLY_CONFIG.MIN_VOLUME_24H) {
        reasons.push(`vol24h $${input.volume24h.toFixed(0)} < $${BULLY_CONFIG.MIN_VOLUME_24H}`);
    }
    
    if (input.tvl > BULLY_CONFIG.MAX_TVL) {
        reasons.push(`tvl $${input.tvl.toFixed(0)} > $${BULLY_CONFIG.MAX_TVL} (pro pool)`);
    }
    
    if (input.binReuseRate < BULLY_CONFIG.MIN_BIN_REVISIT_RATE) {
        reasons.push(`binReuse ${(input.binReuseRate * 100).toFixed(0)}% < ${(BULLY_CONFIG.MIN_BIN_REVISIT_RATE * 100).toFixed(0)}%`);
    }
    
    if (input.priceEscapeRatio > BULLY_CONFIG.MAX_PRICE_ESCAPE_RATIO) {
        reasons.push(`escapeRatio ${(input.priceEscapeRatio * 100).toFixed(0)}% > ${(BULLY_CONFIG.MAX_PRICE_ESCAPE_RATIO * 100).toFixed(0)}%`);
    }
    
    return {
        eligible: reasons.length === 0,
        reasons,
    };
}

/**
 * Normalize a value to 0-1 range
 */
function normalize(value: number, max: number): number {
    return Math.min(1.0, Math.max(0, value / max));
}

/**
 * Calculate Bullyability Score for a pool
 */
export function calculateBullyScore(input: BullyInput): BullyResult {
    const eligibility = checkEligibility(input);
    
    // Default result for ineligible pools
    if (!eligibility.eligible) {
        return {
            poolAddress: input.poolAddress,
            poolName: input.poolName,
            eligible: false,
            eligibilityReasons: eligibility.reasons,
            components: {
                binReuseRate: 0,
                feesPerBinPerMin: 0,
                swapDensity: 0,
                liquidityFragmentation: 0,
                volatilityInsideRange: 0,
            },
            bullyScore: 0,
            tier: 'INELIGIBLE',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CALCULATE COMPONENT SCORES
    // ═══════════════════════════════════════════════════════════════════════════
    
    // 1. Bin Reuse Rate (already 0-1)
    const binReuseScore = Math.min(1.0, input.binReuseRate);
    
    // 2. Fees per bin per minute
    const feesPerBin = input.activeBins > 0 ? input.fees24h / input.activeBins : 0;
    const feesPerBinPerMin = feesPerBin / (24 * 60);
    const feesPerBinScore = normalize(feesPerBinPerMin, BULLY_CONFIG.MAX_FEES_PER_BIN_PER_MIN);
    
    // 3. Swap density (swaps per minute)
    const swapDensityScore = normalize(input.swapsPerMinute, BULLY_CONFIG.MAX_SWAP_DENSITY);
    
    // 4. Liquidity fragmentation (higher = more fragmented = better for us)
    const fragmentation = input.liquidityFragmentation ?? (input.activeBins / 100);
    const fragScore = normalize(fragmentation, BULLY_CONFIG.MAX_LIQUIDITY_FRAG);
    
    // 5. Volatility inside range (lower escape = better)
    // Invert: higher inside-range time = higher score
    const volInsideRange = 1.0 - input.priceEscapeRatio;
    const volScore = volInsideRange;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPUTE WEIGHTED SCORE
    // ═══════════════════════════════════════════════════════════════════════════
    
    const { WEIGHTS } = BULLY_CONFIG;
    const bullyScore = 
        binReuseScore * WEIGHTS.binReuseRate +
        feesPerBinScore * WEIGHTS.feesPerBinPerMin +
        swapDensityScore * WEIGHTS.swapDensity +
        fragScore * WEIGHTS.liquidityFragmentation +
        volScore * WEIGHTS.volatilityInsideRange;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CLASSIFY TIER
    // ═══════════════════════════════════════════════════════════════════════════
    
    let tier: 'S' | 'A' | 'B' | 'C' | 'INELIGIBLE';
    if (bullyScore >= 0.75) {
        tier = 'S';
    } else if (bullyScore >= 0.60) {
        tier = 'A';
    } else if (bullyScore >= 0.45) {
        tier = 'B';
    } else if (bullyScore >= BULLY_CONFIG.MIN_BULLY_SCORE) {
        tier = 'C';
    } else {
        tier = 'INELIGIBLE';
    }
    
    const result: BullyResult = {
        poolAddress: input.poolAddress,
        poolName: input.poolName,
        eligible: bullyScore >= BULLY_CONFIG.MIN_BULLY_SCORE,
        eligibilityReasons: bullyScore < BULLY_CONFIG.MIN_BULLY_SCORE 
            ? [`bullyScore ${bullyScore.toFixed(2)} < ${BULLY_CONFIG.MIN_BULLY_SCORE}`] 
            : [],
        components: {
            binReuseRate: binReuseScore,
            feesPerBinPerMin: feesPerBinScore,
            swapDensity: swapDensityScore,
            liquidityFragmentation: fragScore,
            volatilityInsideRange: volScore,
        },
        bullyScore,
        tier,
    };
    
    // Log for validation
    if (result.eligible) {
        logger.info(
            `[PREDATOR-POOL] ${input.poolName} bullyScore=${bullyScore.toFixed(2)} tier=${tier} | ` +
            `binReuse=${(binReuseScore * 100).toFixed(0)}% fees/bin=${(feesPerBinScore * 100).toFixed(0)}% ` +
            `swapDens=${(swapDensityScore * 100).toFixed(0)}% frag=${(fragScore * 100).toFixed(0)}%`
        );
    }
    
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH SCORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Score and rank multiple pools by bullyability
 */
export function rankPoolsByBullyability(inputs: BullyInput[]): BullyResult[] {
    const results = inputs.map(calculateBullyScore);
    
    // Sort by bully score descending
    results.sort((a, b) => b.bullyScore - a.bullyScore);
    
    // Log summary
    const eligible = results.filter(r => r.eligible);
    const byTier = {
        S: eligible.filter(r => r.tier === 'S').length,
        A: eligible.filter(r => r.tier === 'A').length,
        B: eligible.filter(r => r.tier === 'B').length,
        C: eligible.filter(r => r.tier === 'C').length,
    };
    
    logger.info(
        `[PREDATOR-DISCOVERY] Scored ${inputs.length} pools | ` +
        `eligible=${eligible.length} | S=${byTier.S} A=${byTier.A} B=${byTier.B} C=${byTier.C}`
    );
    
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POOL CONVERSION HELPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert pool telemetry to BullyInput
 */
export function poolToBullyInput(pool: {
    address: string;
    name: string;
    liquidity?: number;
    volume24h?: number;
    fees24h?: number;
    createdAt?: number;
    microMetrics?: {
        activeBins?: number;
        swapVelocity?: number;
        binVelocity?: number;
        entropy?: number;
    };
    binStep?: number;
}): BullyInput {
    const now = Date.now();
    const createdAt = pool.createdAt ?? (now - 30 * 24 * 60 * 60 * 1000);
    const ageDays = (now - createdAt) / (24 * 60 * 60 * 1000);
    
    const activeBins = pool.microMetrics?.activeBins ?? 10;
    const swapsPerMinute = pool.microMetrics?.swapVelocity ?? 0;
    const binVelocity = pool.microMetrics?.binVelocity ?? 0;
    const entropy = pool.microMetrics?.entropy ?? 0.5;
    
    // Estimate bin reuse from bin velocity (lower velocity = more reuse)
    // Normalize: binVelocity of 0 = 100% reuse, binVelocity of 10 = 0% reuse
    const binReuseRate = Math.max(0, 1 - (binVelocity / 10));
    
    // Estimate price escape from entropy (higher entropy = more escape)
    const priceEscapeRatio = Math.min(1, entropy);
    
    // Estimate volatility from bin velocity
    const volatilityPctPerHour = binVelocity * 0.1;
    
    // Estimate liquidity fragmentation from entropy
    const liquidityFragmentation = entropy;
    
    return {
        poolAddress: pool.address,
        poolName: pool.name,
        ageDays,
        volume24h: pool.volume24h ?? 0,
        tvl: pool.liquidity ?? 0,
        fees24h: pool.fees24h ?? 0,
        activeBins,
        binStep: pool.binStep ?? 10,
        binReuseRate,
        priceEscapeRatio,
        swapsPerMinute,
        volatilityPctPerHour,
        liquidityFragmentation,
    };
}

