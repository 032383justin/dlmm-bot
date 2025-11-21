// Volatility Analysis Module

import { Pool } from '../core/normalizePools';
import { MemoCache } from './performance';

interface VolatilityData {
    readonly priceRange24h: number;
    readonly volatilityPercent: number;
    readonly classification: 'low' | 'medium' | 'high';
    readonly positionSizeMultiplier: number;
}

// Cache volatility calculations for 5 minutes
const volatilityCache = new MemoCache<VolatilityData>(5 * 60 * 1000);

/**
 * Calculate 24h price volatility for a pool
 * Uses high/low from 24h volume as proxy for price range
 */
export function calculateVolatility(pool: Pool): VolatilityData {
    const cacheKey = pool.address;
    const cached = volatilityCache.get(cacheKey);
    if (cached) return cached;

    // Estimate price volatility from volume/TVL ratio and velocity
    // Higher velocity relative to TVL suggests more price movement
    const turnover = pool.liquidity > 0 ? pool.velocity / pool.liquidity : 0;

    // Approximate volatility percentage
    // High turnover (>3x daily) = high volatility
    // Medium turnover (1-3x daily) = medium volatility
    // Low turnover (<1x daily) = low volatility
    const volatilityPercent = turnover * 100;

    let classification: 'low' | 'medium' | 'high';
    let positionSizeMultiplier: number;

    if (volatilityPercent > 300) {
        // High volatility (>300% daily turnover)
        classification = 'high';
        positionSizeMultiplier = 0.50; // 50% of normal size
    } else if (volatilityPercent > 150) {
        // Medium volatility (150-300% daily turnover)
        classification = 'medium';
        positionSizeMultiplier = 0.75; // 75% of normal size
    } else {
        // Low volatility (<150% daily turnover)
        classification = 'low';
        positionSizeMultiplier = 1.0; // Full size
    }

    const result: VolatilityData = {
        priceRange24h: turnover,
        volatilityPercent,
        classification,
        positionSizeMultiplier,
    };

    volatilityCache.set(cacheKey, result);
    return result;
}

/**
 * Get position size multiplier based on volatility
 */
export function getVolatilityMultiplier(pool: Pool): number {
    const volatility = calculateVolatility(pool);
    return volatility.positionSizeMultiplier;
}

/**
 * Check if pool is too volatile for current risk tolerance
 */
export function isExcessivelyVolatile(pool: Pool, maxVolatilityPercent: number = 500): boolean {
    const volatility = calculateVolatility(pool);
    return volatility.volatilityPercent > maxVolatilityPercent;
}
