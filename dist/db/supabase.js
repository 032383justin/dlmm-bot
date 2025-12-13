"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveSnapshot = exports.logAction = exports.supabase = void 0;
exports.ensurePoolExists = ensurePoolExists;
const supabase_js_1 = require("@supabase/supabase-js");
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = __importDefault(require("../utils/logger"));
dotenv_1.default.config();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
    logger_1.default.error('Missing Supabase URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}
// Validate URL format to prevent crash
const isValidUrl = (url) => {
    try {
        new URL(url);
        return true;
    }
    catch {
        return false;
    }
};
exports.supabase = (supabaseUrl && isValidUrl(supabaseUrl) && supabaseKey)
    ? (0, supabase_js_1.createClient)(supabaseUrl, supabaseKey)
    : {
        from: () => ({
            select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ data: [], error: 'Mock Client: No DB connection' }) }) }) }),
            insert: () => ({ error: 'Mock Client: No DB connection' }),
            maybeSingle: () => ({ data: null, error: 'Mock Client: No DB connection' })
        })
    }; // Mock client to prevent crash if config missing
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
async function ensurePoolExists(poolMeta) {
    const { pool_address } = poolMeta;
    if (!pool_address) {
        logger_1.default.error('[POOL-REGISTER] Cannot register pool - missing pool_address');
        return false;
    }
    try {
        // Check if pool already exists
        const existing = await exports.supabase
            .from('pools')
            .select('pool_address')
            .eq('pool_address', pool_address)
            .maybeSingle();
        if (existing.data) {
            logger_1.default.debug(`[POOL-REGISTER] Pool already present ${pool_address.slice(0, 8)}...`);
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
        const insert = await exports.supabase
            .from('pools')
            .insert(insertPayload);
        if (insert.error) {
            // Check if it's a duplicate key error (race condition - another process inserted)
            if (insert.error.code === '23505' || insert.error.message?.includes('duplicate')) {
                logger_1.default.debug(`[POOL-REGISTER] Pool already present (race) ${pool_address.slice(0, 8)}...`);
                return true;
            }
            logger_1.default.error(`[POOL-REGISTER] Insert failed for ${pool_address.slice(0, 8)}...: ${insert.error.message}`);
            return false;
        }
        logger_1.default.info(`[POOL-REGISTER] Inserted new pool ${pool_address.slice(0, 8)}...`);
        return true;
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger_1.default.error(`[POOL-REGISTER] Error for ${pool_address.slice(0, 8)}...: ${errorMsg}`);
        return false;
    }
}
const logAction = async (action, details) => {
    const { error } = await exports.supabase.from('bot_logs').insert({
        action,
        details,
        timestamp: new Date().toISOString(),
    });
    if (error) {
        logger_1.default.error('Failed to log action to Supabase', error);
    }
};
exports.logAction = logAction;
const saveSnapshot = async (poolData) => {
    const { error } = await exports.supabase.from('pool_snapshots').insert({
        pool_address: poolData.address,
        data: poolData,
        timestamp: new Date().toISOString()
    });
    if (error) {
        logger_1.default.error('Failed to save snapshot', error);
    }
};
exports.saveSnapshot = saveSnapshot;
//# sourceMappingURL=supabase.js.map