"use strict";
// Volatility Analysis Module
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateVolatility = calculateVolatility;
exports.getVolatilityMultiplier = getVolatilityMultiplier;
exports.isExcessivelyVolatile = isExcessivelyVolatile;
const performance_1 = require("./performance");
// Cache volatility calculations for 5 minutes
const volatilityCache = new performance_1.MemoCache(5 * 60 * 1000);
/**
 * Calculate 24h price volatility for a pool
 * Uses high/low from 24h volume as proxy for price range
 */
function calculateVolatility(pool) {
    const cacheKey = pool.address;
    const cached = volatilityCache.get(cacheKey);
    if (cached)
        return cached;
    // Estimate price volatility from volume/TVL ratio and velocity
    // Higher velocity relative to TVL suggests more price movement
    const turnover = pool.liquidity > 0 ? pool.velocity / pool.liquidity : 0;
    // Approximate volatility percentage
    // High turnover (>3x daily) = high volatility
    // Medium turnover (1-3x daily) = medium volatility
    // Low turnover (<1x daily) = low volatility
    const volatilityPercent = turnover * 100;
    let classification;
    let positionSizeMultiplier;
    if (volatilityPercent > 300) {
        // High volatility (>300% daily turnover)
        classification = 'high';
        positionSizeMultiplier = 0.50; // 50% of normal size
    }
    else if (volatilityPercent > 150) {
        // Medium volatility (150-300% daily turnover)
        classification = 'medium';
        positionSizeMultiplier = 0.75; // 75% of normal size
    }
    else {
        // Low volatility (<150% daily turnover)
        classification = 'low';
        positionSizeMultiplier = 1.0; // Full size
    }
    const result = {
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
function getVolatilityMultiplier(pool) {
    const volatility = calculateVolatility(pool);
    return volatility.positionSizeMultiplier;
}
/**
 * Check if pool is too volatile for current risk tolerance
 */
function isExcessivelyVolatile(pool, maxVolatilityPercent = 500) {
    const volatility = calculateVolatility(pool);
    return volatility.volatilityPercent > maxVolatilityPercent;
}
//# sourceMappingURL=volatility.js.map