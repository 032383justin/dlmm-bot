/**
 * Adaptive Pool Selection - Tracker
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tracks and manages the adaptive pool universe.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
    AdaptivePoolEntry,
    PoolStatus,
    AdaptivePoolConfig,
    PoolSelectionResult,
    PoolFilterCriteria,
    UniverseUpdateEvent,
} from './types';
import { DEFAULT_CONFIG } from './config';
import { 
    getPoolSharpe, 
    getPoolMetrics,
} from '../../risk/poolSharpeMemory';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const poolUniverse: Map<string, AdaptivePoolEntry> = new Map();
const updateHistory: UniverseUpdateEvent[] = [];
let lastRefreshTime = 0;
let nextRefreshTime = 0;

const MAX_HISTORY = 1000;

// ═══════════════════════════════════════════════════════════════════════════════
// UNIVERSE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Add a pool to the adaptive universe
 */
export function addPoolToUniverse(
    poolAddress: string,
    poolName: string,
    discoveryScore: number,
    origin: 'INITIAL' | 'REFRESH' | 'MANUAL' = 'INITIAL',
    config: AdaptivePoolConfig = DEFAULT_CONFIG
): AdaptivePoolEntry {
    const now = Date.now();
    
    // Check if already exists
    const existing = poolUniverse.get(poolAddress);
    if (existing) {
        // Update discovery score and refresh timestamp
        existing.discoveryScore = Math.max(existing.discoveryScore, discoveryScore);
        existing.lastActivityTime = now;
        recalculatePriority(existing, config);
        poolUniverse.set(poolAddress, existing);
        return existing;
    }
    
    // Create new entry
    const entry: AdaptivePoolEntry = {
        poolAddress,
        poolName,
        status: 'DISCOVERY',
        sharpeScore: 0.5, // Default neutral Sharpe
        normalizedSharpe: 0.58, // Normalized default
        discoveryScore,
        priorityScore: 0,
        tradeCount: 0,
        winRate: 0,
        totalPnL: 0,
        addedTime: now,
        lastActivityTime: now,
        blockCount: 0,
        origin,
    };
    
    recalculatePriority(entry, config);
    poolUniverse.set(poolAddress, entry);
    
    recordUpdate({
        type: 'ADD',
        poolAddress,
        poolName,
        newStatus: 'DISCOVERY',
        reason: `Added via ${origin} with discovery score ${discoveryScore.toFixed(2)}`,
        timestamp: now,
    });
    
    return entry;
}

/**
 * Remove a pool from the universe
 */
export function removePoolFromUniverse(
    poolAddress: string,
    reason: string
): boolean {
    const entry = poolUniverse.get(poolAddress);
    if (!entry) return false;
    
    poolUniverse.delete(poolAddress);
    
    recordUpdate({
        type: 'REMOVE',
        poolAddress,
        poolName: entry.poolName,
        previousStatus: entry.status,
        newStatus: 'EXPIRED',
        reason,
        timestamp: Date.now(),
    });
    
    return true;
}

/**
 * Update pool status
 */
export function updatePoolStatus(
    poolAddress: string,
    newStatus: PoolStatus,
    reason: string,
    config: AdaptivePoolConfig = DEFAULT_CONFIG
): boolean {
    const entry = poolUniverse.get(poolAddress);
    if (!entry) return false;
    
    const previousStatus = entry.status;
    
    if (previousStatus === newStatus) return true;
    
    entry.status = newStatus;
    entry.lastActivityTime = Date.now();
    
    if (newStatus === 'BLOCKED') {
        entry.blockCount++;
    }
    
    recalculatePriority(entry, config);
    poolUniverse.set(poolAddress, entry);
    
    recordUpdate({
        type: 'STATUS_CHANGE',
        poolAddress,
        poolName: entry.poolName,
        previousStatus,
        newStatus,
        reason,
        timestamp: Date.now(),
    });
    
    return true;
}

/**
 * Refresh pool metrics from Sharpe Memory
 */
export function refreshPoolMetrics(
    poolAddress: string,
    config: AdaptivePoolConfig = DEFAULT_CONFIG
): void {
    const entry = poolUniverse.get(poolAddress);
    if (!entry) return;
    
    const sharpeResult = getPoolSharpe(poolAddress);
    const metrics = getPoolMetrics(poolAddress);
    
    entry.sharpeScore = sharpeResult.sharpeScore;
    entry.normalizedSharpe = sharpeResult.normalizedSharpe;
    
    if (metrics) {
        entry.tradeCount = metrics.totalTrades;
        entry.winRate = metrics.winRate;
        entry.totalPnL = metrics.totalPnL;
    }
    
    recalculatePriority(entry, config);
    
    // Evaluate status change based on Sharpe
    if (entry.tradeCount >= config.minTradesForEvaluation) {
        evaluateStatusChange(entry, config);
    }
    
    poolUniverse.set(poolAddress, entry);
}

