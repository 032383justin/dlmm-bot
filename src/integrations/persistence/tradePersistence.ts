/**
 * Trade Persistence Module - Centralized database operations for trades and positions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: ALL TRADES AND POSITIONS MUST BE PERSISTED
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module handles:
 * - Writing new trades to `trades` table
 * - Writing open positions to `positions` table
 * - Updating trades and positions on exit
 * - Loading open positions from database on startup
 * 
 * RULES:
 * 1. Every entry must write to BOTH trades AND positions tables
 * 2. Every exit must update BOTH tables
 * 3. Startup recovery must load from database
 * 4. Errors THROW - never swallowed (fail-fast for data integrity)
 * 
 * GREP-FRIENDLY LOGS:
 * - [DB-WRITE] - Successful database write
 * - [DB-ERROR] - Database operation failed
 */

import { supabaseClient, isSupabaseAvailable } from '../supabaseClient';
import { safeInsert, safeUpdate } from '../../services/db';
import logger from '../../utils/logger';
import { Trade, TradeInput } from '../../db/models/Trade';
import { ensurePoolExists, PoolMeta } from '../../db/supabase';
import { getActiveRunId } from '../../services/runEpoch';
import {
    isReconciliationSealed,
    assertReconciliationSealed,
    getReconciliationSeal,
    isTradeAuthorizedBySeal,
} from '../../state/reconciliationSeal';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * TradeLike interface for trades with known ID (after DB insertion)
 * id is required because this is used after the DB has assigned an ID
 */
export interface TradeLike {
    id: string;                  // Required - assigned by database
    pool: string;
    poolName: string;
    entryPrice: number;
    size: number;
    mode: 'paper' | 'live' | 'standard' | 'aggressive';
    timestamp: number;
    entryBin?: number;
    score?: number;
    riskTier?: string;
    leverage?: number;
    regime?: string;
    migrationDirection?: string;
    velocitySlope?: number;
    liquiditySlope?: number;
    entropySlope?: number;
    entropy?: number;
    liquidity?: number;
    velocity?: number;
    execution?: {
        entryAssetValueUsd?: number;
        entryFeesPaid?: number;
        entrySlippageUsd?: number;
        netReceivedBase?: number;
        netReceivedQuote?: number;
        priceSource?: string;
    };
}

/**
 * TradeLikeInput for trades before DB insertion (no id - DB generates it)
 */
export interface TradeLikeInput extends Omit<TradeLike, 'id'> {
    // id is omitted - database generates it via gen_random_uuid()
}

export interface PositionLike {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    entryPrice: number;
    entryBin?: number;
    entrySizeUsd: number;
    entryTime: number;
    entryScore?: number;
    entryMicroScore?: number;
    tier?: string;
    strategy?: string;
    regime?: string;
    migrationDirection?: string;
    velocitySlope?: number;
    liquiditySlope?: number;
    entropySlope?: number;
    currentBin?: number;
    healthScore?: number;
    riskTier?: string;
}

export interface PositionUpdate {
    currentBin?: number;
    healthScore?: number;
    riskTier?: string;
    // NOTE: regime removed - not in minimal positions schema
}

