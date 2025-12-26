/**
 * PnL Service - Authoritative PnL Calculation Module
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * SINGLE SOURCE OF TRUTH FOR PnL CALCULATIONS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides:
 * - computeRealizedPnLFromDb() — canonical realized PnL from closed trades
 * - computeUnrealizedPnLFromPositions() — unrealized PnL from open positions
 * - getTotalPnL() — combined realized + unrealized
 * - reconcilePnL() — compare in-memory vs DB and return drift
 * 
 * RULES:
 * 1. Database is the SINGLE SOURCE OF TRUTH for historical realized PnL
 * 2. In-memory values are caches that must be reconcilable back to DB
 * 3. All calculations are deterministic and auditable
 * 4. Fees and slippage are always included in net PnL calculations
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../db/supabase';
import { capitalManager } from './capitalManager';
import logger from '../utils/logger';
import { Position } from '../engine/ExecutionEngine';
import { getActiveRunId, getActiveRunEpoch } from './runEpoch';
import { 
    isWithinReconciliationGracePeriod, 
    getReconciliationGracePeriodRemaining,
    hasReconciliationCompleted,
} from './positionReconciler';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RealizedPnLResult {
    totalRealizedPnL: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    totalFees: number;
    totalSlippage: number;
    trades: TradeHistoryRecord[];
    computedAt: string;
}

export interface UnrealizedPnLResult {
    totalUnrealizedPnL: number;
    positionCount: number;
    positions: PositionPnL[];
    computedAt: string;
}

export interface TotalPnLResult {
    realizedPnL: number;
    unrealizedPnL: number;
    totalPnL: number;
    openPositionCount: number;
    closedTradeCount: number;
    computedAt: string;
}

export interface PnLReconciliationResult {
    inMemoryRealizedPnL: number;
    dbRealizedPnL: number;
    driftUSD: number;
    driftPercent: number;
    hasDrift: boolean;
    driftThresholdUSD: number;
    correctionNeeded: boolean;
    computedAt: string;
}

export interface TradeHistoryRecord {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    entryValueUSD: number;
    exitValueUSD: number;
    feesUSD: number;
    slippageUSD: number;
    grossPnL: number;
    netPnL: number;
    pnlPercent: number;
    entryTime: string;
    exitTime: string;
    holdTimeMs: number;
    exitReason: string;
}

export interface PositionPnL {
    positionId: string;
    poolAddress: string;
    symbol: string;
    entrySizeUSD: number;
    currentValueUSD: number;
    unrealizedPnL: number;
    unrealizedPnLPercent: number;
    holdTimeMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_DRIFT_THRESHOLD_USD = 0.01; // $0.01 drift tolerance

// ═══════════════════════════════════════════════════════════════════════════════
// REALIZED PnL CALCULATION — FROM DATABASE (AUTHORITATIVE)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute canonical realized PnL by walking all closed trades in database
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * ACCOUNTING CORRECTNESS: RUN_ID SCOPED
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This function ONLY includes trades from the ACTIVE run.
 * Historical trades from prior runs are NEVER included.
 * 
 * This is the AUTHORITATIVE source for realized PnL.
 * Any in-memory values must reconcile back to this.
 * 
 * Formula per trade:
 *   grossPnL = exit_asset_value_usd - entry_asset_value_usd
 *   netPnL = grossPnL - total_fees - total_slippage
 * 
 * Total realized PnL = sum of all netPnL (this run only)
 */
