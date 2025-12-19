/**
 * Rate-Limited Logger — Reduce Log Spam While Preserving Observability
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 5 PRODUCTION LOGGING
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PROBLEM:
 *   Same log message (e.g., EXIT_TRIGGERED + EXIT-SUPPRESS) prints every 10s
 *   for each trade, creating massive log spam.
 * 
 * SOLUTION:
 *   Rate-limit identical logs to max once per N seconds
 *   Track suppression counts and emit periodic summaries
 * 
 * USAGE:
 *   import { rateLimitedLog, logSuppressionSummary } from './rateLimitedLogger';
 *   
 *   // Instead of: logger.info(`[EXIT-SUPPRESS] tradeId=... reason=...`)
 *   rateLimitedLog('exit-suppress', tradeId, `reason=${reason}`, 60000);
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from './logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const RATE_LIMIT_CONFIG = {
    /** Default rate limit (ms) */
    DEFAULT_RATE_LIMIT_MS: 60 * 1000, // 60 seconds
    
    /** Rate limit for exit suppression logs */
    EXIT_SUPPRESS_RATE_LIMIT_MS: 60 * 1000, // 60 seconds
    
    /** Rate limit for exit triggered logs */
    EXIT_TRIGGERED_RATE_LIMIT_MS: 120 * 1000, // 2 minutes
    
    /** Rate limit for harmonic check logs */
    HARMONIC_CHECK_RATE_LIMIT_MS: 60 * 1000, // 60 seconds
    
    /** Summary interval (ms) */
    SUMMARY_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
    
    /** Max tracked keys (prevent memory leak) */
    MAX_TRACKED_KEYS: 1000,
    
    /** Stale entry cleanup threshold (ms) */
    STALE_THRESHOLD_MS: 30 * 60 * 1000, // 30 minutes
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface RateLimitEntry {
    lastLogTime: number;
    suppressedCount: number;
    lastMessage: string;
    firstSuppressedTime: number;
    category: string;
}

