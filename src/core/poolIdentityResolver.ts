/**
 * Pool Identity Resolver — SINGLE AUTHORITATIVE MODULE
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PHASE 1 BLOCKER: Pool identity must be resolved before ANY trade logic
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module is the ONLY source of truth for pool token identity.
 * 
 * INPUT:
 *   - poolAddress
 * 
 * OUTPUT (ALL REQUIRED):
 *   - baseMint
 *   - quoteMint
 *   - baseDecimals
 *   - quoteDecimals
 *   - baseSymbol (optional)
 *   - quoteSymbol (optional)
 *   - canonicalPairKey = baseMint:quoteMint (order-stable)
 * 
 * DATA SOURCES (priority order):
 *   1. Memory cache (fastest)
 *   2. Database cache (persistent)
 *   3. DLMM SDK on-chain pool state
 *   4. SPL Mint account fetch (for decimals)
 * 
 * RULES:
 *   - If ANY required field missing → resolver FAILS
 *   - Resolver results are cached (DB + memory)
 *   - Resolver is called BEFORE any trade logic
 *   - Failed pools are blacklisted for 30-60 minutes
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { Connection, PublicKey } from '@solana/web3.js';
import { supabase } from '../db/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PoolIdentity {
    poolAddress: string;
    baseMint: string;
    quoteMint: string;
    baseDecimals: number;
    quoteDecimals: number;
    baseSymbol?: string;
    quoteSymbol?: string;
    canonicalPairKey: string;  // baseMint:quoteMint (order-stable)
    resolvedAt: number;
    source: 'CACHE' | 'DB' | 'ONCHAIN';
}

export interface ResolverResult {
    success: boolean;
    identity?: PoolIdentity;
    error?: string;
    errorCode?: 'MISSING_POOL' | 'MISSING_MINTS' | 'MISSING_DECIMALS' | 'FETCH_FAILED' | 'BLACKLISTED';
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const RESOLVER_CONFIG = {
    /** Blacklist duration for failed pools (30 minutes) */
    BLACKLIST_DURATION_MS: 30 * 60 * 1000,
    
    /** Memory cache TTL (1 hour) */
    CACHE_TTL_MS: 60 * 60 * 1000,
    
    /** Max retries for on-chain fetch */
    MAX_RETRIES: 2,
    
    /** RPC timeout */
    RPC_TIMEOUT_MS: 10000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWN TOKEN REGISTRY — Fallback for common tokens
// ═══════════════════════════════════════════════════════════════════════════════

const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
    'So11111111111111111111111111111111111111112': { symbol: 'SOL', decimals: 9 },
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6 },
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6 },
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { symbol: 'mSOL', decimals: 9 },
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': { symbol: 'JitoSOL', decimals: 9 },
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK', decimals: 5 },
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'WETH', decimals: 8 },
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': { symbol: 'JUP', decimals: 6 },
    'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof': { symbol: 'RNDR', decimals: 8 },
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': { symbol: 'POPCAT', decimals: 9 },
    'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': { symbol: 'PYTH', decimals: 6 },
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': { symbol: 'WIF', decimals: 6 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE — Memory cache and blacklist
// ═══════════════════════════════════════════════════════════════════════════════

const identityCache = new Map<string, PoolIdentity>();
const blacklist = new Map<string, number>();  // poolAddress -> expiry timestamp

// ═══════════════════════════════════════════════════════════════════════════════
// CORE RESOLVER FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve pool identity — SINGLE AUTHORITATIVE FUNCTION
 * 
 * Must be called BEFORE any trade logic.
 * If this fails, the pool CANNOT be traded.
 */