export interface ExitUpdate {
    exitPrice: number;
    exitTime?: number;
    pnl?: number;
    pnlUsd?: number;
    pnlNet?: number;
    pnlPercent?: number;
    exitReason: string;
    exitAssetValueUsd?: number;
    exitFeesPaid?: number;
    exitSlippageUsd?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a new trade to the trades table (DB-FIRST ID GENERATION)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⚠️ DEPRECATED: Use saveTradeToDB() from src/db/models/Trade.ts instead.
 * This function exists for backward compatibility only.
 * The canonical trade insert path is saveTradeToDB() in Trade.ts.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * CRITICAL: DO NOT pass an id field - database generates it via gen_random_uuid()
 * 
 * @param trade - Trade input without ID
 * @returns The database-generated trade ID
 * @throws Error if database write fails, no ID returned, or pool registration fails
 * @deprecated Use saveTradeToDB() from src/db/models/Trade.ts instead
 */
export async function recordNewTrade(trade: TradeLikeInput): Promise<string> {
    logger.warn('[DEPRECATED] recordNewTrade() called — use saveTradeToDB() from Trade.ts instead');
    if (!isSupabaseAvailable()) {
        const errorMsg = 'Supabase not available - cannot persist trade';
        logger.error(`[DB-ERROR] ${JSON.stringify({ op: 'RECORD_TRADE', errorMessage: errorMsg })}`);
        throw new Error(`[DB-ERROR] ${errorMsg}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // AUTO-POOL REGISTRATION - Ensure pool exists before trade insert
    // ═══════════════════════════════════════════════════════════════════════════════
    const poolMeta: PoolMeta = {
        pool_address: trade.pool,
        tokenA: trade.poolName?.split('/')[0] ?? null,
        tokenB: trade.poolName?.split('/')[1] ?? null,
        // Token mints/decimals may not be available in TradeLikeInput execution type
    };

    const poolRegistered = await ensurePoolExists(poolMeta);
    if (!poolRegistered) {
        throw new Error(`[DB-ERROR] Pool registration failed for ${trade.pool.slice(0, 8)}... - aborting trade persistence`);
    }

    // NO id field - let database generate it via gen_random_uuid()
    const payload = {
        pool_address: trade.pool,
        pool_name: trade.poolName,
        mode: trade.mode === 'standard' || trade.mode === 'aggressive' ? 'paper' : trade.mode,
        size: trade.size,
        entry_price: trade.entryPrice,
        bin: trade.entryBin,
        score: trade.score ?? 0,
        risk_tier: trade.riskTier ?? 'C',
        leverage: trade.leverage ?? 1.0,
        v_slope: trade.velocitySlope ?? 0,
        l_slope: trade.liquiditySlope ?? 0,
        e_slope: trade.entropySlope ?? 0,
        entropy: trade.entropy ?? 0,
        liquidity: trade.liquidity ?? 0,
        velocity: trade.velocity ?? 0,
        entry_asset_value_usd: trade.execution?.entryAssetValueUsd ?? trade.size,
        entry_fees_paid: trade.execution?.entryFeesPaid ?? 0,
        entry_slippage_usd: trade.execution?.entrySlippageUsd ?? 0,
        entry_price_source: trade.execution?.priceSource ?? 'birdeye',
        status: 'open',
        created_at: new Date(trade.timestamp).toISOString(),
    };

    // Insert and get the returned ID
    const { data, error } = await supabaseClient
        .from('trades')
        .insert(payload)
        .select('id')
        .single();

    if (error) {
        logger.error(`[DB-ERROR] ${JSON.stringify({ 
            op: 'RECORD_TRADE', 
            errorMessage: error.message,
            pool: trade.pool.slice(0, 8)
        })}`);
        throw new Error(`[DB-ERROR] Trade insert failed: ${error.message}`);
    }

    if (!data || !data.id) {
        throw new Error('[DB-ERROR] Trade insert returned no ID - abort trade');
    }

    const dbGeneratedId = data.id as string;
    logger.info(`[TRADE-ID] Assigned from DB: ${dbGeneratedId}`);
    
    return dbGeneratedId;
}

/**
 * Update trade on exit
 * Called when a trade is closed
 * 
 * @throws Error if database write fails
 */
export async function updateTradeOnExit(tradeId: string, exitData: ExitUpdate): Promise<void> {
    if (!isSupabaseAvailable()) {
        const errorMsg = 'Supabase not available - cannot update trade exit';
        logger.error(`[DB-ERROR] ${JSON.stringify({ op: 'CLOSE_TRADE', id: tradeId, errorMessage: errorMsg })}`);
        throw new Error(`[DB-ERROR] ${errorMsg}`);
    }

    const exitTime = exitData.exitTime ? new Date(exitData.exitTime).toISOString() : new Date().toISOString();

    const payload = {
        exit_price: exitData.exitPrice,
        exit_time: exitTime,
        pnl_usd: exitData.pnlUsd ?? exitData.pnl ?? 0,
        pnl_net: exitData.pnlNet ?? exitData.pnl ?? 0,
        pnl_percent: exitData.pnlPercent ?? 0,
        exit_reason: exitData.exitReason,
        exit_asset_value_usd: exitData.exitAssetValueUsd,
        exit_fees_paid: exitData.exitFeesPaid ?? 0,
        exit_slippage_usd: exitData.exitSlippageUsd ?? 0,
        status: 'closed',
    };

    await safeUpdate('trades', payload, { id: tradeId }, {
        op: 'CLOSE_TRADE',
        id: tradeId,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sync an open position to the positions table
 * Called on every trade entry
 * 
 * @throws Error if database write fails or pool registration fails
 */
export async function syncOpenPosition(position: PositionLike): Promise<void> {
    if (!isSupabaseAvailable()) {
        const errorMsg = 'Supabase not available - cannot sync position';
        logger.error(`[DB-ERROR] ${JSON.stringify({ op: 'OPEN_POSITION', id: position.tradeId, errorMessage: errorMsg })}`);
        throw new Error(`[DB-ERROR] ${errorMsg}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // AUTO-POOL REGISTRATION - Ensure pool exists before position insert
    // ═══════════════════════════════════════════════════════════════════════════════
    const poolMeta: PoolMeta = {
        pool_address: position.poolAddress,
        tokenA: position.poolName?.split('/')[0] ?? null,
        tokenB: position.poolName?.split('/')[1] ?? null,
    };

    const poolRegistered = await ensurePoolExists(poolMeta);
    if (!poolRegistered) {
        throw new Error(`[DB-ERROR] Pool registration failed for ${position.poolAddress.slice(0, 8)}... - aborting position sync`);
    }

    const now = new Date().toISOString();

    // ═══════════════════════════════════════════════════════════════════════════════
    // MINIMAL POSITION PAYLOAD — MATCHES CANONICAL positions TABLE SCHEMA
    // ❌ REMOVED: entry_timestamp, regime (not in minimal schema)
    // ✅ USING: trade_id, pool_address, entry_price, size_usd, risk_tier, current_bin, health_score
    // ✅ ADDED: run_id for accounting correctness
    // ═══════════════════════════════════════════════════════════════════════════════
    const currentRunId = getActiveRunId();
    
    const payload = {
        trade_id: position.tradeId,
        pool_address: position.poolAddress,
        entry_price: position.entryPrice,
        size_usd: position.entrySizeUsd,
        risk_tier: position.riskTier ?? position.tier ?? 'C',
        current_bin: position.currentBin ?? position.entryBin ?? null,
        health_score: position.healthScore ?? position.entryScore ?? null,
        run_id: currentRunId,
        created_at: now,
        updated_at: now,
    };

    await safeInsert('positions', payload, {
        op: 'OPEN_POSITION',
        id: position.tradeId,
    });
}

/**
 * Update position state during runtime
 * Called when bin, health_score, or risk_tier changes
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * MINIMAL SCHEMA COMPLIANT — Only updates valid columns:
 * current_bin, health_score, risk_tier, updated_at
 * ❌ REMOVED: regime (not in minimal positions schema)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * @throws Error if database write fails
 */
export async function updatePositionState(tradeId: string, update: PositionUpdate): Promise<void> {
    if (!isSupabaseAvailable()) {
        const errorMsg = 'Supabase not available - cannot update position state';
        logger.error(`[DB-ERROR] ${JSON.stringify({ op: 'UPDATE_POSITION', id: tradeId, errorMessage: errorMsg })}`);
        throw new Error(`[DB-ERROR] ${errorMsg}`);
    }

    const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };

    if (update.currentBin !== undefined) {
        updateData.current_bin = update.currentBin;
    }
    if (update.healthScore !== undefined) {
        updateData.health_score = update.healthScore;
    }
    if (update.riskTier !== undefined) {
        updateData.risk_tier = update.riskTier;
    }
    // NOTE: regime removed - not in minimal positions schema

    await safeUpdate('positions', updateData, { trade_id: tradeId }, {
        op: 'UPDATE_POSITION',
        id: tradeId,
    });
}

/**
 * Close a position in the positions table
 * Called when a trade is exited
 * 
 * @throws Error if database write fails
 */
export async function closePosition(tradeId: string, exitData: ExitUpdate): Promise<void> {
    if (!isSupabaseAvailable()) {
        const errorMsg = 'Supabase not available - cannot close position';
        logger.error(`[DB-ERROR] ${JSON.stringify({ op: 'CLOSE_POSITION', id: tradeId, errorMessage: errorMsg })}`);
        throw new Error(`[DB-ERROR] ${errorMsg}`);
    }

    const now = new Date().toISOString();
    const closedAt = exitData.exitTime ? new Date(exitData.exitTime).toISOString() : now;

    const payload = {
        closed_at: closedAt,
        exit_reason: exitData.exitReason,
        pnl_usd: exitData.pnlUsd ?? exitData.pnl ?? 0,
        updated_at: now,
    };

    await safeUpdate('positions', payload, { trade_id: tradeId }, {
        op: 'CLOSE_POSITION',
        id: tradeId,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP RECOVERY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load all open positions from the database
 * Called on startup to recover state
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * SEAL ENFORCEMENT: After reconciliation seal is set, this function:
 * 1. MUST verify seal is set (assertReconciliationSealed)
 * 2. MUST only return positions authorized by the seal
 * 3. MUST drop any position not in seal.openTradeIds
 * 
 * This prevents "zombie trades" from being resurrected after restart.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export async function loadOpenPositionsFromDB(): Promise<PositionLike[]> {
    // ═══════════════════════════════════════════════════════════════════════════
    // SEAL ENFORCEMENT: Check seal status and gate hydration
    // ═══════════════════════════════════════════════════════════════════════════
    if (isReconciliationSealed()) {
        assertReconciliationSealed('loadOpenPositionsFromDB');
        
        const seal = getReconciliationSeal();
        
        // If seal says 0 open positions, skip hydration entirely
        if (seal.openCount === 0) {
            logger.info('[SEAL] No open positions allowed — skipping hydration');
            return [];
        }
        
        logger.info(`[SEAL] Hydrating positions from seal: ${seal.openCount} authorized`);
    }
    
    if (!isSupabaseAvailable()) {
        logger.warn('[DB] Supabase not available - starting with zero positions');
        return [];
    }

    try {
        const seal = getReconciliationSeal();
        
        // Try to load from positions table first (positions without closed_at are open)
        const { data: positionsData, error: positionsError } = await supabaseClient
            .from('positions')
            .select('*')
            .is('closed_at', null);

        if (!positionsError && positionsData && positionsData.length > 0) {
            const positions: PositionLike[] = [];
            
            for (const row of positionsData) {
                const tradeId = row.trade_id as string;
                
                // ═══════════════════════════════════════════════════════════════
                // SEAL ENFORCEMENT: Drop any position not explicitly listed in seal
                // ═══════════════════════════════════════════════════════════════
                if (seal.sealed && !isTradeAuthorizedBySeal(tradeId)) {
                    logger.warn(`[SEAL] Dropping unauthorized position hydration`, {
                        tradeId: tradeId.slice(0, 8),
                    });
                    continue;
                }
                
                positions.push({
                    tradeId,
                    poolAddress: row.pool_address as string,
                    poolName: (row.pool_name as string) ?? '',
                    entryPrice: parseFloat(String(row.entry_price ?? 0)),
                    entryBin: row.entry_bin as number | undefined,
                    entrySizeUsd: parseFloat(String(row.entry_size_usd ?? row.size_usd ?? 0)),
                    entryTime: new Date(String(row.entry_time ?? row.opened_at)).getTime(),
                    entryScore: parseFloat(String(row.entry_score ?? 0)),
                    entryMicroScore: parseFloat(String(row.entry_micro_score ?? row.entry_score ?? 0)),
                    tier: (row.tier as string) ?? 'C',
                    strategy: (row.strategy as string) ?? 'tier4',
                    regime: (row.regime as string) ?? 'NEUTRAL',
                    migrationDirection: (row.migration_direction as string) ?? 'neutral',
                    velocitySlope: parseFloat(String(row.velocity_slope ?? 0)),
                    liquiditySlope: parseFloat(String(row.liquidity_slope ?? 0)),
                    entropySlope: parseFloat(String(row.entropy_slope ?? 0)),
                });
            }

            logger.info(`[DB] ✅ Loaded ${positions.length} active positions from database`);
            return positions;
        }

        // Fallback: try to load from trades table where status='open'
        const { data: tradesData, error: tradesError } = await supabaseClient
            .from('trades')
            .select('*')
            .eq('status', 'open');

        if (tradesError) {
            logger.error(`[DB-ERROR] ${JSON.stringify({ 
                op: 'LOAD_OPEN_TRADES', 
                errorMessage: tradesError.message,
                errorCode: tradesError.code 
            })}`);
            return [];
        }

        if (!tradesData || tradesData.length === 0) {
            logger.info('[DB] No open positions found in database - starting fresh');
            return [];
        }

        // Convert trades to positions with seal enforcement
        const positions: PositionLike[] = [];
        
        for (const row of tradesData) {
            const tradeId = row.id as string;
            
            // ═══════════════════════════════════════════════════════════════════
            // SEAL ENFORCEMENT: Drop any trade not explicitly listed in seal
            // ═══════════════════════════════════════════════════════════════════
            if (seal.sealed && !isTradeAuthorizedBySeal(tradeId)) {
                logger.warn(`[SEAL] Dropping unauthorized trade hydration`, {
                    tradeId: tradeId.slice(0, 8),
                });
                continue;
            }
            
            positions.push({
                tradeId,
                poolAddress: row.pool_address as string,
                poolName: (row.pool_name as string) ?? '',
                entryPrice: parseFloat(String(row.entry_price ?? 0)),
                entryBin: row.bin as number | undefined,
                entrySizeUsd: parseFloat(String(row.size ?? 0)),
                entryTime: new Date(String(row.created_at)).getTime(),
                entryScore: parseFloat(String(row.score ?? 0)),
                tier: (row.risk_tier as string) ?? 'C',
                strategy: 'tier4',
                regime: 'NEUTRAL',
                migrationDirection: 'neutral',
                velocitySlope: parseFloat(String(row.v_slope ?? 0)),
                liquiditySlope: parseFloat(String(row.l_slope ?? 0)),
                entropySlope: parseFloat(String(row.e_slope ?? 0)),
            });
        }

        logger.info(`[DB] ✅ Loaded ${positions.length} active trades from database`);
        return positions;

    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[DB-ERROR] ${JSON.stringify({ op: 'LOAD_OPEN_POSITIONS', errorMessage: errorMsg })}`);
        return [];
    }
}

/**
 * Load positions by sealed position IDs (from reconciliation seal)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: This is the ONLY function that should be used to hydrate positions
 * after reconciliation seal. It loads EXCLUSIVELY from the positions table
 * using the sealed IDs as the authoritative source.
 * 
 * RULES:
 * - ONLY load positions by the exact IDs from the reconciliation seal
 * - NEVER query the trades table to determine open positions
 * - If sealed IDs length ≠ returned positions length → process.exit(1)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * @param sealedPositionIds - Position IDs from reconciliation seal (authoritative)
 * @returns Array of PositionLike objects loaded from positions table
 */
export async function loadPositionsBySealedIds(sealedPositionIds: readonly string[]): Promise<PositionLike[]> {
    if (!isSupabaseAvailable()) {
        logger.error('[DB] Supabase not available - cannot load sealed positions');
        if (sealedPositionIds.length > 0) {
            console.error('');
            console.error('════════════════════════════════════════════════════════════════');
            console.error('🚨 FATAL: Cannot hydrate sealed positions without database');
            console.error('════════════════════════════════════════════════════════════════');
            console.error(`   Sealed Position Count: ${sealedPositionIds.length}`);
            console.error('   Supabase is not available.');
            console.error('════════════════════════════════════════════════════════════════');
            process.exit(1);
        }
        return [];
    }

    // If no sealed positions, return empty array
    if (sealedPositionIds.length === 0) {
        logger.info('[DB] No sealed positions to load');
        return [];
    }

    try {
        // ═══════════════════════════════════════════════════════════════════════════
        // CRITICAL: Load positions ONLY by sealed IDs
        // NO OTHER FILTERS ALLOWED — sealed IDs are AUTHORITATIVE
        // - No .is('closed_at', null)
        // - No status checks
        // - No LIMIT
        // ═══════════════════════════════════════════════════════════════════════════
        const { data: positionsData, error: positionsError } = await supabaseClient
            .from('positions')
            .select('*')
            .in('trade_id', [...sealedPositionIds]);

        if (positionsError) {
            console.error('');
            console.error('════════════════════════════════════════════════════════════════');
            console.error('🚨 FATAL: Failed to load sealed positions from database');
            console.error('════════════════════════════════════════════════════════════════');
            console.error(`   Error: ${positionsError.message}`);
            console.error(`   Expected Positions: ${sealedPositionIds.length}`);
            console.error('════════════════════════════════════════════════════════════════');
            process.exit(1);
        }

        if (!positionsData) {
            console.error('');
            console.error('════════════════════════════════════════════════════════════════');
            console.error('🚨 FATAL: No data returned when loading sealed positions');
            console.error('════════════════════════════════════════════════════════════════');
            console.error(`   Expected Positions: ${sealedPositionIds.length}`);
            console.error('════════════════════════════════════════════════════════════════');
            process.exit(1);
        }

        // CRITICAL INVARIANT: Sealed count MUST equal loaded count
        // NO FALLBACK — NO AUTO-CLOSE — NO PARTIAL HYDRATION
        if (positionsData.length !== sealedPositionIds.length) {
            const loadedIdSet = new Set(positionsData.map((p: Record<string, unknown>) => p.trade_id));
            const missingIds = sealedPositionIds.filter(id => !loadedIdSet.has(id));
            const loadedIds = positionsData.map((p: Record<string, unknown>) => p.trade_id as string);
            
            console.error('');
            console.error('════════════════════════════════════════════════════════════════');
            console.error('🚨 FATAL: Position count mismatch with reconciliation seal');
            console.error('════════════════════════════════════════════════════════════════');
            console.error(`   Sealed Count: ${sealedPositionIds.length}`);
            console.error(`   Loaded Count: ${positionsData.length}`);
            console.error('');
            console.error('   Sealed IDs:');
            for (const id of sealedPositionIds) {
                console.error(`     - ${id}`);
            }
            console.error('');
            console.error('   Loaded IDs:');
            for (const id of loadedIds) {
                console.error(`     - ${id}`);
            }
            console.error('');
            console.error('   Missing IDs (sealed but not found in DB):');
            for (const id of missingIds) {
                console.error(`     - ${id}`);
            }
            console.error('');
            console.error('   This is a critical consistency violation.');
            console.error('   Query was: SELECT * FROM positions WHERE trade_id IN (sealed IDs)');
            console.error('   NO other filters applied. Seal is authoritative.');
            console.error('   Cannot proceed — fail closed.');
            console.error('════════════════════════════════════════════════════════════════');
            process.exit(1);
        }

        const positions: PositionLike[] = positionsData.map((row: Record<string, unknown>) => ({
            tradeId: row.trade_id as string,
            poolAddress: row.pool_address as string,
            poolName: (row.pool_name as string) ?? '',
            entryPrice: parseFloat(String(row.entry_price ?? 0)),
            entryBin: row.entry_bin as number | undefined,
            entrySizeUsd: parseFloat(String(row.entry_size_usd ?? row.size_usd ?? 0)),
            entryTime: new Date(String(row.entry_time ?? row.opened_at)).getTime(),
            entryScore: parseFloat(String(row.entry_score ?? 0)),
            entryMicroScore: parseFloat(String(row.entry_micro_score ?? row.entry_score ?? 0)),
            tier: (row.tier as string) ?? 'C',
            strategy: (row.strategy as string) ?? 'tier4',
            regime: (row.regime as string) ?? 'NEUTRAL',
            migrationDirection: (row.migration_direction as string) ?? 'neutral',
            velocitySlope: parseFloat(String(row.velocity_slope ?? 0)),
            liquiditySlope: parseFloat(String(row.liquidity_slope ?? 0)),
            entropySlope: parseFloat(String(row.entropy_slope ?? 0)),
        }));

        // Structured log as per requirement
        const loadedIds = positions.map(p => p.tradeId);
        logger.info(
            `[EXECUTION] Hydrated positions from seal ` +
            `expectedCount=${sealedPositionIds.length} ` +
            `loadedCount=${positions.length} ` +
            `ids=[${loadedIds.map(id => id.slice(0, 8)).join(', ')}]`
        );
        
        return positions;

    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error('');
        console.error('════════════════════════════════════════════════════════════════');
        console.error('🚨 FATAL: Exception loading sealed positions');
        console.error('════════════════════════════════════════════════════════════════');
        console.error(`   Error: ${errorMsg}`);
        console.error(`   Expected Positions: ${sealedPositionIds.length}`);
        console.error('════════════════════════════════════════════════════════════════');
        process.exit(1);
    }
}

/**
 * Persist position entry to positions table
 * 
 * NOTE: Trade is already in the trades table (inserted by ExecutionEngine).
 * This function ONLY writes to the positions table for lifecycle tracking.
 * 
 * CRITICAL: trade.id must be the DB-generated ID from saveTradeToDB()
 * 
 * @param trade - Trade with DB-assigned ID
 * @throws Error if database write fails or pool registration fails
 */
export async function persistTradeEntry(trade: Trade): Promise<void> {
    const now = new Date().toISOString();

    // Validate that we have a DB-assigned ID
    if (!trade.id) {
        throw new Error('[DB-ERROR] Cannot persist position - trade has no ID');
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // AUTO-POOL REGISTRATION - Ensure pool exists before position insert
    // ═══════════════════════════════════════════════════════════════════════════════
    const poolMeta: PoolMeta = {
        pool_address: trade.pool,
        tokenA: trade.poolName?.split('/')[0] ?? null,
        tokenB: trade.poolName?.split('/')[1] ?? null,
        tokenAMint: trade.execution?.baseMint,
        tokenBMint: trade.execution?.quoteMint,
        decimalsA: trade.execution?.baseDecimals,
        decimalsB: trade.execution?.quoteDecimals,
    };

    const poolRegistered = await ensurePoolExists(poolMeta);
    if (!poolRegistered) {
        throw new Error(`[DB-ERROR] Pool registration failed for ${trade.pool.slice(0, 8)}... - aborting position persistence`);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MINIMAL POSITION PAYLOAD — MATCHES CANONICAL positions TABLE SCHEMA
    // ❌ REMOVED: entry_timestamp, regime (not in minimal schema)
    // ✅ USING: trade_id, pool_address, entry_price, size_usd, risk_tier, current_bin, health_score
    // ✅ ADDED: run_id for accounting correctness
    // ═══════════════════════════════════════════════════════════════════════════════
    const currentRunId = getActiveRunId();
    
    const positionPayload = {
        trade_id: trade.id,
        pool_address: trade.pool,
        entry_price: trade.entryPrice,
        size_usd: trade.size,
        risk_tier: trade.riskTier ?? null,
        current_bin: trade.entryBin ?? null,
        health_score: trade.score ?? null,
        run_id: currentRunId,
        created_at: now,
        updated_at: now,
    };

    await safeInsert('positions', positionPayload, {
        op: 'OPEN_POSITION',
        id: trade.id,
    });

    logger.info(`[DB-WRITE] Position ${trade.id.slice(0, 8)}... persisted to positions table`);
}

/**
 * Update positions table on exit
 * 
 * NOTE: trades table is updated separately via updateTradeExitInDB in ExecutionEngine.
 * This function ONLY updates the positions table to avoid duplicate key violations.
 * 
 * @throws Error if database write fails
 */
export async function persistTradeExit(tradeId: string, exitData: ExitUpdate): Promise<void> {
    const now = new Date().toISOString();

    // Round PnL to 2 decimals for consistency
    const netPnlUsd = Math.round((exitData.pnlUsd ?? exitData.pnl ?? 0) * 100) / 100;

    const payload = {
        closed_at: now,
        exit_reason: exitData.exitReason ?? 'UNKNOWN',
        pnl_usd: netPnlUsd,
        updated_at: now,
    };

    await safeUpdate('positions', payload, { trade_id: tradeId }, {
        op: 'CLOSE_POSITION',
        id: tradeId,
        details: { pnl_usd: netPnlUsd },
    });
}
