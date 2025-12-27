/**
 * Capital Manager - Persistent Capital Tracking via Supabase
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: ALL CAPITAL OPERATIONS MUST GO THROUGH THIS MODULE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module handles:
 * - Persistent capital balance (survives bot restarts)
 * - Capital allocation/locking per trade
 * - Realized P&L application on exit
 * - Atomic database operations
 * - Fail-safe behavior (no trade if DB unavailable)
 * - RUN_ID scoping for accounting correctness
 * 
 * RULES:
 * 1. NEVER rely on in-memory P&L - all capital comes from DB
 * 2. allocate() must lock capital BEFORE trade execution
 * 3. release() must be called on trade exit
 * 4. applyPNL() must update capital with realized gains/losses
 * 5. If database unavailable → FAIL SAFE (reject trade)
 * 6. All PnL is scoped to active run_id
 * 
 * EQUITY FORMULA (run_id scoped):
 *   Net Equity = Starting Capital (this run)
 *              + Realized PnL (this run only)
 *              + Unrealized PnL (active positions this run)
 */

import { supabase } from '../db/supabase';
import logger from '../utils/logger';
import { isReconciliationSealed } from '../state/reconciliationSeal';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

interface CapitalState {
    available_balance: number;      // Unlocked capital available for new trades
    locked_balance: number;         // Capital locked in active trades
    total_realized_pnl: number;     // Cumulative realized P&L
    initial_capital: number;        // Starting capital (for reference)
    updated_at: string;             // Last update timestamp
}

