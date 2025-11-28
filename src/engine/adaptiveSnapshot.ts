/**
 * Adaptive Snapshot Frequency Controller - Tier 4 Predator Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * NEVER USE FIXED SNAPSHOT INTERVALS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * The bot must compress or expand telemetry frequency based on activity.
 * 
 * Key rule:
 * - More trades = more frequent snapshots
 * - Dormancy = slower snapshots
 * 
 * Implementation:
 * snapshotIntervalMs = baseline * (1 - (swapVelocity / maxSwapWindow))
 * 
 * Hard bounds:
 * - min: 10s
 * - max: 60s
 * 
 * This prevents "dying by lag" without overprocessing.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { 
    computeMicrostructureMetrics, 
    getPoolHistory,
    MicrostructureMetrics,
} from '../services/dlmmTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool activity level classification
 */
export type ActivityLevel = 'HYPERACTIVE' | 'ACTIVE' | 'NORMAL' | 'DORMANT' | 'DEAD';

/**
 * Snapshot frequency state for a pool
 */
export interface SnapshotFrequencyState {
    poolId: string;
    
    // Current settings
    currentIntervalMs: number;
    lastSnapshotTime: number;
    nextSnapshotTime: number;
    
    // Activity metrics
    activityLevel: ActivityLevel;
    avgSwapVelocity: number;
    avgBinVelocity: number;
    recentActivityTrend: 'increasing' | 'stable' | 'decreasing';
    
    // Adjustment tracking
    adjustmentCount: number;
    lastAdjustmentTime: number;
    intervalHistory: number[];
    
    timestamp: number;
}

/**
 * Global telemetry frequency state
 */
export interface GlobalFrequencyState {
    baselineIntervalMs: number;
    currentIntervalMs: number;
    activePoolCount: number;
    dormantPoolCount: number;
    avgMarketActivity: number;
    marketPressure: 'low' | 'medium' | 'high';
    
    timestamp: number;
}

/**
 * Snapshot schedule result
 */
