/**
 * Discovery Cache Controller
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * INTELLIGENT DISCOVERY CACHING - SCAN ≠ DISCOVER
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * CRITICAL DISTINCTION:
 *   SCAN = observe state of known pools (telemetry refresh) - runs every cycle
 *   DISCOVER = rebuild the entire pool universe - runs at controlled intervals
 * 
 * Discovery must NOT trigger every scan. Full multi-source discovery only runs
 * at controlled intervals to preserve:
 * - Trend memory
 * - Volume inertia
 * - SPS signals
 * - Structural decay tracking
 * - Liquidity migration patterns
 * 
 * CACHE RULES:
 * - Default refresh interval: 15 minutes (900000ms)
 * - Force refresh ONLY when:
 *   • now - lastDiscovery > 900000ms (15 minutes)
 *   • activePools < 5
 *   • MHI(global) < 0.35
 *   • No valid entries for 4 consecutive cycles
 *   • Kill switch triggered
 *   • Regime flipped
 * - Otherwise return cachedPools - DO NOT rediscover
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';
import { computeMHI } from '../engine/microstructureHealthIndex';
import { getAlivePoolIds } from './dlmmTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discovery refresh interval: 15 minutes
 * Discovery logs should repeat every 15-20 minutes, NOT every 3-10 seconds
 * CRITICAL: Discovery ≠ Scan. Discovery rebuilds the universe. Scan observes known pools.
 */
export const DISCOVERY_REFRESH_MS = 15 * 60 * 1000; // 15 minutes (900000ms)

/**
 * Force refresh thresholds
 * These are the ONLY conditions that trigger full discovery outside the 15-minute interval
 */
export const FORCE_REFRESH_THRESHOLDS = {
    minGlobalMHI: 0.35,           // Force refresh if global MHI < 0.35
    minAlivePools: 5,             // Force refresh if alive pools < 5
    maxNoEntryCycles: 4,          // Force refresh after 4 consecutive no-entry cycles
};

/**
 * Force refresh reason codes
 */
export type ForceRefreshReason = 
    | 'SCHEDULED'                  // Normal 15-minute refresh
    | 'MHI_CRITICAL'               // Global MHI < 0.35
    | 'ALIVE_POOLS_LOW'            // Alive pools < 5
    | 'NO_ENTRY_STREAK'            // 4 consecutive no-entry cycles
    | 'KILL_SWITCH'                // Kill switch triggered
    | 'REGIME_FLIP'                // Regime flipped (bear → bull or bull → neutral)
    | 'MANUAL'                     // Manual invalidation
    | 'INITIAL';                   // First run

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool metadata stored in cache (for lightweight lookups)
 */
export interface PoolMeta {
    address: string;
    name: string;
    score: number;
    mhi: number;
    regime: MarketRegime;
    lastUpdated: number;
}

/**
 * Full enriched pool data for cache (avoids re-discovery)
 */
export interface CachedEnrichedPool {
    address: string;
    symbol: string;
    baseMint: string;
    quoteMint: string;
    tvl: number;
    volume24h: number;
    fees24h: number;
    price: number;
    priceImpact: number;
    traders24h: number;
    holders: number;
    liquidity: number;
    entropy: number;
    binCount: number;
    velocity: number;
    activeBin: number;
    migrationDirection: 'in' | 'out' | 'stable';
    lastUpdated: number;
    feeRate: number;
    velocityLiquidityRatio: number;
    turnover24h: number;
    feeEfficiency: number;
}

/**
 * Global discovery cache container
 * Stores BOTH metadata (for quick lookups) AND full pool data (for cache hits)
 */
export interface DiscoveryCache {
    pools: PoolMeta[];
    enrichedPools: CachedEnrichedPool[];  // Full pool data for cache hits
    lastFetch: number;
    lastRefreshReason: ForceRefreshReason;
    fetchCount: number;
}