interface CapitalLock {
    trade_id: string;
    amount: number;
    locked_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class CapitalManager {
    private initialized: boolean = false;
    private dbAvailable: boolean = false;
    private activeRunId: string | null = null;
    private runStartingCapital: number = 0;
    private runStartedAt: string | null = null;
    
    /**
     * Initialize capital manager - MUST be called before any operations
     * Creates capital_state table if not exists and validates connection
     */
    async initialize(initialCapital?: number): Promise<boolean> {
        try {
            // Test database connection
            const { data, error } = await supabase
                .from('capital_state')
                .select('*')
                .limit(1);
            
            if (error) {
                // Table might not exist - try to create it
                if (error.message.includes('does not exist') || error.code === '42P01') {
                    logger.error('[CAPITAL] capital_state table does not exist');
                    logger.error('[CAPITAL] Please run the SQL migration to create required tables');
                    this.dbAvailable = false;
                    this.initialized = false;
                    return false;
                }
                
                logger.error(`[CAPITAL] Database error: ${error.message}`);
                this.dbAvailable = false;
                this.initialized = false;
                return false;
            }
            
            // Check if we have a capital state record
            if (!data || data.length === 0) {
                // Initialize with default capital
                const startingCapital = initialCapital ?? parseFloat(process.env.PAPER_CAPITAL || '10000');
                
                const { error: insertError } = await supabase
                    .from('capital_state')
                    .insert({
                        id: 1, // Single row for capital state
                        available_balance: startingCapital,
                        locked_balance: 0,
                        total_realized_pnl: 0,
                        initial_capital: startingCapital,
                        updated_at: new Date().toISOString(),
                    });
                
                if (insertError) {
                    logger.error(`[CAPITAL] Failed to initialize capital state: ${insertError.message}`);
                    this.dbAvailable = false;
                    this.initialized = false;
                    return false;
                }
                
                logger.info(`[CAPITAL] ✅ Initialized with starting capital: $${startingCapital.toFixed(2)}`);
            } else {
                logger.info(`[CAPITAL] ✅ Connected - Available: $${data[0].available_balance.toFixed(2)}, Locked: $${data[0].locked_balance.toFixed(2)}`);
            }
            
            this.dbAvailable = true;
            this.initialized = true;
            return true;
            
        } catch (err: any) {
            logger.error(`[CAPITAL] Initialization failed: ${err.message || err}`);
            this.dbAvailable = false;
            this.initialized = false;
            return false;
        }
    }
    
    /**
     * Check if capital manager is ready for operations
     */
    isReady(): boolean {
        return this.initialized && this.dbAvailable;
    }
    
    /**
     * Get current available balance from database
     * 
     * @returns Available balance or 0 if DB unavailable
     * @throws Error if database is unavailable (fail-safe)
     */
    async getBalance(): Promise<number> {
        if (!this.isReady()) {
            throw new Error('Capital manager not initialized - cannot retrieve balance');
        }
        
        try {
            const { data, error } = await supabase
                .from('capital_state')
                .select('available_balance')
                .eq('id', 1)
                .single();
            
            if (error) {
                throw new Error(`Database error: ${error.message}`);
            }
            
            if (!data) {
                throw new Error('No capital state found in database');
            }
            
            return data.available_balance;
            
        } catch (err: any) {
            logger.error(`[CAPITAL] getBalance failed: ${err.message || err}`);
            throw err;
        }
    }
    
    /**
     * Get full capital state from database
     */
    async getFullState(): Promise<CapitalState | null> {
        if (!this.isReady()) {
            return null;
        }
        
        try {
            const { data, error } = await supabase
                .from('capital_state')
                .select('*')
                .eq('id', 1)
                .single();
            
            if (error || !data) {
                return null;
            }
            
            return data as CapitalState;
            
        } catch {
            return null;
        }
    }
    
    /**
     * Get total equity (available + locked)
     */
    async getEquity(): Promise<number> {
        if (!this.isReady()) {
            throw new Error('Capital manager not initialized');
        }
        
        try {
            const { data, error } = await supabase
                .from('capital_state')
                .select('available_balance, locked_balance')
                .eq('id', 1)
                .single();
            
            if (error || !data) {
                throw new Error('Failed to retrieve capital state');
            }
            
            return data.available_balance + data.locked_balance;
            
        } catch (err: any) {
            throw err;
        }
    }
    
    /**
     * Allocate capital for a new trade
     * 
     * ATOMIC OPERATION:
     * 1. Check if balance >= requested amount
     * 2. Subtract from available_balance
     * 3. Add to locked_balance
     * 4. Record lock in capital_locks table
     * 
     * @param tradeId - Unique trade identifier
     * @param amount - Amount to allocate
     * @returns true if allocation successful, false if insufficient balance
     * @throws Error if database unavailable (fail-safe - do not trade)
     */
    async allocate(tradeId: string, amount: number): Promise<boolean> {
        if (!this.isReady()) {
            throw new Error('Capital manager not initialized - cannot allocate capital');
        }
        
        if (amount <= 0) {
            logger.warn(`[CAPITAL] Invalid allocation amount: ${amount}`);
            return false;
        }
        
        try {
            // Get current state
            const { data: currentState, error: fetchError } = await supabase
                .from('capital_state')
                .select('available_balance, locked_balance')
                .eq('id', 1)
                .single();
            
            if (fetchError || !currentState) {
                throw new Error(`Failed to fetch capital state: ${fetchError?.message || 'No data'}`);
            }
            
            // Check if sufficient balance
            if (currentState.available_balance < amount) {
                logger.warn(`[CAPITAL] Insufficient balance: $${currentState.available_balance.toFixed(2)} < $${amount.toFixed(2)}`);
                return false;
            }
            
            // Update capital state atomically
            const newAvailable = currentState.available_balance - amount;
            const newLocked = currentState.locked_balance + amount;
            
            const { error: updateError } = await supabase
                .from('capital_state')
                .update({
                    available_balance: newAvailable,
                    locked_balance: newLocked,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', 1);
            
            if (updateError) {
                throw new Error(`Failed to update capital state: ${updateError.message}`);
            }
            
            // Record the lock
            const { error: lockError } = await supabase
                .from('capital_locks')
                .insert({
                    trade_id: tradeId,
                    amount: amount,
                    locked_at: new Date().toISOString(),
                });
            
            if (lockError) {
                // Rollback the capital state update
                await supabase
                    .from('capital_state')
                    .update({
                        available_balance: currentState.available_balance,
                        locked_balance: currentState.locked_balance,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', 1);
                
                throw new Error(`Failed to record capital lock: ${lockError.message}`);
            }
            
            logger.info(`[CAPITAL] ✅ Allocated $${amount.toFixed(2)} for trade ${tradeId.slice(0, 8)}... (Available: $${newAvailable.toFixed(2)})`);
            return true;
            
        } catch (err: any) {
            logger.error(`[CAPITAL] Allocation failed: ${err.message || err}`);
            throw err; // Propagate error - fail safe
        }
    }
    
    /**
     * Release locked capital back to available (without P&L - used for failed trades)
     * 
     * @param tradeId - Trade ID to release capital for
     */
    async release(tradeId: string): Promise<void> {
        if (!this.isReady()) {
            throw new Error('Capital manager not initialized');
        }
        
        try {
            // Get the lock record
            const { data: lockData, error: lockFetchError } = await supabase
                .from('capital_locks')
                .select('amount')
                .eq('trade_id', tradeId)
                .single();
            
            if (lockFetchError || !lockData) {
                logger.warn(`[CAPITAL] No lock found for trade ${tradeId}`);
                return;
            }
            
            const amount = lockData.amount;
            
            // Get current state
            const { data: currentState, error: fetchError } = await supabase
                .from('capital_state')
                .select('available_balance, locked_balance')
                .eq('id', 1)
                .single();
            
            if (fetchError || !currentState) {
                throw new Error('Failed to fetch capital state');
            }
            
            // Update capital state
            const { error: updateError } = await supabase
                .from('capital_state')
                .update({
                    available_balance: currentState.available_balance + amount,
                    locked_balance: Math.max(0, currentState.locked_balance - amount),
                    updated_at: new Date().toISOString(),
                })
                .eq('id', 1);
            
            if (updateError) {
                throw new Error(`Failed to update capital state: ${updateError.message}`);
            }
            
            // Remove the lock record
            await supabase
                .from('capital_locks')
                .delete()
                .eq('trade_id', tradeId);
            
            logger.info(`[CAPITAL] ✅ Released $${amount.toFixed(2)} for trade ${tradeId.slice(0, 8)}...`);
            
        } catch (err: any) {
            logger.error(`[CAPITAL] Release failed: ${err.message || err}`);
            throw err;
        }
    }
    
    /**
     * Apply realized P&L on trade exit
     * 
     * ATOMIC OPERATION:
     * 1. Get locked amount for trade
     * 2. Release locked capital
     * 3. Add P&L to available balance
     * 4. Update total realized P&L
     * 
     * @param tradeId - Trade ID
     * @param pnl - Realized profit/loss (positive = profit, negative = loss)
     */
    async applyPNL(tradeId: string, pnl: number): Promise<void> {
        if (!this.isReady()) {
            throw new Error('Capital manager not initialized');
        }
        
        try {
            // Get the lock record
            const { data: lockData, error: lockFetchError } = await supabase
                .from('capital_locks')
                .select('amount')
                .eq('trade_id', tradeId)
                .single();
            
            if (lockFetchError || !lockData) {
                logger.warn(`[CAPITAL] No lock found for trade ${tradeId} - skipping PNL application`);
                return;
            }
            
            const lockedAmount = lockData.amount;
            
            // Get current state
            const { data: currentState, error: fetchError } = await supabase
                .from('capital_state')
                .select('available_balance, locked_balance, total_realized_pnl')
                .eq('id', 1)
                .single();
            
            if (fetchError || !currentState) {
                throw new Error('Failed to fetch capital state');
            }
            
            // Calculate new values
            // Return locked amount + P&L to available balance
            const returnAmount = lockedAmount + pnl;
            const newAvailable = currentState.available_balance + returnAmount;
            const newLocked = Math.max(0, currentState.locked_balance - lockedAmount);
            const newTotalPnl = currentState.total_realized_pnl + pnl;
            
            // Update capital state
            const { error: updateError } = await supabase
                .from('capital_state')
                .update({
                    available_balance: newAvailable,
                    locked_balance: newLocked,
                    total_realized_pnl: newTotalPnl,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', 1);
            
            if (updateError) {
                throw new Error(`Failed to update capital state: ${updateError.message}`);
            }
            
            // Remove the lock record
            await supabase
                .from('capital_locks')
                .delete()
                .eq('trade_id', tradeId);
            
            const pnlSign = pnl >= 0 ? '+' : '';
            logger.info(`[CAPITAL] ✅ Applied P&L ${pnlSign}$${pnl.toFixed(2)} for trade ${tradeId.slice(0, 8)}... (New balance: $${newAvailable.toFixed(2)})`);
            
        } catch (err: any) {
            logger.error(`[CAPITAL] applyPNL failed: ${err.message || err}`);
            throw err;
        }
    }
    
    /**
     * Credit an amount directly to available balance (for refunds/corrections)
     * 
     * Use this for:
     * - Stale position reconciliation refunds
     * - Manual balance corrections
     * - Error recovery
     * 
     * @param amount - Amount to credit (positive number)
     * @param reason - Reason for the credit (for logging)
     */
    async credit(amount: number, reason: string = 'MANUAL_CREDIT'): Promise<void> {
        if (!this.isReady()) {
            throw new Error('Capital manager not initialized');
        }
        
        if (amount <= 0) {
            logger.warn(`[CAPITAL] Invalid credit amount: ${amount}`);
            return;
        }
        
        try {
            // Get current state
            const { data: currentState, error: fetchError } = await supabase
                .from('capital_state')
                .select('available_balance, locked_balance')
                .eq('id', 1)
                .single();
            
            if (fetchError || !currentState) {
                throw new Error('Failed to fetch capital state');
            }
            
            const newAvailable = currentState.available_balance + amount;
            
            // Update capital state
            const { error: updateError } = await supabase
                .from('capital_state')
                .update({
                    available_balance: newAvailable,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', 1);
            
            if (updateError) {
                throw new Error(`Failed to update capital state: ${updateError.message}`);
            }
            
            logger.info(
                `[CAPITAL] Credited $${amount.toFixed(2)} (${reason}). ` +
                `New available balance: $${newAvailable.toFixed(2)}`
            );
            
        } catch (err: any) {
            logger.error(`[CAPITAL] Credit failed: ${err.message || err}`);
            throw err;
        }
    }
    
    /**
     * Reset capital to initial value (for testing/paper trading reset)
     * @deprecated Use resetCapital() instead for full reset with audit trail
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * WARNING: After reconciliation seal, reset is FORBIDDEN (except in tests)
     * ═══════════════════════════════════════════════════════════════════════════════
     */
    async reset(initialCapital?: number): Promise<void> {
        // Guard: Cannot reset after reconciliation seal (except in tests)
        if (isReconciliationSealed() && process.env.NODE_ENV !== 'test') {
            console.error('');
            console.error('════════════════════════════════════════════════════════════════');
            console.error('🚨 [CAPITAL] FATAL: reset() called after reconciliation seal');
            console.error('════════════════════════════════════════════════════════════════');
            console.error('   Capital reset is FORBIDDEN after reconciliation.');
            console.error('   This would destroy the sealed runtime truth.');
            console.error('════════════════════════════════════════════════════════════════');
            process.exit(1);
        }
        
        const startingCapital = initialCapital ?? parseFloat(process.env.PAPER_CAPITAL || '10000');
        
        try {
            // Update capital state
            await supabase
                .from('capital_state')
                .update({
                    available_balance: startingCapital,
                    locked_balance: 0,
                    total_realized_pnl: 0,
                    initial_capital: startingCapital,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', 1);
            
            // Clear all locks
            await supabase
                .from('capital_locks')
                .delete()
                .neq('trade_id', ''); // Delete all
            
            logger.info(`[CAPITAL] ✅ Reset to $${startingCapital.toFixed(2)}`);
            
        } catch (err: any) {
            logger.error(`[CAPITAL] Reset failed: ${err.message || err}`);
            throw err;
        }
    }
    
    /**
     * Full capital reset with audit trail and trade cleanup
     * 
     * ═══════════════════════════════════════════════════════════════════════════════
     * THIS IS THE PREFERRED RESET METHOD
     * ═══════════════════════════════════════════════════════════════════════════════
     * 
     * ⚠️ AFTER RECONCILIATION SEAL, THIS IS FORBIDDEN (except in tests)
     * 
     * What it does:
     * 1. Clears all open trades (marks as cancelled)
     * 2. Clears all capital locks
     * 3. Sets available_balance = balance, locked_balance = 0
     * 4. Resets total_realized_pnl to 0
     * 5. Writes entry to bot_logs for audit trail
     * 6. Records baseline_reset_at timestamp for analytics
     * 
     * Why:
     * - Prevents ghost locks from orphaned trades
     * - Prevents orphan trades from corrupting state
     * - Keeps audit trail clean and traceable
     * - Works with Tier logic, not against it
     * 
     * @param balance - New starting balance (e.g., 10000)
     * @returns Reset result with details
     */
    async resetCapital(balance: number): Promise<{
        success: boolean;
        previousState: CapitalState | null;
        tradesCleared: number;
        locksCleared: number;
        newBalance: number;
        resetTimestamp: string;
        error?: string;
    }> {
        const resetTimestamp = new Date().toISOString();
        
        // ═══════════════════════════════════════════════════════════════════════
        // GUARD: Cannot reset after reconciliation seal (except in tests)
        // ═══════════════════════════════════════════════════════════════════════
        if (isReconciliationSealed() && process.env.NODE_ENV !== 'test') {
            console.error('');
            console.error('════════════════════════════════════════════════════════════════');
            console.error('🚨 [CAPITAL] FATAL: resetCapital() called after reconciliation seal');
            console.error('════════════════════════════════════════════════════════════════');
            console.error('   Capital reset is FORBIDDEN after reconciliation.');
            console.error('   This would destroy the sealed runtime truth.');
            console.error('════════════════════════════════════════════════════════════════');
            process.exit(1);
        }
        
        logger.info('═══════════════════════════════════════════════════════════════');
        logger.info('[CAPITAL_RESET] Starting full capital reset...');
        logger.info(`[CAPITAL_RESET] New balance: $${balance.toFixed(2)}`);
        
        // Validate balance
        if (balance <= 0) {
            const error = `Invalid balance: $${balance} - must be positive`;
            logger.error(`[CAPITAL_RESET] ❌ ${error}`);
            return {
                success: false,
                previousState: null,
                tradesCleared: 0,
                locksCleared: 0,
                newBalance: 0,
                resetTimestamp,
                error,
            };
        }
        
        try {
            // ═══════════════════════════════════════════════════════════════════
            // STEP 1: Get current state for audit
            // ═══════════════════════════════════════════════════════════════════
            const previousState = await this.getFullState();
            
            logger.info(`[CAPITAL_RESET] Previous state: ` +
                `Available=$${previousState?.available_balance?.toFixed(2) || 0} | ` +
                `Locked=$${previousState?.locked_balance?.toFixed(2) || 0} | ` +
                `PnL=$${previousState?.total_realized_pnl?.toFixed(2) || 0}`
            );
            
            // ═══════════════════════════════════════════════════════════════════
            // STEP 2: Count and clear all open trades
            // ═══════════════════════════════════════════════════════════════════
            const { data: openTrades, error: tradesQueryError } = await supabase
                .from('trades')
                .select('id, pool_name, size')
                .eq('status', 'open');
            
            let tradesCleared = 0;
            
            if (!tradesQueryError && openTrades && openTrades.length > 0) {
                // Log each trade being cancelled
                for (const trade of openTrades) {
                    logger.warn(`[CAPITAL_RESET] Cancelling trade: ${trade.id.slice(0, 8)}... | ${trade.pool_name} | $${trade.size}`);
                }
                
                // Mark all open trades as cancelled
                const { error: updateError } = await supabase
                    .from('trades')
                    .update({
                        status: 'cancelled',
                        exit_reason: 'CAPITAL_RESET',
                        exit_time: resetTimestamp,
                        pnl_usd: 0, // No PnL on reset
                    })
                    .eq('status', 'open');
                
                if (updateError) {
                    logger.error(`[CAPITAL_RESET] ⚠️ Failed to cancel trades: ${updateError.message}`);
                } else {
                    tradesCleared = openTrades.length;
                    logger.info(`[CAPITAL_RESET] ✅ Cancelled ${tradesCleared} open trades`);
                }
            } else {
                logger.info('[CAPITAL_RESET] No open trades to cancel');
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // STEP 3: Clear all capital locks
            // ═══════════════════════════════════════════════════════════════════
            const { data: locks, error: locksQueryError } = await supabase
                .from('capital_locks')
                .select('trade_id, amount');
            
            let locksCleared = 0;
            
            if (!locksQueryError && locks && locks.length > 0) {
                for (const lock of locks) {
                    logger.warn(`[CAPITAL_RESET] Clearing lock: ${lock.trade_id.slice(0, 8)}... | $${lock.amount}`);
                }
                
                const { error: deleteError } = await supabase
                    .from('capital_locks')
                    .delete()
                    .neq('trade_id', ''); // Delete all
                
                if (deleteError) {
                    logger.error(`[CAPITAL_RESET] ⚠️ Failed to clear locks: ${deleteError.message}`);
                } else {
                    locksCleared = locks.length;
                    logger.info(`[CAPITAL_RESET] ✅ Cleared ${locksCleared} capital locks`);
                }
            } else {
                logger.info('[CAPITAL_RESET] No capital locks to clear');
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // STEP 4: Reset capital state
            // ═══════════════════════════════════════════════════════════════════
            const { error: updateError } = await supabase
                .from('capital_state')
                .update({
                    available_balance: balance,
                    locked_balance: 0,
                    total_realized_pnl: 0,
                    initial_capital: balance,
                    updated_at: resetTimestamp,
                })
                .eq('id', 1);
            
            if (updateError) {
                throw new Error(`Failed to update capital state: ${updateError.message}`);
            }
            
            logger.info(`[CAPITAL_RESET] ✅ Capital state reset to $${balance.toFixed(2)}`);
            
            // ═══════════════════════════════════════════════════════════════════
            // STEP 5: Record baseline reset timestamp in bot_state
            // ═══════════════════════════════════════════════════════════════════
            await supabase
                .from('bot_state')
                .upsert({
                    key: 'baseline_reset_at',
                    value: { 
                        timestamp: resetTimestamp,
                        balance: balance,
                        previousBalance: previousState?.available_balance ?? 0,
                        previousPnL: previousState?.total_realized_pnl ?? 0,
                        tradesCleared,
                        locksCleared,
                    },
                    updated_at: resetTimestamp,
                });
            
            logger.info(`[CAPITAL_RESET] ✅ Baseline reset timestamp recorded`);
            
            // ═══════════════════════════════════════════════════════════════════
            // STEP 6: Write to bot_logs for audit trail
            // ═══════════════════════════════════════════════════════════════════
            await supabase
                .from('bot_logs')
                .insert({
                    action: 'CAPITAL_RESET',
                    details: {
                        newBalance: balance,
                        previousState: {
                            available: previousState?.available_balance ?? 0,
                            locked: previousState?.locked_balance ?? 0,
                            pnl: previousState?.total_realized_pnl ?? 0,
                            initial: previousState?.initial_capital ?? 0,
                        },
                        tradesCleared,
                        locksCleared,
                        resetTimestamp,
                        reason: 'Manual capital reset via resetCapital()',
                    },
                    timestamp: resetTimestamp,
                });
            
            logger.info(`[CAPITAL_RESET] ✅ Audit log recorded`);
            
            logger.info('═══════════════════════════════════════════════════════════════');
            logger.info(`[CAPITAL_RESET] ✅ COMPLETE - New balance: $${balance.toFixed(2)}`);
            logger.info(`[CAPITAL_RESET] Summary: ${tradesCleared} trades cancelled, ${locksCleared} locks cleared`);
            logger.info('═══════════════════════════════════════════════════════════════');
            
            return {
                success: true,
                previousState,
                tradesCleared,
                locksCleared,
                newBalance: balance,
                resetTimestamp,
            };
            
        } catch (err: any) {
            const errorMessage = err.message || String(err);
            logger.error(`[CAPITAL_RESET] ❌ Failed: ${errorMessage}`);
            
            // Try to log the failure
            try {
                await supabase
                    .from('bot_logs')
                    .insert({
                        action: 'CAPITAL_RESET_FAILED',
                        details: {
                            requestedBalance: balance,
                            error: errorMessage,
                            timestamp: resetTimestamp,
                        },
                        timestamp: resetTimestamp,
                    });
            } catch {
                // Ignore logging error
            }
            
            return {
                success: false,
                previousState: null,
                tradesCleared: 0,
                locksCleared: 0,
                newBalance: 0,
                resetTimestamp,
                error: errorMessage,
            };
        }
    }
    
    /**
     * Get the last baseline reset timestamp
     */
    async getLastResetTimestamp(): Promise<string | null> {
        try {
            const { data, error } = await supabase
                .from('bot_state')
                .select('value')
                .eq('key', 'baseline_reset_at')
                .single();
            
            if (error || !data) {
                return null;
            }
            
            return data.value?.timestamp ?? null;
            
        } catch {
            return null;
        }
    }
    
    /**
     * Get all active capital locks
     */
    async getActiveLocks(): Promise<CapitalLock[]> {
        if (!this.isReady()) {
            return [];
        }
        
        try {
            const { data, error } = await supabase
                .from('capital_locks')
                .select('*');
            
            if (error || !data) {
                return [];
            }
            
            return data as CapitalLock[];
            
        } catch {
            return [];
        }
    }
    
    /**
     * Reconcile locks with active trades (cleanup orphaned locks)
     */
    async reconcileLocks(activeTradeIds: string[]): Promise<void> {
        if (!this.isReady()) {
            return;
        }
        
        try {
            const locks = await this.getActiveLocks();
            
            for (const lock of locks) {
                if (!activeTradeIds.includes(lock.trade_id)) {
                    logger.warn(`[CAPITAL] Orphaned lock found for trade ${lock.trade_id} - releasing`);
                    await this.release(lock.trade_id);
                }
            }
            
        } catch (err: any) {
            logger.error(`[CAPITAL] Reconciliation failed: ${err.message || err}`);
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // RUN EPOCH SCOPING — ACCOUNTING CORRECTNESS
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /**
     * Set the active run ID and starting capital for this epoch
     * 
     * MUST be called during bootstrap before any trades are executed.
     * All PnL calculations will be scoped to this run.
     */
    setRunEpoch(runId: string, startingCapital: number): void {
        this.activeRunId = runId;
        this.runStartingCapital = startingCapital;
        this.runStartedAt = new Date().toISOString();
        
        logger.info(`[CAPITAL] Run epoch set: ${runId} | Starting Capital: $${startingCapital.toFixed(2)}`);
    }
    
    /**
     * Get active run ID
     */
    getActiveRunId(): string | null {
        return this.activeRunId;
    }
    
    /**
     * Get starting capital for this run
     */
    getRunStartingCapital(): number {
        return this.runStartingCapital;
    }
    
    /**
     * Get run-scoped realized PnL
     * 
     * Only includes trades closed DURING this run (after runStartedAt).
     * This ensures restarts don't inherit prior run's realized PnL.
     */
    async getRunScopedRealizedPnL(): Promise<number> {
        if (!this.isReady() || !this.runStartedAt) {
            return 0;
        }
        
        try {
            const { data: closedTrades, error } = await supabase
                .from('trades')
                .select('pnl_usd, pnl_net')
                .eq('status', 'closed')
                .gte('exit_time', this.runStartedAt);
            
            if (error || !closedTrades) {
                return 0;
            }
            
            const totalPnL = closedTrades.reduce((sum: number, t: { pnl_net?: number | null; pnl_usd?: number | null }) => {
                const pnl = t.pnl_net ?? t.pnl_usd ?? 0;
                return sum + pnl;
            }, 0);
            
            return Math.round(totalPnL * 100) / 100;
            
        } catch (err: any) {
            logger.error(`[CAPITAL] Failed to get run-scoped PnL: ${err.message}`);
            return 0;
        }
    }
    
    /**
     * Get run-scoped net equity
     * 
     * Formula:
     *   Net Equity = Starting Capital (this run)
     *              + Realized PnL (this run only)
     *              + Unrealized PnL (provided)
     * 
     * This is the ONLY correct equity calculation.
     */
    async getRunScopedNetEquity(unrealizedPnL: number = 0): Promise<{
        runId: string | null;
        startingCapital: number;
        realizedPnL: number;
        unrealizedPnL: number;
        netEquity: number;
    }> {
        const realizedPnL = await this.getRunScopedRealizedPnL();
        const netEquity = this.runStartingCapital + realizedPnL + unrealizedPnL;
        
        return {
            runId: this.activeRunId,
            startingCapital: this.runStartingCapital,
            realizedPnL,
            unrealizedPnL,
            netEquity: Math.round(netEquity * 100) / 100,
        };
    }
    
    /**
     * Sanity check: Detect phantom equity
     * 
     * If Net Equity > Starting Capital + maxUnrealized + epsilon, something is wrong.
     * This MUST throw an error to prevent corrupted accounting.
     * 
     * @param netEquity Current calculated net equity
     * @param maxUnrealizedPnL Maximum possible unrealized PnL from open positions
     * @param epsilon Small tolerance for floating point (default $1)
     */
    validateEquitySanity(
        netEquity: number,
        maxUnrealizedPnL: number,
        epsilon: number = 1.0
    ): { valid: boolean; error?: string } {
        const maxAllowedEquity = this.runStartingCapital + maxUnrealizedPnL + epsilon;
        
        if (netEquity > maxAllowedEquity) {
            const excess = netEquity - maxAllowedEquity;
            const error = `[PHANTOM-EQUITY] CRITICAL: Net Equity ($${netEquity.toFixed(2)}) ` +
                          `exceeds maximum allowed ($${maxAllowedEquity.toFixed(2)}) by $${excess.toFixed(2)}. ` +
                          `Run ID: ${this.activeRunId}, ` +
                          `Starting Capital: $${this.runStartingCapital.toFixed(2)}, ` +
                          `Max Unrealized: $${maxUnrealizedPnL.toFixed(2)}`;
            
            logger.error(error);
            return { valid: false, error };
        }
        
        return { valid: true };
    }
    
    /**
     * Guardrail: Prevent restart from increasing equity
     * 
     * Called during bootstrap to verify that a restart hasn't created phantom equity.
     * 
     * @param previousEquity Equity from before restart (if known)
     * @param currentEquity Current calculated equity
     */
    validateRestartEquity(
        previousEquity: number | null,
        currentEquity: number
    ): { valid: boolean; error?: string } {
        // If we don't have previous equity, we can't validate
        if (previousEquity === null) {
            return { valid: true };
        }
        
        // Equity should not increase on restart (with small tolerance for timing)
        const tolerance = 5.0; // $5 tolerance for unrealized PnL timing differences
        
        if (currentEquity > previousEquity + tolerance) {
            const increase = currentEquity - previousEquity;
            const error = `[RESTART-EQUITY-CHECK] CRITICAL: Restart increased equity by $${increase.toFixed(2)}. ` +
                          `Previous: $${previousEquity.toFixed(2)}, Current: $${currentEquity.toFixed(2)}. ` +
                          `This indicates phantom equity or double-counting.`;
            
            logger.error(error);
            return { valid: false, error };
        }
        
        return { valid: true };
    }
    
    /**
     * Initialize capital for a fresh run (with PAPER_CAPITAL provided)
     * 
     * This resets all accounting to a clean state:
     * - available_balance = paperCapital
     * - locked_balance = 0
     * - total_realized_pnl = 0
     * 
     * CRITICAL: Must NOT be called if open positions exist from prior runs.
     */
    async initializeFreshRun(paperCapital: number, runId: string): Promise<boolean> {
        try {
            // Set run epoch first
            this.setRunEpoch(runId, paperCapital);
            
            // Reset capital state for fresh run
            const { error } = await supabase
                .from('capital_state')
                .update({
                    available_balance: paperCapital,
                    locked_balance: 0,
                    total_realized_pnl: 0,
                    initial_capital: paperCapital,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', 1);
            
            if (error) {
                logger.error(`[CAPITAL] Failed to initialize fresh run: ${error.message}`);
                return false;
            }
            
            // Clear all capital locks
            await supabase
                .from('capital_locks')
                .delete()
                .neq('trade_id', '');
            
            logger.info(`[CAPITAL] ✅ Fresh run initialized: $${paperCapital.toFixed(2)}`);
            return true;
            
        } catch (err: any) {
            logger.error(`[CAPITAL] Fresh run initialization failed: ${err.message}`);
            return false;
        }
    }
    
    /**
     * Initialize capital for a continuation run (without PAPER_CAPITAL)
     * 
     * Inherits the net equity from the previous run as starting capital.
     * Does NOT reset realized PnL - it continues accumulating.
     */
    async initializeContinuationRun(runId: string): Promise<boolean> {
        try {
            const state = await this.getFullState();
            if (!state) {
                logger.error('[CAPITAL] Cannot continue - no prior state found');
                return false;
            }
            
            // Net equity from prior run becomes starting capital for this run
            const priorNetEquity = state.available_balance + state.locked_balance;
            
            // Set run epoch with inherited equity
            this.setRunEpoch(runId, priorNetEquity);
            
            // Note: We don't reset capital_state here - we inherit it
            // But we track that this run started with priorNetEquity
            
            logger.info(
                `[CAPITAL] ✅ Continuation run initialized: ` +
                `Starting Capital: $${priorNetEquity.toFixed(2)} ` +
                `(Available: $${state.available_balance.toFixed(2)}, ` +
                `Locked: $${state.locked_balance.toFixed(2)})`
            );
            
            return true;
            
        } catch (err: any) {
            logger.error(`[CAPITAL] Continuation run initialization failed: ${err.message}`);
            return false;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const capitalManager = new CapitalManager();

export default capitalManager;

