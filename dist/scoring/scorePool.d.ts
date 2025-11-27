/**
 * @deprecated This scoring module uses 24h metrics which are DEPRECATED.
 * Use the new microstructure-based scoring instead:
 *
 * import { scoreMicrostructure } from './microstructureScoring';
 *
 * The new scoring uses real-time DLMM signals:
 * - binVelocity (30%)
 * - liquidityFlow (30%)
 * - swapVelocity (25%)
 * - feeIntensity (15%)
 *
 * RULE: No pool should ever be scored using 24h or TVL-only metrics.
 * DLMM alpha exists inside short-term bin-level volatility.
 */
import { Pool } from '../core/normalizePools';
/**
 * Scoring diagnostics breakdown for verbose logging.
 * Captures all sub-scores, multipliers, penalties, and microstructure transitions.
 */
export interface ScoringDiagnostics {
    poolName: string;
    poolAddress: string;
    inputs: {
        liquidity: number;
        velocity: number;
        fees24h: number;
        volume24h: number;
        binCount: number;
        poolAgeDays: number;
        riskScore: number;
        dilutionScore: number;
    };
    subScores: {
        dailyYield: number;
        normYield: number;
        turnover: number;
        normTurnover: number;
        normTVL: number;
        velocityRatio: number;
    };
    multipliers: {
        safetyFactor: number;
        binBonus: number;
        ageBonus: number;
        feeTierBonus: number;
        velocityAccelerationBonus: number;
    };
    microstructureTransitions: {
        velocitySlope: number;
        velocitySlopeBonus: number;
        liquidityDelta: number;
        liquidityMigrationBonus: number;
        entropy: number | null;
        entropyDivergenceBonus: number;
    };
    penalties: {
        dilutionPenaltyApplied: boolean;
        dilutionPenaltyFactor: number;
    };
    composition: {
        baseScore: number;
        preMultiplierScore: number;
        afterSnapshotMultipliers: number;
        afterTransitionMultipliers: number;
        prePenaltyScore: number;
        finalScore: number;
    };
}
export declare const scorePool: (pool: Pool) => number;
/**
 * Log entry rejection reason with scoring context.
 * Call this when a pool is rejected due to score threshold.
 */
export declare function logEntryRejection(pool: Pool, score: number, threshold: number, additionalReason?: string): void;
//# sourceMappingURL=scorePool.d.ts.map