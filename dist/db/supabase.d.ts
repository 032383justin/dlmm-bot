export declare const supabase: any;
/**
 * Pool metadata for auto-registration
 * Ensures pools table has entries before trades/positions are persisted
 */
export interface PoolMeta {
    pool_address: string;
    tokenA?: string;
    tokenB?: string;
    decimalsA?: number;
    decimalsB?: number;
    name?: string;
}
/**
 * Ensure pool exists in the pools table before persisting trades/positions.
 * If missing, automatically inserts the pool metadata.
 *
 * This eliminates FK violations and enables a clean relational schema.
 *
 * @param poolMeta - Pool metadata to register
 * @returns true if pool exists or was inserted, false on error
 */
export declare function ensurePoolExists(poolMeta: PoolMeta): Promise<boolean>;
export declare const logAction: (action: string, details: any) => Promise<void>;
export declare const saveSnapshot: (poolData: any) => Promise<void>;
//# sourceMappingURL=supabase.d.ts.map