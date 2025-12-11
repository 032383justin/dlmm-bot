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
 * 4. Errors are logged but do not crash the bot
 */

import { supabaseClient, isSupabaseAvailable } from '../supabaseClient';
import { supabase } from '../../db/supabaseClient';
import logger from '../../utils/logger';
import { updateTradeExitInDB, Trade, saveTradeToDB } from '../../db/models/Trade';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TradeLike {
    id: string;
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
    regime?: string;
    riskTier?: string;
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
 * Record a new trade to the trades table
 * Called on every trade entry
 */
export async function recordNewTrade(trade: TradeLike): Promise<void> {
    if (!isSupabaseAvailable()) {
        logger.error('[DB-ERROR] Supabase not available - cannot persist trade');
        return;
    }

    try {
        const { error } = await supabaseClient.from('trades').insert({
            id: trade.id,
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
        });

        if (error) {
            logger.error('[DB-ERROR] Failed to insert trade', { error: error.message, tradeId: trade.id });
            return;
        }

        logger.info(`[DB] Inserted trade ${trade.id}`);
    } catch (err: any) {
        logger.error('[DB-ERROR] Failed to insert trade', { error: err.message, tradeId: trade.id });
    }
}

/**
 * Update trade on exit
 * Called when a trade is closed
 */
export async function updateTradeOnExit(tradeId: string, exitData: ExitUpdate): Promise<void> {
    if (!isSupabaseAvailable()) {
        logger.error('[DB-ERROR] Supabase not available - cannot update trade exit');
        return;
    }

    try {
        const exitTime = exitData.exitTime ? new Date(exitData.exitTime).toISOString() : new Date().toISOString();

        const { error } = await supabaseClient
            .from('trades')
            .update({
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
            })
            .eq('id', tradeId);

        if (error) {
            logger.error('[DB-ERROR] Failed to update trade on exit', { error: error.message, tradeId });
            return;
        }

        logger.info(`[DB] Updated trade ${tradeId} on exit`);
    } catch (err: any) {
        logger.error('[DB-ERROR] Failed to update trade on exit', { error: err.message, tradeId });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sync an open position to the positions table
 * Called on every trade entry
 * 
 * Schema: public.positions
 * - id, trade_id, pool_address, size_usd, entry_price, entry_timestamp
 * - current_bin, health_score, regime, risk_tier
 * - closed_at, exit_reason, pnl_usd, created_at, updated_at
 */
export async function syncOpenPosition(position: PositionLike): Promise<void> {
    if (!isSupabaseAvailable()) {
        logger.error('[DB-ERROR] Supabase not available - cannot sync position');
        return;
    }

    try {
        const now = new Date().toISOString();
        const entryTimestamp = new Date(position.entryTime).toISOString();
        
        const { error } = await supabaseClient.from('positions').insert({
            trade_id: position.tradeId,
            pool_address: position.poolAddress,
            size_usd: position.entrySizeUsd,
            entry_price: position.entryPrice,
            entry_timestamp: entryTimestamp,
            current_bin: position.currentBin ?? position.entryBin ?? 0,
            health_score: position.healthScore ?? position.entryScore ?? 0,
            regime: position.regime ?? 'NEUTRAL',
            risk_tier: position.riskTier ?? position.tier ?? 'C',
            created_at: now,
            updated_at: now,
        });

        if (error) {
            logger.error('[DB-ERROR] Failed to insert position', { error: error.message, tradeId: position.tradeId });
            return;
        }

        logger.info(`[DB] Inserted position for trade ${position.tradeId}`);
    } catch (err: any) {
        logger.error('[DB-ERROR] Failed to insert position', { error: err.message, tradeId: position.tradeId });
    }
}

/**
 * Update position state during runtime
 * Called when bin, regime, health, or risk_tier changes
 * 
 * Schema columns updated: current_bin, health_score, regime, updated_at
 * Does NOT overwrite entry values.
 */
export async function updatePositionState(tradeId: string, update: PositionUpdate) {
    try {
        const updateData: Record<string, any> = {
            updated_at: new Date().toISOString(),
        };

        if (update.currentBin !== undefined) {
            updateData.current_bin = update.currentBin;
        }
        if (update.healthScore !== undefined) {
            updateData.health_score = update.healthScore;
        }
        if (update.regime !== undefined) {
            updateData.regime = update.regime;
        }

        const { error } = await supabase.from("positions")
            .update(updateData)
            .eq("trade_id", tradeId);

        if (error) {
            logger.error('[DB-ERROR] Failed to update position state', { error: error.message, tradeId });
        }
    } catch (err: any) {
        logger.error('[DB-ERROR] updatePositionState failed', { error: err.message, tradeId });
    }
}
  

/**
 * Close a position in the positions table
 * Called when a trade is exited
 * NOTE: Does NOT delete rows - only updates with closed_at timestamp
 * 
 * Schema columns updated: closed_at, exit_reason, pnl_usd, updated_at
 */
export async function closePosition(tradeId: string, exitData: ExitUpdate): Promise<void> {
    if (!isSupabaseAvailable()) {
        logger.error('[DB-ERROR] Supabase not available - cannot close position');
        return;
    }

    try {
        const now = new Date().toISOString();
        const closedAt = exitData.exitTime ? new Date(exitData.exitTime).toISOString() : now;

        const { error } = await supabaseClient
            .from('positions')
            .update({
                closed_at: closedAt,
                exit_reason: exitData.exitReason,
                pnl_usd: exitData.pnlUsd ?? exitData.pnl ?? 0,
                updated_at: now,
            })
            .eq('trade_id', tradeId);

        if (error) {
            logger.error('[DB-ERROR] Failed to close position', { error: error.message, tradeId });
            return;
        }

        logger.info(`[DB] Closed position for trade ${tradeId}`);
    } catch (err: any) {
        logger.error('[DB-ERROR] Failed to close position', { error: err.message, tradeId });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP RECOVERY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load all open positions from the database
 * Called on startup to recover state
 */
export async function loadOpenPositionsFromDB(): Promise<PositionLike[]> {
    if (!isSupabaseAvailable()) {
        logger.warn('[DB] Supabase not available - starting with zero positions');
        return [];
    }

    try {
        // Try to load from positions table first (positions without closed_at are open)
        const { data: positionsData, error: positionsError } = await supabaseClient
            .from('positions')
            .select('*')
            .is('closed_at', null);

        if (!positionsError && positionsData && positionsData.length > 0) {
            const positions: PositionLike[] = positionsData.map((row: any) => ({
                tradeId: row.trade_id,
                poolAddress: row.pool_address,
                poolName: row.pool_name ?? '',
                entryPrice: parseFloat(row.entry_price ?? 0),
                entryBin: row.entry_bin,
                entrySizeUsd: parseFloat(row.entry_size_usd ?? row.size_usd ?? 0),
                entryTime: new Date(row.entry_time ?? row.opened_at).getTime(),
                entryScore: parseFloat(row.entry_score ?? 0),
                entryMicroScore: parseFloat(row.entry_micro_score ?? row.entry_score ?? 0),
                tier: row.tier ?? 'C',
                strategy: row.strategy ?? 'tier4',
                regime: row.regime ?? 'NEUTRAL',
                migrationDirection: row.migration_direction ?? 'neutral',
                velocitySlope: parseFloat(row.velocity_slope ?? 0),
                liquiditySlope: parseFloat(row.liquidity_slope ?? 0),
                entropySlope: parseFloat(row.entropy_slope ?? 0),
            }));

            logger.info(`[DB] ✅ Loaded ${positions.length} active positions from database`);
            return positions;
        }

        // Fallback: try to load from trades table where status='open'
        const { data: tradesData, error: tradesError } = await supabaseClient
            .from('trades')
            .select('*')
            .eq('status', 'open');

        if (tradesError) {
            logger.error('[DB-ERROR] Failed to load open trades', { error: tradesError.message });
            return [];
        }

        if (!tradesData || tradesData.length === 0) {
            logger.info('[DB] No open positions found in database - starting fresh');
            return [];
        }

        // Convert trades to positions
        const positions: PositionLike[] = tradesData.map((row: any) => ({
            tradeId: row.id,
            poolAddress: row.pool_address,
            poolName: row.pool_name ?? '',
            entryPrice: parseFloat(row.entry_price ?? 0),
            entryBin: row.bin,
            entrySizeUsd: parseFloat(row.size ?? 0),
            entryTime: new Date(row.created_at).getTime(),
            entryScore: parseFloat(row.score ?? 0),
            tier: row.risk_tier ?? 'C',
            strategy: 'tier4',
            regime: 'NEUTRAL',
            migrationDirection: 'neutral',
            velocitySlope: parseFloat(row.v_slope ?? 0),
            liquiditySlope: parseFloat(row.l_slope ?? 0),
            entropySlope: parseFloat(row.e_slope ?? 0),
        }));

        logger.info(`[DB] ✅ Loaded ${positions.length} active trades from database`);
        return positions;

    } catch (err: any) {
        logger.error('[DB-ERROR] Failed to load open positions', { error: err.message });
        return [];
    }
}

/**
 * Record both trade and position on entry (convenience function)
 * This is the main function to call on trade entry
 */
export async function persistTradeEntry(trade: Trade) {
    const now = new Date().toISOString();
  
    // Insert into trades table (unchanged)
    await saveTradeToDB(trade);
  
    // Insert into positions table (NEW SCHEMA)
    try {
        const { error } = await supabase.from("positions").insert({
            trade_id: trade.id,
            pool_address: trade.pool,
            entry_timestamp: now,
            entry_price: trade.entryPrice,
            size_usd: trade.size,
            risk_tier: trade.riskTier ?? null,
            regime: null,
            current_bin: trade.entryBin ?? null,
            health_score: trade.score ?? null,
            created_at: now,
            updated_at: now,
        });

        if (error) {
            logger.error('[DB-ERROR] Failed to insert position', { error: error.message, tradeId: trade.id });
        } else {
            logger.info(`[DB] Inserted position for trade ${trade.id}`);
            console.log("[TEST] persistTradeEntry OK");
        }
    } catch (err: any) {
        logger.error('[DB-ERROR] persistTradeEntry failed', { error: err.message, tradeId: trade.id });
    }
}
  

/**
 * Update positions table on exit
 * 
 * NOTE: trades table is updated separately via updateTradeExitInDB in ExecutionEngine.
 * This function ONLY updates the positions table to avoid duplicate key violations.
 * 
 * Does NOT delete or modify historical entries - only updates with exit data.
 */
export async function persistTradeExit(tradeId: string, exitData: ExitUpdate) {
    const now = new Date().toISOString();
    
    // Round PnL to 2 decimals for consistency
    const netPnlUsd = Math.round((exitData.pnlUsd ?? exitData.pnl ?? 0) * 100) / 100;
  
    // Update positions table ONLY (trades table already updated by updateTradeExitInDB)
    try {
        const { error } = await supabase.from("positions")
            .update({
                closed_at: now,
                exit_reason: exitData.exitReason ?? "UNKNOWN",
                pnl_usd: netPnlUsd,
                updated_at: now,
            })
            .eq("trade_id", tradeId);

        if (error) {
            logger.error('[DB-ERROR] Failed to update position on exit', { error: error.message, tradeId });
        } else {
            logger.info(`[DB] Updated position exit for trade ${tradeId} | PnL: $${netPnlUsd.toFixed(2)}`);
        }
    } catch (err: any) {
        logger.error('[DB-ERROR] persistTradeExit failed', { error: err.message, tradeId });
    }
}
  

