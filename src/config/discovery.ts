/**
 * Discovery Configuration - Tunable Thresholds for Pool Discovery
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONDITIONAL PRE-TIER FILTERING CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * The discovery pipeline uses TWO filter sets:
 * 
 * 1. ENRICHED MODE (Birdeye/24h metrics available):
 *    - Full pre-tier filter set with strict thresholds
 *    - volume24h, tvl, uniqueSwappers24h validated
 *    
 * 2. MICROSTRUCTURE-ONLY MODE (enrichment unavailable):
 *    - Relaxed thresholds using only on-chain data
 *    - Pools pass based on microstructure signals alone
 *    - TVL filtering is soft (demotes, doesn't discard)
 * 
 * This ensures the bot NEVER gets stuck with "no candidates" due to
 * missing external API data.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// ENRICHED MODE THRESHOLDS (when Birdeye/24h data is available)
// ═══════════════════════════════════════════════════════════════════════════════

export const ENRICHED_THRESHOLDS = {
    // Pre-tier microstructure filters (strict when enrichment available)
    swapVelocity: 0.12,           // swaps/sec minimum
    poolEntropy: 0.65,            // Shannon entropy minimum
    liquidityFlow: 0.005,         // 0.5% liquidity flow minimum
    
    // 24h metric requirements
    volume24h: 75000,             // $75,000 minimum
    tvl: 200000,                  // $200,000 minimum
    uniqueSwappers24h: 35,        // 35 unique traders
    medianTradeSize: 75,          // $75 median trade
};

// ═══════════════════════════════════════════════════════════════════════════════
// MICROSTRUCTURE-ONLY THRESHOLDS (fallback when enrichment unavailable)
// ═══════════════════════════════════════════════════════════════════════════════

export const MICROSTRUCTURE_ONLY_THRESHOLDS = {
    // Relaxed microstructure filters (pure on-chain telemetry)
    swapVelocity: 0.05,           // swaps/sec (relaxed from 0.12)
    poolEntropy: 0.35,            // Shannon entropy (relaxed from 0.65)
    liquidityFlow: 0.002,         // 0.2% liquidity flow (relaxed from 0.5%)
    
    // Soft TVL threshold (demotes priority, doesn't discard)
    softTvlThreshold: 100000,     // $100,000 - below this, demote score
    softTvlPenalty: 0.70,         // 30% score penalty for low TVL
    
    // No hard requirements for 24h metrics when enrichment unavailable
    // Pools are NOT auto-failed for missing:
    // - volume24h
    // - uniqueSwappers24h  
    // - medianTradeSize
};

// ═══════════════════════════════════════════════════════════════════════════════
// UPSTREAM MEMORY OPTIMIZATION FILTERS
// Applied during initial Meteora fetch to reduce memory usage
// ═══════════════════════════════════════════════════════════════════════════════

export const UPSTREAM_FILTERS = {
    // Very relaxed - just to avoid loading 100k+ dead pools
    minTvlForFetch: 10000,        // $10k TVL minimum to even consider
    minVolumeForFetch: 5000,      // $5k volume minimum to even consider
    
    // Note: Pools passing these may still fail pre-tier filters
    // This is intentional - we want to catch edge cases
};

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY LIMITS (NOT static caps - just for performance)
// ═══════════════════════════════════════════════════════════════════════════════

export const DISCOVERY_LIMITS = {
    // These are performance limits, NOT trading caps
    // The risk engine decides how many to actually trade
    
    maxPoolsForTelemetry: 200,    // Max pools to fetch on-chain telemetry for
    maxPoolsToScore: 100,         // Max pools to pass to Tier4 scoring
    maxCandidatesForRisk: 50,     // Max candidates handed to risk engine
    
    // Cache configuration
    cacheTtlMinutes: 12,          // 10-15 minute range per spec
    rotationIntervalMinutes: 3,   // Check for rotation every 3 min
    deadPoolThreshold: 15,        // Score below which pool is "dead"
};

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-WEIGHTED SCORING CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export const TIME_WEIGHT_CONFIG = {
    consistencyWeight: 0.30,      // 30% boost for high consistency
    spikesPenalty: 0.60,          // 60% penalty for spiky activity
    minConsistencyScore: 40,      // Minimum to pass time-weight check
};

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY THRESHOLDS (for Tier4 scoring)
// ═══════════════════════════════════════════════════════════════════════════════

export const ENTRY_SCORE_THRESHOLDS = {
    // Entry threshold by tier/regime
    tier1Entry: 32,               // Tier B momentum entries
    tier2Entry: 35,               // Tier C speculative entries  
    tier3Entry: 38,               // More conservative
    tier4Entry: 42,               // Most conservative
    
    // Exit threshold (score collapse triggers exit)
    defaultExit: 22,              // Exit when score drops below
    
    // Exception override thresholds
    exceptionMinScore: 50,        // High score can override blocks
    exceptionMinFeeIntensity: 0.8, // High fee activity can override
    exceptionMinEntropySlope: 0.0001, // Improving entropy can override
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELIUS CONFIGURATION (OPTIONAL)
// ═══════════════════════════════════════════════════════════════════════════════

export const HELIUS_CONFIG = {
    // Helius is treated as OPTIONAL
    // If not configured, discovery continues without it
    required: false,
    
    // Log message when not configured
    notConfiguredMessage: '[DISCOVERY] Helius API key not configured - continuing without Helius enrichment',
    
    // Timeout for Helius requests
    timeoutMs: 30000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// BIRDEYE CONFIGURATION (OPTIONAL)
// ═══════════════════════════════════════════════════════════════════════════════

export const BIRDEYE_CONFIG = {
    // Birdeye is treated as OPTIONAL for enrichment
    // Discovery works without it using microstructure-only mode
    required: false,
    
    // Batch configuration
    batchSize: 10,
    batchDelayMs: 100,
    timeoutMs: 5000,
    
    // Log message when not configured
    notConfiguredMessage: '[DISCOVERY] Birdeye API key not configured - using microstructure-only mode',
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Check if pool has enrichment data
// ═══════════════════════════════════════════════════════════════════════════════

export function hasEnrichmentData(pool: {
    volume24h?: number;
    uniqueSwappers24h?: number;
    tvl?: number;
}): boolean {
    // Pool has enrichment if it has valid 24h metrics
    // Volume24h and uniqueSwappers are the key indicators
    return (
        pool.volume24h !== undefined && 
        pool.volume24h > 0 &&
        pool.uniqueSwappers24h !== undefined &&
        pool.uniqueSwappers24h > 0
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Get appropriate thresholds for pool
// ═══════════════════════════════════════════════════════════════════════════════

export function getThresholdsForPool(pool: {
    volume24h?: number;
    uniqueSwappers24h?: number;
    tvl?: number;
}): {
    mode: 'enriched' | 'microstructure-only';
    swapVelocity: number;
    poolEntropy: number;
    liquidityFlow: number;
    volume24h: number | null;
    tvl: number | null;
    uniqueSwappers24h: number | null;
} {
    if (hasEnrichmentData(pool)) {
        return {
            mode: 'enriched',
            swapVelocity: ENRICHED_THRESHOLDS.swapVelocity,
            poolEntropy: ENRICHED_THRESHOLDS.poolEntropy,
            liquidityFlow: ENRICHED_THRESHOLDS.liquidityFlow,
            volume24h: ENRICHED_THRESHOLDS.volume24h,
            tvl: ENRICHED_THRESHOLDS.tvl,
            uniqueSwappers24h: ENRICHED_THRESHOLDS.uniqueSwappers24h,
        };
    }
    
    return {
        mode: 'microstructure-only',
        swapVelocity: MICROSTRUCTURE_ONLY_THRESHOLDS.swapVelocity,
        poolEntropy: MICROSTRUCTURE_ONLY_THRESHOLDS.poolEntropy,
        liquidityFlow: MICROSTRUCTURE_ONLY_THRESHOLDS.liquidityFlow,
        volume24h: null,  // Not required
        tvl: null,        // Not required (soft threshold applied separately)
        uniqueSwappers24h: null, // Not required
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const DISCOVERY_CONFIG = {
    enriched: ENRICHED_THRESHOLDS,
    microstructureOnly: MICROSTRUCTURE_ONLY_THRESHOLDS,
    upstream: UPSTREAM_FILTERS,
    limits: DISCOVERY_LIMITS,
    timeWeight: TIME_WEIGHT_CONFIG,
    entryScores: ENTRY_SCORE_THRESHOLDS,
    helius: HELIUS_CONFIG,
    birdeye: BIRDEYE_CONFIG,
};

export default DISCOVERY_CONFIG;