/**
 * Batch refresh all pool metrics
 */
export function refreshAllPoolMetrics(config: AdaptivePoolConfig = DEFAULT_CONFIG): void {
    for (const poolAddress of poolUniverse.keys()) {
        refreshPoolMetrics(poolAddress, config);
    }
    lastRefreshTime = Date.now();
    nextRefreshTime = lastRefreshTime + config.discoveryRefreshIntervalMs;
}

/**
 * Evaluate and change pool status based on Sharpe
 */
function evaluateStatusChange(
    entry: AdaptivePoolEntry,
    config: AdaptivePoolConfig
): void {
    const previousStatus = entry.status;
    let newStatus = previousStatus;
    let reason = '';
    
    // Check for blocking
    if (entry.sharpeScore < config.blockSharpeThreshold) {
        newStatus = 'BLOCKED';
        reason = `Sharpe ${entry.sharpeScore.toFixed(2)} < ${config.blockSharpeThreshold} block threshold`;
    }
    // Check for probation
    else if (entry.sharpeScore < config.probationSharpeThreshold) {
        if (previousStatus === 'ACTIVE') {
            newStatus = 'PROBATION';
            reason = `Sharpe ${entry.sharpeScore.toFixed(2)} < ${config.probationSharpeThreshold} probation threshold`;
        }
    }
    // Check for activation
    else if (entry.sharpeScore >= config.activeSharpeThreshold) {
        if (previousStatus === 'PROBATION' || previousStatus === 'DISCOVERY') {
            newStatus = 'ACTIVE';
            reason = `Sharpe ${entry.sharpeScore.toFixed(2)} >= ${config.activeSharpeThreshold} active threshold`;
        }
    }
    
    if (newStatus !== previousStatus) {
        entry.status = newStatus;
        
        if (newStatus === 'BLOCKED') {
            entry.blockCount++;
        }
        
        recordUpdate({
            type: 'STATUS_CHANGE',
            poolAddress: entry.poolAddress,
            poolName: entry.poolName,
            previousStatus,
            newStatus,
            reason,
            timestamp: Date.now(),
        });
    }
}

/**
 * Recalculate priority score
 */
