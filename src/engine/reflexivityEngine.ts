/**
 * Cross-Pool Reflexivity Scoring Engine - Tier 4 Predator Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TRACK POOLS LIKE ORGANISMS IN AN ECOSYSTEM
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * When Pool A goes dormant:
 * - Does Pool B spike in the same base token?
 * - Is there liquidity migration across correlated DLMM markets?
 * - Is entropy increasing in neighboring pairs?
 * 
 * Give a pool a +X score multiplier if its neighbors are losing structural stability.
 * This identifies where predatory LPs will attack next.
 * 
 * Formula:
 * reflexivityScore = +0.1 * (# correlated pools with negative liquidityFlow)
 * Cap at +15%.
 * 
 * Works beautifully on SOL → meme microcaps.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { 
    computeMicrostructureMetrics, 
    getPoolHistory,
    MicrostructureMetrics,
    DLMMTelemetry,
} from '../services/dlmmTelemetry';
import { getMomentumSlopes, MomentumSlopes } from '../scoring/momentumEngine';
import { computeMHI, MHIResult } from './microstructureHealthIndex';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool ecosystem state
 */
export interface PoolEcosystemState {
    poolId: string;
    poolName: string;
    baseToken: string;          // Token X mint (base)
    quoteToken: string;         // Token Y mint (quote)
    
    // Health metrics
    mhi: number;
    entropy: number;
    liquidityFlowPct: number;
    swapVelocity: number;
    
    // Slopes
    liquiditySlope: number;
    entropySlope: number;
    
    // Classification
    isDormant: boolean;
    isDraining: boolean;
    isStable: boolean;
    isGrowing: boolean;
    
    timestamp: number;
}

/**
 * Token correlation graph
 */
export interface TokenCorrelation {
    tokenMint: string;
    poolIds: string[];              // Pools containing this token
    aggregateLiquidityFlow: number; // Sum of liquidity flows
    aggregateEntropy: number;       // Average entropy
    drainingPoolCount: number;      // Pools with negative flow
    growingPoolCount: number;       // Pools with positive flow
}

/**
 * Reflexivity score result
 */
export interface ReflexivityResult {
    poolId: string;
    poolName: string;
    
    // Core score
    reflexivityScore: number;       // 0-0.15 (capped)
    reflexivityMultiplier: number;  // 1.0 + reflexivityScore
    
    // Analysis
    correlatedPools: number;
    drainingNeighbors: number;
    growingNeighbors: number;
    
    // Signals
    predatorOpportunity: boolean;
    migrationTarget: boolean;
    
    // Details
    baseTokenFlow: number;
    quoteTokenFlow: number;
    neighborEntropy: number;
    
    timestamp: number;
}

/**
 * Pool personality profile (for specialist focus)
 */
export interface PoolPersonality {
    poolId: string;
    poolName: string;
    
    // Behavioral patterns
    avgMHI: number;
    mhiVolatility: number;
    avgLiquidityFlow: number;
    avgSwapVelocity: number;
    
    // Cycle patterns
    typicalCycleLength: number;     // ms between dormant/active transitions
    lastActiveTime: number;
    lastDormantTime: number;
    
    // Predator detection
    predatorActivityScore: number;  // How often large LPs manipulate
    profitPotential: number;        // Historical profit opportunities
    
