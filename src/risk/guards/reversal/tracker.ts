/**
 * Reverse Entry Guard - History Tracker
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Track migration direction history and cooldown states per pool.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { MigrationDirection } from '../../../types';
import { HistoryTick, PoolCooldownState, ReversalGuardConfig } from './types';
import { DEFAULT_CONFIG } from './config';
import logger from '../../../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

/** Per-pool history of ticks */
const poolHistory: Map<string, HistoryTick[]> = new Map();

/** Per-pool cooldown states */
const poolCooldowns: Map<string, PoolCooldownState> = new Map();

/** Maximum ticks to keep per pool */
const MAX_HISTORY_SIZE = 50;

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a new tick for a pool
 */
export function recordTick(
    poolAddress: string,
    tick: Omit<HistoryTick, 'timestamp'>
): void {
    const history = poolHistory.get(poolAddress) ?? [];
    
    history.push({
        ...tick,
        timestamp: Date.now(),
    });
    
    // Trim old history
    if (history.length > MAX_HISTORY_SIZE) {
        history.splice(0, history.length - MAX_HISTORY_SIZE);
    }
    
    poolHistory.set(poolAddress, history);
}

/**
 * Get tick history for a pool
 */
export function getPoolHistory(poolAddress: string): HistoryTick[] {
    return poolHistory.get(poolAddress) ?? [];
}

/**
 * Get recent ticks for a pool
 */
export function getRecentTicks(
    poolAddress: string,
    count: number = DEFAULT_CONFIG.recentTickCount
): HistoryTick[] {
    const history = getPoolHistory(poolAddress);
    return history.slice(-count);
}

/**
 * Get historical ticks for comparison (excluding recent)
 */
export function getHistoricalTicks(
    poolAddress: string,
    recentCount: number = DEFAULT_CONFIG.recentTickCount,
    historicalCount: number = DEFAULT_CONFIG.historicalTickCount
): HistoryTick[] {
    const history = getPoolHistory(poolAddress);
    
    // Skip the most recent ticks
    const endIndex = Math.max(0, history.length - recentCount);
    const startIndex = Math.max(0, endIndex - historicalCount);
    
    return history.slice(startIndex, endIndex);
}

/**
 * Get migration direction history
 */
export function getMigrationDirectionHistory(
    poolAddress: string,
    count?: number
): MigrationDirection[] {
    const history = getPoolHistory(poolAddress);
    const sliced = count ? history.slice(-count) : history;
    return sliced.map(t => t.migrationDirection);
}

/**
 * Clear history for a pool
 */
export function clearPoolHistory(poolAddress: string): void {
    poolHistory.delete(poolAddress);
    logger.debug(`[REVERSAL_GUARD] Cleared history for ${poolAddress.slice(0, 8)}...`);
}

/**
 * Clear all history
 */
export function clearAllHistory(): void {
    poolHistory.clear();
    logger.info('[REVERSAL_GUARD] Cleared all pool history');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COOLDOWN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Set cooldown for a pool
 */
export function setCooldown(
    poolAddress: string,
    durationSeconds: number,
    reason: string
): void {
    poolCooldowns.set(poolAddress, {
        poolAddress,
        startedAt: Date.now(),
        durationSeconds,
        reason,
    });
    
    logger.info(`[REVERSAL_GUARD] Cooldown set for ${poolAddress.slice(0, 8)}...: ${durationSeconds}s - ${reason}`);
}

/**
 * Check if a pool is in cooldown
 */
export function isInCooldown(poolAddress: string): boolean {
    const state = poolCooldowns.get(poolAddress);
    if (!state) return false;
    
    const elapsed = (Date.now() - state.startedAt) / 1000;
    const inCooldown = elapsed < state.durationSeconds;
    
    // Clean up expired cooldown
    if (!inCooldown) {
        poolCooldowns.delete(poolAddress);
    }
    
    return inCooldown;
}

/**
 * Get remaining cooldown time in seconds
 */
export function getRemainingCooldown(poolAddress: string): number {
    const state = poolCooldowns.get(poolAddress);
    if (!state) return 0;
    
    const elapsed = (Date.now() - state.startedAt) / 1000;
    const remaining = Math.max(0, state.durationSeconds - elapsed);
    
    // Clean up expired cooldown
    if (remaining <= 0) {
        poolCooldowns.delete(poolAddress);
    }
    
    return remaining;
}

/**
 * Get cooldown state for a pool
 */
export function getCooldownState(poolAddress: string): PoolCooldownState | undefined {
    if (!isInCooldown(poolAddress)) return undefined;
    return poolCooldowns.get(poolAddress);
}

/**
 * Clear cooldown for a pool
 */
export function clearCooldown(poolAddress: string): void {
    poolCooldowns.delete(poolAddress);
}

/**
 * Clear all cooldowns
 */
export function clearAllCooldowns(): void {
    poolCooldowns.clear();
    logger.info('[REVERSAL_GUARD] Cleared all cooldowns');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYSIS HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Count consecutive migrations in the same direction (from most recent)
 */
export function countSustainedMigrations(poolAddress: string): {
    count: number;
    direction: MigrationDirection;
} {
    const history = getMigrationDirectionHistory(poolAddress);
    
    if (history.length === 0) {
        return { count: 0, direction: 'neutral' };
    }
    
    const latestDirection = history[history.length - 1];
    let count = 0;
    
    // Count backwards from most recent
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] === latestDirection) {
            count++;
        } else {
            break;
        }
    }
    
    return { count, direction: latestDirection };
}

/**
 * Detect if recent direction has flipped relative to historical
 */
export function detectDirectionFlip(
    poolAddress: string,
    config: ReversalGuardConfig = DEFAULT_CONFIG
): {
    flipped: boolean;
    recentDirection: MigrationDirection;
    historicalDirection: MigrationDirection;
} {
    const recentTicks = getRecentTicks(poolAddress, config.recentTickCount);
    const historicalTicks = getHistoricalTicks(
        poolAddress, 
        config.recentTickCount, 
        config.historicalTickCount
    );
    
    // Not enough data to detect flip
    if (recentTicks.length === 0 || historicalTicks.length === 0) {
        return {
            flipped: false,
            recentDirection: 'neutral',
            historicalDirection: 'neutral',
        };
    }
    
    // Get dominant direction from recent ticks
    const recentDirections = recentTicks.map(t => t.migrationDirection);
    const recentDirection = getDominantDirection(recentDirections);
    
    // Get dominant direction from historical ticks
    const historicalDirections = historicalTicks.map(t => t.migrationDirection);
    const historicalDirection = getDominantDirection(historicalDirections);
    
    // Check for flip (in → out or out → in)
    const flipped = (
        (recentDirection === 'in' && historicalDirection === 'out') ||
        (recentDirection === 'out' && historicalDirection === 'in')
    );
    
    return {
        flipped,
        recentDirection,
        historicalDirection,
    };
}

/**
 * Get dominant direction from a list of directions
 */
function getDominantDirection(directions: MigrationDirection[]): MigrationDirection {
    if (directions.length === 0) return 'neutral';
    
    let inCount = 0;
    let outCount = 0;
    let neutralCount = 0;
    
    for (const d of directions) {
        if (d === 'in') inCount++;
        else if (d === 'out') outCount++;
        else neutralCount++;
    }
    
    if (inCount > outCount && inCount > neutralCount) return 'in';
    if (outCount > inCount && outCount > neutralCount) return 'out';
    return 'neutral';
}

