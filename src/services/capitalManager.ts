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
 * 
 * RULES:
 * 1. NEVER rely on in-memory P&L - all capital comes from DB
 * 2. allocate() must lock capital BEFORE trade execution
 * 3. release() must be called on trade exit
 * 4. applyPNL() must update capital with realized gains/losses
 * 5. If database unavailable → FAIL SAFE (reject trade)
 */

import { supabase } from '../db/supabase';
import logger from '../utils/logger';

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
     * Reset capital to initial value (for testing/paper trading reset)
     */
    async reset(initialCapital?: number): Promise<void> {
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const capitalManager = new CapitalManager();

export default capitalManager;