function recalculatePriority(
    entry: AdaptivePoolEntry,
    config: AdaptivePoolConfig
): void {
    const now = Date.now();
    const weights = config.priorityWeights;
    
    // Sharpe component (normalized 0-1)
    const sharpeComponent = entry.normalizedSharpe * weights.sharpe;
    
    // Discovery component (normalized 0-1)
    const discoveryComponent = Math.min(1, entry.discoveryScore / 100) * weights.discovery;
    
    // Recency component (decays over time)
    const hoursSinceActivity = (now - entry.lastActivityTime) / (60 * 60 * 1000);
    const recencyComponent = Math.exp(-hoursSinceActivity / 24) * weights.recency;
    
    // Status penalty
    let statusMultiplier = 1;
    if (entry.status === 'PROBATION') statusMultiplier = 0.5;
    else if (entry.status === 'BLOCKED') statusMultiplier = 0;
    else if (entry.status === 'DISCOVERY') statusMultiplier = 0.7;
    
    entry.priorityScore = (sharpeComponent + discoveryComponent + recencyComponent) * statusMultiplier;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get pool entry from universe
 */
export function getPoolEntry(poolAddress: string): AdaptivePoolEntry | undefined {
    return poolUniverse.get(poolAddress);
}

/**
 * Get all pools in universe
 */
export function getAllPools(): AdaptivePoolEntry[] {
    return Array.from(poolUniverse.values());
}

/**
 * Get pools matching filter criteria
 */
export function getFilteredPools(criteria: PoolFilterCriteria = {}): AdaptivePoolEntry[] {
    let pools = Array.from(poolUniverse.values());
    
    if (criteria.activeOnly) {
        pools = pools.filter(p => p.status === 'ACTIVE');
    }
    
    if (criteria.includeProbation === false) {
        pools = pools.filter(p => p.status !== 'PROBATION');
    }
    
    if (criteria.minSharpe !== undefined) {
        pools = pools.filter(p => p.sharpeScore >= criteria.minSharpe!);
    }
    
    if (criteria.minTrades !== undefined) {
        pools = pools.filter(p => p.tradeCount >= criteria.minTrades!);
    }
    
    if (criteria.minWinRate !== undefined) {
        pools = pools.filter(p => p.winRate >= criteria.minWinRate!);
    }
    
    // Sort by priority (highest first)
    pools.sort((a, b) => b.priorityScore - a.priorityScore);
    
    if (criteria.limit !== undefined) {
        pools = pools.slice(0, criteria.limit);
    }
    
    return pools;
}

/**
 * Get pool selection result
 */
export function getPoolSelectionResult(
    config: AdaptivePoolConfig = DEFAULT_CONFIG
): PoolSelectionResult {
    const allPools = Array.from(poolUniverse.values());
    
    const activePools = allPools.filter(p => p.status === 'ACTIVE')
        .sort((a, b) => b.priorityScore - a.priorityScore);
    
    const probationPools = allPools.filter(p => p.status === 'PROBATION')
        .sort((a, b) => b.priorityScore - a.priorityScore);
    
    const blockedPools = allPools.filter(p => p.status === 'BLOCKED')
        .sort((a, b) => a.sharpeScore - b.sharpeScore);
    
    // Calculate discovery slots
    const discoverySlots = Math.max(
        0,
        Math.floor(config.maxActivePoolCount * config.discoveryRefreshFraction) - 
        allPools.filter(p => p.status === 'DISCOVERY').length
    );
    
    return {
        activePools,
        probationPools,
        blockedPools,
        discoverySlots,
        totalPools: allPools.length,
        lastRefreshTime,
        nextRefreshTime,
    };
}

/**
 * Check if pool is in active trading universe
 */
export function isPoolActive(poolAddress: string): boolean {
    const entry = poolUniverse.get(poolAddress);
    return entry?.status === 'ACTIVE';
}

/**
 * Check if pool is blocked
 */
export function isPoolBlocked(poolAddress: string): boolean {
    const entry = poolUniverse.get(poolAddress);
    return entry?.status === 'BLOCKED';
}

/**
 * Check if pool exists in universe
 */
export function isPoolInUniverse(poolAddress: string): boolean {
    return poolUniverse.has(poolAddress);
}

/**
 * Get pool count by status
 */
export function getPoolCountByStatus(): Record<PoolStatus, number> {
    const counts: Record<PoolStatus, number> = {
        ACTIVE: 0,
        PROBATION: 0,
        BLOCKED: 0,
        DISCOVERY: 0,
        EXPIRED: 0,
    };
    
    for (const entry of poolUniverse.values()) {
        counts[entry.status]++;
    }
    
    return counts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAINTENANCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Remove permanently blocked pools
 */
export function removePermanentlyBlocked(
    config: AdaptivePoolConfig = DEFAULT_CONFIG
): number {
    let removed = 0;
    
    for (const [poolAddress, entry] of poolUniverse.entries()) {
        if (entry.status === 'BLOCKED' && entry.blockCount >= config.maxBlockCount) {
            poolUniverse.delete(poolAddress);
            recordUpdate({
                type: 'REMOVE',
                poolAddress,
                poolName: entry.poolName,
                previousStatus: 'BLOCKED',
                newStatus: 'EXPIRED',
                reason: `Permanently removed after ${entry.blockCount} blocks`,
                timestamp: Date.now(),
            });
            removed++;
        }
    }
    
    return removed;
}

/**
 * Mark stale pools as expired
 */
export function expireStalePools(
    config: AdaptivePoolConfig = DEFAULT_CONFIG
): number {
    const now = Date.now();
    const cutoff = now - config.staleTimeMs;
    let expired = 0;
    
    for (const entry of poolUniverse.values()) {
        if (entry.lastActivityTime < cutoff && entry.status !== 'BLOCKED') {
            updatePoolStatus(entry.poolAddress, 'EXPIRED', `No activity for ${Math.round((now - entry.lastActivityTime) / (60 * 60 * 1000))} hours`, config);
            expired++;
        }
    }
    
    return expired;
}

/**
 * Record update event
 */
function recordUpdate(event: UniverseUpdateEvent): void {
    updateHistory.push(event);
    
    // Trim history
    while (updateHistory.length > MAX_HISTORY) {
        updateHistory.shift();
    }
}

/**
 * Get update history
 */
export function getUpdateHistory(limit: number = 100): UniverseUpdateEvent[] {
    return updateHistory.slice(-limit);
}

/**
 * Clear all data (for testing)
 */
export function clearUniverse(): void {
    poolUniverse.clear();
    updateHistory.length = 0;
    lastRefreshTime = 0;
    nextRefreshTime = 0;
}

/**
 * Get universe size
 */
export function getUniverseSize(): number {
    return poolUniverse.size;
}