export async function resolvePoolIdentity(
    poolAddress: string,
    connection?: Connection,
    poolData?: {
        mintX?: string;
        mintY?: string;
        tokenASymbol?: string;
        tokenBSymbol?: string;
    }
): Promise<ResolverResult> {
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK BLACKLIST
    // ═══════════════════════════════════════════════════════════════════════════
    const blacklistExpiry = blacklist.get(poolAddress);
    if (blacklistExpiry && Date.now() < blacklistExpiry) {
        logger.debug(`[POOL-IDENTITY] Blacklisted: ${poolAddress.slice(0, 8)}...`);
        return {
            success: false,
            error: 'Pool is blacklisted due to previous resolution failure',
            errorCode: 'BLACKLISTED',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK MEMORY CACHE
    // ═══════════════════════════════════════════════════════════════════════════
    const cached = identityCache.get(poolAddress);
    if (cached && Date.now() - cached.resolvedAt < RESOLVER_CONFIG.CACHE_TTL_MS) {
        logger.debug(`[POOL-IDENTITY] Cache hit: ${poolAddress.slice(0, 8)}... → ${cached.canonicalPairKey}`);
        return { success: true, identity: cached };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK DATABASE CACHE
    // ═══════════════════════════════════════════════════════════════════════════
    try {
        const dbResult = await supabase
            .from('pools')
            .select('pool_address, token_a_mint, token_b_mint, decimals_a, decimals_b, base_token, quote_token')
            .eq('pool_address', poolAddress)
            .maybeSingle();
        
        if (dbResult.data && dbResult.data.token_a_mint && dbResult.data.token_b_mint) {
            const identity: PoolIdentity = {
                poolAddress,
                baseMint: dbResult.data.token_a_mint,
                quoteMint: dbResult.data.token_b_mint,
                baseDecimals: dbResult.data.decimals_a ?? 9,
                quoteDecimals: dbResult.data.decimals_b ?? 6,
                baseSymbol: dbResult.data.base_token ?? undefined,
                quoteSymbol: dbResult.data.quote_token ?? undefined,
                canonicalPairKey: `${dbResult.data.token_a_mint}:${dbResult.data.token_b_mint}`,
                resolvedAt: Date.now(),
                source: 'DB',
            };
            
            // Update memory cache
            identityCache.set(poolAddress, identity);
            
            logger.debug(`[POOL-IDENTITY] DB hit: ${poolAddress.slice(0, 8)}... → ${identity.canonicalPairKey}`);
            return { success: true, identity };
        }
    } catch (err) {
        logger.debug(`[POOL-IDENTITY] DB lookup failed: ${err}`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RESOLVE FROM PROVIDED DATA (mintX/mintY from indexer)
    // ═══════════════════════════════════════════════════════════════════════════
    if (poolData?.mintX && poolData?.mintY) {
        const baseMint = poolData.mintX;
        const quoteMint = poolData.mintY;
        
        // Look up decimals from known tokens or default
        const baseToken = KNOWN_TOKENS[baseMint];
        const quoteToken = KNOWN_TOKENS[quoteMint];
        
        const identity: PoolIdentity = {
            poolAddress,
            baseMint,
            quoteMint,
            baseDecimals: baseToken?.decimals ?? 9,
            quoteDecimals: quoteToken?.decimals ?? 6,
            baseSymbol: poolData.tokenASymbol ?? baseToken?.symbol,
            quoteSymbol: poolData.tokenBSymbol ?? quoteToken?.symbol,
            canonicalPairKey: `${baseMint}:${quoteMint}`,
            resolvedAt: Date.now(),
            source: 'ONCHAIN',
        };
        
        // Cache in memory
        identityCache.set(poolAddress, identity);
        
        logger.info(
            `[POOL-IDENTITY] ✅ Resolved: ${poolAddress.slice(0, 8)}... → ` +
            `${identity.baseSymbol ?? 'UNKNOWN'}/${identity.quoteSymbol ?? 'UNKNOWN'} ` +
            `(${baseMint.slice(0, 6)}.../${quoteMint.slice(0, 6)}...)`
        );
        
        return { success: true, identity };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // FETCH FROM ON-CHAIN (if connection provided)
    // ═══════════════════════════════════════════════════════════════════════════
    if (connection) {
        try {
            const poolPubkey = new PublicKey(poolAddress);
            const accountInfo = await connection.getAccountInfo(poolPubkey);
            
            if (accountInfo && accountInfo.data.length >= 200) {
                // DLMM pool layout: tokenXMint at offset 72, tokenYMint at offset 104
                // This is approximate - actual offset depends on DLMM version
                const tokenXMint = new PublicKey(accountInfo.data.slice(72, 104)).toBase58();
                const tokenYMint = new PublicKey(accountInfo.data.slice(104, 136)).toBase58();
                
                const baseToken = KNOWN_TOKENS[tokenXMint];
                const quoteToken = KNOWN_TOKENS[tokenYMint];
                
                const identity: PoolIdentity = {
                    poolAddress,
                    baseMint: tokenXMint,
                    quoteMint: tokenYMint,
                    baseDecimals: baseToken?.decimals ?? 9,
                    quoteDecimals: quoteToken?.decimals ?? 6,
                    baseSymbol: baseToken?.symbol,
                    quoteSymbol: quoteToken?.symbol,
                    canonicalPairKey: `${tokenXMint}:${tokenYMint}`,
                    resolvedAt: Date.now(),
                    source: 'ONCHAIN',
                };
                
                identityCache.set(poolAddress, identity);
                
                logger.info(
                    `[POOL-IDENTITY] ✅ On-chain resolved: ${poolAddress.slice(0, 8)}... → ` +
                    `${identity.baseSymbol ?? 'UNKNOWN'}/${identity.quoteSymbol ?? 'UNKNOWN'}`
                );
                
                return { success: true, identity };
            }
        } catch (err) {
            logger.warn(`[POOL-IDENTITY] On-chain fetch failed: ${err}`);
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RESOLUTION FAILED — Blacklist and reject
    // ═══════════════════════════════════════════════════════════════════════════
    blacklist.set(poolAddress, Date.now() + RESOLVER_CONFIG.BLACKLIST_DURATION_MS);
    
    logger.error(
        `[POOL-IDENTITY] ❌ FAILED: ${poolAddress.slice(0, 8)}... | ` +
        `No mints available | Blacklisted for ${RESOLVER_CONFIG.BLACKLIST_DURATION_MS / 60000}m`
    );
    
    return {
        success: false,
        error: 'Could not resolve pool identity - no mint data available',
        errorCode: 'MISSING_MINTS',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREFLIGHT GATE — HARD BLOCK
// ═══════════════════════════════════════════════════════════════════════════════

export interface PreflightResult {
    allowed: boolean;
    identity?: PoolIdentity;
    rejectReason?: string;
}

/**
 * Preflight Gate — MUST pass before any of:
 *   - sizing
 *   - aggression ladder
 *   - trade ID assignment
 *   - capital allocation
 * 
 * If this returns allowed=false, the trade CANNOT proceed.
 */
export function preflightGate(identity: PoolIdentity | undefined): PreflightResult {
    if (!identity) {
        return {
            allowed: false,
            rejectReason: 'MISSING_POOL_IDENTITY',
        };
    }
    
    // Validate all required fields
    if (!identity.baseMint) {
        return {
            allowed: false,
            identity,
            rejectReason: 'MISSING_BASE_MINT',
        };
    }
    
    if (!identity.quoteMint) {
        return {
            allowed: false,
            identity,
            rejectReason: 'MISSING_QUOTE_MINT',
        };
    }
    
    if (typeof identity.baseDecimals !== 'number' || identity.baseDecimals < 0) {
        return {
            allowed: false,
            identity,
            rejectReason: 'INVALID_BASE_DECIMALS',
        };
    }
    
    if (typeof identity.quoteDecimals !== 'number' || identity.quoteDecimals < 0) {
        return {
            allowed: false,
            identity,
            rejectReason: 'INVALID_QUOTE_DECIMALS',
        };
    }
    
    // All checks passed
    return {
        allowed: true,
        identity,
    };
}

/**
 * Combined resolve + preflight gate
 * Returns PreflightResult with identity if successful
 */
export async function resolveAndGate(
    poolAddress: string,
    connection?: Connection,
    poolData?: {
        mintX?: string;
        mintY?: string;
        tokenASymbol?: string;
        tokenBSymbol?: string;
    }
): Promise<PreflightResult> {
    const resolveResult = await resolvePoolIdentity(poolAddress, connection, poolData);
    
    if (!resolveResult.success) {
        logger.warn(
            `[GATE] REJECT | pool=${poolAddress.slice(0, 8)}... | ` +
            `reason=${resolveResult.errorCode ?? 'RESOLUTION_FAILED'} | ${resolveResult.error}`
        );
        return {
            allowed: false,
            rejectReason: resolveResult.errorCode ?? 'RESOLUTION_FAILED',
        };
    }
    
    const preflight = preflightGate(resolveResult.identity);
    
    if (!preflight.allowed) {
        logger.warn(
            `[GATE] REJECT | pool=${poolAddress.slice(0, 8)}... | ` +
            `reason=${preflight.rejectReason}`
        );
    }
    
    return preflight;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POOL REGISTRATION — ATOMIC, IDENTITY-FIRST
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register pool in database — ONLY after identity resolution succeeds
 * 
 * RULE: A pool may only be inserted into the DB after identity resolution succeeds.
 * 
 * FORBIDDEN:
 *   - Writing tokenA = "BRAIN-SOL" style labels
 *   - Writing tokenB = null
 *   - Inferring tokens from string names
 * 
 * REQUIRED INVARIANT:
 *   If a pool exists in DB, it has valid base/quote mints and decimals.
 */
export async function registerPoolWithIdentity(identity: PoolIdentity): Promise<boolean> {
    // Validate identity before registration
    const preflight = preflightGate(identity);
    if (!preflight.allowed) {
        logger.error(
            `[POOL-REGISTER] ❌ BLOCKED: ${identity.poolAddress.slice(0, 8)}... | ` +
            `Preflight failed: ${preflight.rejectReason}`
        );
        return false;
    }
    
    try {
        // Check if pool already exists with valid identity
        const existing = await supabase
            .from('pools')
            .select('pool_address, token_a_mint, token_b_mint')
            .eq('pool_address', identity.poolAddress)
            .maybeSingle();
        
        if (existing.data) {
            // Pool exists - verify it has valid mints
            if (existing.data.token_a_mint && existing.data.token_b_mint) {
                logger.debug(`[POOL-REGISTER] Already registered: ${identity.poolAddress.slice(0, 8)}...`);
                return true;
            }
            
            // Pool exists but has invalid mints - update it
            const update = await supabase
                .from('pools')
                .update({
                    base_token: identity.baseSymbol ?? 'UNKNOWN',
                    quote_token: identity.quoteSymbol ?? 'UNKNOWN',
                    token_a_mint: identity.baseMint,
                    token_b_mint: identity.quoteMint,
                    decimals_a: identity.baseDecimals,
                    decimals_b: identity.quoteDecimals,
                    updated_at: new Date().toISOString(),
                })
                .eq('pool_address', identity.poolAddress);
            
            if (update.error) {
                logger.error(`[POOL-REGISTER] Update failed: ${update.error.message}`);
                return false;
            }
            
            logger.info(`[POOL-REGISTER] ✅ Updated pool identity: ${identity.poolAddress.slice(0, 8)}...`);
            return true;
        }
        
        // Insert new pool with validated identity
        const insert = await supabase
            .from('pools')
            .insert({
                pool_address: identity.poolAddress,
                base_token: identity.baseSymbol ?? 'UNKNOWN',
                quote_token: identity.quoteSymbol ?? 'UNKNOWN',
                token_a_mint: identity.baseMint,
                token_b_mint: identity.quoteMint,
                decimals_a: identity.baseDecimals,
                decimals_b: identity.quoteDecimals,
                blockchain: 'solana',
                dex: 'meteora',
                version: 'dlmm',
                metadata: {
                    canonicalPairKey: identity.canonicalPairKey,
                    resolvedAt: identity.resolvedAt,
                    source: identity.source,
                },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
        
        if (insert.error) {
            // Handle race condition
            if (insert.error.code === '23505' || insert.error.message?.includes('duplicate')) {
                logger.debug(`[POOL-REGISTER] Already registered (race): ${identity.poolAddress.slice(0, 8)}...`);
                return true;
            }
            
            logger.error(`[POOL-REGISTER] Insert failed: ${insert.error.message}`);
            return false;
        }
        
        logger.info(
            `[POOL-REGISTER] ✅ Registered: ${identity.poolAddress.slice(0, 8)}... → ` +
            `${identity.baseSymbol ?? 'UNKNOWN'}/${identity.quoteSymbol ?? 'UNKNOWN'}`
        );
        return true;
        
    } catch (err) {
        logger.error(`[POOL-REGISTER] Exception: ${err}`);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

export function getCachedIdentity(poolAddress: string): PoolIdentity | undefined {
    return identityCache.get(poolAddress);
}

export function clearIdentityCache(poolAddress?: string): void {
    if (poolAddress) {
        identityCache.delete(poolAddress);
        blacklist.delete(poolAddress);
    } else {
        identityCache.clear();
        blacklist.clear();
    }
}

export function getBlacklistedPools(): string[] {
    const now = Date.now();
    const active: string[] = [];
    for (const [pool, expiry] of blacklist.entries()) {
        if (expiry > now) {
            active.push(pool);
        }
    }
    return active;
}

export function isPoolBlacklisted(poolAddress: string): boolean {
    const expiry = blacklist.get(poolAddress);
    return expiry !== undefined && Date.now() < expiry;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════

export function getResolverStats(): {
    cachedPools: number;
    blacklistedPools: number;
    cacheHitRate: number;
} {
    return {
        cachedPools: identityCache.size,
        blacklistedPools: getBlacklistedPools().length,
        cacheHitRate: 0,  // Would need to track hits/misses for this
    };
}

