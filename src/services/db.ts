/**
 * Database Helper Module - Safe Database Operations with Strict Error Handling
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: ALL DB WRITES MUST GO THROUGH THIS MODULE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides:
 * - safeInsert() — Insert with error checking and logging
 * - safeUpdate() — Update with error checking and logging
 * - safeUpsert() — Upsert with error checking and logging
 * - verifyDbHealth() — Startup health check
 * 
 * RULES:
 * 1. NEVER swallow errors - always throw on failure
 * 2. Always log [DB-WRITE] on success
 * 3. Always log [DB-ERROR] on failure with full context
 * 4. All operations are awaited - no fire-and-forget
 * 
 * GREP-FRIENDLY LOGS:
 * - [DB-WRITE] - Successful database write
 * - [DB-ERROR] - Database operation failed
 * - [DB-HEALTH] - Database health check result
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabaseClient, isSupabaseAvailable } from '../integrations/supabaseClient';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DbOperationContext {
    /** Operation name (e.g., 'OPEN_POSITION', 'CLOSE_POSITION', 'UPDATE_TRADE') */
    op: string;
    /** Optional ID for the record being operated on */
    id?: string;
    /** Optional additional context for logging */
    details?: Record<string, unknown>;
}

export interface DbWriteResult<T> {
    data: T;
    success: true;
}

