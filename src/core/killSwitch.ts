/**
 * Kill Switch Module - Market-Wide Emergency Exit System
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * REDUCED HYPER-SENSITIVITY VERSION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * When triggered: Close ALL positions immediately, stop scanning, pause trading.
 * 
 * KEY CHANGES FROM PREVIOUS VERSION:
 * 1. Alive pool uses OR conditions (not strict AND)
 * 2. Kill requires multiple conditions (aliveRatio + snapshots + runtime + trades)
 * 3. Weighted market health from top 10 pools µScore
 * 4. 20-minute post-kill cooldown
 * 5. Hysteresis: requires higher thresholds to resume after kill
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { PREDATOR_CONFIG } from '../config/predatorModeConfig';
import { getAllDominanceStates, DominanceState } from '../capital/binDominanceTracker';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export interface KillSwitchSignal {
    triggered: boolean;
    reason: string;
    severity: 'warning' | 'critical' | 'emergency';
}

export interface KillDecision {
    killAll: boolean;
    reason: string;
    shouldPause: boolean;
    pauseDurationMs: number;
    debug?: KillSwitchDebug;
    /** Trade IDs that are protected from kill (DOMINANT positions in predator mode) */
    protectedTradeIds?: string[];
}

export interface KillSwitchDebug {
    aliveRatio: number;
    alivePoolCount: number;
    totalPoolCount: number;
    marketHealth: number;
    snapshotCount: number;
    runtimeMs: number;
    tradesCount: number;
    isInCooldown: boolean;
    cooldownRemainingMs: number;
    isKilled: boolean;
    resumeConditionsMet: boolean;
}

/**
 * Pool metrics for alive detection
 */
export interface PoolMetrics {
    poolId: string;
    swapVelocity: number;         // Swaps per second
    liquidityFlowPct: number;     // Liquidity change as % (negative = outflow)
    entropy: number;              // Pool health indicator (0-1)
    feeIntensity: number;         // Current fee intensity
    feeIntensityBaseline60s: number; // 60-second baseline fee intensity
    microScore: number;           // µScore for weighted health
}

/**
 * Kill switch evaluation context
 */
