import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import logger from '../utils/logger';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    logger.error('Missing Supabase URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}

// Validate URL format to prevent crash
const isValidUrl = (url: string) => {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
};

export const supabase = (supabaseUrl && isValidUrl(supabaseUrl) && supabaseKey)
    ? createClient(supabaseUrl, supabaseKey)
    : {
        from: () => ({
            select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ data: [], error: 'Mock Client: No DB connection' }) }) }) }),
            insert: () => ({ error: 'Mock Client: No DB connection' }),
            maybeSingle: () => ({ data: null, error: 'Mock Client: No DB connection' })
        })
    } as any; // Mock client to prevent crash if config missing

// ═══════════════════════════════════════════════════════════════════════════════
// POOL METADATA TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool metadata for auto-registration
 * Ensures pools table has entries before trades/positions are persisted
 */
export interface PoolMeta {
    pool_address: string;
    tokenA?: string;          // Base token mint address
    tokenB?: string;          // Quote token mint address
    decimalsA?: number;       // Base token decimals
    decimalsB?: number;       // Quote token decimals
    name?: string;            // Pool name (e.g., "BONK/USDC")
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO POOL REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ensure pool exists in the pools table before persisting trades/positions.
 * If missing, automatically inserts the pool metadata.
 * 
 * This eliminates FK violations and enables a clean relational schema.
 * 
 * @param poolMeta - Pool metadata to register
 * @returns true if pool exists or was inserted, false on error
 */
export async function ensurePoolExists(poolMeta: PoolMeta): Promise<boolean> {
    const { pool_address } = poolMeta;

    if (!pool_address) {
        logger.error('[POOL-REGISTER] Cannot register pool - missing pool_address');
        return false;
    }

    try {
        // Check if pool already exists
        const existing = await supabase
            .from('pools')
            .select('pool_address')
            .eq('pool_address', pool_address)
            .maybeSingle();

        if (existing.data) {
            logger.debug(`[POOL-REGISTER] Pool already present ${pool_address.slice(0, 8)}...`);
            return true;
        }

        // Insert minimal pool metadata
        const insertPayload = {
            pool_address,
            token_a: poolMeta.tokenA ?? null,
            token_b: poolMeta.tokenB ?? null,
            decimals_a: poolMeta.decimalsA ?? null,
            decimals_b: poolMeta.decimalsB ?? null,
            name: poolMeta.name ?? null,
            metadata: poolMeta,
            created_at: new Date().toISOString(),
        };

        const insert = await supabase
            .from('pools')
            .insert(insertPayload);

        if (insert.error) {
            // Check if it's a duplicate key error (race condition - another process inserted)
            if (insert.error.code === '23505' || insert.error.message?.includes('duplicate')) {
                logger.debug(`[POOL-REGISTER] Pool already present (race) ${pool_address.slice(0, 8)}...`);
                return true;
            }
            
            logger.error(`[POOL-REGISTER] Insert failed for ${pool_address.slice(0, 8)}...: ${insert.error.message}`);
            return false;
        }

        logger.info(`[POOL-REGISTER] Inserted new pool ${pool_address.slice(0, 8)}...`);
        return true;

    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[POOL-REGISTER] Error for ${pool_address.slice(0, 8)}...: ${errorMsg}`);
        return false;
    }
}

export const logAction = async (action: string, details: any) => {
    const { error } = await supabase.from('bot_logs').insert({
        action,
        details,
        timestamp: new Date().toISOString(),
    });

    if (error) {
        logger.error('Failed to log action to Supabase', error);
    }
};

export const saveSnapshot = async (poolData: any) => {
    const { error } = await supabase.from('pool_snapshots').insert({
        pool_address: poolData.address,
        data: poolData,
        timestamp: new Date().toISOString()
    });
    if (error) {
        logger.error('Failed to save snapshot', error);
    }
}