export interface SnapshotSchedule {
    poolId: string;
    intervalMs: number;
    priority: 'high' | 'normal' | 'low';
    isDueNow: boolean;
    msUntilDue: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Adaptive snapshot configuration
 */
export const ADAPTIVE_SNAPSHOT_CONFIG = {
    // Hard bounds
    minIntervalMs: 10_000,        // 10 seconds minimum
    maxIntervalMs: 60_000,        // 60 seconds maximum
    
    // Baseline interval
    baselineIntervalMs: 30_000,   // 30 seconds default
    
    // Activity thresholds for swap velocity (swaps/sec)
    activityThresholds: {
        hyperactive: 0.50,         // > 0.50 swaps/sec
        active: 0.20,              // > 0.20 swaps/sec
        normal: 0.05,              // > 0.05 swaps/sec
        dormant: 0.01,             // > 0.01 swaps/sec
        dead: 0,                   // < 0.01 swaps/sec
    },
    
    // Interval multipliers by activity level
    intervalMultipliers: {
        HYPERACTIVE: 0.33,         // 10s (min)
        ACTIVE: 0.50,              // 15s
        NORMAL: 1.00,              // 30s
        DORMANT: 1.50,             // 45s
        DEAD: 2.00,                // 60s (max)
    },
    
    // Max swap velocity for formula (swaps/sec)
    maxSwapVelocityForScaling: 1.0,
    
    // Smoothing factor for interval changes (0-1)
    smoothingFactor: 0.3,         // 30% new value, 70% old value
    
    // Minimum interval change before applying
    minIntervalChangePct: 0.10,   // 10% minimum change
    
    // History length for averaging
    historyLength: 10,
    
    // Market pressure thresholds
    marketPressure: {
        high: 0.30,                // > 30% of pools are hyperactive/active
        medium: 0.15,              // > 15% of pools are hyperactive/active
        low: 0,                    // Rest
    },
    
    // Priority thresholds
    priorityThresholds: {
        high: 0.40,                // Activity > 0.40
        normal: 0.15,              // Activity > 0.15
        low: 0,                    // Rest
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════════════════════════

// Per-pool frequency states
const poolFrequencyStates: Map<string, SnapshotFrequencyState> = new Map();

// Global frequency state
let globalState: GlobalFrequencyState = {
    baselineIntervalMs: ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs,
    currentIntervalMs: ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs,
    activePoolCount: 0,
    dormantPoolCount: 0,
    avgMarketActivity: 0,
    marketPressure: 'low',
    timestamp: Date.now(),
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clamp a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Classify activity level from swap velocity
 */
function classifyActivityLevel(swapVelocity: number): ActivityLevel {
    const thresholds = ADAPTIVE_SNAPSHOT_CONFIG.activityThresholds;
    
    if (swapVelocity >= thresholds.hyperactive) return 'HYPERACTIVE';
    if (swapVelocity >= thresholds.active) return 'ACTIVE';
    if (swapVelocity >= thresholds.normal) return 'NORMAL';
    if (swapVelocity >= thresholds.dormant) return 'DORMANT';
    return 'DEAD';
}

/**
 * Calculate snapshot interval using adaptive formula
 * 
 * Formula: baseline * (1 - (swapVelocity / maxSwapWindow))
 */
function calculateAdaptiveInterval(swapVelocity: number, binVelocity: number): number {
    const config = ADAPTIVE_SNAPSHOT_CONFIG;
    
    // Normalize swap velocity (0-1)
    const normalizedSwapVelocity = Math.min(swapVelocity / config.maxSwapVelocityForScaling, 1);
    
    // Apply formula: baseline * (1 - normalizedVelocity)
    // Higher velocity = lower interval
    let interval = config.baselineIntervalMs * (1 - normalizedSwapVelocity);
    
    // Add bin velocity adjustment (faster bin movement = faster snapshots)
    const binVelocityBonus = Math.min(binVelocity * 1000, 0.2);  // Max 20% reduction
    interval *= (1 - binVelocityBonus);
    
    // Clamp to bounds
    return clamp(interval, config.minIntervalMs, config.maxIntervalMs);
}

/**
 * Apply smoothing to interval change
 */
function smoothIntervalChange(currentInterval: number, newInterval: number): number {
    const smoothing = ADAPTIVE_SNAPSHOT_CONFIG.smoothingFactor;
    return (newInterval * smoothing) + (currentInterval * (1 - smoothing));
}

/**
 * Check if interval change is significant enough to apply
 */
function isSignificantChange(currentInterval: number, newInterval: number): boolean {
    const changePct = Math.abs(newInterval - currentInterval) / currentInterval;
    return changePct >= ADAPTIVE_SNAPSHOT_CONFIG.minIntervalChangePct;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute optimal snapshot interval for a pool.
 * Returns the interval in milliseconds.
 */
export function computePoolSnapshotInterval(poolId: string): number {
    const metrics = computeMicrostructureMetrics(poolId);
    
    if (!metrics) {
        // No metrics - use baseline
        return ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs;
    }
    
    // Get raw velocities (denormalize from 0-100)
    const swapVelocity = metrics.swapVelocity / 100;
    const binVelocity = metrics.binVelocity / 100;
    
    // Calculate adaptive interval
    const adaptiveInterval = calculateAdaptiveInterval(swapVelocity, binVelocity);
    
    // Get existing state for smoothing
    const existingState = poolFrequencyStates.get(poolId);
    
    if (existingState) {
        // Apply smoothing
        const smoothedInterval = smoothIntervalChange(existingState.currentIntervalMs, adaptiveInterval);
        
        // Only apply if significant change
        if (isSignificantChange(existingState.currentIntervalMs, smoothedInterval)) {
            return Math.round(smoothedInterval);
        }
        return existingState.currentIntervalMs;
    }
    
    return Math.round(adaptiveInterval);
}

/**
 * Update snapshot frequency state for a pool.
 */
export function updatePoolFrequencyState(poolId: string): SnapshotFrequencyState {
    const now = Date.now();
    const metrics = computeMicrostructureMetrics(poolId);
    
    // Get or create state
    let state = poolFrequencyStates.get(poolId);
    const isNew = !state;
    
    if (!state) {
        state = {
            poolId,
            currentIntervalMs: ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs,
            lastSnapshotTime: now,
            nextSnapshotTime: now + ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs,
            activityLevel: 'NORMAL',
            avgSwapVelocity: 0,
            avgBinVelocity: 0,
            recentActivityTrend: 'stable',
            adjustmentCount: 0,
            lastAdjustmentTime: now,
            intervalHistory: [],
            timestamp: now,
        };
        poolFrequencyStates.set(poolId, state);
    }
    
    if (!metrics) {
        return state;
    }
    
    // Extract velocities
    const swapVelocity = metrics.swapVelocity / 100;
    const binVelocity = metrics.binVelocity / 100;
    
    // Update averages (simple moving average)
    state.avgSwapVelocity = (state.avgSwapVelocity * 0.8) + (swapVelocity * 0.2);
    state.avgBinVelocity = (state.avgBinVelocity * 0.8) + (binVelocity * 0.2);
    
    // Classify activity level
    state.activityLevel = classifyActivityLevel(state.avgSwapVelocity);
    
    // Determine activity trend
    const velocityDelta = swapVelocity - state.avgSwapVelocity;
    if (velocityDelta > 0.05) {
        state.recentActivityTrend = 'increasing';
    } else if (velocityDelta < -0.05) {
        state.recentActivityTrend = 'decreasing';
    } else {
        state.recentActivityTrend = 'stable';
    }
    
    // Calculate new interval
    const newInterval = computePoolSnapshotInterval(poolId);
    
    // Apply if significant change
    if (isNew || isSignificantChange(state.currentIntervalMs, newInterval)) {
        // Record history
        state.intervalHistory.push(state.currentIntervalMs);
        if (state.intervalHistory.length > ADAPTIVE_SNAPSHOT_CONFIG.historyLength) {
            state.intervalHistory.shift();
        }
        
        state.currentIntervalMs = newInterval;
        state.adjustmentCount++;
        state.lastAdjustmentTime = now;
    }
    
    // Update next snapshot time
    state.nextSnapshotTime = state.lastSnapshotTime + state.currentIntervalMs;
    state.timestamp = now;
    
    return state;
}

/**
 * Mark that a snapshot was taken for a pool.
 */
export function markSnapshotTaken(poolId: string): void {
    const state = poolFrequencyStates.get(poolId);
    if (state) {
        state.lastSnapshotTime = Date.now();
        state.nextSnapshotTime = state.lastSnapshotTime + state.currentIntervalMs;
    }
}

/**
 * Check if a pool is due for a snapshot.
 */
export function isSnapshotDue(poolId: string): boolean {
    const state = poolFrequencyStates.get(poolId);
    if (!state) {
        return true;  // No state = never snapshotted = due
    }
    return Date.now() >= state.nextSnapshotTime;
}

/**
 * Get snapshot schedule for a pool.
 */
export function getSnapshotSchedule(poolId: string): SnapshotSchedule {
    const state = poolFrequencyStates.get(poolId);
    const now = Date.now();
    
    if (!state) {
        return {
            poolId,
            intervalMs: ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs,
            priority: 'normal',
            isDueNow: true,
            msUntilDue: 0,
        };
    }
    
    const msUntilDue = Math.max(0, state.nextSnapshotTime - now);
    const isDueNow = msUntilDue === 0;
    
    // Determine priority based on activity
    let priority: 'high' | 'normal' | 'low';
    if (state.avgSwapVelocity >= ADAPTIVE_SNAPSHOT_CONFIG.priorityThresholds.high) {
        priority = 'high';
    } else if (state.avgSwapVelocity >= ADAPTIVE_SNAPSHOT_CONFIG.priorityThresholds.normal) {
        priority = 'normal';
    } else {
        priority = 'low';
    }
    
    return {
        poolId,
        intervalMs: state.currentIntervalMs,
        priority,
        isDueNow,
        msUntilDue,
    };
}

/**
 * Update global frequency state from all pools.
 */
export function updateGlobalFrequencyState(): GlobalFrequencyState {
    const now = Date.now();
    
    let activeCount = 0;
    let dormantCount = 0;
    let totalActivity = 0;
    let poolCount = 0;
    
    for (const state of poolFrequencyStates.values()) {
        poolCount++;
        totalActivity += state.avgSwapVelocity;
        
        if (state.activityLevel === 'HYPERACTIVE' || state.activityLevel === 'ACTIVE') {
            activeCount++;
        } else if (state.activityLevel === 'DORMANT' || state.activityLevel === 'DEAD') {
            dormantCount++;
        }
    }
    
    const avgMarketActivity = poolCount > 0 ? totalActivity / poolCount : 0;
    const activeRatio = poolCount > 0 ? activeCount / poolCount : 0;
    
    // Determine market pressure
    let marketPressure: 'low' | 'medium' | 'high';
    if (activeRatio >= ADAPTIVE_SNAPSHOT_CONFIG.marketPressure.high) {
        marketPressure = 'high';
    } else if (activeRatio >= ADAPTIVE_SNAPSHOT_CONFIG.marketPressure.medium) {
        marketPressure = 'medium';
    } else {
        marketPressure = 'low';
    }
    
    // Adjust global interval based on market pressure
    let currentIntervalMs = ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs;
    switch (marketPressure) {
        case 'high':
            currentIntervalMs = ADAPTIVE_SNAPSHOT_CONFIG.minIntervalMs * 1.5;  // 15s
            break;
        case 'medium':
            currentIntervalMs = ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs * 0.75;  // 22.5s
            break;
        case 'low':
            currentIntervalMs = ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs;  // 30s
            break;
    }
    
    globalState = {
        baselineIntervalMs: ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs,
        currentIntervalMs: Math.round(currentIntervalMs),
        activePoolCount: activeCount,
        dormantPoolCount: dormantCount,
        avgMarketActivity,
        marketPressure,
        timestamp: now,
    };
    
    return globalState;
}

/**
 * Get the current global snapshot interval.
 */
export function getGlobalSnapshotInterval(): number {
    return globalState.currentIntervalMs;
}

/**
 * Get all pools that are due for a snapshot.
 */
export function getPoolsDueForSnapshot(): string[] {
    const duePools: string[] = [];
    const now = Date.now();
    
    for (const [poolId, state] of poolFrequencyStates) {
        if (now >= state.nextSnapshotTime) {
            duePools.push(poolId);
        }
    }
    
    return duePools;
}

/**
 * Get prioritized snapshot schedule for all pools.
 */
export function getPrioritizedSchedule(): SnapshotSchedule[] {
    const schedules: SnapshotSchedule[] = [];
    
    for (const poolId of poolFrequencyStates.keys()) {
        schedules.push(getSnapshotSchedule(poolId));
    }
    
    // Sort by priority and due time
    schedules.sort((a, b) => {
        // Priority ordering: high > normal > low
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        
        // Then by due time
        return a.msUntilDue - b.msUntilDue;
    });
    
    return schedules;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log adaptive snapshot summary
 */
export function logAdaptiveSnapshotSummary(): void {
    const state = updateGlobalFrequencyState();
    
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info('ADAPTIVE SNAPSHOT CONTROLLER');
    logger.info(`  Market Pressure: ${state.marketPressure.toUpperCase()}`);
    logger.info(`  Global Interval: ${state.currentIntervalMs}ms`);
    logger.info(`  Active Pools: ${state.activePoolCount} | Dormant: ${state.dormantPoolCount}`);
    logger.info(`  Avg Activity: ${state.avgMarketActivity.toFixed(4)} swaps/sec`);
    
    // Log per-activity-level counts
    const activityCounts = { HYPERACTIVE: 0, ACTIVE: 0, NORMAL: 0, DORMANT: 0, DEAD: 0 };
    for (const ps of poolFrequencyStates.values()) {
        activityCounts[ps.activityLevel]++;
    }
    
    logger.info(
        `  Activity Distribution: ` +
        `🔥${activityCounts.HYPERACTIVE} ` +
        `⚡${activityCounts.ACTIVE} ` +
        `✓${activityCounts.NORMAL} ` +
        `💤${activityCounts.DORMANT} ` +
        `💀${activityCounts.DEAD}`
    );
    logger.info('───────────────────────────────────────────────────────────────');
}

/**
 * Log pool frequency state
 */
export function logPoolFrequencyState(poolId: string): void {
    const state = poolFrequencyStates.get(poolId);
    if (!state) {
        logger.debug(`[ADAPTIVE] Pool ${poolId.slice(0, 8)}... not tracked`);
        return;
    }
    
    const activityEmoji = {
        HYPERACTIVE: '🔥',
        ACTIVE: '⚡',
        NORMAL: '✓',
        DORMANT: '💤',
        DEAD: '💀',
    }[state.activityLevel];
    
    logger.debug(
        `[ADAPTIVE] ${poolId.slice(0, 8)}... | ` +
        `${activityEmoji} ${state.activityLevel} | ` +
        `interval=${state.currentIntervalMs}ms | ` +
        `velocity=${state.avgSwapVelocity.toFixed(4)} | ` +
        `trend=${state.recentActivityTrend}`
    );
}

/**
 * Clear all frequency state
 */
export function clearFrequencyState(): void {
    poolFrequencyStates.clear();
    globalState = {
        baselineIntervalMs: ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs,
        currentIntervalMs: ADAPTIVE_SNAPSHOT_CONFIG.baselineIntervalMs,
        activePoolCount: 0,
        dormantPoolCount: 0,
        avgMarketActivity: 0,
        marketPressure: 'low',
        timestamp: Date.now(),
    };
    logger.info('[ADAPTIVE] Cleared frequency state');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    ADAPTIVE_SNAPSHOT_CONFIG,
    SnapshotFrequencyState,
    GlobalFrequencyState,
};