export interface KillSwitchContext {
    poolMetrics: PoolMetrics[];
    snapshotCount: number;        // Total snapshots collected
    runtimeMs: number;            // Bot runtime in ms
    activeTradesCount: number;    // Number of active positions
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const KILL_SWITCH_CONFIG = {
    // ═══════════════════════════════════════════════════════════════════════════
    // ALIVE POOL THRESHOLDS (OR conditions - any one makes pool alive)
    // ═══════════════════════════════════════════════════════════════════════════
    aliveThresholds: {
        swapVelocity: 0.015,           // > 0.015 swaps/sec
        liquidityFlowPct: 0.15,        // > 15% flow (in or out)
        entropy: 0.28,                  // > 0.28 entropy
        feeIntensityAboveBaseline: true, // feeIntensity > baseline(60s)
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // KILL TRIGGER CONDITIONS (ALL must be true)
    // RELAXED: Lowered maxAliveRatio to reduce false kill triggers
    // ═══════════════════════════════════════════════════════════════════════════
    killTrigger: {
        maxAliveRatio: 0.20,           // < 20% alive triggers kill (was 0.18, relaxed)
        minSnapshotCount: 12,          // Need at least 12 snapshots
        minRuntimeMs: 10 * 60 * 1000,  // 10 minutes minimum runtime
        minTradesCount: 4,             // At least 4 trades made
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // WEIGHTED MARKET HEALTH (top 10 pools µScore)
    // ═══════════════════════════════════════════════════════════════════════════
    marketHealth: {
        topPoolCount: 10,              // Use top 10 pools by µScore
        minHealthScore: 22,            // Kill if mean µScore < 22
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // COOLDOWN
    // ═══════════════════════════════════════════════════════════════════════════
    cooldown: {
        postKillDurationMs: 20 * 60 * 1000, // 20 minutes cooldown
    },
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HYSTERESIS (requirements to resume after kill)
    // ═══════════════════════════════════════════════════════════════════════════
    hysteresis: {
        minAliveRatioToResume: 0.28,   // > 28% alive to resume
        minHealthScoreToResume: 28,    // > 28 market health to resume
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Kill switch state (persistent across checks)
 */
interface KillSwitchState {
    isKilled: boolean;              // Currently in killed state
    killTimestamp: number;          // When kill was triggered
    cooldownUntil: number;          // Cooldown end timestamp
    lastCheckTimestamp: number;     // Last evaluation timestamp
    consecutiveKillConditions: number; // Consecutive checks meeting kill conditions
}

// Global state
let killSwitchState: KillSwitchState = {
    isKilled: false,
    killTimestamp: 0,
    cooldownUntil: 0,
    lastCheckTimestamp: 0,
    consecutiveKillConditions: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// ALIVE POOL DETECTION (OR conditions)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine if a pool is "alive" using OR conditions.
 * A pool is alive if ANY of the conditions are met.
 */
export function isPoolAlive(metrics: PoolMetrics): boolean {
    const config = KILL_SWITCH_CONFIG.aliveThresholds;
    
    // OR condition 1: swapVelocity above threshold
    if (metrics.swapVelocity > config.swapVelocity) {
        return true;
    }
    
    // OR condition 2: liquidityFlowPct above threshold (absolute value for flow)
    if (Math.abs(metrics.liquidityFlowPct) > config.liquidityFlowPct) {
        return true;
    }
    
    // OR condition 3: entropy above threshold
    if (metrics.entropy > config.entropy) {
        return true;
    }
    
    // OR condition 4: feeIntensity above 60s baseline
    if (config.feeIntensityAboveBaseline && 
        metrics.feeIntensity > metrics.feeIntensityBaseline60s &&
        metrics.feeIntensityBaseline60s > 0) {
        return true;
    }
    
    // None of the conditions met → pool is dead
    return false;
}

/**
 * Count alive pools and calculate alive ratio
 * 
 * FIXED: No longer assumes healthy when telemetry=0
 * Returns degraded state when denominator is 0
 */
export function calculateAliveRatio(poolMetrics: PoolMetrics[]): {
    aliveCount: number;
    totalCount: number;
    aliveRatio: number;
    isDegraded: boolean;
} {
    if (poolMetrics.length === 0) {
        // FIXED: Don't assume healthy - mark as degraded
        return { 
            aliveCount: 0, 
            totalCount: 0, 
            aliveRatio: 0,  // CHANGED: 0 not 1.0 when no data
            isDegraded: true,  // NEW: Flag for degraded state
        };
    }
    
    let aliveCount = 0;
    for (const metrics of poolMetrics) {
        if (isPoolAlive(metrics)) {
            aliveCount++;
        }
    }
    
    return {
        aliveCount,
        totalCount: poolMetrics.length,
        aliveRatio: aliveCount / poolMetrics.length,
        isDegraded: false,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEIGHTED MARKET HEALTH (top 10 pools µScore)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate weighted market health from top N pools by µScore
 */
export function calculateMarketHealth(poolMetrics: PoolMetrics[]): number {
    if (poolMetrics.length === 0) {
        return 50; // Neutral if no data
    }
    
    // Sort by µScore descending
    const sorted = [...poolMetrics].sort((a, b) => b.microScore - a.microScore);
    
    // Take top N pools
    const topPools = sorted.slice(0, KILL_SWITCH_CONFIG.marketHealth.topPoolCount);
    
    if (topPools.length === 0) {
        return 50;
    }
    
    // Calculate mean µScore
    const sum = topPools.reduce((acc, p) => acc + p.microScore, 0);
    return sum / topPools.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HYSTERESIS CHECK (resume conditions after kill)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if conditions are met to resume trading after a kill.
 * Requires HIGHER thresholds than kill trigger (hysteresis).
 */
export function checkResumeConditions(
    aliveRatio: number,
    marketHealth: number
): boolean {
    const hysteresis = KILL_SWITCH_CONFIG.hysteresis;
    
    return (
        aliveRatio > hysteresis.minAliveRatioToResume &&
        marketHealth > hysteresis.minHealthScoreToResume
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EVALUATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate kill switch conditions.
 * 
 * Kill trigger requires ALL of:
 * - aliveRatio < 0.18
 * - snapshotCount >= 12
 * - runtime >= 10 minutes
 * - tradesCount >= 4
 * - OR marketHealth < 22
 * 
 * Also respects cooldown and hysteresis.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// PREDATOR MODE: Protect DOMINANT positions from kill switch
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get trade IDs that are protected from kill switch.
 * In predator mode, DOMINANT positions cannot be force-exited by kill switch.
 * 
 * Kill switch behavior with predator mode:
 *   ❌ Cannot force exit from active dominant bins
 *   ✅ Can block new entries
 *   ✅ Can prevent new pools
 *   ❌ Cannot suppress rebalancing in active dominance mode
 */
function getProtectedDominantTradeIds(): string[] {
    if (!PREDATOR_CONFIG.ENABLED || !PREDATOR_CONFIG.KILL_SWITCH.BLOCK_DOMINANT_EXIT) {
        return [];
    }
    
    const dominanceStates = getAllDominanceStates();
    const protectedIds: string[] = [];
    
    for (const [tradeId, dominance] of dominanceStates) {
        if (dominance.metrics.dominanceState === 'DOMINANT') {
            protectedIds.push(tradeId);
            logger.debug(
                `[KILL-SWITCH] Protected position: ${tradeId.slice(0, 8)} | ` +
                `pool=${dominance.poolName} | state=DOMINANT | ` +
                `binSwapShare=${(dominance.metrics.binSwapShare * 100).toFixed(1)}%`
            );
        }
    }
    
    return protectedIds;
}

/**
 * Check if a specific trade ID is protected from kill switch exit
 */
export function isTradeProtectedFromKill(tradeId: string): boolean {
    if (!PREDATOR_CONFIG.ENABLED || !PREDATOR_CONFIG.KILL_SWITCH.BLOCK_DOMINANT_EXIT) {
        return false;
    }
    
    const dominanceStates = getAllDominanceStates();
    const dominance = dominanceStates.get(tradeId);
    
    return dominance?.metrics.dominanceState === 'DOMINANT';
}

export function evaluateKillSwitch(context: KillSwitchContext): KillDecision {
    const now = Date.now();
    const config = KILL_SWITCH_CONFIG;
    
    // Calculate metrics
    const { aliveCount, totalCount, aliveRatio, isDegraded } = calculateAliveRatio(context.poolMetrics);
    const marketHealth = calculateMarketHealth(context.poolMetrics);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DEGRADED STATE: Telemetry is 0/denominator is 0
    // Do NOT report healthy, mark as degraded and log warning
    // ═══════════════════════════════════════════════════════════════════════════
    if (isDegraded) {
        logger.warn(
            `[KILL-SWITCH] ⚠️ DEGRADED_STATE | telemetry=0 denominator=0 | ` +
            `Cannot evaluate kill switch - marking as DEGRADED (not healthy)`
        );
    }
    
    // Check cooldown
    const isInCooldown = now < killSwitchState.cooldownUntil;
    const cooldownRemainingMs = Math.max(0, killSwitchState.cooldownUntil - now);
    
    // Check resume conditions (only relevant if currently killed)
    const resumeConditionsMet = checkResumeConditions(aliveRatio, marketHealth);
    
    // Build debug info
    const debug: KillSwitchDebug = {
        aliveRatio,
        alivePoolCount: aliveCount,
        totalPoolCount: totalCount,
        marketHealth,
        snapshotCount: context.snapshotCount,
        runtimeMs: context.runtimeMs,
        tradesCount: context.activeTradesCount,
        isInCooldown,
        cooldownRemainingMs,
        isKilled: killSwitchState.isKilled,
        resumeConditionsMet,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CASE 1: Currently in killed state - check for resume
    // ═══════════════════════════════════════════════════════════════════════════
    if (killSwitchState.isKilled) {
        if (isInCooldown) {
            logger.info(
                `[KILL-SWITCH] 🔒 Cooldown active | ` +
                `remaining=${Math.ceil(cooldownRemainingMs / 1000)}s | ` +
                `aliveRatio=${(aliveRatio * 100).toFixed(1)}% | ` +
                `marketHealth=${marketHealth.toFixed(1)}`
            );
            
            return {
                killAll: false,
                reason: 'In cooldown',
                shouldPause: true,
                pauseDurationMs: cooldownRemainingMs,
                debug,
            };
        }
        
        // Check if resume conditions are met
        if (resumeConditionsMet) {
            logger.info(
                `[KILL-SWITCH] ✅ RESUME CONDITIONS MET | ` +
                `aliveRatio=${(aliveRatio * 100).toFixed(1)}% > ${(config.hysteresis.minAliveRatioToResume * 100).toFixed(1)}% | ` +
                `marketHealth=${marketHealth.toFixed(1)} > ${config.hysteresis.minHealthScoreToResume}`
            );
            
            // Reset killed state
            killSwitchState.isKilled = false;
            killSwitchState.consecutiveKillConditions = 0;
            
            return {
                killAll: false,
                reason: 'Resumed trading - conditions improved',
                shouldPause: false,
                pauseDurationMs: 0,
                debug,
            };
        } else {
            // Still killed, conditions not improved enough
            logger.warn(
                `[KILL-SWITCH] ⚠️ Still in killed state | ` +
                `aliveRatio=${(aliveRatio * 100).toFixed(1)}% (need >${(config.hysteresis.minAliveRatioToResume * 100).toFixed(1)}%) | ` +
                `marketHealth=${marketHealth.toFixed(1)} (need >${config.hysteresis.minHealthScoreToResume})`
            );
            
            return {
                killAll: false,
                reason: 'Waiting for resume conditions',
                shouldPause: true,
                pauseDurationMs: 60_000, // Check again in 1 minute
                debug,
            };
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CASE 2: Not killed - check kill conditions
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Check all kill trigger conditions (ALL must be true for aliveRatio-based kill)
    const meetsAliveRatioCondition = aliveRatio < config.killTrigger.maxAliveRatio;
    const meetsSnapshotCondition = context.snapshotCount >= config.killTrigger.minSnapshotCount;
    const meetsRuntimeCondition = context.runtimeMs >= config.killTrigger.minRuntimeMs;
    const meetsTradesCondition = context.activeTradesCount >= config.killTrigger.minTradesCount;
    
    // Check market health kill condition
    const meetsMarketHealthKill = marketHealth < config.marketHealth.minHealthScore;
    
    // Determine if kill should trigger
    const aliveRatioKill = (
        meetsAliveRatioCondition &&
        meetsSnapshotCondition &&
        meetsRuntimeCondition &&
        meetsTradesCondition
    );
    
    const marketHealthKill = (
        meetsMarketHealthKill &&
        meetsSnapshotCondition &&
        meetsRuntimeCondition
    );
    
    const shouldKill = aliveRatioKill || marketHealthKill;
    
    if (shouldKill) {
        killSwitchState.consecutiveKillConditions++;
        
        // Require 2 consecutive checks before triggering (reduce false positives)
        if (killSwitchState.consecutiveKillConditions >= 2) {
            // TRIGGER KILL
            killSwitchState.isKilled = true;
            killSwitchState.killTimestamp = now;
            killSwitchState.cooldownUntil = now + config.cooldown.postKillDurationMs;
            
            const reason = aliveRatioKill 
                ? `Market dormancy: ${(aliveRatio * 100).toFixed(1)}% alive < ${(config.killTrigger.maxAliveRatio * 100).toFixed(1)}%`
                : `Market health collapse: µScore ${marketHealth.toFixed(1)} < ${config.marketHealth.minHealthScore}`;
            
            // ═══════════════════════════════════════════════════════════════════
            // PREDATOR MODE: Protect DOMINANT positions from kill
            // Kill switch CANNOT force exit from active dominant bins
            // ═══════════════════════════════════════════════════════════════════
            const protectedTradeIds = getProtectedDominantTradeIds();
            
            logger.error(
                `[KILL-SWITCH] 🚨 KILL TRIGGERED | ` +
                `reason="${reason}" | ` +
                `aliveRatio=${(aliveRatio * 100).toFixed(1)}% | ` +
                `marketHealth=${marketHealth.toFixed(1)} | ` +
                `cooldown=${config.cooldown.postKillDurationMs / 60000}min | ` +
                `protectedPositions=${protectedTradeIds.length}`
            );
            
            if (protectedTradeIds.length > 0) {
                logger.warn(
                    `[KILL-SWITCH] 🦖 PREDATOR PROTECTION: ${protectedTradeIds.length} DOMINANT positions exempt from kill`
                );
            }
            
            return {
                killAll: true,
                reason,
                shouldPause: true,
                pauseDurationMs: config.cooldown.postKillDurationMs,
                debug,
                protectedTradeIds,
            };
        } else {
            logger.warn(
                `[KILL-SWITCH] ⚠️ Kill conditions met (${killSwitchState.consecutiveKillConditions}/2) | ` +
                `aliveRatio=${(aliveRatio * 100).toFixed(1)}% | ` +
                `marketHealth=${marketHealth.toFixed(1)} | ` +
                `Waiting for confirmation...`
            );
        }
    } else {
        // Reset consecutive counter if conditions not met
        killSwitchState.consecutiveKillConditions = 0;
    }
    
    // Log periodic status
    if (now - killSwitchState.lastCheckTimestamp > 60_000) {
        logger.info(
            `[KILL-SWITCH] ✅ Market healthy | ` +
            `aliveRatio=${(aliveRatio * 100).toFixed(1)}% | ` +
            `alivePools=${aliveCount}/${totalCount} | ` +
            `marketHealth=${marketHealth.toFixed(1)} | ` +
            `snapshots=${context.snapshotCount}`
        );
    }
    
    killSwitchState.lastCheckTimestamp = now;
    
    return {
        killAll: false,
        reason: '',
        shouldPause: false,
        pauseDurationMs: 0,
        debug,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY INTERFACE (for backwards compatibility with existing code)
// ═══════════════════════════════════════════════════════════════════════════════

import { Pool } from './normalizePools';
import { DLMMTelemetry, BinSnapshot } from './dlmmTelemetry';

// BinScore interface (originally from deleted binScoring.ts)
interface BinScore {
    starvation: number;
    concentration: number;
    imbalance: number;
    total: number;
}

/**
 * Legacy evaluateKill function for backward compatibility.
 * Converts old interface to new evaluateKillSwitch.
 */
export function evaluateKill(snapshotHistory: BinSnapshot[], positions: any[]): { killAll: boolean; reason: string } {
    // Convert legacy format to new context format
    // This is a simplified conversion - the new format is preferred
    
    const validSnapshots = snapshotHistory.filter(s => Object.keys(s.bins).length > 0);
    
    // Build minimal context from legacy data
    const context: KillSwitchContext = {
        poolMetrics: [], // Legacy doesn't have this - will use empty
        snapshotCount: validSnapshots.length,
        runtimeMs: validSnapshots.length * 8000, // Estimate from snapshot count
        activeTradesCount: positions.length,
    };
    
    // If not enough snapshots, skip kill switch (consistent with old behavior)
    if (validSnapshots.length < 5) {
        return { killAll: false, reason: '' };
    }
    
    const decision = evaluateKillSwitch(context);
    return {
        killAll: decision.killAll,
        reason: decision.reason,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reset kill switch state (for testing or manual recovery)
 */
export function resetKillSwitchState(): void {
    killSwitchState = {
        isKilled: false,
        killTimestamp: 0,
        cooldownUntil: 0,
        lastCheckTimestamp: 0,
        consecutiveKillConditions: 0,
    };
    logger.info('[KILL-SWITCH] State reset');
}

/**
 * Get current kill switch state
 */
export function getKillSwitchState(): Readonly<KillSwitchState> {
    return { ...killSwitchState };
}

/**
 * Check if trading is currently paused due to kill switch
 */
export function isKillSwitchActive(): boolean {
    return killSwitchState.isKilled;
}

/**
 * Get remaining cooldown time in milliseconds
 */
export function getKillSwitchCooldownRemaining(): number {
    return Math.max(0, killSwitchState.cooldownUntil - Date.now());
}

/**
 * Force resume trading (manual override)
 */
export function forceResumeTrading(): void {
    killSwitchState.isKilled = false;
    killSwitchState.cooldownUntil = 0;
    killSwitchState.consecutiveKillConditions = 0;
    logger.warn('[KILL-SWITCH] ⚠️ Trading FORCE RESUMED by manual override');
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUB FUNCTIONS (not implemented - for interface compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

export function checkKillSwitch(
    pool: Pool,
    telemetry: DLMMTelemetry,
    binScore: BinScore
): KillSwitchSignal {
    // TODO: Per-pool kill switch check (not implemented)
    return { triggered: false, reason: '', severity: 'warning' };
}

export function detectBinCollapse(telemetry: DLMMTelemetry): boolean {
    // TODO: Detect bin structure collapse
    return false;
}

export function detectLiquidityCrisis(telemetry: DLMMTelemetry): boolean {
    // TODO: Detect critical liquidity crisis
    return false;
}

export function detectAnomalousActivity(
    currentTelemetry: DLMMTelemetry,
    historicalTelemetry: DLMMTelemetry[]
): boolean {
    // TODO: Detect anomalous bin activity patterns
    return false;
}
