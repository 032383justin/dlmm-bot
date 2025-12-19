/**
 * Run Epoch Module — Single Run Accounting Correctness
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * ARCHITECTURAL BACKBONE — ALL ACCOUNTING MUST BE SCOPED TO ACTIVE RUN_ID
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE:
 * - Generate unique run_id at each bot startup
 * - Persist run_id globally (engine, ledger, positions, logs)
 * - Ensure all equity calculations are scoped to active run_id
 * - Prevent phantom equity from prior runs
 * 
 * INVARIANTS:
 * 1. Each bot startup creates exactly ONE new run_id
 * 2. Positions/trades belong to exactly one run_id
 * 3. Realized PnL is scoped to current run_id only
 * 4. Historical data from prior runs is NEVER included in current equity
 * 
 * EQUITY FORMULA (run_id scoped):
 *   Net Equity = Starting Capital (run_id)
 *              + Realized PnL (this run only)
 *              + Unrealized PnL (active positions this run)
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../db/supabase';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RunEpoch {
    run_id: string;
    started_at: string;
    starting_capital: number;
    paper_capital_provided: boolean;
    parent_run_id: string | null;  // Previous run (for continuation)
    status: 'active' | 'closed';
}

export interface RunEpochState {
    run_id: string;
    starting_capital: number;
    realized_pnl: number;
    unrealized_pnl: number;
    net_equity: number;
    open_positions: number;
    closed_trades: number;
    updated_at: string;
}

export interface StartupValidation {
    valid: boolean;
    error?: string;
    mode: 'fresh_start' | 'continuation' | 'hybrid_blocked';
    run_id?: string;
    starting_capital?: number;
    prior_run_id?: string;
    prior_net_equity?: number;
    open_positions_from_prior?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let activeRunId: string | null = null;
let activeRunEpoch: RunEpoch | null = null;
let startingCapitalThisRun: number = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a new unique run_id
 */
function generateRunId(): string {
    const timestamp = Date.now();
    const uuid = uuidv4().split('-')[0];
    return `run_${timestamp}_${uuid}`;
}

/**
 * Get the active run_id for this session
 */
export function getActiveRunId(): string | null {
    return activeRunId;
}

/**
 * Get the active run epoch details
 */
export function getActiveRunEpoch(): RunEpoch | null {
    return activeRunEpoch;
}

/**
 * Get starting capital for this run
 */
export function getStartingCapitalThisRun(): number {
    return startingCapitalThisRun;
}

/**
 * Validate startup conditions and determine run mode
 * 
 * RULES:
 * 1. If PAPER_CAPITAL provided → Fresh start, new run_id, ignore prior data
 * 2. If PAPER_CAPITAL NOT provided → Continuation, inherit from last run
 * 3. If mismatch (open positions + fresh PAPER_CAPITAL) → FATAL ERROR
 */
