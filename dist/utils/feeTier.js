"use strict";
// Fee Tier Optimization
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateFeeTierScore = calculateFeeTierScore;
const volatility_1 = require("./volatility");
/**
 * Calculate fee tier score based on how well it matches pool volatility
 * Stable pairs should have low fees, volatile pairs should have high fees
 */
function calculateFeeTierScore(pool) {
    const volatility = (0, volatility_1.calculateVolatility)(pool);
    const feePercent = pool.baseFee * 100; // Convert to percentage
    // Optimal fee tiers by volatility
    if (volatility.classification === 'low') {
        // Low volatility: prefer low fees (0.01-0.1%)
        if (feePercent >= 0.01 && feePercent <= 0.1) {
            return 1.10; // 10% bonus
        }
        else if (feePercent <= 0.3) {
            return 1.05; // 5% bonus
        }
        return 1.0; // No bonus for high fees on stable pairs
    }
    if (volatility.classification === 'medium') {
        // Medium volatility: prefer medium fees (0.1-0.5%)
        if (feePercent >= 0.1 && feePercent <= 0.5) {
            return 1.10; // 10% bonus
        }
        return 1.05; // Small bonus for others
    }
    // High volatility: prefer high fees (0.3-1.0%)
    if (feePercent >= 0.3 && feePercent <= 1.0) {
        return 1.15; // 15% bonus for optimal high fees
    }
    else if (feePercent >= 0.1) {
        return 1.08; // 8% bonus for medium-high fees
    }
    return 1.0; // No bonus for low fees on volatile pairs
}
//# sourceMappingURL=feeTier.js.map