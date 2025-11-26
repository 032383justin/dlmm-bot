import { Pool } from '../core/normalizePools';
import { isVerboseScoringEnabled } from '../config/constants';
import logger from '../utils/logger';

/**
 * Extended Pool interface for transition-based scoring.
 * These optional fields enable microstructure transition detection.
 */
interface PoolWithTransitions extends Pool {
  prevVelocity?: number;
  prevLiquidity?: number;
  entropy?: number;
}

/**
 * Scoring diagnostics breakdown for verbose logging.
 * Captures all sub-scores, multipliers, penalties, and microstructure transitions.
 */
export interface ScoringDiagnostics {
  poolName: string;
  poolAddress: string;
  
  // Raw inputs
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
  
  // Sub-scores (0-100 scale)
  subScores: {
    dailyYield: number;
    normYield: number;
    turnover: number;
    normTurnover: number;
    normTVL: number;
    velocityRatio: number;
  };
  
  // Multipliers (snapshot-based)
  multipliers: {
    safetyFactor: number;
    binBonus: number;
    ageBonus: number;
    feeTierBonus: number;
    velocityAccelerationBonus: number;
  };
  
  // Microstructure Transition Multipliers (transition-based)
  microstructureTransitions: {
    velocitySlope: number;
    velocitySlopeBonus: number;
    liquidityDelta: number;
    liquidityMigrationBonus: number;
    entropy: number | null;
    entropyDivergenceBonus: number;
  };
  
  // Penalties
  penalties: {
    dilutionPenaltyApplied: boolean;
    dilutionPenaltyFactor: number;
  };
  
  // Composition
  composition: {
    baseScore: number;
    preMultiplierScore: number;
    afterSnapshotMultipliers: number;
    afterTransitionMultipliers: number;
    prePenaltyScore: number;
    finalScore: number;
  };
}

/**
 * Log scoring diagnostics in a readable format.
 */
function logScoringDiagnostics(diag: ScoringDiagnostics): void {
  const divider = '─'.repeat(60);
  
  logger.info(`\n${divider}`);
  logger.info(`📊 SCORING DIAGNOSTICS: ${diag.poolName}`);
  logger.info(`   Address: ${diag.poolAddress.slice(0, 8)}...${diag.poolAddress.slice(-6)}`);
  logger.info(divider);
  
  // Raw Inputs
  logger.info(`📥 RAW INPUTS:`);
  logger.info(`   Liquidity:     $${diag.inputs.liquidity.toLocaleString()}`);
  logger.info(`   Velocity:      ${diag.inputs.velocity.toLocaleString()}`);
  logger.info(`   Fees 24h:      $${diag.inputs.fees24h.toLocaleString()}`);
  logger.info(`   Volume 24h:    $${diag.inputs.volume24h.toLocaleString()}`);
  logger.info(`   Bin Count:     ${diag.inputs.binCount}`);
  logger.info(`   Pool Age:      ${diag.inputs.poolAgeDays.toFixed(1)} days`);
  logger.info(`   Risk Score:    ${diag.inputs.riskScore}`);
  logger.info(`   Dilution Score:${diag.inputs.dilutionScore}`);
  
  // Sub-Scores
  logger.info(`\n📈 SUB-SCORES (0-100 normalized):`);
  logger.info(`   Daily Yield:   ${diag.subScores.dailyYield.toFixed(4)}%`);
  logger.info(`   Norm Yield:    ${diag.subScores.normYield.toFixed(1)} (weight: 40%)`);
  logger.info(`   Turnover:      ${diag.subScores.turnover.toFixed(4)}`);
  logger.info(`   Norm Turnover: ${diag.subScores.normTurnover.toFixed(1)} (weight: 35%)`);
  logger.info(`   Norm TVL:      ${diag.subScores.normTVL.toFixed(1)} (weight: 25%)`);
  logger.info(`   Velocity Ratio:${diag.subScores.velocityRatio.toFixed(4)}`);
  
  // Snapshot-based Multipliers
  logger.info(`\n✖️  SNAPSHOT MULTIPLIERS:`);
  logger.info(`   Safety Factor:     ${diag.multipliers.safetyFactor.toFixed(2)}x (from riskScore)`);
  logger.info(`   Bin Bonus:         ${diag.multipliers.binBonus.toFixed(2)}x`);
  logger.info(`   Age Bonus:         ${diag.multipliers.ageBonus.toFixed(2)}x`);
  logger.info(`   Fee Tier Bonus:    ${diag.multipliers.feeTierBonus.toFixed(2)}x`);
  logger.info(`   Velocity Accel:    ${diag.multipliers.velocityAccelerationBonus.toFixed(2)}x`);
  
  // Transition-based Microstructure Multipliers
  logger.info(`\n🔄 TRANSITION MULTIPLIERS (microstructure):`);
  const mt = diag.microstructureTransitions;
  logger.info(`   Velocity Slope:    ${(mt.velocitySlope * 100).toFixed(2)}% → ${mt.velocitySlopeBonus.toFixed(2)}x`);
  logger.info(`   Liquidity Delta:   ${(mt.liquidityDelta * 100).toFixed(2)}% → ${mt.liquidityMigrationBonus.toFixed(2)}x`);
  if (mt.entropy !== null) {
    logger.info(`   Entropy:           ${mt.entropy.toFixed(4)} → ${mt.entropyDivergenceBonus.toFixed(2)}x`);
  } else {
    logger.info(`   Entropy:           N/A (no entropy data)`);
  }
  
  // Penalties
  logger.info(`\n⚠️  PENALTIES:`);
  if (diag.penalties.dilutionPenaltyApplied) {
    logger.info(`   Dilution Penalty:  ${diag.penalties.dilutionPenaltyFactor.toFixed(2)}x (APPLIED - dilution > 60)`);
  } else {
    logger.info(`   Dilution Penalty:  None (dilution ${diag.inputs.dilutionScore} ≤ 60)`);
  }
  
  // Score Composition
  logger.info(`\n🧮 SCORE COMPOSITION:`);
  logger.info(`   Base Score:              ${diag.composition.baseScore.toFixed(2)}`);
  logger.info(`   After Snapshot Mult:     ${diag.composition.afterSnapshotMultipliers.toFixed(2)}`);
  logger.info(`   After Transition Mult:   ${diag.composition.afterTransitionMultipliers.toFixed(2)}`);
  logger.info(`   After Penalties:         ${diag.composition.finalScore.toFixed(2)}`);
  logger.info(`   ─────────────────────────────────`);
  logger.info(`   📌 FINAL SCORE:          ${diag.composition.finalScore.toFixed(2)}`);
  logger.info(divider + '\n');
}