    // Trust score
    trustScore: number;             // 0-1, based on past interactions
    tradeCount: number;
    winRate: number;
    avgPnL: number;
    
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reflexivity configuration
 */
export const REFLEXIVITY_CONFIG = {
    // Score calculation
    scorePerDrainingNeighbor: 0.03,   // +3% per draining neighbor
    maxReflexivityBonus: 0.15,        // Cap at +15%
    
    // Thresholds
    dormantMHI: 0.40,                 // Below this = dormant
    drainingFlowThreshold: -0.02,     // Below this = draining
    growingFlowThreshold: 0.02,       // Above this = growing
    
    // Minimum neighbors for signal
    minNeighborsForSignal: 2,
    
    // Predator opportunity thresholds
    predatorOpportunityThreshold: 3,  // Need 3+ draining neighbors
    migrationTargetThreshold: 0.10,   // Need 10%+ reflexivity score
};

/**
 * Personality tracking configuration
 */
export const PERSONALITY_CONFIG = {
    // History depth
    maxHistoryLength: 100,
    minHistoryForProfile: 10,
    
    // Update intervals
    profileUpdateIntervalMs: 60_000,  // Update every minute
    
    // Trust score weights
    trustWeights: {
        winRate: 0.40,
        avgPnL: 0.30,
        mhiStability: 0.30,
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Pool ecosystem states - updated on each cycle
const ecosystemStates: Map<string, PoolEcosystemState> = new Map();

// Token correlation graph
const tokenCorrelations: Map<string, TokenCorrelation> = new Map();

// Pool personalities (long-term memory)
const poolPersonalities: Map<string, PoolPersonality> = new Map();

// Historical MHI for volatility calculation
const mhiHistory: Map<string, number[]> = new Map();

// Pool token mappings (poolId -> {base, quote})
const poolTokens: Map<string, { base: string; quote: string; name: string }> = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register pool token info.
 * Called when discovering pools.
 */
export function registerPoolTokens(
    poolId: string,
    baseToken: string,
    quoteToken: string,
    poolName: string
): void {
    poolTokens.set(poolId, { base: baseToken, quote: quoteToken, name: poolName });
}

/**
 * Update ecosystem state for a pool.
 * Called on each telemetry refresh.
 */
export function updateEcosystemState(poolId: string): PoolEcosystemState | null {
    const metrics = computeMicrostructureMetrics(poolId);
    const mhiResult = computeMHI(poolId);
    const slopes = getMomentumSlopes(poolId);
    const tokens = poolTokens.get(poolId);
    
    if (!metrics || !mhiResult || !tokens) {
        return null;
    }
    
    // Calculate liquidity flow
    const history = getPoolHistory(poolId);
    let liquidityFlowPct = 0;
    if (history.length >= 2) {
        const latest = history[history.length - 1];
        const previous = history[history.length - 2];
        liquidityFlowPct = previous.liquidityUSD > 0
            ? (latest.liquidityUSD - previous.liquidityUSD) / previous.liquidityUSD
            : 0;
    }
    
    // Classify pool state
    const isDormant = mhiResult.mhi < REFLEXIVITY_CONFIG.dormantMHI;
    const isDraining = liquidityFlowPct < REFLEXIVITY_CONFIG.drainingFlowThreshold;
    const isGrowing = liquidityFlowPct > REFLEXIVITY_CONFIG.growingFlowThreshold;
    const isStable = !isDormant && !isDraining && !isGrowing;
    
    const state: PoolEcosystemState = {
        poolId,
        poolName: tokens.name,
        baseToken: tokens.base,
        quoteToken: tokens.quote,
        mhi: mhiResult.mhi,
        entropy: metrics.poolEntropy,
        liquidityFlowPct,
        swapVelocity: metrics.swapVelocity / 100,
        liquiditySlope: slopes?.liquiditySlope ?? 0,
        entropySlope: slopes?.entropySlope ?? 0,
        isDormant,
        isDraining,
        isStable,
        isGrowing,
        timestamp: Date.now(),
    };
    
    ecosystemStates.set(poolId, state);
    
    // Update MHI history for volatility tracking
    updateMHIHistory(poolId, mhiResult.mhi);
    
    return state;
}

/**
 * Update MHI history for a pool
 */
function updateMHIHistory(poolId: string, mhi: number): void {
    let history = mhiHistory.get(poolId);
    if (!history) {
        history = [];
        mhiHistory.set(poolId, history);
    }
    
    history.push(mhi);
    
    // Limit history length
    while (history.length > PERSONALITY_CONFIG.maxHistoryLength) {
        history.shift();
    }
}

/**
 * Build token correlation graph from current ecosystem states.
 */
export function buildTokenCorrelations(): void {
    tokenCorrelations.clear();
    
    for (const [poolId, state] of ecosystemStates) {
        // Process base token
        updateTokenCorrelation(state.baseToken, poolId, state);
        
        // Process quote token
        updateTokenCorrelation(state.quoteToken, poolId, state);
    }
}

/**
 * Update correlation data for a token
 */
function updateTokenCorrelation(tokenMint: string, poolId: string, state: PoolEcosystemState): void {
    let correlation = tokenCorrelations.get(tokenMint);
    
    if (!correlation) {
        correlation = {
            tokenMint,
            poolIds: [],
            aggregateLiquidityFlow: 0,
            aggregateEntropy: 0,
            drainingPoolCount: 0,
            growingPoolCount: 0,
        };
        tokenCorrelations.set(tokenMint, correlation);
    }
    
    if (!correlation.poolIds.includes(poolId)) {
        correlation.poolIds.push(poolId);
    }
    
    correlation.aggregateLiquidityFlow += state.liquidityFlowPct;
    correlation.aggregateEntropy += state.entropy;
    
    if (state.isDraining) {
        correlation.drainingPoolCount++;
    }
    if (state.isGrowing) {
        correlation.growingPoolCount++;
    }
}

/**
 * Compute reflexivity score for a pool.
 * 
 * Higher score = more opportunity as neighbors are unstable.
 */
export function computeReflexivity(poolId: string): ReflexivityResult | null {
    const state = ecosystemStates.get(poolId);
    const tokens = poolTokens.get(poolId);
    
    if (!state || !tokens) {
        return null;
    }
    
    // Get correlations for both tokens
    const baseCorrelation = tokenCorrelations.get(tokens.base);
    const quoteCorrelation = tokenCorrelations.get(tokens.quote);
    
    // Count draining neighbors (exclude self)
    let drainingNeighbors = 0;
    let growingNeighbors = 0;
    let correlatedPools = 0;
    let neighborEntropySum = 0;
    
    const processedPools = new Set<string>();
    
    // Process base token neighbors
    if (baseCorrelation) {
        for (const neighborId of baseCorrelation.poolIds) {
            if (neighborId === poolId || processedPools.has(neighborId)) continue;
            processedPools.add(neighborId);
            
            const neighborState = ecosystemStates.get(neighborId);
            if (neighborState) {
                correlatedPools++;
                neighborEntropySum += neighborState.entropy;
                
                if (neighborState.isDraining) drainingNeighbors++;
                if (neighborState.isGrowing) growingNeighbors++;
            }
        }
    }
    
    // Process quote token neighbors
    if (quoteCorrelation) {
        for (const neighborId of quoteCorrelation.poolIds) {
            if (neighborId === poolId || processedPools.has(neighborId)) continue;
            processedPools.add(neighborId);
            
            const neighborState = ecosystemStates.get(neighborId);
            if (neighborState) {
                correlatedPools++;
                neighborEntropySum += neighborState.entropy;
                
                if (neighborState.isDraining) drainingNeighbors++;
                if (neighborState.isGrowing) growingNeighbors++;
            }
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REFLEXIVITY SCORE CALCULATION
    // reflexivityScore = scorePerDrainingNeighbor * drainingNeighbors
    // Capped at maxReflexivityBonus
    // ═══════════════════════════════════════════════════════════════════════════
    
    const rawReflexivityScore = REFLEXIVITY_CONFIG.scorePerDrainingNeighbor * drainingNeighbors;
    const reflexivityScore = Math.min(rawReflexivityScore, REFLEXIVITY_CONFIG.maxReflexivityBonus);
    const reflexivityMultiplier = 1.0 + reflexivityScore;
    
    // Determine signals
    const predatorOpportunity = drainingNeighbors >= REFLEXIVITY_CONFIG.predatorOpportunityThreshold &&
                                 !state.isDraining && state.mhi >= 0.50;
    
    const migrationTarget = reflexivityScore >= REFLEXIVITY_CONFIG.migrationTargetThreshold &&
                            state.isGrowing;
    
    // Calculate neighbor entropy
    const neighborEntropy = correlatedPools > 0 ? neighborEntropySum / correlatedPools : 0;
    
    // Token flow aggregates
    const baseTokenFlow = baseCorrelation?.aggregateLiquidityFlow ?? 0;
    const quoteTokenFlow = quoteCorrelation?.aggregateLiquidityFlow ?? 0;
    
    return {
        poolId,
        poolName: tokens.name,
        reflexivityScore,
        reflexivityMultiplier,
        correlatedPools,
        drainingNeighbors,
        growingNeighbors,
        predatorOpportunity,
        migrationTarget,
        baseTokenFlow,
        quoteTokenFlow,
        neighborEntropy,
        timestamp: Date.now(),
    };
}

/**
 * Get all predator opportunities.
 * Returns pools that are healthy while neighbors are draining.
 */
export function getPredatorOpportunities(): ReflexivityResult[] {
    const opportunities: ReflexivityResult[] = [];
    
    for (const [poolId] of ecosystemStates) {
        const result = computeReflexivity(poolId);
        if (result && result.predatorOpportunity) {
            opportunities.push(result);
        }
    }
    
    // Sort by reflexivity score descending
    opportunities.sort((a, b) => b.reflexivityScore - a.reflexivityScore);
    
    return opportunities;
}

/**
 * Get migration targets.
 * Returns pools that are growing and have high reflexivity.
 */
export function getMigrationTargets(): ReflexivityResult[] {
    const targets: ReflexivityResult[] = [];
    
    for (const [poolId] of ecosystemStates) {
        const result = computeReflexivity(poolId);
        if (result && result.migrationTarget) {
            targets.push(result);
        }
    }
    
    // Sort by reflexivity score descending
    targets.sort((a, b) => b.reflexivityScore - a.reflexivityScore);
    
    return targets;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POOL PERSONALITY PROFILING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update pool personality from trade result.
 * Called after each trade is closed.
 */
export function updatePoolPersonality(
    poolId: string,
    pnl: number,
    won: boolean
): void {
    const tokens = poolTokens.get(poolId);
    if (!tokens) return;
    
    let personality = poolPersonalities.get(poolId);
    
    if (!personality) {
        personality = {
            poolId,
            poolName: tokens.name,
            avgMHI: 0,
            mhiVolatility: 0,
            avgLiquidityFlow: 0,
            avgSwapVelocity: 0,
            typicalCycleLength: 0,
            lastActiveTime: Date.now(),
            lastDormantTime: 0,
            predatorActivityScore: 0,
            profitPotential: 0,
            trustScore: 0.50,  // Start neutral
            tradeCount: 0,
            winRate: 0,
            avgPnL: 0,
            timestamp: Date.now(),
        };
        poolPersonalities.set(poolId, personality);
    }
    
    // Update trade statistics
    personality.tradeCount++;
    personality.avgPnL = (personality.avgPnL * (personality.tradeCount - 1) + pnl) / personality.tradeCount;
    
    const winCount = personality.winRate * (personality.tradeCount - 1) + (won ? 1 : 0);
    personality.winRate = winCount / personality.tradeCount;
    
    // Update trust score
    updateTrustScore(personality);
    
    // Update MHI statistics
    updateMHIStatistics(personality, poolId);
    
    personality.timestamp = Date.now();
}

/**
 * Update trust score based on performance
 */
function updateTrustScore(personality: PoolPersonality): void {
    const { trustWeights } = PERSONALITY_CONFIG;
    
    // Win rate component (0-1)
    const winRateScore = personality.winRate;
    
    // PnL component (normalized, -1 to 1)
    const pnlScore = Math.max(-1, Math.min(1, personality.avgPnL / 50));  // $50 = 1.0
    const normalizedPnL = (pnlScore + 1) / 2;  // Convert to 0-1
    
    // MHI stability component (inverse of volatility)
    const stabilityScore = Math.max(0, 1 - personality.mhiVolatility);
    
    personality.trustScore = 
        winRateScore * trustWeights.winRate +
        normalizedPnL * trustWeights.avgPnL +
        stabilityScore * trustWeights.mhiStability;
}

/**
 * Update MHI statistics from history
 */
function updateMHIStatistics(personality: PoolPersonality, poolId: string): void {
    const history = mhiHistory.get(poolId);
    if (!history || history.length < 2) return;
    
    // Calculate average MHI
    personality.avgMHI = history.reduce((a, b) => a + b, 0) / history.length;
    
    // Calculate MHI volatility (standard deviation)
    const variance = history.reduce((sum, mhi) => sum + Math.pow(mhi - personality.avgMHI, 2), 0) / history.length;
    personality.mhiVolatility = Math.sqrt(variance);
}

/**
 * Get pool personality.
 */
export function getPoolPersonality(poolId: string): PoolPersonality | null {
    return poolPersonalities.get(poolId) || null;
}

/**
 * Get top trusted pools (specialist focus).
 */
export function getTopTrustedPools(limit: number = 5): PoolPersonality[] {
    const profiles = Array.from(poolPersonalities.values());
    
    // Filter by minimum trade count
    const qualified = profiles.filter(p => p.tradeCount >= PERSONALITY_CONFIG.minHistoryForProfile);
    
    // Sort by trust score descending
    qualified.sort((a, b) => b.trustScore - a.trustScore);
    
    return qualified.slice(0, limit);
}

/**
 * Check if pool is a "specialist" pool (high trust, good history).
 */
export function isSpecialistPool(poolId: string): boolean {
    const personality = poolPersonalities.get(poolId);
    if (!personality) return false;
    
    return personality.tradeCount >= 5 && personality.trustScore >= 0.70;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update all ecosystem states and correlations.
 * Called on each scan cycle.
 */
export function updateAllEcosystemStates(poolIds: string[]): void {
    // Update individual states
    for (const poolId of poolIds) {
        updateEcosystemState(poolId);
    }
    
    // Rebuild correlations
    buildTokenCorrelations();
}

/**
 * Get reflexivity scores for all pools.
 */
export function getAllReflexivityScores(): Map<string, ReflexivityResult> {
    const results = new Map<string, ReflexivityResult>();
    
    for (const [poolId] of ecosystemStates) {
        const result = computeReflexivity(poolId);
        if (result) {
            results.set(poolId, result);
        }
    }
    
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log reflexivity summary
 */
export function logReflexivitySummary(): void {
    const predatorOpps = getPredatorOpportunities();
    const migrationTargets = getMigrationTargets();
    
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('CROSS-POOL REFLEXIVITY ANALYSIS');
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`Tracked Pools: ${ecosystemStates.size}`);
    logger.info(`Token Correlations: ${tokenCorrelations.size}`);
    logger.info(`Predator Opportunities: ${predatorOpps.length}`);
    logger.info(`Migration Targets: ${migrationTargets.length}`);
    
    if (predatorOpps.length > 0) {
        logger.info('');
        logger.info('🦅 PREDATOR OPPORTUNITIES:');
        for (const opp of predatorOpps.slice(0, 3)) {
            logger.info(
                `  ${opp.poolName} | ` +
                `reflexivity=${(opp.reflexivityScore * 100).toFixed(1)}% | ` +
                `draining=${opp.drainingNeighbors} | ` +
                `multiplier=${opp.reflexivityMultiplier.toFixed(2)}x`
            );
        }
    }
    
    if (migrationTargets.length > 0) {
        logger.info('');
        logger.info('🎯 MIGRATION TARGETS:');
        for (const target of migrationTargets.slice(0, 3)) {
            logger.info(
                `  ${target.poolName} | ` +
                `reflexivity=${(target.reflexivityScore * 100).toFixed(1)}% | ` +
                `growing=${target.growingNeighbors} | ` +
                `entropy=${target.neighborEntropy.toFixed(4)}`
            );
        }
    }
    
    logger.info('═══════════════════════════════════════════════════════════════');
}

/**
 * Log specialist pools
 */
export function logSpecialistPools(): void {
    const trusted = getTopTrustedPools(5);
    
    if (trusted.length === 0) {
        logger.debug('[PERSONALITY] No specialist pools yet');
        return;
    }
    
    logger.info('');
    logger.info('🎯 SPECIALIST POOLS (High Trust):');
    for (const p of trusted) {
        logger.info(
            `  ${p.poolName} | ` +
            `trust=${(p.trustScore * 100).toFixed(1)}% | ` +
            `winRate=${(p.winRate * 100).toFixed(1)}% | ` +
            `trades=${p.tradeCount} | ` +
            `avgPnL=$${p.avgPnL.toFixed(2)}`
        );
    }
}

/**
 * Clear all reflexivity state
 */
export function clearReflexivityState(): void {
    ecosystemStates.clear();
    tokenCorrelations.clear();
    mhiHistory.clear();
    logger.info('[REFLEXIVITY] Cleared ecosystem state');
}

/**
 * Clear pool personality data
 */
export function clearPoolPersonalities(): void {
    poolPersonalities.clear();
    logger.info('[PERSONALITY] Cleared pool personalities');
}

