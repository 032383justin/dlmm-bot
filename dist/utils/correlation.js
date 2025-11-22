"use strict";
// Cross-Pool Correlation Analysis
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculatePoolCorrelation = calculatePoolCorrelation;
exports.isHighlyCorrelated = isHighlyCorrelated;
exports.filterUncorrelatedPools = filterUncorrelatedPools;
/**
 * Calculate correlation coefficient between two arrays
 * Returns value between -1 and 1
 * 1 = perfect positive correlation
 * 0 = no correlation
 * -1 = perfect negative correlation
 */
function calculateCorrelation(arrayA, arrayB) {
    if (arrayA.length !== arrayB.length || arrayA.length === 0)
        return 0;
    const n = arrayA.length;
    const meanA = arrayA.reduce((sum, val) => sum + val, 0) / n;
    const meanB = arrayB.reduce((sum, val) => sum + val, 0) / n;
    let numerator = 0;
    let denomA = 0;
    let denomB = 0;
    for (let i = 0; i < n; i++) {
        const diffA = arrayA[i] - meanA;
        const diffB = arrayB[i] - meanB;
        numerator += diffA * diffB;
        denomA += diffA * diffA;
        denomB += diffB * diffB;
    }
    const denominator = Math.sqrt(denomA * denomB);
    if (denominator === 0)
        return 0;
    return numerator / denominator;
}
/**
 * Calculate price movement correlation between two pools
 * Uses velocity (volume) as proxy for price movement
 */
function calculatePoolCorrelation(poolA, poolB, historicalData) {
    // If we have historical data, use it
    if (historicalData) {
        const dataA = historicalData.get(poolA.address);
        const dataB = historicalData.get(poolB.address);
        if (dataA && dataB && dataA.length >= 5 && dataB.length >= 5) {
            return calculateCorrelation(dataA, dataB);
        }
    }
    // Fallback: estimate correlation from current metrics
    // Pools with similar velocity/TVL ratios tend to be correlated
    const ratioA = poolA.liquidity > 0 ? poolA.velocity / poolA.liquidity : 0;
    const ratioB = poolB.liquidity > 0 ? poolB.velocity / poolB.liquidity : 0;
    // Simple similarity measure (not true correlation, but good enough)
    const diff = Math.abs(ratioA - ratioB);
    const avg = (ratioA + ratioB) / 2;
    if (avg === 0)
        return 0;
    // Convert difference to correlation-like score
    // Small difference = high correlation
    const similarity = 1 - Math.min(diff / avg, 1);
    return similarity;
}
/**
 * Check if a new pool is highly correlated with existing positions
 */
function isHighlyCorrelated(newPool, existingPools, threshold = 0.7, historicalData) {
    for (const existing of existingPools) {
        const correlation = calculatePoolCorrelation(newPool, existing, historicalData);
        if (correlation > threshold) {
            return true;
        }
    }
    return false;
}
/**
 * Find pools that are not correlated with existing positions
 */
function filterUncorrelatedPools(candidates, existingPools, threshold = 0.7, historicalData) {
    if (existingPools.length === 0)
        return [...candidates];
    return candidates.filter(candidate => {
        return !isHighlyCorrelated(candidate, existingPools, threshold, historicalData);
    });
}
//# sourceMappingURL=correlation.js.map