export const scorePool = (pool: Pool): number => {
  const verbose = isVerboseScoringEnabled();
  
  // Cast to extended interface for transition fields
  const poolExt = pool as PoolWithTransitions;
  
  // --- SMART SCORING STRATEGY ---
  // Goal: "Best rewards (Yield) with least amount of risk"
  // Optimized for microstructure volatility harvesting:
  // - Favor high velocity/volume conditions
  // - Reward liquidity acceleration
  // - Detect favorable microstructure transitions
  // - Maintain full risk system integrity

  // 1. Calculate Daily Yield
  const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) * 100 : 0;

  // 2. Normalize Yield Score (0-100 scale)
  // Adjusted: 0.3% daily = 100 points (more achievable for active pools)
  // 0.1% daily = 33 points, 0.15% = 50 points
  const normYield = Math.min((dailyYield / 0.3) * 100, 100);

  // 3. Base Score (The "Opportunity")
  // Driven by Turnover (Volume Velocity) and TVL (Liquidity Depth).
  // Microstructure harvesting favors high turnover with sufficient liquidity.

  const turnover = pool.liquidity > 0 ? pool.velocity / pool.liquidity : 0;
  // Adjusted: 200% turnover = 100 points (was 500%, too aggressive)
  // This better captures the velocity signal that microstructure logic depends on
  const normTurnover = Math.min((turnover / 2) * 100, 100);
  
  // TVL normalization unchanged - 500k remains the benchmark
  const normTVL = Math.min((pool.liquidity / 500000) * 100, 100);

  // 4. Velocity Acceleration Bonus (snapshot-based)
  // When velocity is high relative to TVL, activity is accelerating
  // This rewards pools where volume velocity indicates favorable microstructure
  const velocityRatio = pool.liquidity > 0 ? pool.velocity / pool.liquidity : 0;
  const velocityAccelerationBonus = velocityRatio > 0.5 ? 1.08 : // High activity: 8% bonus
                                    velocityRatio > 0.3 ? 1.04 : // Moderate activity: 4% bonus
                                    1.0;

  // Base Score: 40% Yield, 35% Turnover (velocity), 25% Stability
  // Rebalanced to favor velocity/volume - the core microstructure signal
  const baseScore = (normYield * 0.40) + (normTurnover * 0.35) + (normTVL * 0.25);

  // 5. Safety Multiplier (The "Least Risk")
  // UNCHANGED - Risk system remains fully intact
  // If a pool is risky, it decimates the score.
  // Risk Score 0 = Multiplier 1.0 (No penalty)
  // Risk Score 50 = Multiplier 0.5 (Score halved)
  // Risk Score 100 = Multiplier 0.0 (Score zeroed)
  const safetyFactor = (100 - pool.riskScore) / 100;

  // 6. Age/Bin/Fee Tier Bonuses (snapshot-based)
  // Widened ranges for DLMM pool characteristics

  // Bin Bonus: DLMM pools often have 25-60 bins, widen the optimal range
  // 8-60 bins = optimal for concentrated liquidity strategies
  const binBonus = (pool.binCount >= 8 && pool.binCount <= 60) ? 1.10 :
                   (pool.binCount > 60 && pool.binCount <= 100) ? 1.05 : 1.0;

  // Age Bonus: Graduated bonus for established pools
  // 3+ days = small bonus, 5+ days = medium, 7+ days = full bonus
  const poolAgeDays = (Date.now() - pool.createdAt) / (1000 * 60 * 60 * 24);
  const ageBonus = poolAgeDays >= 7 ? 1.08 :   // Mature pool: 8% bonus
                   poolAgeDays >= 5 ? 1.05 :   // Established: 5% bonus
                   poolAgeDays >= 3 ? 1.02 :   // Emerging: 2% bonus
                   1.0;

  // Fee tier bonus (imported from feeTier module)
  const { calculateFeeTierScore } = require('../utils/feeTier');
  const feeTierBonus = calculateFeeTierScore(pool);

  // Apply snapshot-based multipliers
  const afterSnapshotMultipliers = baseScore * safetyFactor * binBonus * ageBonus * feeTierBonus * velocityAccelerationBonus;

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. TRANSITION-BASED MICROSTRUCTURE INDICATORS
  // These detect favorable state transitions rather than static snapshots.
  // Applied AFTER snapshot multipliers, BEFORE dilution penalty.
  // ═══════════════════════════════════════════════════════════════════════════

  // 7a. Velocity Slope Bonus
  // Detects acceleration/deceleration of trading activity
  const prevVelocity = poolExt.prevVelocity ?? pool.velocity;
  const velocitySlope = prevVelocity > 0 
    ? (pool.velocity - prevVelocity) / prevVelocity 
    : 0;
  
  let velocitySlopeBonus: number;
  if (velocitySlope > 0.15) {
    velocitySlopeBonus = 1.12;  // Strong acceleration: 12% bonus
  } else if (velocitySlope > 0.07) {
    velocitySlopeBonus = 1.06;  // Moderate acceleration: 6% bonus
  } else if (velocitySlope > 0.02) {
    velocitySlopeBonus = 1.03;  // Slight acceleration: 3% bonus
  } else if (velocitySlope < 0) {
    velocitySlopeBonus = 0.88;  // Deceleration: 12% penalty
  } else {
    velocitySlopeBonus = 1.0;   // Flat: no adjustment
  }

  // 7b. Liquidity Migration Bonus
  // Detects LP inflows/outflows indicating market confidence
  const prevLiquidity = poolExt.prevLiquidity ?? pool.liquidity;
  const liquidityDelta = prevLiquidity > 0 
    ? (pool.liquidity - prevLiquidity) / prevLiquidity 
    : 0;
  
  let liquidityMigrationBonus: number;
  if (liquidityDelta > 0.10) {
    liquidityMigrationBonus = 1.10;  // Strong LP inflow: 10% bonus
  } else if (liquidityDelta > 0.05) {
    liquidityMigrationBonus = 1.05;  // Moderate LP inflow: 5% bonus
  } else if (liquidityDelta < -0.05) {
    liquidityMigrationBonus = 0.85;  // LP outflow: 15% penalty
  } else {
    liquidityMigrationBonus = 1.0;   // Stable: no adjustment
  }

  // 7c. Entropy Divergence Bonus
  // Rewards high bin entropy indicating healthy price discovery
  const entropy = poolExt.entropy ?? null;
  let entropyDivergenceBonus: number;
  
  if (entropy !== null) {
    if (entropy > 0.65) {
      entropyDivergenceBonus = 1.12;  // High entropy: 12% bonus
    } else if (entropy > 0.45) {
      entropyDivergenceBonus = 1.06;  // Moderate entropy: 6% bonus
    } else {
      entropyDivergenceBonus = 1.0;   // Low entropy: no bonus
    }
  } else {
    entropyDivergenceBonus = 1.0;     // No entropy data: skip
  }

  // Apply transition-based multipliers
  const afterTransitionMultipliers = afterSnapshotMultipliers * velocitySlopeBonus * liquidityMigrationBonus * entropyDivergenceBonus;

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Dilution Penalty
  // Applied LAST - after all bonuses
  // Slightly relaxed threshold (60 vs 50) to reduce false negatives
  // But penalty remains severe (25%) when triggered
  // ═══════════════════════════════════════════════════════════════════════════
  const dilutionPenaltyApplied = pool.dilutionScore > 60;
  const dilutionPenaltyFactor = dilutionPenaltyApplied ? 0.75 : 1.0;
  const totalScore = afterTransitionMultipliers * dilutionPenaltyFactor;

  // Verbose diagnostics logging
  if (verbose) {
    const diagnostics: ScoringDiagnostics = {
      poolName: pool.name,
      poolAddress: pool.address,
      inputs: {
        liquidity: pool.liquidity,
        velocity: pool.velocity,
        fees24h: pool.fees24h,
        volume24h: pool.volume24h,
        binCount: pool.binCount,
        poolAgeDays,
        riskScore: pool.riskScore,
        dilutionScore: pool.dilutionScore,
      },
      subScores: {
        dailyYield,
        normYield,
        turnover,
        normTurnover,
        normTVL,
        velocityRatio,
      },
      multipliers: {
        safetyFactor,
        binBonus,
        ageBonus,
        feeTierBonus,
        velocityAccelerationBonus,
      },
      microstructureTransitions: {
        velocitySlope,
        velocitySlopeBonus,
        liquidityDelta,
        liquidityMigrationBonus,
        entropy,
        entropyDivergenceBonus,
      },
      penalties: {
        dilutionPenaltyApplied,
        dilutionPenaltyFactor,
      },
      composition: {
        baseScore,
        preMultiplierScore: baseScore,
        afterSnapshotMultipliers,
        afterTransitionMultipliers,
        prePenaltyScore: afterTransitionMultipliers,
        finalScore: totalScore,
      },
    };
    
    logScoringDiagnostics(diagnostics);
  }

  return totalScore;
};