export async function computeRealizedPnLFromDb(sinceTimestamp?: string): Promise<RealizedPnLResult> {
    const computedAt = new Date().toISOString();
    
    try {
        // Get active run info for scoping
        const activeRunId = getActiveRunId();
        const activeRunEpoch = getActiveRunEpoch();
        
        // Build query for closed trades - SCOPED TO ACTIVE RUN
        let query = supabase
            .from('trades')
            .select('*')
            .eq('status', 'closed')
            .order('exit_time', { ascending: true });
        
        // ═══════════════════════════════════════════════════════════════════════
        // RUN_ID SCOPING: Only include trades from active run
        // This prevents phantom equity from prior runs
        // ═══════════════════════════════════════════════════════════════════════
        if (activeRunId) {
            query = query.eq('run_id', activeRunId);
        } else if (activeRunEpoch?.started_at) {
            // Fallback: use timestamp if run_id column doesn't exist
            query = query.gte('exit_time', activeRunEpoch.started_at);
        }
        
        // Optionally filter by timestamp (for computing PnL since last reset)
        if (sinceTimestamp) {
            query = query.gte('exit_time', sinceTimestamp);
        }
        
        const { data: closedTrades, error } = await query;
        
        if (error) {
            logger.error(`[PNL-SERVICE] Failed to fetch closed trades: ${error.message}`);
            return {
                totalRealizedPnL: 0,
                tradeCount: 0,
                winCount: 0,
                lossCount: 0,
                totalFees: 0,
                totalSlippage: 0,
                trades: [],
                computedAt,
            };
        }
        
        if (!closedTrades || closedTrades.length === 0) {
            // ═══════════════════════════════════════════════════════════════════════
            // EMPTY POSITIONS EDGE CASE HANDLING
            // Check if capital_state has non-zero PnL but no trades exist
            // ═══════════════════════════════════════════════════════════════════════
            try {
                const { data: capitalData } = await supabase
                    .from('capital_state')
                    .select('total_realized_pnl')
                    .eq('id', 1)
                    .single();
                
                const capitalPnL = capitalData?.total_realized_pnl ?? 0;
                
                if (capitalPnL !== 0) {
                    logger.warn(`[PNL-AUDIT] ${JSON.stringify({
                        message: 'No closed positions found in DB but capital_state PnL is non-zero',
                        capitalPnL,
                        dbTradeCount: 0,
                        action: 'Returning 0 as safe default - historical trades may be missing',
                        computedAt,
                    })}`);
                }
            } catch {
                // Ignore errors checking capital state
            }
            
            return {
                totalRealizedPnL: 0,
                tradeCount: 0,
                winCount: 0,
                lossCount: 0,
                totalFees: 0,
                totalSlippage: 0,
                trades: [],
                computedAt,
            };
        }
        
        let totalRealizedPnL = 0;
        let winCount = 0;
        let lossCount = 0;
        let totalFees = 0;
        let totalSlippage = 0;
        const trades: TradeHistoryRecord[] = [];
        
        for (const trade of closedTrades) {
            // Extract values with fallbacks
            const entryValueUSD = parseFloat(trade.entry_asset_value_usd ?? trade.size ?? 0);
            const exitValueUSD = parseFloat(trade.exit_asset_value_usd ?? trade.size ?? 0);
            const entryFees = parseFloat(trade.entry_fees_paid ?? 0);
            const exitFees = parseFloat(trade.exit_fees_paid ?? 0);
            const entrySlippage = parseFloat(trade.entry_slippage_usd ?? 0);
            const exitSlippage = parseFloat(trade.exit_slippage_usd ?? 0);
            
            const tradeFees = entryFees + exitFees;
            const tradeSlippage = entrySlippage + exitSlippage;
            
            // Calculate PnL
            const grossPnL = exitValueUSD - entryValueUSD;
            
            // Use stored pnl_net if available, otherwise calculate
            let netPnL: number;
            if (trade.pnl_net !== null && trade.pnl_net !== undefined) {
                netPnL = parseFloat(trade.pnl_net);
            } else if (trade.pnl_usd !== null && trade.pnl_usd !== undefined) {
                netPnL = parseFloat(trade.pnl_usd);
            } else {
                netPnL = grossPnL - tradeFees - tradeSlippage;
            }
            
            // Round to 2 decimals
            netPnL = Math.round(netPnL * 100) / 100;
            
            const pnlPercent = entryValueUSD > 0 ? (netPnL / entryValueUSD) * 100 : 0;
            
            // Calculate hold time
            const entryTime = trade.created_at;
            const exitTime = trade.exit_time;
            const holdTimeMs = entryTime && exitTime 
                ? new Date(exitTime).getTime() - new Date(entryTime).getTime()
                : 0;
            
            // Aggregate
            totalRealizedPnL += netPnL;
            totalFees += tradeFees;
            totalSlippage += tradeSlippage;
            
            if (netPnL >= 0) {
                winCount++;
            } else {
                lossCount++;
            }
            
            trades.push({
                tradeId: trade.id,
                poolAddress: trade.pool_address,
                poolName: trade.pool_name ?? 'Unknown',
                entryValueUSD,
                exitValueUSD,
                feesUSD: tradeFees,
                slippageUSD: tradeSlippage,
                grossPnL,
                netPnL,
                pnlPercent,
                entryTime,
                exitTime,
                holdTimeMs,
                exitReason: trade.exit_reason ?? 'Unknown',
            });
        }
        
        // Round total
        totalRealizedPnL = Math.round(totalRealizedPnL * 100) / 100;
        
        return {
            totalRealizedPnL,
            tradeCount: trades.length,
            winCount,
            lossCount,
            totalFees: Math.round(totalFees * 100) / 100,
            totalSlippage: Math.round(totalSlippage * 100) / 100,
            trades,
            computedAt,
        };
        
    } catch (err: any) {
        logger.error(`[PNL-SERVICE] computeRealizedPnLFromDb failed: ${err.message}`);
        return {
            totalRealizedPnL: 0,
            tradeCount: 0,
            winCount: 0,
            lossCount: 0,
            totalFees: 0,
            totalSlippage: 0,
            trades: [],
            computedAt,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNREALIZED PnL CALCULATION — FROM OPEN POSITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute unrealized PnL from open positions
 * 
 * Uses current prices and position entry data to calculate mark-to-market PnL
 * 
 * Formula per position:
 *   unrealizedPnL = (currentPrice - entryPrice) / entryPrice * sizeUSD
 */
export function computeUnrealizedPnLFromPositions(positions: Position[]): UnrealizedPnLResult {
    const computedAt = new Date().toISOString();
    const now = Date.now();
    
    const openPositions = positions.filter(p => !p.closed);
    
    if (openPositions.length === 0) {
        return {
            totalUnrealizedPnL: 0,
            positionCount: 0,
            positions: [],
            computedAt,
        };
    }
    
    let totalUnrealizedPnL = 0;
    const positionPnLs: PositionPnL[] = [];
    
    for (const position of openPositions) {
        const priceChange = position.entryPrice > 0
            ? (position.currentPrice - position.entryPrice) / position.entryPrice
            : 0;
        
        const unrealizedPnL = priceChange * position.sizeUSD;
        const currentValueUSD = position.sizeUSD + unrealizedPnL;
        const holdTimeMs = now - position.openedAt;
        
        totalUnrealizedPnL += unrealizedPnL;
        
        positionPnLs.push({
            positionId: position.id,
            poolAddress: position.pool,
            symbol: position.symbol,
            entrySizeUSD: position.sizeUSD,
            currentValueUSD,
            unrealizedPnL: Math.round(unrealizedPnL * 100) / 100,
            unrealizedPnLPercent: priceChange * 100,
            holdTimeMs,
        });
    }
    
    return {
        totalUnrealizedPnL: Math.round(totalUnrealizedPnL * 100) / 100,
        positionCount: openPositions.length,
        positions: positionPnLs,
        computedAt,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOTAL PnL — REALIZED + UNREALIZED
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get combined realized + unrealized PnL
 */
export async function getTotalPnL(positions: Position[]): Promise<TotalPnLResult> {
    const computedAt = new Date().toISOString();
    
    const realizedResult = await computeRealizedPnLFromDb();
    const unrealizedResult = computeUnrealizedPnLFromPositions(positions);
    
    const totalPnL = realizedResult.totalRealizedPnL + unrealizedResult.totalUnrealizedPnL;
    
    return {
        realizedPnL: realizedResult.totalRealizedPnL,
        unrealizedPnL: unrealizedResult.totalUnrealizedPnL,
        totalPnL: Math.round(totalPnL * 100) / 100,
        openPositionCount: unrealizedResult.positionCount,
        closedTradeCount: realizedResult.tradeCount,
        computedAt,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PnL RECONCILIATION — COMPARE IN-MEMORY VS DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reconcile in-memory realized PnL against database
 * 
 * Returns drift information and whether correction is needed
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * EDGE CASE HANDLING:
 * - If DB has no closed trades but capital_state has non-zero PnL:
 *   → Log [PNL-AUDIT] warning
 *   → Prefer DB computed value (0) as authoritative
 *   → Mark correction needed to reset capital_state
 * 
 * RECONCILIATION GRACE PERIOD:
 * - After bootstrap reconciliation, there is a grace period
 * - During this period, PNL-AUDIT should NOT "correct" values
 * - Reconciliation output is authoritative for this boot
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export async function reconcilePnL(
    driftThresholdUSD: number = DEFAULT_DRIFT_THRESHOLD_USD
): Promise<PnLReconciliationResult> {
    const computedAt = new Date().toISOString();
    
    try {
        // ═══════════════════════════════════════════════════════════════════════
        // RECONCILIATION GRACE PERIOD CHECK
        // If we're within the grace period after reconciliation, skip corrections
        // ═══════════════════════════════════════════════════════════════════════
        if (hasReconciliationCompleted() && isWithinReconciliationGracePeriod()) {
            const remainingMs = getReconciliationGracePeriodRemaining();
            const remainingMin = Math.ceil(remainingMs / 60000);
            
            logger.info(`[PNL-AUDIT] Skipping correction - within reconciliation grace period (${remainingMin}m remaining)`);
            
            // Get values but mark as no correction needed
            const capitalState = await capitalManager.getFullState();
            const inMemoryRealizedPnL = capitalState?.total_realized_pnl ?? 0;
            const dbResult = await computeRealizedPnLFromDb();
            
            return {
                inMemoryRealizedPnL: Math.round(inMemoryRealizedPnL * 100) / 100,
                dbRealizedPnL: Math.round(dbResult.totalRealizedPnL * 100) / 100,
                driftUSD: 0,
                driftPercent: 0,
                hasDrift: false,
                driftThresholdUSD,
                correctionNeeded: false,  // KEY: Do not correct during grace period
                computedAt,
            };
        }
        
        // Get in-memory value from capital manager
        const capitalState = await capitalManager.getFullState();
        const inMemoryRealizedPnL = capitalState?.total_realized_pnl ?? 0;
        
        // Get authoritative value from database
        const dbResult = await computeRealizedPnLFromDb();
        const dbRealizedPnL = dbResult.totalRealizedPnL;
        
        // ═══════════════════════════════════════════════════════════════════════
        // EDGE CASE: No DB trades but non-zero capital_state PnL
        // ═══════════════════════════════════════════════════════════════════════
        if (dbResult.tradeCount === 0 && inMemoryRealizedPnL !== 0) {
            logger.warn(`[PNL-AUDIT] ${JSON.stringify({
                message: 'No closed trades in DB but capital_state has non-zero PnL',
                inMemoryRealizedPnL,
                dbRealizedPnL: 0,
                dbTradeCount: 0,
                action: 'Correction needed - will reset capital_state PnL to 0',
                computedAt,
            })}`);
            
            return {
                inMemoryRealizedPnL: Math.round(inMemoryRealizedPnL * 100) / 100,
                dbRealizedPnL: 0,
                driftUSD: Math.abs(inMemoryRealizedPnL),
                driftPercent: 100,
                hasDrift: true,
                driftThresholdUSD,
                correctionNeeded: true,
                computedAt,
            };
        }
        
        // Calculate drift
        const driftUSD = Math.abs(inMemoryRealizedPnL - dbRealizedPnL);
        const driftPercent = dbRealizedPnL !== 0 
            ? (driftUSD / Math.abs(dbRealizedPnL)) * 100 
            : (driftUSD > 0 ? 100 : 0);
        
        const hasDrift = driftUSD > driftThresholdUSD;
        
        if (hasDrift) {
            logger.warn(`[PNL-AUDIT] ${JSON.stringify({
                message: 'PnL drift detected between capital_state and computed trades',
                inMemoryRealizedPnL: Math.round(inMemoryRealizedPnL * 100) / 100,
                dbRealizedPnL: Math.round(dbRealizedPnL * 100) / 100,
                driftUSD: Math.round(driftUSD * 100) / 100,
                driftPercent: Math.round(driftPercent * 100) / 100,
                dbTradeCount: dbResult.tradeCount,
                correctionNeeded: true,
                computedAt,
            })}`);
        }
        
        return {
            inMemoryRealizedPnL: Math.round(inMemoryRealizedPnL * 100) / 100,
            dbRealizedPnL: Math.round(dbRealizedPnL * 100) / 100,
            driftUSD: Math.round(driftUSD * 100) / 100,
            driftPercent: Math.round(driftPercent * 100) / 100,
            hasDrift,
            driftThresholdUSD,
            correctionNeeded: hasDrift,
            computedAt,
        };
        
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[PNL-SERVICE] reconcilePnL failed: ${errorMsg}`);
        return {
            inMemoryRealizedPnL: 0,
            dbRealizedPnL: 0,
            driftUSD: 0,
            driftPercent: 0,
            hasDrift: false,
            driftThresholdUSD,
            correctionNeeded: false,
            computedAt,
        };
    }
}

/**
 * Correct in-memory realized PnL to match database
 * 
 * Updates capital_state.total_realized_pnl to match computed value from trades
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * BEHAVIOR:
 * - Computes realized PnL from closed trades in DB
 * - If no trades exist, resets to 0
 * - Always logs [PNL-AUDIT] with before/after values
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export async function correctPnLDrift(): Promise<boolean> {
    try {
        // Get current capital state for logging
        const capitalState = await capitalManager.getFullState();
        const previousValue = capitalState?.total_realized_pnl ?? 0;
        
        // Compute correct value from DB trades
        const dbResult = await computeRealizedPnLFromDb();
        const correctValue = dbResult.totalRealizedPnL;
        
        // Log the reset case explicitly
        if (dbResult.tradeCount === 0 && previousValue !== 0) {
            logger.warn(`[PNL-AUDIT] ${JSON.stringify({
                message: 'Resetting realized PnL to 0 due to missing DB history',
                previousValue,
                newValue: 0,
                dbTradeCount: 0,
                action: 'RESET_TO_ZERO',
            })}`);
        }
        
        // Update capital_state directly
        const { error } = await supabase
            .from('capital_state')
            .update({
                total_realized_pnl: correctValue,
                updated_at: new Date().toISOString(),
            })
            .eq('id', 1);
        
        if (error) {
            logger.error(`[DB-ERROR] ${JSON.stringify({
                op: 'CORRECT_PNL_DRIFT',
                table: 'capital_state',
                errorMessage: error.message,
                errorCode: error.code,
            })}`);
            return false;
        }
        
        logger.info(`[PNL-AUDIT] ${JSON.stringify({
            message: 'Corrected realized PnL drift',
            previousValue: Math.round(previousValue * 100) / 100,
            newValue: Math.round(correctValue * 100) / 100,
            dbTradeCount: dbResult.tradeCount,
            driftCorrected: Math.round(Math.abs(correctValue - previousValue) * 100) / 100,
        })}`);
        
        return true;
        
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[PNL-SERVICE] correctPnLDrift failed: ${errorMsg}`);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log a structured trade entry
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER-4 EXECUTION COST SEMANTICS
 * All fee/slippage fields are explicitly labeled as entry-side costs.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function logTradeEntry(params: {
    positionId: string;
    poolId: string;
    baseToken: string;
    quoteToken: string;
    side: string;
    notionalSizeUSD: number;
    baseAmount: number;
    quoteAmount: number;
    entryPrice: number;
    entryTime: string;
    capitalDebited: number;
    // Explicit entry-side costs (Tier-4 semantics)
    entryFeesUSD: number;
    entrySlippageUSD: number;
    riskTier: string;
    regime: string;
}): void {
    const logData = {
        positionId: params.positionId,
        poolId: params.poolId,
        pair: `${params.baseToken}/${params.quoteToken}`,
        side: params.side,
        notionalSizeUSD: `$${params.notionalSizeUSD.toFixed(2)}`,
        baseAmount: params.baseAmount.toFixed(6),
        quoteAmount: params.quoteAmount.toFixed(6),
        entryPrice: params.entryPrice.toFixed(8),
        entryTime: params.entryTime,
        capitalDebited: `$${params.capitalDebited.toFixed(2)}`,
        // Explicit entry costs (unambiguous naming)
        entryFeesUSD: `$${params.entryFeesUSD.toFixed(2)}`,
        entrySlippageUSD: `$${params.entrySlippageUSD.toFixed(2)}`,
        riskTier: params.riskTier,
        regime: params.regime,
    };
    
    logger.info(`[TRADE-ENTRY] ${JSON.stringify(logData)}`);
}

/**
 * Log a structured trade exit
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER-4 EXECUTION COST SEMANTICS
 * All fee/slippage fields are explicitly labeled as entry/exit/total.
 * This eliminates ambiguity for analytics and dashboards.
 * 
 * BREAKING CHANGE: 'slippageUSD' renamed to 'exitSlippageUSD' (was ambiguous)
 * BACKWARD COMPAT: 'slippageUSD' still emitted as deprecated alias for 1 release
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function logTradeExit(params: {
    positionId: string;
    poolId: string;
    symbol: string;
    exitPrice: number;
    exitTime: string;
    entryNotionalUSD: number;
    grossExitValueUSD: number;
    // Explicit entry/exit/total breakdown (Tier-4 semantics)
    entryFeesUSD: number;
    exitFeesUSD: number;
    totalFeesUSD: number;
    entrySlippageUSD: number;
    exitSlippageUSD: number;
    totalSlippageUSD: number;
    // PnL
    grossPnLUSD: number;
    netPnLUSD: number;
    pnlPercent: number;
    holdTimeMs: number;
    exitReason: string;
    updatedTotalRealizedPnLUSD: number;
}): void {
    const holdTimeFormatted = formatDuration(params.holdTimeMs);
    const pnlSign = params.netPnLUSD >= 0 ? '+' : '';
    const grossSign = params.grossPnLUSD >= 0 ? '+' : '';
    
    const logData = {
        positionId: params.positionId,
        poolId: params.poolId,
        symbol: params.symbol,
        exitPrice: params.exitPrice.toFixed(8),
        exitTime: params.exitTime,
        entryNotionalUSD: `$${params.entryNotionalUSD.toFixed(2)}`,
        grossExitValueUSD: `$${params.grossExitValueUSD.toFixed(2)}`,
        // ═══════════════════════════════════════════════════════════════════
        // EXPLICIT ENTRY/EXIT/TOTAL FEES (Tier-4 semantics)
        // ═══════════════════════════════════════════════════════════════════
        entryFeesUSD: `$${params.entryFeesUSD.toFixed(2)}`,
        exitFeesUSD: `$${params.exitFeesUSD.toFixed(2)}`,
        totalFeesUSD: `$${params.totalFeesUSD.toFixed(2)}`,
        // ═══════════════════════════════════════════════════════════════════
        // EXPLICIT ENTRY/EXIT/TOTAL SLIPPAGE (Tier-4 semantics)
        // ═══════════════════════════════════════════════════════════════════
        entrySlippageUSD: `$${params.entrySlippageUSD.toFixed(2)}`,
        exitSlippageUSD: `$${params.exitSlippageUSD.toFixed(2)}`,
        totalSlippageUSD: `$${params.totalSlippageUSD.toFixed(2)}`,
        // DEPRECATED: 'slippageUSD' — kept for backward compatibility (1 release)
        // This was ambiguous (was exit-only but named as if total). Remove in next release.
        slippageUSD: `$${params.exitSlippageUSD.toFixed(2)}`,
        // ═══════════════════════════════════════════════════════════════════
        // PnL BREAKDOWN
        // ═══════════════════════════════════════════════════════════════════
        grossPnLUSD: `${grossSign}$${params.grossPnLUSD.toFixed(2)}`,
        netPnLUSD: `${pnlSign}$${params.netPnLUSD.toFixed(2)}`,
        pnlPercent: `${pnlSign}${params.pnlPercent.toFixed(2)}%`,
        // Legacy alias for backward compatibility
        realizedPnLPct: `${pnlSign}${params.pnlPercent.toFixed(2)}%`,
        holdTime: holdTimeFormatted,
        exitReason: params.exitReason,
        updatedTotalRealizedPnLUSD: `$${params.updatedTotalRealizedPnLUSD.toFixed(2)}`,
    };
    
    logger.info(`[TRADE-EXIT] ${JSON.stringify(logData)}`);
}

/**
 * Format duration from milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    computeRealizedPnLFromDb,
    computeUnrealizedPnLFromPositions,
    getTotalPnL,
    reconcilePnL,
    correctPnLDrift,
    logTradeEntry,
    logTradeExit,
};

