export declare const supabase: any;
/**
 * Pool metadata for auto-registration
 * Ensures pools table has entries before trades/positions are persisted
 *
 * CANONICAL SCHEMA:
 * - pool_address TEXT PRIMARY KEY
 * - base_token TEXT NOT NULL
 * - quote_token TEXT NOT NULL
 * - token_a_mint TEXT
 * - token_b_mint TEXT
 * - decimals_a INTEGER
 * - decimals_b INTEGER
 * - blockchain TEXT
 * - dex TEXT
 * - version TEXT
 * - metadata JSONB
 * - created_at TIMESTAMP
 * - updated_at TIMESTAMPTZ
 */
export interface PoolMeta {
    pool_address: string;
    tokenA?: string;
    tokenB?: string;
    tokenAMint?: string;
    tokenBMint?: string;
    decimalsA?: number;
    decimalsB?: number;
}
/**
 * Ensure pool exists in the pools table before persisting trades/positions.
 * If missing, automatically inserts the pool metadata.
 *
 * This eliminates FK violations and enables a clean relational schema.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * CANONICAL PAYLOAD — MATCHES pools TABLE SCHEMA EXACTLY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * @param poolMeta - Pool metadata to register
 * @returns true if pool exists or was inserted, false on error
 */
export declare function ensurePoolExists(poolMeta: PoolMeta): Promise<boolean>;
export declare const logAction: (action: string, details: any) => Promise<void>;
export declare const saveSnapshot: (poolData: any) => Promise<void>;
//# sourceMappingURL=supabase.d.ts.map