export async function validateStartupConditions(
    paperCapitalProvided: boolean,
    paperCapital: number
): Promise<StartupValidation> {
    try {
        // Check for open positions from prior runs
        const { data: openPositions, error: posError } = await supabase
            .from('positions')
            .select('trade_id, size_usd, pool_address, run_id')
            .is('closed_at', null);
        
        if (posError) {
            logger.error(`[RUN-EPOCH] Failed to check open positions: ${posError.message}`);
        }
        
        const openPositionCount = openPositions?.length ?? 0;
        const totalLockedCapital = openPositions?.reduce((sum: number, p: { size_usd?: number | null }) => sum + (p.size_usd ?? 0), 0) ?? 0;
        
        // Get last run info
        const { data: lastRun } = await supabase
            .from('run_epochs')
            .select('*')
            .eq('status', 'active')
            .order('started_at', { ascending: false })
            .limit(1)
            .single();
        
        // ═══════════════════════════════════════════════════════════════════════
        // CASE 1: Fresh start with PAPER_CAPITAL provided
        // ═══════════════════════════════════════════════════════════════════════
        if (paperCapitalProvided) {
            // CRITICAL CHECK: Block hybrid state
            if (openPositionCount > 0) {
                return {
                    valid: false,
                    mode: 'hybrid_blocked',
                    error: `FATAL: Cannot start fresh run with PAPER_CAPITAL=$${paperCapital} ` +
                           `while ${openPositionCount} positions are still open from prior run ` +
                           `(locked capital: $${totalLockedCapital.toFixed(2)}). ` +
                           `Either close all positions first, or remove PAPER_CAPITAL to continue previous run.`,
                    open_positions_from_prior: openPositionCount,
                    prior_run_id: lastRun?.run_id,
                };
            }
            
            // Fresh start allowed
            const newRunId = generateRunId();
            return {
                valid: true,
                mode: 'fresh_start',
                run_id: newRunId,
                starting_capital: paperCapital,
                prior_run_id: lastRun?.run_id,
            };
        }
        
        // ═══════════════════════════════════════════════════════════════════════
        // CASE 2: Continuation mode (no PAPER_CAPITAL provided)
        // ═══════════════════════════════════════════════════════════════════════
        if (lastRun) {
            // Get net equity from last run
            const { data: capitalState } = await supabase
                .from('capital_state')
                .select('available_balance, locked_balance, total_realized_pnl, initial_capital')
                .eq('id', 1)
                .single();
            
            const priorNetEquity = capitalState 
                ? capitalState.available_balance + capitalState.locked_balance
                : 10000;
            
            // Continue with a new run_id but inherit equity
            const newRunId = generateRunId();
            return {
                valid: true,
                mode: 'continuation',
                run_id: newRunId,
                starting_capital: priorNetEquity,
                prior_run_id: lastRun.run_id,
                prior_net_equity: priorNetEquity,
                open_positions_from_prior: openPositionCount,
            };
        }
        
        // No prior run and no PAPER_CAPITAL — use default
        const defaultCapital = parseFloat(process.env.PAPER_CAPITAL || '10000');
        const newRunId = generateRunId();
        return {
            valid: true,
            mode: 'fresh_start',
            run_id: newRunId,
            starting_capital: defaultCapital,
        };
        
    } catch (err: any) {
        logger.error(`[RUN-EPOCH] Startup validation failed: ${err.message}`);
        return {
            valid: false,
            mode: 'hybrid_blocked',
            error: `Startup validation failed: ${err.message}`,
        };
    }
}

/**
 * Initialize a new run epoch
 * 
 * MUST be called at bot startup after validation passes.
 * Creates run_epochs record and sets global state.
 */
export async function initializeRunEpoch(
    runId: string,
    startingCapital: number,
    paperCapitalProvided: boolean,
    parentRunId: string | null = null
): Promise<boolean> {
    const startedAt = new Date().toISOString();
    
    try {
        // Close any prior active runs
        if (parentRunId) {
            await supabase
                .from('run_epochs')
                .update({ status: 'closed' })
                .eq('run_id', parentRunId);
        }
        
        // Create new run epoch record
        const runEpoch: RunEpoch = {
            run_id: runId,
            started_at: startedAt,
            starting_capital: startingCapital,
            paper_capital_provided: paperCapitalProvided,
            parent_run_id: parentRunId,
            status: 'active',
        };
        
        const { error: insertError } = await supabase
            .from('run_epochs')
            .insert(runEpoch);
        
        if (insertError) {
            // Table might not exist yet - create it
            if (insertError.message.includes('does not exist') || insertError.code === '42P01') {
                logger.warn('[RUN-EPOCH] run_epochs table does not exist - will use in-memory only');
            } else {
                logger.error(`[RUN-EPOCH] Failed to create run epoch: ${insertError.message}`);
            }
        }
        
        // Set global state
        activeRunId = runId;
        activeRunEpoch = runEpoch;
        startingCapitalThisRun = startingCapital;
        
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info(`[RUN-EPOCH] NEW EPOCH INITIALIZED`);
        logger.info(`   Run ID: ${runId}`);
        logger.info(`   Starting Capital: $${startingCapital.toFixed(2)}`);
        logger.info(`   Mode: ${paperCapitalProvided ? 'FRESH START' : 'CONTINUATION'}`);
        if (parentRunId) {
            logger.info(`   Parent Run: ${parentRunId}`);
        }
        logger.info(`   Started At: ${startedAt}`);
        logger.info('═══════════════════════════════════════════════════════════════');
        
        return true;
        
    } catch (err: any) {
        logger.error(`[RUN-EPOCH] Failed to initialize: ${err.message}`);
        
        // Fallback to in-memory only
        activeRunId = runId;
        startingCapitalThisRun = startingCapital;
        activeRunEpoch = {
            run_id: runId,
            started_at: startedAt,
            starting_capital: startingCapital,
            paper_capital_provided: paperCapitalProvided,
            parent_run_id: parentRunId,
            status: 'active',
        };
        
        return true;
    }
}

