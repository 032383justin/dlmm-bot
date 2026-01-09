/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WATCHLIST POOLS — Manual Allowlist for Special Pools
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PROBLEM:
 * "Why no Pippin/SOL?" — Valid complaint. Usually caused by:
 *   - Hidden pools
 *   - Missing fields in discovery
 *   - Filtered out by thresholds
 *   - Not in Meteora list endpoint
 *   - Metadata/mints missing
 * 
 * SOLUTION:
 * "Watchlist Pools" (manual allowlist by address or symbol):
 *   - If in watchlist, BYPASSES discovery filters
 *   - Still MUST pass ES >= threshold (safety)
 *   - Log clearly: WATCHLIST_CONSIDERED, WATCHLIST_REJECTED(reason=...)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { ES_CONFIG } from '../scoring/extractabilityScore';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const WATCHLIST_CONFIG = {
    /** Enable watchlist system */
    ENABLED: true,
    
    /** Minimum ES score for watchlist pools (can be lower than normal threshold) */
    MIN_ES_FOR_WATCHLIST: 45,  // Lower than normal 55 threshold
    
    /** Watchlist pools by address (takes priority) */
    POOLS_BY_ADDRESS: new Map<string, WatchlistEntry>([
        // Add pool addresses here
        // ['POOL_ADDRESS', { name: 'POOL_NAME', reason: 'Manual add', addedAt: Date.now() }],
    ]),
    
    /** Watchlist pools by symbol/name pattern */
    POOLS_BY_SYMBOL: [
        // High-priority meme pools
        { pattern: 'PIPPIN', priority: 'HIGH' as WatchlistPriority, reason: 'High churn meme pool' },
        { pattern: 'BRAIN', priority: 'HIGH' as WatchlistPriority, reason: 'AI narrative pool' },
        { pattern: 'FISH', priority: 'MEDIUM' as WatchlistPriority, reason: 'Meme pool' },
        { pattern: 'BONK', priority: 'HIGH' as WatchlistPriority, reason: 'OG Solana meme' },
        { pattern: 'WIF', priority: 'HIGH' as WatchlistPriority, reason: 'High volume meme' },
        { pattern: 'POPCAT', priority: 'MEDIUM' as WatchlistPriority, reason: 'Cat meme' },
        { pattern: 'FARTCOIN', priority: 'MEDIUM' as WatchlistPriority, reason: 'Viral meme' },
        { pattern: 'GOAT', priority: 'MEDIUM' as WatchlistPriority, reason: 'AI meme' },
        { pattern: 'AI16Z', priority: 'HIGH' as WatchlistPriority, reason: 'AI DAO token' },
        { pattern: 'ZEREBRO', priority: 'MEDIUM' as WatchlistPriority, reason: 'AI narrative' },
        { pattern: 'ELIZA', priority: 'MEDIUM' as WatchlistPriority, reason: 'AI framework token' },
        { pattern: 'TRUMP', priority: 'HIGH' as WatchlistPriority, reason: 'Political meme' },
        { pattern: 'MELANIA', priority: 'MEDIUM' as WatchlistPriority, reason: 'Political meme' },
        { pattern: 'VINE', priority: 'MEDIUM' as WatchlistPriority, reason: 'Social token' },
        { pattern: 'ANIME', priority: 'MEDIUM' as WatchlistPriority, reason: 'Culture token' },
    ] as WatchlistSymbol[],
    
    /** Log watchlist activity */
    LOG_ACTIVITY: true,
    
    /** Bypass these discovery filters for watchlist pools */
    BYPASSED_FILTERS: [
        'MIN_TVL_USD',
        'MIN_VOLUME_24H_USD',
        'MIN_HOLDER_COUNT',
        'MIN_POOL_AGE_DAYS',
        'MIN_ACTIVE_BINS',
    ],
    
    /** These filters are NEVER bypassed (safety) */
    NEVER_BYPASS: [
        'TOKEN_RISK',        // Mintable/freezable
        'POOL_DEPRECATED',
        'POOL_MIGRATION',
        'DECIMALS_ERROR',
    ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface WatchlistEntry {
    name: string;
    reason: string;
    addedAt: number;
    priority?: 'HIGH' | 'MEDIUM' | 'LOW';
    notes?: string;
}

export type WatchlistPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface WatchlistSymbol {
    pattern: string;
    priority: WatchlistPriority;
    reason: string;
}

export interface WatchlistCheckResult {
    /** Is this pool on the watchlist? */
    isWatchlisted: boolean;
    
    /** Match type */
    matchType?: 'ADDRESS' | 'SYMBOL';
    
    /** Matched pattern or address */
    matchedBy?: string;
    
    /** Priority level */
    priority?: 'HIGH' | 'MEDIUM' | 'LOW';
    
    /** Reason for being on watchlist */
    reason?: string;
    
    /** Should this pool bypass discovery filters? */
    bypassFilters: boolean;
}

export interface WatchlistDecision {
    /** Consider this pool for deployment? */
    consider: boolean;
    
    /** Reason for decision */
    reason: string;
    
    /** ES score (if checked) */
    esScore?: number;
    
    /** Filters bypassed */
    filtersBypassed: string[];
    
    /** Was it rejected despite being watchlisted? */
    rejected: boolean;
    rejectionReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a pool is on the watchlist.
 */
export function checkWatchlist(
    poolAddress: string,
    poolName: string
): WatchlistCheckResult {
    if (!WATCHLIST_CONFIG.ENABLED) {
        return { isWatchlisted: false, bypassFilters: false };
    }
    
    // Check by address first (highest priority)
    const addressEntry = WATCHLIST_CONFIG.POOLS_BY_ADDRESS.get(poolAddress);
    if (addressEntry) {
        return {
            isWatchlisted: true,
            matchType: 'ADDRESS',
            matchedBy: poolAddress,
            priority: addressEntry.priority || 'HIGH',
            reason: addressEntry.reason,
            bypassFilters: true,
        };
    }
    
    // Check by symbol pattern
    const upperName = poolName.toUpperCase();
    for (const symbolEntry of WATCHLIST_CONFIG.POOLS_BY_SYMBOL) {
        if (upperName.includes(symbolEntry.pattern)) {
            return {
                isWatchlisted: true,
                matchType: 'SYMBOL',
                matchedBy: symbolEntry.pattern,
                priority: symbolEntry.priority,
                reason: symbolEntry.reason,
                bypassFilters: true,
            };
        }
    }
    
    return { isWatchlisted: false, bypassFilters: false };
}

/**
 * Add a pool to the watchlist by address.
 */
export function addToWatchlist(
    poolAddress: string,
    name: string,
    reason: string,
    priority: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM'
): void {
    WATCHLIST_CONFIG.POOLS_BY_ADDRESS.set(poolAddress, {
        name,
        reason,
        addedAt: Date.now(),
        priority,
    });
    
    logger.info(
        `[WATCHLIST] ADDED | address=${poolAddress.slice(0, 8)} name=${name} | ` +
        `priority=${priority} reason="${reason}"`
    );
}

/**
 * Remove a pool from the watchlist.
 */
export function removeFromWatchlist(poolAddress: string): boolean {
    const existed = WATCHLIST_CONFIG.POOLS_BY_ADDRESS.has(poolAddress);
    WATCHLIST_CONFIG.POOLS_BY_ADDRESS.delete(poolAddress);
    
    if (existed) {
        logger.info(`[WATCHLIST] REMOVED | address=${poolAddress.slice(0, 8)}`);
    }
    
    return existed;
}

/**
 * Evaluate watchlist pool for deployment.
 * Returns whether to consider despite failing normal filters.
 */
export function evaluateWatchlistPool(
    poolAddress: string,
    poolName: string,
    esScore: number,
    failedFilters: string[]
): WatchlistDecision {
    const watchlistCheck = checkWatchlist(poolAddress, poolName);
    
    // Not on watchlist = normal processing
    if (!watchlistCheck.isWatchlisted) {
        return {
            consider: false,
            reason: 'Not on watchlist',
            filtersBypassed: [],
            rejected: false,
        };
    }
    
    // On watchlist - check ES threshold
    if (esScore < WATCHLIST_CONFIG.MIN_ES_FOR_WATCHLIST) {
        if (WATCHLIST_CONFIG.LOG_ACTIVITY) {
            logger.info(
                `[WATCHLIST] REJECTED | pool=${poolName} | ` +
                `ES=${esScore.toFixed(1)} < ${WATCHLIST_CONFIG.MIN_ES_FOR_WATCHLIST} min threshold | ` +
                `Even watchlist pools need minimum extractability`
            );
        }
        
        return {
            consider: false,
            reason: `ES ${esScore.toFixed(1)} below watchlist minimum ${WATCHLIST_CONFIG.MIN_ES_FOR_WATCHLIST}`,
            esScore,
            filtersBypassed: [],
            rejected: true,
            rejectionReason: 'ES_TOO_LOW',
        };
    }
    
    // Check for non-bypassable filters
    const nonBypassable = failedFilters.filter(f => 
        WATCHLIST_CONFIG.NEVER_BYPASS.some(nb => f.toUpperCase().includes(nb))
    );
    
    if (nonBypassable.length > 0) {
        if (WATCHLIST_CONFIG.LOG_ACTIVITY) {
            logger.info(
                `[WATCHLIST] REJECTED | pool=${poolName} | ` +
                `Failed non-bypassable filters: [${nonBypassable.join(',')}]`
            );
        }
        
        return {
            consider: false,
            reason: `Failed safety filters: ${nonBypassable.join(', ')}`,
            esScore,
            filtersBypassed: [],
            rejected: true,
            rejectionReason: `SAFETY_FILTER: ${nonBypassable[0]}`,
        };
    }
    
    // Determine which filters to bypass
    const filtersBypassed = failedFilters.filter(f =>
        WATCHLIST_CONFIG.BYPASSED_FILTERS.some(bf => f.toUpperCase().includes(bf))
    );
    
    if (WATCHLIST_CONFIG.LOG_ACTIVITY) {
        logger.info(
            `[WATCHLIST] CONSIDERED | pool=${poolName} | ` +
            `ES=${esScore.toFixed(1)} | priority=${watchlistCheck.priority} | ` +
            `bypassed=[${filtersBypassed.join(',')}] | ` +
            `reason="${watchlistCheck.reason}"`
        );
    }
    
    return {
        consider: true,
        reason: `Watchlist: ${watchlistCheck.reason}`,
        esScore,
        filtersBypassed,
        rejected: false,
    };
}

/**
 * Get all watchlisted pools.
 */
export function getWatchlist(): {
    byAddress: Array<{ address: string; entry: WatchlistEntry }>;
    bySymbol: WatchlistSymbol[];
} {
    const byAddress: Array<{ address: string; entry: WatchlistEntry }> = [];
    for (const [address, entry] of WATCHLIST_CONFIG.POOLS_BY_ADDRESS) {
        byAddress.push({ address, entry });
    }
    
    return {
        byAddress,
        bySymbol: WATCHLIST_CONFIG.POOLS_BY_SYMBOL,
    };
}

/**
 * Check if a filter can be bypassed for watchlist pools.
 */
export function canBypassFilter(filterName: string): boolean {
    const upperFilter = filterName.toUpperCase();
    
    // Check never-bypass list
    if (WATCHLIST_CONFIG.NEVER_BYPASS.some(nb => upperFilter.includes(nb))) {
        return false;
    }
    
    // Check bypass list
    return WATCHLIST_CONFIG.BYPASSED_FILTERS.some(bf => upperFilter.includes(bf));
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log watchlist summary.
 */
export function logWatchlistSummary(): void {
    const watchlist = getWatchlist();
    
    logger.info(`[WATCHLIST-SUMMARY] ═══════════════════════════════════════════════`);
    logger.info(
        `[WATCHLIST-SUMMARY] ` +
        `By Address: ${watchlist.byAddress.length} | ` +
        `By Symbol: ${watchlist.bySymbol.length} | ` +
        `Min ES: ${WATCHLIST_CONFIG.MIN_ES_FOR_WATCHLIST}`
    );
    
    if (watchlist.byAddress.length > 0) {
        logger.info(`[WATCHLIST-SUMMARY] ADDRESS ENTRIES:`);
        for (const { address, entry } of watchlist.byAddress) {
            logger.info(
                `[WATCHLIST-SUMMARY]   ${address.slice(0, 8)}... | ` +
                `${entry.name} | ${entry.priority || 'MEDIUM'} | ${entry.reason}`
            );
        }
    }
    
    logger.info(`[WATCHLIST-SUMMARY] SYMBOL PATTERNS:`);
    const highPriority = watchlist.bySymbol.filter(s => s.priority === 'HIGH');
    const medPriority = watchlist.bySymbol.filter(s => s.priority === 'MEDIUM');
    
    logger.info(
        `[WATCHLIST-SUMMARY]   HIGH: [${highPriority.map(s => s.pattern).join(', ')}]`
    );
    logger.info(
        `[WATCHLIST-SUMMARY]   MED:  [${medPriority.map(s => s.pattern).join(', ')}]`
    );
    
    logger.info(`[WATCHLIST-SUMMARY] ═══════════════════════════════════════════════`);
}

export default {
    WATCHLIST_CONFIG,
    checkWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    evaluateWatchlistPool,
    getWatchlist,
    canBypassFilter,
    logWatchlistSummary,
};

