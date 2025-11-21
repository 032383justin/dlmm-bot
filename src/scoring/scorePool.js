"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scorePool = void 0;
var scorePool = function (pool) {
    // --- SMART SCORING STRATEGY ---
    // Goal: "Best rewards (Yield) with least amount of risk, maintaining min 1-5% returns."
    // 1. Calculate Daily Yield
    var dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) * 100 : 0;
    // 2. HARD FILTER: Minimum 1% Daily Return
    // If the pool doesn't meet the user's minimum profit requirement, we ignore it.
    if (dailyYield < 1.0) {
        return 0;
    }
    // 3. Base Score (The "Opportunity")
    // Driven by Turnover (Yield Potential) and TVL (Liquidity Depth).
    // We want high turnover, but we also want enough liquidity to be stable.
    var turnover = pool.liquidity > 0 ? pool.velocity / pool.liquidity : 0;
    var normTurnover = Math.min((turnover / 5) * 100, 100); // 500% turnover = 100
    var normTVL = Math.min((pool.liquidity / 500000) * 100, 100); // 500k TVL = 100
    // Base Score is 70% Yield, 30% Stability
    var baseScore = (normTurnover * 0.70) + (normTVL * 0.30);
    // 4. Safety Multiplier (The "Least Risk")
    // Instead of adding risk as a small weight, we use it as a MULTIPLIER.
    // If a pool is risky, it decimates the score.
    // Risk Score 0 = Multiplier 1.0 (No penalty)
    // Risk Score 50 = Multiplier 0.5 (Score halved)
    // Risk Score 100 = Multiplier 0.0 (Score zeroed)
    var safetyFactor = (100 - pool.riskScore) / 100;
    // 5. Age/Bin Bonus
    // Small bonus for optimal setup, but not a driver.
    var binBonus = (pool.binCount >= 8 && pool.binCount <= 22) ? 1.10 : 1.0; // 10% bonus
    var ageBonus = ((Date.now() - pool.createdAt) > 7 * 24 * 60 * 60 * 1000) ? 1.05 : 1.0; // 5% bonus for >7 days
    var totalScore = baseScore * safetyFactor * binBonus * ageBonus;
    // Dilution Penalty
    // "If dilutionScore rises more than 8%... Lower total pool score by 25%"
    // We check current dilution score.
    // If > threshold, penalize.
    if (pool.dilutionScore > 50) { // Arbitrary threshold for "high"
        totalScore *= 0.75;
    }
    return totalScore;
};
exports.scorePool = scorePool;