/**
 * Get run-scoped realized PnL
 * 
 * Only includes trades closed DURING this run.
 * NEVER includes historical trades from prior runs.
 */
export async function getRunScopedRealizedPnL(): Promise<number> {
    if (!activeRunId || !activeRunEpoch) {
        return 0;
    }
    
    try {
        // Get trades closed during this run
        const { data: closedTrades, error } = await supabase
            .from('trades')
            .select('pnl_usd, pnl_net')
            .eq('status', 'closed')
            .eq('run_id', activeRunId);
        
        if (error) {
            // Fallback: use timestamp-based filtering if run_id column doesn't exist
            const { data: fallbackTrades } = await supabase
                .from('trades')
                .select('pnl_usd, pnl_net, exit_time')
                .eq('status', 'closed')
                .gte('exit_time', activeRunEpoch.started_at);
            
            if (fallbackTrades) {
                return fallbackTrades.reduce((sum: number, t: { pnl_net?: number | null; pnl_usd?: number | null }) => sum + (t.pnl_net ?? t.pnl_usd ?? 0), 0);
            }
            return 0;
        }
        
        if (!closedTrades) return 0;
        
        return closedTrades.reduce((sum: number, t: { pnl_net?: number | null; pnl_usd?: number | null }) => sum + (t.pnl_net ?? t.pnl_usd ?? 0), 0);
        
    } catch (err: any) {
        logger.error(`[RUN-EPOCH] Failed to get run-scoped PnL: ${err.message}`);
        return 0;
    }
}

/**
 * Get run-scoped net equity
 * 
 * Formula:
 *   Net Equity = Starting Capital (this run)
 *              + Realized PnL (this run only)
 *              + Unrealized PnL (active positions this run)
 */
export async function getRunScopedNetEquity(unrealizedPnL: number = 0): Promise<RunEpochState> {
    const now = new Date().toISOString();
    
    if (!activeRunId || !activeRunEpoch) {
        return {
            run_id: 'unknown',
            starting_capital: 0,
            realized_pnl: 0,
            unrealized_pnl: 0,
            net_equity: 0,
            open_positions: 0,
            closed_trades: 0,
            updated_at: now,
        };
    }
    
    const realizedPnL = await getRunScopedRealizedPnL();
    const netEquity = startingCapitalThisRun + realizedPnL + unrealizedPnL;
    
    // Get position/trade counts for this run
    let openPositions = 0;
    let closedTrades = 0;
    
    try {
        const { data: openPos } = await supabase
            .from('positions')
            .select('trade_id')
            .is('closed_at', null)
            .eq('run_id', activeRunId);
        
        openPositions = openPos?.length ?? 0;
        
        const { data: closedT } = await supabase
            .from('trades')
            .select('id')
            .eq('status', 'closed')
            .eq('run_id', activeRunId);
        
        closedTrades = closedT?.length ?? 0;
        
    } catch {
        // Fallback to timestamp-based counting
        try {
            const { data: openPos } = await supabase
                .from('positions')
                .select('trade_id')
                .is('closed_at', null)
                .gte('created_at', activeRunEpoch.started_at);
            
            openPositions = openPos?.length ?? 0;
        } catch {}
    }
    
    return {
        run_id: activeRunId,
        starting_capital: startingCapitalThisRun,
        realized_pnl: Math.round(realizedPnL * 100) / 100,
        unrealized_pnl: Math.round(unrealizedPnL * 100) / 100,
        net_equity: Math.round(netEquity * 100) / 100,
        open_positions: openPositions,
        closed_trades: closedTrades,
        updated_at: now,
    };
}