/**
 * Discovery state tracking for force refresh conditions
 */
interface DiscoveryState {
    // Cycle tracking
    noEntryCycleCount: number;      // Consecutive cycles with no entries
    lastEntryTime: number;          // Timestamp of last successful entry
    
    // Regime tracking for flip detection
    previousRegime: MarketRegime | null;
    currentRegime: MarketRegime | null;
    lastRegimeChange: number;
    
    // Kill switch state
    killSwitchActive: boolean;
    killSwitchTriggeredAt: number;
    
    // MHI tracking
    lastGlobalMHI: number;
    mhiHistory: number[];           // Last 5 global MHI readings
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let discoveryCache: DiscoveryCache | null = null;

const discoveryState: DiscoveryState = {
    noEntryCycleCount: 0,
    lastEntryTime: 0,
    previousRegime: null,
    currentRegime: null,
    lastRegimeChange: 0,
    killSwitchActive: false,
    killSwitchTriggeredAt: 0,
    lastGlobalMHI: 1.0,
    mhiHistory: [],
};

// ═══════════════════════════════════════════════════════════════════════════════
// FORCE REFRESH CONDITION CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate global MHI as average of top pools' MHI
 */
function calculateGlobalMHI(poolIds: string[]): number {
    if (poolIds.length === 0) return 0;
    
    let validCount = 0;
    let totalMHI = 0;
    
    // Take top 10 pools for global MHI calculation
    const topPools = poolIds.slice(0, 10);
    
    for (const poolId of topPools) {
        const mhiResult = computeMHI(poolId);
        if (mhiResult && mhiResult.valid) {
            totalMHI += mhiResult.mhi;
            validCount++;
        }
    }
    
    if (validCount === 0) return 0;
    
    const globalMHI = totalMHI / validCount;
    
    // Update history
    discoveryState.mhiHistory.push(globalMHI);
    if (discoveryState.mhiHistory.length > 5) {
        discoveryState.mhiHistory.shift();
    }
    discoveryState.lastGlobalMHI = globalMHI;
    
    return globalMHI;
}

/**
 * Check if regime has flipped (bear → bull or bull → neutral)
 */
function checkRegimeFlip(currentRegime: MarketRegime): boolean {
    const prev = discoveryState.previousRegime;
    
    if (!prev) {
        // First time - no flip
        return false;
    }
    
    // Detect significant flips
    const isFlip = (
        (prev === 'BEAR' && currentRegime === 'BULL') ||
        (prev === 'BULL' && currentRegime === 'NEUTRAL') ||
        (prev === 'BEAR' && currentRegime === 'NEUTRAL')
    );
    
    return isFlip;
}

/**
 * Evaluate if force refresh is needed
 * Returns reason if refresh needed, null otherwise
 */
export function shouldForceRefresh(poolIds: string[]): ForceRefreshReason | null {
    const now = Date.now();
    
    // Check 1: Kill switch
    if (discoveryState.killSwitchActive) {
        return 'KILL_SWITCH';
    }
    
    // Check 2: No-entry streak
    if (discoveryState.noEntryCycleCount >= FORCE_REFRESH_THRESHOLDS.maxNoEntryCycles) {
        return 'NO_ENTRY_STREAK';
    }
    
    // Check 3: Alive pools count
    const alivePools = getAlivePoolIds();
    if (alivePools.length < FORCE_REFRESH_THRESHOLDS.minAlivePools) {
        return 'ALIVE_POOLS_LOW';
    }
    
    // Check 4: Global MHI
    const globalMHI = calculateGlobalMHI(poolIds);
    if (globalMHI < FORCE_REFRESH_THRESHOLDS.minGlobalMHI) {
        return 'MHI_CRITICAL';
    }
    
    // Check 5: Regime flip
    if (discoveryState.currentRegime && checkRegimeFlip(discoveryState.currentRegime)) {
        return 'REGIME_FLIP';
    }
    
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if discovery refresh is needed
 * Returns { shouldRefresh, reason } where reason explains why
 */
export function shouldRefreshDiscovery(poolIds: string[] = []): { 
    shouldRefresh: boolean; 
    reason: ForceRefreshReason;
    cacheAge: number;
} {
    const now = Date.now();
    
    // First run - must refresh
    if (!discoveryCache) {
        return { 
            shouldRefresh: true, 
            reason: 'INITIAL',
            cacheAge: 0,
        };
    }
    
    const cacheAge = now - discoveryCache.lastFetch;
    
    // Check force refresh conditions
    const forceReason = shouldForceRefresh(poolIds);
    if (forceReason) {
        logger.info(`[DISCOVERY-CACHE] ⚠️ Force refresh triggered: ${forceReason}`);
        return { 
            shouldRefresh: true, 
            reason: forceReason,
            cacheAge,
        };
    }
    
    // Check normal refresh interval
    if (cacheAge >= DISCOVERY_REFRESH_MS) {
        return { 
            shouldRefresh: true, 
            reason: 'SCHEDULED',
            cacheAge,
        };
    }
    
    // Cache is still valid
    return { 
        shouldRefresh: false, 
        reason: discoveryCache.lastRefreshReason,
        cacheAge,
    };
}

/**
 * Get cached pools if cache is valid
 * Returns null if cache is invalid or expired
 */
export function getCachedPools(): PoolMeta[] | null {
    if (!discoveryCache) {
        return null;
    }
    
    const cacheAge = Date.now() - discoveryCache.lastFetch;
    
    // Check if cache is still valid (no force refresh conditions)
    if (cacheAge >= DISCOVERY_REFRESH_MS) {
        return null;
    }
    
    return discoveryCache.pools;
}

/**
 * Get cached enriched pools for scan-only cycles (no full discovery)
 * 
 * CRITICAL: This is the key to separating Scan from Discover.
 * When cache is valid, use these pools directly - DO NOT run discovery.
 * 
 * @returns CachedEnrichedPool[] if cache valid, null if discovery needed
 */
export function getCachedEnrichedPools(): CachedEnrichedPool[] | null {
    if (!discoveryCache) {
        return null;
    }
    
    const cacheAge = Date.now() - discoveryCache.lastFetch;
    
    // Cache expired - needs discovery
    if (cacheAge >= DISCOVERY_REFRESH_MS) {
        return null;
    }
    
    // No enriched pools stored - needs discovery
    if (!discoveryCache.enrichedPools || discoveryCache.enrichedPools.length === 0) {
        return null;
    }
    
    return discoveryCache.enrichedPools;
}

/**
 * Update the discovery cache with new pools
 * 
 * @param pools - Pool metadata for quick lookups
 * @param reason - Reason for this refresh
 * @param enrichedPools - Full pool data for cache hits (avoids re-discovery)
 */
export function updateDiscoveryCache(
    pools: PoolMeta[],
    reason: ForceRefreshReason,
    enrichedPools?: CachedEnrichedPool[]
): void {
    const now = Date.now();
    const fetchCount = discoveryCache ? discoveryCache.fetchCount + 1 : 1;
    
    discoveryCache = {
        pools,
        enrichedPools: enrichedPools || [],
        lastFetch: now,
        lastRefreshReason: reason,
        fetchCount,
    };
    
    // Log single summary
    logger.info('═══════════════════════════════════════════════════════════════════');
    logger.info(`[DISCOVERY-CACHE] ✅ Cache updated | Reason: ${reason}`);
    logger.info(`[DISCOVERY-CACHE] Pools: ${pools.length} | Enriched: ${enrichedPools?.length ?? 0} | Fetch #${fetchCount}`);
    logger.info(`[DISCOVERY-CACHE] Next refresh in: ${Math.round(DISCOVERY_REFRESH_MS / 60000)} minutes`);
    if (pools.length > 0) {
        const avgMHI = pools.reduce((sum, p) => sum + p.mhi, 0) / pools.length;
        const avgScore = pools.reduce((sum, p) => sum + p.score, 0) / pools.length;
        logger.info(`[DISCOVERY-CACHE] Avg MHI: ${avgMHI.toFixed(3)} | Avg Score: ${avgScore.toFixed(1)}`);
    }
    logger.info('═══════════════════════════════════════════════════════════════════');
}

/**
 * Get discovery cache status
 */
export function getDiscoveryCacheStatus(): {
    cached: boolean;
    age: number;
    poolCount: number;
    lastRefreshReason: ForceRefreshReason | null;
    noEntryCycles: number;
    globalMHI: number;
    currentRegime: MarketRegime | null;
} {
    if (!discoveryCache) {
        return {
            cached: false,
            age: 0,
            poolCount: 0,
            lastRefreshReason: null,
            noEntryCycles: discoveryState.noEntryCycleCount,
            globalMHI: discoveryState.lastGlobalMHI,
            currentRegime: discoveryState.currentRegime,
        };
    }
    
    return {
        cached: true,
        age: Date.now() - discoveryCache.lastFetch,
        poolCount: discoveryCache.pools.length,
        lastRefreshReason: discoveryCache.lastRefreshReason,
        noEntryCycles: discoveryState.noEntryCycleCount,
        globalMHI: discoveryState.lastGlobalMHI,
        currentRegime: discoveryState.currentRegime,
    };
}

/**
 * Force invalidate the cache
 */
export function invalidateDiscoveryCache(): void {
    discoveryCache = null;
    logger.info('[DISCOVERY-CACHE] 🔄 Cache invalidated (MANUAL)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE UPDATE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record an entry event (resets no-entry counter)
 */
export function recordEntry(): void {
    discoveryState.noEntryCycleCount = 0;
    discoveryState.lastEntryTime = Date.now();
}

/**
 * Record a cycle with no entries
 */
export function recordNoEntryCycle(): void {
    discoveryState.noEntryCycleCount++;
    logger.debug(`[DISCOVERY-CACHE] No-entry cycle count: ${discoveryState.noEntryCycleCount}`);
}

/**
 * Update the current regime (for flip detection)
 */
export function updateRegime(regime: MarketRegime): void {
    const prevRegime = discoveryState.currentRegime;
    
    if (prevRegime !== regime) {
        discoveryState.previousRegime = prevRegime;
        discoveryState.currentRegime = regime;
        discoveryState.lastRegimeChange = Date.now();
        
        if (prevRegime) {
            logger.info(`[DISCOVERY-CACHE] Regime change: ${prevRegime} → ${regime}`);
        }
    }
}

/**
 * Set kill switch state
 */
export function setKillSwitch(active: boolean): void {
    if (active && !discoveryState.killSwitchActive) {
        discoveryState.killSwitchTriggeredAt = Date.now();
        logger.warn('[DISCOVERY-CACHE] ⚠️ Kill switch ACTIVATED - will force refresh');
    }
    
    discoveryState.killSwitchActive = active;
}

/**
 * Reset discovery state (for testing or restart)
 */
export function resetDiscoveryState(): void {
    discoveryCache = null;
    discoveryState.noEntryCycleCount = 0;
    discoveryState.lastEntryTime = 0;
    discoveryState.previousRegime = null;
    discoveryState.currentRegime = null;
    discoveryState.lastRegimeChange = 0;
    discoveryState.killSwitchActive = false;
    discoveryState.killSwitchTriggeredAt = 0;
    discoveryState.lastGlobalMHI = 1.0;
    discoveryState.mhiHistory = [];
    
    logger.info('[DISCOVERY-CACHE] State reset');
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL STATE EXPORTS (for testing/debugging only)
// ═══════════════════════════════════════════════════════════════════════════════

export {
    discoveryCache,
    discoveryState,
};