interface SuppressionSummary {
    category: string;
    key: string;
    suppressedCount: number;
    durationMs: number;
    lastMessage: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const rateLimitMap = new Map<string, RateLimitEntry>();
let lastCleanupTime = Date.now();
let lastSummaryTime = Date.now();

// Aggregated stats
const categoryStats = new Map<string, {
    totalSuppressed: number;
    totalLogged: number;
    lastLogTime: number;
}>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log with rate limiting. Returns true if logged, false if suppressed.
 * 
 * @param category - Log category (e.g., 'exit-suppress', 'exit-triggered')
 * @param key - Unique identifier (e.g., tradeId or poolAddress)
 * @param message - Log message (will be prefixed with category)
 * @param rateLimitMs - Rate limit in milliseconds
 * @param logLevel - Log level ('info' | 'warn' | 'debug')
 * @returns true if logged, false if suppressed
 */
export function rateLimitedLog(
    category: string,
    key: string,
    message: string,
    rateLimitMs: number = RATE_LIMIT_CONFIG.DEFAULT_RATE_LIMIT_MS,
    logLevel: 'info' | 'warn' | 'debug' = 'info'
): boolean {
    const now = Date.now();
    const compositeKey = `${category}:${key}`;
    
    // Cleanup stale entries periodically
    if (now - lastCleanupTime > RATE_LIMIT_CONFIG.STALE_THRESHOLD_MS) {
        cleanupStaleEntries();
        lastCleanupTime = now;
    }
    
    // Check existing entry
    const existing = rateLimitMap.get(compositeKey);
    
    if (existing && (now - existing.lastLogTime) < rateLimitMs) {
        // Suppress this log
        existing.suppressedCount++;
        existing.lastMessage = message;
        
        // Update category stats
        updateCategoryStats(category, false);
        
        return false;
    }
    
    // Log this message
    const prefix = `[${category.toUpperCase()}]`;
    let logMessage = `${prefix} ${message}`;
    
    // If we had suppressed logs, add count
    if (existing && existing.suppressedCount > 0) {
        const durationSec = Math.floor((now - existing.firstSuppressedTime) / 1000);
        logMessage += ` (suppressed=${existing.suppressedCount} last${durationSec}s)`;
    }
    
    // Actually log
    switch (logLevel) {
        case 'warn':
            logger.warn(logMessage);
            break;
        case 'debug':
            logger.debug(logMessage);
            break;
        default:
            logger.info(logMessage);
    }
    
    // Update/create entry
    if (existing) {
        existing.lastLogTime = now;
        existing.suppressedCount = 0;
        existing.lastMessage = message;
        existing.firstSuppressedTime = now;
    } else {
        // Check if we need to evict old entries
        if (rateLimitMap.size >= RATE_LIMIT_CONFIG.MAX_TRACKED_KEYS) {
            evictOldestEntry();
        }
        
        rateLimitMap.set(compositeKey, {
            lastLogTime: now,
            suppressedCount: 0,
            lastMessage: message,
            firstSuppressedTime: now,
            category,
        });
    }
    
    // Update category stats
    updateCategoryStats(category, true);
    
    return true;
}

/**
 * Log exit suppression with automatic rate limiting
 */
export function logExitSuppressRateLimited(
    tradeId: string,
    poolName: string,
    reason: string,
    details: string
): boolean {
    const message = `pool=${poolName} tradeId=${tradeId.slice(0, 8)}... reason=${reason} ${details}`;
    return rateLimitedLog(
        'EXIT-SUPPRESS',
        tradeId,
        message,
        RATE_LIMIT_CONFIG.EXIT_SUPPRESS_RATE_LIMIT_MS,
        'info'
    );
}

/**
 * Log exit triggered with automatic rate limiting
 */
export function logExitTriggeredRateLimited(
    tradeId: string,
    poolName: string,
    reason: string,
    healthScore: number
): boolean {
    const message = `pool=${poolName} tradeId=${tradeId.slice(0, 8)}... reason=${reason} healthScore=${healthScore.toFixed(2)}`;
    return rateLimitedLog(
        'EXIT-TRIGGERED',
        tradeId,
        message,
        RATE_LIMIT_CONFIG.EXIT_TRIGGERED_RATE_LIMIT_MS,
        'warn'
    );
}

/**
 * Log harmonic check with automatic rate limiting
 */
export function logHarmonicCheckRateLimited(
    tradeId: string,
    poolName: string,
    status: string,
    badSamples: number,
    maxSamples: number
): boolean {
    const message = `pool=${poolName} tradeId=${tradeId.slice(0, 8)}... status=${status} badSamples=${badSamples}/${maxSamples}`;
    return rateLimitedLog(
        'HARMONIC-CHECK',
        tradeId,
        message,
        RATE_LIMIT_CONFIG.HARMONIC_CHECK_RATE_LIMIT_MS,
        'debug'
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get suppression summary for all tracked entries
 */
export function getSuppressionSummary(): SuppressionSummary[] {
    const summaries: SuppressionSummary[] = [];
    const now = Date.now();
    
    for (const [key, entry] of rateLimitMap) {
        if (entry.suppressedCount > 0) {
            summaries.push({
                category: entry.category,
                key,
                suppressedCount: entry.suppressedCount,
                durationMs: now - entry.firstSuppressedTime,
                lastMessage: entry.lastMessage,
            });
        }
    }
    
    return summaries.sort((a, b) => b.suppressedCount - a.suppressedCount);
}

/**
 * Log periodic summary of suppressions
 * Call this from main loop periodically
 */
export function logPeriodicSummary(forceLog: boolean = false): void {
    const now = Date.now();
    
    if (!forceLog && (now - lastSummaryTime) < RATE_LIMIT_CONFIG.SUMMARY_INTERVAL_MS) {
        return;
    }
    
    lastSummaryTime = now;
    
    // Aggregate by category
    const categoryAggregates = new Map<string, {
        totalSuppressed: number;
        uniqueKeys: number;
    }>();
    
    for (const [key, entry] of rateLimitMap) {
        if (entry.suppressedCount > 0) {
            const existing = categoryAggregates.get(entry.category) || {
                totalSuppressed: 0,
                uniqueKeys: 0,
            };
            existing.totalSuppressed += entry.suppressedCount;
            existing.uniqueKeys++;
            categoryAggregates.set(entry.category, existing);
        }
    }
    
    if (categoryAggregates.size === 0) {
        return; // Nothing to report
    }
    
    // Log summary
    let summaryParts: string[] = [];
    for (const [category, agg] of categoryAggregates) {
        summaryParts.push(`${category}=${agg.totalSuppressed}(${agg.uniqueKeys} keys)`);
    }
    
    logger.info(`[LOG-SUMMARY] Suppressed logs: ${summaryParts.join(' | ')}`);
    
    // Log top suppressions if significant
    const summaries = getSuppressionSummary().slice(0, 3);
    for (const s of summaries) {
        if (s.suppressedCount >= 5) {
            const durationMin = Math.floor(s.durationMs / 60000);
            logger.info(
                `[LOG-SUMMARY] Top: ${s.category} key=${s.key.split(':')[1]?.slice(0, 8) || s.key} ` +
                `suppressed=${s.suppressedCount} duration=${durationMin}min`
            );
        }
    }
}

/**
 * Get category statistics
 */
export function getCategoryStats(): Map<string, { totalSuppressed: number; totalLogged: number }> {
    return new Map(categoryStats);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAINTENANCE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function updateCategoryStats(category: string, logged: boolean): void {
    const existing = categoryStats.get(category) || {
        totalSuppressed: 0,
        totalLogged: 0,
        lastLogTime: 0,
    };
    
    if (logged) {
        existing.totalLogged++;
        existing.lastLogTime = Date.now();
    } else {
        existing.totalSuppressed++;
    }
    
    categoryStats.set(category, existing);
}

function cleanupStaleEntries(): void {
    const now = Date.now();
    const staleThreshold = now - RATE_LIMIT_CONFIG.STALE_THRESHOLD_MS;
    
    for (const [key, entry] of rateLimitMap) {
        if (entry.lastLogTime < staleThreshold && entry.suppressedCount === 0) {
            rateLimitMap.delete(key);
        }
    }
}

function evictOldestEntry(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    
    for (const [key, entry] of rateLimitMap) {
        if (entry.lastLogTime < oldestTime) {
            oldestTime = entry.lastLogTime;
            oldestKey = key;
        }
    }
    
    if (oldestKey) {
        rateLimitMap.delete(oldestKey);
    }
}

/**
 * Clear a specific key from rate limiting (e.g., when trade closes)
 */
export function clearRateLimitKey(category: string, key: string): void {
    const compositeKey = `${category}:${key}`;
    rateLimitMap.delete(compositeKey);
}

/**
 * Clear all rate limit state for a trade
 */
export function clearTradeRateLimits(tradeId: string): void {
    const keysToDelete: string[] = [];
    
    for (const key of rateLimitMap.keys()) {
        if (key.includes(tradeId)) {
            keysToDelete.push(key);
        }
    }
    
    for (const key of keysToDelete) {
        rateLimitMap.delete(key);
    }
}

/**
 * Reset all rate limiting state (for testing)
 */
export function resetRateLimitState(): void {
    rateLimitMap.clear();
    categoryStats.clear();
    lastCleanupTime = Date.now();
    lastSummaryTime = Date.now();
}

/**
 * Get current rate limit map size
 */
export function getRateLimitMapSize(): number {
    return rateLimitMap.size;
}