/**
 * Sanity check: Detect phantom equity
 * 
 * If Net Equity > Starting Capital + maxUnrealized + epsilon, something is wrong.
 */
export function sanityCheckEquity(
    netEquity: number,
    startingCapital: number,
    maxUnrealizedPnL: number,
    epsilon: number = 1.0
): { valid: boolean; error?: string } {
    const maxAllowedEquity = startingCapital + maxUnrealizedPnL + epsilon;
    
    if (netEquity > maxAllowedEquity) {
        const excess = netEquity - maxAllowedEquity;
        return {
            valid: false,
            error: `PHANTOM EQUITY DETECTED: Net Equity ($${netEquity.toFixed(2)}) ` +
                   `exceeds maximum allowed ($${maxAllowedEquity.toFixed(2)}) ` +
                   `by $${excess.toFixed(2)}. ` +
                   `Starting Capital: $${startingCapital.toFixed(2)}, ` +
                   `Max Unrealized: $${maxUnrealizedPnL.toFixed(2)}`,
        };
    }
    
    return { valid: true };
}

/**
 * Check if historical data exists outside active run
 */
export async function checkHistoricalDataOutsideRun(): Promise<{
    hasHistoricalData: boolean;
    priorRunCount: number;
    priorTradeCount: number;
    totalHistoricalPnL: number;
}> {
    if (!activeRunId || !activeRunEpoch) {
        return {
            hasHistoricalData: false,
            priorRunCount: 0,
            priorTradeCount: 0,
            totalHistoricalPnL: 0,
        };
    }
    
    try {
        // Count prior runs
        const { data: priorRuns } = await supabase
            .from('run_epochs')
            .select('run_id')
            .neq('run_id', activeRunId);
        
        const priorRunCount = priorRuns?.length ?? 0;
        
        // Count trades from prior runs
        const { data: priorTrades } = await supabase
            .from('trades')
            .select('pnl_usd, pnl_net')
            .eq('status', 'closed')
            .lt('created_at', activeRunEpoch.started_at);
        
        const priorTradeCount = priorTrades?.length ?? 0;
        const totalHistoricalPnL = priorTrades?.reduce((sum: number, t: { pnl_net?: number | null; pnl_usd?: number | null }) => 
            sum + (t.pnl_net ?? t.pnl_usd ?? 0), 0) ?? 0;
        
        return {
            hasHistoricalData: priorRunCount > 0 || priorTradeCount > 0,
            priorRunCount,
            priorTradeCount,
            totalHistoricalPnL: Math.round(totalHistoricalPnL * 100) / 100,
        };
        
    } catch {
        return {
            hasHistoricalData: false,
            priorRunCount: 0,
            priorTradeCount: 0,
            totalHistoricalPnL: 0,
        };
    }
}

/**
 * Close the current run epoch (for graceful shutdown)
 */
export async function closeRunEpoch(): Promise<void> {
    if (!activeRunId) return;
    
    try {
        await supabase
            .from('run_epochs')
            .update({
                status: 'closed',
            })
            .eq('run_id', activeRunId);
        
        logger.info(`[RUN-EPOCH] Closed epoch: ${activeRunId}`);
        
    } catch (err: any) {
        logger.warn(`[RUN-EPOCH] Failed to close epoch: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    getActiveRunId,
    getActiveRunEpoch,
    getStartingCapitalThisRun,
    validateStartupConditions,
    initializeRunEpoch,
    getRunScopedRealizedPnL,
    getRunScopedNetEquity,
    sanityCheckEquity,
    checkHistoricalDataOutsideRun,
    closeRunEpoch,
};

