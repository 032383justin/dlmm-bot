/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MARKET SENTIMENT GATE — GLOBAL ENTRY BLOCKER
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Lightweight boolean gate to block entries when ecosystem is weak.
 * 
 * Uses ONLY the first 12 enriched pools from discovery.
 * NO additional telemetry, NO stateful loops, NO database writes.
 * 
 * RELAXED: MIN_SENTIMENT_SCORE lowered to 10 (was ~15-20)
 * This allows entries during mild bearish conditions but still blocks
 * extreme bear markets.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// RELAXED SENTIMENT THRESHOLD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimum sentiment score required to allow trading.
 * Score below this blocks all entries.
 * 
 * was ~15-20 (BEAR regime at score < 25)
 * now 10 - only blocks extreme bear markets
 */
export const MIN_SENTIMENT_SCORE = 10;

export type MarketRegime = 'BULL' | 'NEUTRAL' | 'BEAR';

export interface MarketSentimentResult {
    score: number;
    regime: MarketRegime;
    shouldBlock: boolean;
    reason: string;
}

interface PoolWithMetrics {
    velocityLiquidityRatio?: number;
    microScore?: number;
    isMarketAlive?: boolean;
}

/**
 * Evaluate global market sentiment from top discovery pools.
 * 
 * @param enrichedPools - Pools from discovery (uses first 12 only)
 * @returns Sentiment score, regime classification, and block decision
 */
export function evaluateMarketSentiment(enrichedPools: PoolWithMetrics[]): MarketSentimentResult {
    // Take only first 12 pools
    const sample = enrichedPools.slice(0, 12);
    
    if (sample.length === 0) {
        return {
            score: 0,
            regime: 'BEAR',
            shouldBlock: true,
            reason: 'No pools in sample',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 1: Average velocityLiquidityRatio (0-40 points)
    // ═══════════════════════════════════════════════════════════════════════════
    const vlrValues = sample
        .map(p => p.velocityLiquidityRatio ?? 0)
        .filter(v => v > 0);
    
    const avgVLR = vlrValues.length > 0
        ? vlrValues.reduce((a, b) => a + b, 0) / vlrValues.length
        : 0;
    
    // Normalize: VLR of 0.5+ = 40 points, 0 = 0 points
    const vlrScore = Math.min(40, avgVLR * 80);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 2: Percentage of pools with microScore >= 32 (0-30 points)
    // ═══════════════════════════════════════════════════════════════════════════
    const highScoreCount = sample.filter(p => (p.microScore ?? 0) >= 32).length;
    const highScoreRatio = highScoreCount / sample.length;
    
    // 100% high score = 30 points
    const microScorePoints = highScoreRatio * 30;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPONENT 3: Alive ratio (0-30 points)
    // ═══════════════════════════════════════════════════════════════════════════
    const aliveCount = sample.filter(p => p.isMarketAlive === true).length;
    const aliveRatio = aliveCount / sample.length;
    
    // 100% alive = 30 points
    const alivePoints = aliveRatio * 30;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COMPOSITE SCORE (0-100)
    // ═══════════════════════════════════════════════════════════════════════════
    const score = vlrScore + microScorePoints + alivePoints;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REGIME CLASSIFICATION
    // ═══════════════════════════════════════════════════════════════════════════
    let regime: MarketRegime;
    if (score > 45) {
        regime = 'BULL';
    } else if (score >= 25) {
        regime = 'NEUTRAL';
    } else {
        regime = 'BEAR';
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BLOCK DECISION (RELAXED: uses MIN_SENTIMENT_SCORE instead of regime)
    // Only blocks extreme bear markets (score < 10), not mild bearish conditions
    // ═══════════════════════════════════════════════════════════════════════════
    const shouldBlock = score < MIN_SENTIMENT_SCORE;
    
    const reason = shouldBlock
        ? `Extreme BEAR market (score=${score.toFixed(1)} < ${MIN_SENTIMENT_SCORE}, alive=${(aliveRatio * 100).toFixed(0)}%, highScore=${(highScoreRatio * 100).toFixed(0)}%)`
        : `${regime} market (score=${score.toFixed(1)})`;
    
    logger.info(`[MARKET] Sentiment: ${regime} | Score: ${score.toFixed(1)} | VLR: ${avgVLR.toFixed(3)} | Alive: ${(aliveRatio * 100).toFixed(0)}% | HighScore: ${(highScoreRatio * 100).toFixed(0)}%`);
    
    return { score, regime, shouldBlock, reason };
}