/**
 * Log entry rejection reason with scoring context.
 * Call this when a pool is rejected due to score threshold.
 */
export function logEntryRejection(
  pool: Pool,
  score: number,
  threshold: number,
  additionalReason?: string
): void {
  if (!isVerboseScoringEnabled()) return;
  
  const gap = threshold - score;
  const gapPercent = ((gap / threshold) * 100).toFixed(1);
  
  logger.info(`\n❌ ENTRY REJECTED: ${pool.name}`);
  logger.info(`   Score: ${score.toFixed(2)} < Threshold: ${threshold}`);
  logger.info(`   Gap: ${gap.toFixed(2)} points (${gapPercent}% below threshold)`);
  
  // Identify likely bottlenecks
  const bottlenecks: string[] = [];
  
  const dailyYield = pool.liquidity > 0 ? (pool.fees24h / pool.liquidity) * 100 : 0;
  if (dailyYield < 0.1) bottlenecks.push(`Low yield (${dailyYield.toFixed(4)}% < 0.1%)`);
  
  const turnover = pool.liquidity > 0 ? pool.velocity / pool.liquidity : 0;
  if (turnover < 0.3) bottlenecks.push(`Low turnover (${turnover.toFixed(4)} < 0.3)`);
  
  if (pool.riskScore > 30) bottlenecks.push(`Elevated risk (${pool.riskScore} > 30)`);
  if (pool.dilutionScore > 60) bottlenecks.push(`High dilution (${pool.dilutionScore} > 60)`);
  
  const poolAgeDays = (Date.now() - pool.createdAt) / (1000 * 60 * 60 * 24);
  if (poolAgeDays < 3) bottlenecks.push(`Young pool (${poolAgeDays.toFixed(1)} days < 3)`);
  
  if (bottlenecks.length > 0) {
    logger.info(`   Likely bottlenecks:`);
    bottlenecks.forEach(b => logger.info(`     • ${b}`));
  }
  
  if (additionalReason) {
    logger.info(`   Additional: ${additionalReason}`);
  }
  
  logger.info('');
}
