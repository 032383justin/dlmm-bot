/**
 * Adaptive Pool Selection - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Self-optimizing pool universe that prioritizes best performers
 * and continuously refreshes with new discovery.
 * 
 * BEHAVIOR:
 * - Remove worst-performers from candidate list
 * - Prioritize top performers
 * - Periodically reinsert new/unknown pools via discovery
 * - Maintain a dynamic active universe of best pools only
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Pool status in the adaptive universe
 */
export type PoolStatus = 
    | 'ACTIVE'        // In active trading universe
    | 'PROBATION'     // Under observation, limited trading
    | 'BLOCKED'       // Blocked due to poor performance
    | 'DISCOVERY'     // New pool under discovery evaluation
    | 'EXPIRED';      // Stale, needs re-evaluation

/**
 * Pool entry in the adaptive universe
 */
export interface AdaptivePoolEntry {
    /** Pool address */
    poolAddress: string;
    
    /** Pool name for display */
    poolName: string;
    
    /** Current status */
    status: PoolStatus;
    
    /** Sharpe score from Pool Sharpe Memory */
    sharpeScore: number;
    
    /** Normalized Sharpe (0-1) */
    normalizedSharpe: number;
    
    /** Discovery score (from initial screening) */
    discoveryScore: number;
    
    /** Combined priority score */
    priorityScore: number;
    
    /** Number of trades in this pool */
    tradeCount: number;
    
    /** Win rate from Pool Sharpe Memory */
    winRate: number;
    
    /** Total PnL from this pool */
    totalPnL: number;
    
    /** Time added to universe */
    addedTime: number;
    
    /** Last activity time */
    lastActivityTime: number;
    
    /** Times blocked and reinstated */
    blockCount: number;
    
    /** Discovery origin: 'INITIAL' | 'REFRESH' | 'MANUAL' */
    origin: 'INITIAL' | 'REFRESH' | 'MANUAL';
}

/**
 * Configuration for adaptive pool selection
 */
export interface AdaptivePoolConfig {
    /** Maximum pools in active universe */
    maxActivePoolCount: number;
    
    /** Minimum pools to maintain */
    minActivePoolCount: number;
    
    /** Fraction of universe to refresh each cycle */
    discoveryRefreshFraction: number;
    
    /** Time between discovery refreshes (ms) */
    discoveryRefreshIntervalMs: number;
    
    /** Sharpe threshold for BLOCKED status */
    blockSharpeThreshold: number;
    
    /** Sharpe threshold for PROBATION status */
    probationSharpeThreshold: number;
    
    /** Sharpe threshold for ACTIVE status (from probation) */
    activeSharpeThreshold: number;
    
    /** Minimum trades before evaluating Sharpe */
    minTradesForEvaluation: number;
    
    /** Time before considering a pool stale (ms) */
    staleTimeMs: number;
    
    /** Maximum times a pool can be blocked before permanent removal */
    maxBlockCount: number;
    
    /** Priority score weights */
    priorityWeights: {
        sharpe: number;
        discovery: number;
        recency: number;
    };
}

/**
 * Pool selection result
 */
export interface PoolSelectionResult {
    /** Pools that pass the filter */
    activePools: AdaptivePoolEntry[];
    
    /** Pools in probation (limited trading) */
    probationPools: AdaptivePoolEntry[];
    
    /** Blocked pools */
    blockedPools: AdaptivePoolEntry[];
    
    /** Discovery pool slots available */
    discoverySlots: number;
    
    /** Total pools in universe */
    totalPools: number;
    
    /** Last refresh time */
    lastRefreshTime: number;
    
    /** Next scheduled refresh time */
    nextRefreshTime: number;
}

/**
 * Pool filter criteria
 */
export interface PoolFilterCriteria {
    /** Minimum Sharpe score */
    minSharpe?: number;
    
    /** Minimum trades */
    minTrades?: number;
    
    /** Minimum win rate */
    minWinRate?: number;
    
    /** Only active pools */
    activeOnly?: boolean;
    
    /** Include probation pools */
    includeProbation?: boolean;
    
    /** Maximum pools to return */
    limit?: number;
}

/**
 * Universe update event
 */
export interface UniverseUpdateEvent {
    type: 'ADD' | 'REMOVE' | 'STATUS_CHANGE' | 'REFRESH';
    poolAddress: string;
    poolName: string;
    previousStatus?: PoolStatus;
    newStatus: PoolStatus;
    reason: string;
    timestamp: number;
}