export interface DbError {
    message: string;
    code?: string;
    details?: string;
    hint?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log a database error with full context
 */
function logDbError(
    table: string,
    context: DbOperationContext,
    error: DbError
): void {
    const errorLog = {
        table,
        op: context.op,
        id: context.id,
        errorMessage: error.message,
        errorCode: error.code,
        errorDetails: error.details,
        errorHint: error.hint,
        timestamp: new Date().toISOString(),
        ...context.details,
    };
    
    logger.error(`[DB-ERROR] ${JSON.stringify(errorLog)}`);
}

/**
 * Log a successful database write
 */
function logDbWrite(
    table: string,
    context: DbOperationContext,
    rowCount: number = 1
): void {
    const writeLog = {
        table,
        op: context.op,
        id: context.id,
        rowCount,
        timestamp: new Date().toISOString(),
    };
    
    logger.info(`[DB-WRITE] ${JSON.stringify(writeLog)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFE INSERT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safely insert a record into a table with error checking and logging.
 * 
 * BEHAVIOR:
 * - On success: Logs [DB-WRITE] and returns the inserted row
 * - On failure: Logs [DB-ERROR] and THROWS an Error (never swallows)
 * 
 * @param table - Table name to insert into
 * @param payload - Record to insert
 * @param context - Operation context for logging
 * @returns The inserted row
 * @throws Error if insert fails or Supabase unavailable
 */
export async function safeInsert<T extends Record<string, unknown>>(
    table: string,
    payload: T,
    context: DbOperationContext
): Promise<T> {
    // Check if Supabase is available
    if (!isSupabaseAvailable()) {
        const error: DbError = {
            message: 'Supabase not available - database operations disabled',
            code: 'SUPABASE_UNAVAILABLE',
        };
        logDbError(table, context, error);
        throw new Error(`[DB-ERROR] Supabase unavailable for ${context.op} on ${table}`);
    }
    
    try {
        const { data, error } = await supabaseClient
            .from(table)
            .insert(payload)
            .select('*')
            .single();
        
        if (error) {
            logDbError(table, context, {
                message: error.message,
                code: error.code,
                details: error.details,
                hint: error.hint,
            });
            throw new Error(`[DB-ERROR] ${context.op} failed on ${table}: ${error.message}`);
        }
        
        if (!data) {
            const noDataError: DbError = {
                message: 'Insert succeeded but no data returned',
                code: 'NO_DATA_RETURNED',
            };
            logDbError(table, context, noDataError);
            throw new Error(`[DB-ERROR] ${context.op} returned no data on ${table}`);
        }
        
        logDbWrite(table, context);
        return data as T;
        
    } catch (err: unknown) {
        // Re-throw if already our error format
        if (err instanceof Error && err.message.startsWith('[DB-ERROR]')) {
            throw err;
        }
        
        // Wrap unexpected errors
        const unexpectedError: DbError = {
            message: err instanceof Error ? err.message : String(err),
            code: 'UNEXPECTED_ERROR',
        };
        logDbError(table, context, unexpectedError);
        throw new Error(`[DB-ERROR] Unexpected error in ${context.op} on ${table}: ${unexpectedError.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFE UPDATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safely update records in a table with error checking and logging.
 * 
 * BEHAVIOR:
 * - On success: Logs [DB-WRITE] and returns the updated rows
 * - On failure: Logs [DB-ERROR] and THROWS an Error (never swallows)
 * 
 * @param table - Table name to update
 * @param payload - Fields to update
 * @param filters - Object of column-value pairs to filter by (uses .eq())
 * @param context - Operation context for logging
 * @returns The updated rows
 * @throws Error if update fails or Supabase unavailable
 */
export async function safeUpdate<T extends Record<string, unknown>>(
    table: string,
    payload: Partial<T>,
    filters: Record<string, unknown>,
    context: DbOperationContext
): Promise<T[]> {
    // Check if Supabase is available
    if (!isSupabaseAvailable()) {
        const error: DbError = {
            message: 'Supabase not available - database operations disabled',
            code: 'SUPABASE_UNAVAILABLE',
        };
        logDbError(table, context, error);
        throw new Error(`[DB-ERROR] Supabase unavailable for ${context.op} on ${table}`);
    }
    
    try {
        // Build query with filters
        let query = supabaseClient.from(table).update(payload);
        
        for (const [column, value] of Object.entries(filters)) {
            query = query.eq(column, value);
        }
        
        const { data, error } = await query.select('*');
        
        if (error) {
            logDbError(table, context, {
                message: error.message,
                code: error.code,
                details: error.details,
                hint: error.hint,
            });
            throw new Error(`[DB-ERROR] ${context.op} failed on ${table}: ${error.message}`);
        }
        
        const rowCount = data?.length ?? 0;
        logDbWrite(table, context, rowCount);
        
        return (data ?? []) as T[];
        
    } catch (err: unknown) {
        // Re-throw if already our error format
        if (err instanceof Error && err.message.startsWith('[DB-ERROR]')) {
            throw err;
        }
        
        // Wrap unexpected errors
        const unexpectedError: DbError = {
            message: err instanceof Error ? err.message : String(err),
            code: 'UNEXPECTED_ERROR',
        };
        logDbError(table, context, unexpectedError);
        throw new Error(`[DB-ERROR] Unexpected error in ${context.op} on ${table}: ${unexpectedError.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFE UPSERT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safely upsert a record into a table with error checking and logging.
 * 
 * BEHAVIOR:
 * - On success: Logs [DB-WRITE] and returns the upserted row
 * - On failure: Logs [DB-ERROR] and THROWS an Error (never swallows)
 * 
 * @param table - Table name to upsert into
 * @param payload - Record to upsert
 * @param context - Operation context for logging
 * @param onConflict - Column(s) to use for conflict detection (optional)
 * @returns The upserted row
 * @throws Error if upsert fails or Supabase unavailable
 */
export async function safeUpsert<T extends Record<string, unknown>>(
    table: string,
    payload: T,
    context: DbOperationContext,
    onConflict?: string
): Promise<T> {
    // Check if Supabase is available
    if (!isSupabaseAvailable()) {
        const error: DbError = {
            message: 'Supabase not available - database operations disabled',
            code: 'SUPABASE_UNAVAILABLE',
        };
        logDbError(table, context, error);
        throw new Error(`[DB-ERROR] Supabase unavailable for ${context.op} on ${table}`);
    }
    
    try {
        // Build upsert options
        const upsertOptions = onConflict ? { onConflict } : undefined;
        
        const { data, error } = await supabaseClient
            .from(table)
            .upsert(payload, upsertOptions)
            .select('*')
            .single();
        
        if (error) {
            logDbError(table, context, {
                message: error.message,
                code: error.code,
                details: error.details,
                hint: error.hint,
            });
            throw new Error(`[DB-ERROR] ${context.op} failed on ${table}: ${error.message}`);
        }
        
        if (!data) {
            const noDataError: DbError = {
                message: 'Upsert succeeded but no data returned',
                code: 'NO_DATA_RETURNED',
            };
            logDbError(table, context, noDataError);
            throw new Error(`[DB-ERROR] ${context.op} returned no data on ${table}`);
        }
        
        logDbWrite(table, context);
        return data as T;
        
    } catch (err: unknown) {
        // Re-throw if already our error format
        if (err instanceof Error && err.message.startsWith('[DB-ERROR]')) {
            throw err;
        }
        
        // Wrap unexpected errors
        const unexpectedError: DbError = {
            message: err instanceof Error ? err.message : String(err),
            code: 'UNEXPECTED_ERROR',
        };
        logDbError(table, context, unexpectedError);
        throw new Error(`[DB-ERROR] Unexpected error in ${context.op} on ${table}: ${unexpectedError.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verify database health at startup.
 * 
 * Checks:
 * 1. Supabase client is configured
 * 2. Can reach the database
 * 3. Required tables exist (capital_state, trades, positions)
 * 
 * MUST be called during startup - bot should NOT run without a working DB.
 * 
 * @throws Error if database health check fails
 */
export async function verifyDbHealth(): Promise<void> {
    const checkStart = Date.now();
    
    logger.info('[DB-HEALTH] Starting database health check...');
    
    // Check 1: Supabase configuration
    if (!isSupabaseAvailable()) {
        const error = 'Supabase not configured - SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing';
        logger.error(`[DB-HEALTH-ERROR] ${JSON.stringify({ message: error, errorCode: 'CONFIG_MISSING' })}`);
        throw new Error(`[DB-HEALTH] ${error}`);
    }
    
    // Check 2: Can query capital_state table
    try {
        const { data, error } = await supabaseClient
            .from('capital_state')
            .select('id')
            .limit(1);
        
        if (error) {
            logger.error(`[DB-HEALTH-ERROR] ${JSON.stringify({
                message: 'capital_state query failed',
                errorMessage: error.message,
                errorCode: error.code,
            })}`);
            throw new Error(`[DB-HEALTH] capital_state query failed: ${error.message}`);
        }
        
        logger.info('[DB-HEALTH] ✅ capital_state table accessible');
        
    } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith('[DB-HEALTH]')) {
            throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[DB-HEALTH-ERROR] ${JSON.stringify({ message: msg, errorCode: 'QUERY_FAILED' })}`);
        throw new Error(`[DB-HEALTH] Failed to query capital_state: ${msg}`);
    }
    
    // Check 3: Can query trades table
    try {
        const { error } = await supabaseClient
            .from('trades')
            .select('id')
            .limit(1);
        
        if (error) {
            logger.error(`[DB-HEALTH-ERROR] ${JSON.stringify({
                message: 'trades query failed',
                errorMessage: error.message,
                errorCode: error.code,
            })}`);
            throw new Error(`[DB-HEALTH] trades query failed: ${error.message}`);
        }
        
        logger.info('[DB-HEALTH] ✅ trades table accessible');
        
    } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith('[DB-HEALTH]')) {
            throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[DB-HEALTH-ERROR] ${JSON.stringify({ message: msg, errorCode: 'QUERY_FAILED' })}`);
        throw new Error(`[DB-HEALTH] Failed to query trades: ${msg}`);
    }
    
    // Check 4: Can query positions table (using trade_id as PK per canonical schema)
    try {
        const { error } = await supabaseClient
            .from('positions')
            .select('trade_id')
            .limit(1);
        
        if (error) {
            logger.error(`[DB-HEALTH-ERROR] ${JSON.stringify({
                message: 'positions query failed',
                errorMessage: error.message,
                errorCode: error.code,
            })}`);
            throw new Error(`[DB-HEALTH] positions query failed: ${error.message}`);
        }
        
        logger.info('[DB-HEALTH] ✅ positions table accessible');
        
    } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith('[DB-HEALTH]')) {
            throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[DB-HEALTH-ERROR] ${JSON.stringify({ message: msg, errorCode: 'QUERY_FAILED' })}`);
        throw new Error(`[DB-HEALTH] Failed to query positions: ${msg}`);
    }
    
    const elapsed = Date.now() - checkStart;
    logger.info(`[DB-HEALTH] ✅ All database health checks passed (${elapsed}ms)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    safeInsert,
    safeUpdate,
    safeUpsert,
    verifyDbHealth,
};

