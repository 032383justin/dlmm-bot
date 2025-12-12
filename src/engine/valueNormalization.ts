/**
 * Value Normalization Engine - USD-Based Accounting Pipeline
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * MISSION: Normalize all PnL and asset accounting to USD values.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * CORE PRINCIPLES:
 * 1. Every trade entry and exit stored as USD values ONLY
 * 2. Token raw amounts NEVER compared directly
 * 3. All sizing, leverage, PnL, fees, slippage use normalized USD
 * 4. Decimals fetched from on-chain SPL metadata, NEVER hardcoded defaults
 * 5. Calculations are idempotent, deterministic, and reversible from DB
 * 
 * FORBIDDEN OPERATIONS:
 * - amountA * amountB * price (token × token multiplication)
 * - tokenA_raw / tokenB_raw = price (ratio of raw amounts)
 * - Hardcoding 6 or 9 decimals for any token
 * 
 * REQUIRED PATTERN:
 * normalized = raw / (10 ** decimals)
 * valueUSD = normalized * oraclePrice
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Price source for audit trail
 */
export type PriceSource = 'birdeye' | 'jupiter' | 'pool_mid' | 'oracle' | 'cached';

/**
 * Token metadata with on-chain verified decimals
 */
export interface TokenMetadata {
    mint: string;
    decimals: number;
    symbol?: string;
    fetchedAt: number;
    source: 'on_chain' | 'cached';
}

/**
 * Normalized value result with full audit trail
 */
export interface NormalizedValue {
    rawAmount: bigint | number;
    decimals: number;
    normalizedAmount: number;
    priceUSD: number;
    valueUSD: number;
    priceSource: PriceSource;
    timestamp: number;
}

/**
 * Entry execution result in USD
 */
export interface EntryExecutionUSD {
    entryValueUSD: number;
    entryFeesUSD: number;
    entrySlippageUSD: number;
    netEntryValueUSD: number;
    
    // Normalized token amounts (for audit only, NOT for trading logic)
    normalizedAmountBase: number;
    normalizedAmountQuote: number;
    
    // Raw amounts (for audit only)
    rawAmountBase: bigint;
    rawAmountQuote: bigint;
    
    // Metadata
    baseDecimals: number;
    quoteDecimals: number;
    priceSource: PriceSource;
    timestamp: number;
}

/**
 * Exit execution result in USD
 */
export interface ExitExecutionUSD {
    exitValueUSD: number;
    exitFeesUSD: number;
    exitSlippageUSD: number;
    netExitValueUSD: number;
    
    // PnL calculation
    grossPnLUSD: number;
    netPnLUSD: number;
    
    // Normalized token amounts (for audit only)
    normalizedAmountBase: number;
    normalizedAmountQuote: number;
    
    // Metadata
    priceSource: PriceSource;
    timestamp: number;
}

/**
 * Normalization failure - halts trade execution
 */
export class NormalizationFailure extends Error {
    constructor(
        public readonly reason: string,
        public readonly context: Record<string, any>
    ) {
        super(`[NORMALIZATION_FAILURE] ${reason}`);
        this.name = 'NormalizationFailure';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Value normalization configuration
 */
export const VALUE_NORMALIZATION_CONFIG = {
    // Precision for internal USD calculations (1e-6 = 6 decimal places)
    usdPrecision: 6,
    
    // Maximum allowed price staleness (ms)
    maxPriceStalenessMs: 60_000, // 1 minute
    
    // Cache duration for token metadata
    metadataCacheDurationMs: 24 * 60 * 60 * 1000, // 24 hours
    
    // Default fee estimate if not provided (0.3%)
    defaultFeePct: 0.003,
    
    // Default slippage estimate if not provided (10 bps = 0.1%)
    defaultSlippageBps: 10,
    
    // Minimum valid entry value
    minEntryValueUSD: 1.0,
    
    // Maximum realistic PnL percentage for sanity check
    maxRealisticPnLPct: 50.0, // 5000% - flag anything higher
    
    // Minimum realistic PnL percentage (for loss detection)
    minRealisticPnLPct: -99.0, // -99% - flag total loss
};

// ═══════════════════════════════════════════════════════════════════════════════
// ON-CHAIN DECIMAL FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cache for token metadata to avoid repeated RPC calls
 */
const tokenMetadataCache: Map<string, TokenMetadata> = new Map();

/**
 * RPC connection singleton
 */
let connectionInstance: Connection | null = null;

/**
 * Get or create RPC connection - uses centralized config (no fallback)
 */
import { getConnection as getCentralizedConnection } from '../config/rpc';

function getConnection(): Connection {
    if (!connectionInstance) {
        connectionInstance = getCentralizedConnection();
    }
    return connectionInstance;
}

/**
 * Fetch token decimals from on-chain SPL metadata.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: This function MUST return on-chain verified decimals.
 * NEVER fall back to hardcoded defaults for unknown tokens.
 * If fetch fails → throw NormalizationFailure to halt trade.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * @param mintAddress - Token mint address
 * @returns Token metadata with verified decimals
 * @throws NormalizationFailure if decimals cannot be fetched
 */
export async function fetchTokenDecimals(mintAddress: string): Promise<TokenMetadata> {
    // Check cache first
    const cached = tokenMetadataCache.get(mintAddress);
    if (cached && Date.now() - cached.fetchedAt < VALUE_NORMALIZATION_CONFIG.metadataCacheDurationMs) {
        return { ...cached, source: 'cached' };
    }
    
    try {
        const connection = getConnection();
        const mintPubkey = new PublicKey(mintAddress);
        
        // Fetch mint info from on-chain
        const mintInfo = await getMint(connection, mintPubkey);
        
        const metadata: TokenMetadata = {
            mint: mintAddress,
            decimals: mintInfo.decimals,
            fetchedAt: Date.now(),
            source: 'on_chain',
        };
        
        // Cache the result
        tokenMetadataCache.set(mintAddress, metadata);
        
        logger.debug(`[NORMALIZATION] Fetched decimals for ${mintAddress.slice(0, 8)}...: ${mintInfo.decimals}`);
        
        return metadata;
        
    } catch (error: any) {
        throw new NormalizationFailure(
            `Failed to fetch token decimals for ${mintAddress}`,
            { mintAddress, error: error.message }
        );
    }
}

/**
 * Batch fetch decimals for multiple tokens
 * 
 * @param mintAddresses - Array of token mint addresses
 * @returns Map of mint address to metadata
 * @throws NormalizationFailure if any fetch fails
 */
export async function batchFetchTokenDecimals(
    mintAddresses: string[]
): Promise<Map<string, TokenMetadata>> {
    const results = new Map<string, TokenMetadata>();
    const toFetch: string[] = [];
    
    // Check cache first
    for (const mint of mintAddresses) {
        const cached = tokenMetadataCache.get(mint);
        if (cached && Date.now() - cached.fetchedAt < VALUE_NORMALIZATION_CONFIG.metadataCacheDurationMs) {
            results.set(mint, { ...cached, source: 'cached' });
        } else {
            toFetch.push(mint);
        }
    }
    
    // Fetch remaining from chain
    if (toFetch.length > 0) {
        const connection = getConnection();
        
        // Batch fetch account infos
        const pubkeys = toFetch.map(m => new PublicKey(m));
        const accountInfos = await connection.getMultipleAccountsInfo(pubkeys);
        
        for (let i = 0; i < toFetch.length; i++) {
            const mint = toFetch[i];
            const accountInfo = accountInfos[i];
            
            if (!accountInfo) {
                throw new NormalizationFailure(
                    `Token account not found: ${mint}`,
                    { mintAddress: mint }
                );
            }
            
            try {
                // Parse mint account - decimals is at byte offset 44
                // Layout: mintAuthorityOption(4) + mintAuthority(32) + supply(8) + decimals(1)
                const decimals = accountInfo.data[44];
                
                const metadata: TokenMetadata = {
                    mint,
                    decimals,
                    fetchedAt: Date.now(),
                    source: 'on_chain',
                };
                
                tokenMetadataCache.set(mint, metadata);
                results.set(mint, metadata);
                
            } catch (error: any) {
                throw new NormalizationFailure(
                    `Failed to parse mint account: ${mint}`,
                    { mintAddress: mint, error: error.message }
                );
            }
        }
    }
    
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE NORMALIZATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize raw token amount using verified decimals.
 * 
 * Formula: normalized = rawAmount / (10 ** decimals)
 * 
 * @param rawAmount - Raw token amount (atomic units)
 * @param decimals - Token decimals (MUST be verified on-chain)
 * @returns Normalized float amount
 */
export function normalizeTokenAmount(rawAmount: bigint | number, decimals: number): number {
    if (decimals < 0 || decimals > 18) {
        throw new NormalizationFailure(
            `Invalid decimals: ${decimals}`,
            { rawAmount: rawAmount.toString(), decimals }
        );
    }
    
    const divisor = Math.pow(10, decimals);
    const normalized = typeof rawAmount === 'bigint' 
        ? Number(rawAmount) / divisor 
        : rawAmount / divisor;
    
    return normalized;
}

/**
 * Denormalize float amount back to raw atomic units.
 * 
 * Formula: raw = normalizedAmount * (10 ** decimals)
 * 
 * @param normalizedAmount - Normalized float amount
 * @param decimals - Token decimals
 * @returns Raw amount as bigint
 */
export function denormalizeTokenAmount(normalizedAmount: number, decimals: number): bigint {
    if (decimals < 0 || decimals > 18) {
        throw new NormalizationFailure(
            `Invalid decimals: ${decimals}`,
            { normalizedAmount, decimals }
        );
    }
    
    const multiplier = Math.pow(10, decimals);
    return BigInt(Math.floor(normalizedAmount * multiplier));
}

/**
 * Convert normalized token amount to USD value.
 * 
 * Formula: valueUSD = normalizedAmount * priceUSD
 * 
 * @param normalizedAmount - Normalized token amount (already divided by decimals)
 * @param priceUSD - Price per token in USD
 * @returns Value in USD
 */
export function tokenAmountToUSD(normalizedAmount: number, priceUSD: number): number {
    if (priceUSD < 0) {
        throw new NormalizationFailure(
            'Negative price is invalid',
            { normalizedAmount, priceUSD }
        );
    }
    
    const valueUSD = normalizedAmount * priceUSD;
    return roundUSD(valueUSD);
}

/**
 * Calculate total pool value in USD from base and quote token values.
 * 
 * @param tokenBaseValueUSD - Value of base token in USD
 * @param tokenQuoteValueUSD - Value of quote token in USD
 * @returns Total pool value in USD
 */
export function poolValueUSD(tokenBaseValueUSD: number, tokenQuoteValueUSD: number): number {
    const totalValue = tokenBaseValueUSD + tokenQuoteValueUSD;
    return roundUSD(totalValue);
}

/**
 * Apply trading fees to a USD value.
 * 
 * @param baseValueUSD - Base value before fees
 * @param feePct - Fee percentage (e.g., 0.003 for 0.3%)
 * @returns Fees in USD
 */
export function applyFeesUSD(baseValueUSD: number, feePct: number = VALUE_NORMALIZATION_CONFIG.defaultFeePct): number {
    if (feePct < 0 || feePct > 0.10) {
        throw new NormalizationFailure(
            `Fee percentage out of range: ${feePct}`,
            { baseValueUSD, feePct }
        );
    }
    
    const feesUSD = baseValueUSD * feePct;
    return roundUSD(feesUSD);
}

/**
 * Apply slippage to a USD value.
 * 
 * @param baseValueUSD - Base value before slippage
 * @param slippageBps - Slippage in basis points (e.g., 10 = 0.10%)
 * @returns Slippage cost in USD
 */
export function applySlippageUSD(
    baseValueUSD: number, 
    slippageBps: number = VALUE_NORMALIZATION_CONFIG.defaultSlippageBps
): number {
    if (slippageBps < 0 || slippageBps > 1000) {
        throw new NormalizationFailure(
            `Slippage bps out of range: ${slippageBps}`,
            { baseValueUSD, slippageBps }
        );
    }
    
    const slippagePct = slippageBps / 10000;
    const slippageUSD = baseValueUSD * slippagePct;
    return roundUSD(slippageUSD);
}

/**
 * Round USD value to configured precision.
 * 
 * @param value - Raw USD value
 * @returns Rounded USD value
 */
export function roundUSD(value: number): number {
    const multiplier = Math.pow(10, VALUE_NORMALIZATION_CONFIG.usdPrecision);
    return Math.round(value * multiplier) / multiplier;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL NORMALIZATION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize a raw token amount with full audit trail.
 * 
 * @param rawAmount - Raw token amount (atomic units)
 * @param mintAddress - Token mint address
 * @param priceUSD - Price per token in USD
 * @param priceSource - Source of price data
 * @returns Full normalized value with audit trail
 * @throws NormalizationFailure if normalization fails
 */
export async function normalizeWithAudit(
    rawAmount: bigint | number,
    mintAddress: string,
    priceUSD: number,
    priceSource: PriceSource
): Promise<NormalizedValue> {
    // Fetch verified decimals from chain
    const metadata = await fetchTokenDecimals(mintAddress);
    
    // Normalize amount
    const normalizedAmount = normalizeTokenAmount(rawAmount, metadata.decimals);
    
    // Convert to USD
    const valueUSD = tokenAmountToUSD(normalizedAmount, priceUSD);
    
    return {
        rawAmount,
        decimals: metadata.decimals,
        normalizedAmount,
        priceUSD,
        valueUSD,
        priceSource,
        timestamp: Date.now(),
    };
}

/**
 * Compute entry execution in USD.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENTRY FLOW:
 * rawTokensIn → normalizedAmount → USD Value
 * entryValueUSD = tokenAmountToUSD(normalizedAmount, entryPrice)
 * netEntryValueUSD = entryValueUSD - entryFeesUSD - entrySlippageUSD
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * @param sizeUSD - Desired position size in USD
 * @param baseMint - Base token mint address
 * @param quoteMint - Quote token mint address
 * @param basePrice - Base token price in USD
 * @param quotePrice - Quote token price in USD (typically 1.0 for stablecoins)
 * @param priceSource - Source of price data
 * @param feePct - Fee percentage (optional)
 * @param slippageBps - Slippage in bps (optional)
 * @returns Entry execution result in USD
 * @throws NormalizationFailure if validation fails
 */
export async function computeEntryExecutionUSD(
    sizeUSD: number,
    baseMint: string,
    quoteMint: string,
    basePrice: number,
    quotePrice: number = 1.0,
    priceSource: PriceSource = 'birdeye',
    feePct?: number,
    slippageBps?: number
): Promise<EntryExecutionUSD> {
    const timestamp = Date.now();
    
    // Validate entry value
    if (sizeUSD <= VALUE_NORMALIZATION_CONFIG.minEntryValueUSD) {
        throw new NormalizationFailure(
            `Entry value too small: $${sizeUSD}`,
            { sizeUSD, minRequired: VALUE_NORMALIZATION_CONFIG.minEntryValueUSD }
        );
    }
    
    // Validate price
    if (basePrice <= 0) {
        throw new NormalizationFailure(
            'Invalid base price',
            { basePrice, baseMint }
        );
    }
    
    // Fetch decimals from chain
    const metadataMap = await batchFetchTokenDecimals([baseMint, quoteMint]);
    const baseMetadata = metadataMap.get(baseMint)!;
    const quoteMetadata = metadataMap.get(quoteMint)!;
    
    // Calculate fees and slippage
    const entryFeesUSD = applyFeesUSD(sizeUSD, feePct);
    const entrySlippageUSD = applySlippageUSD(sizeUSD, slippageBps);
    
    // Net value after costs
    const netEntryValueUSD = roundUSD(sizeUSD - entryFeesUSD - entrySlippageUSD);
    
    // Calculate normalized token amounts (for audit trail only)
    // Assuming 50/50 split between base and quote for DLMM positions
    const baseValueUSD = netEntryValueUSD / 2;
    const quoteValueUSD = netEntryValueUSD / 2;
    
    const normalizedAmountBase = baseValueUSD / basePrice;
    const normalizedAmountQuote = quoteValueUSD / quotePrice;
    
    // Calculate raw amounts (for audit trail only)
    const rawAmountBase = denormalizeTokenAmount(normalizedAmountBase, baseMetadata.decimals);
    const rawAmountQuote = denormalizeTokenAmount(normalizedAmountQuote, quoteMetadata.decimals);
    
    return {
        entryValueUSD: roundUSD(sizeUSD),
        entryFeesUSD,
        entrySlippageUSD,
        netEntryValueUSD,
        normalizedAmountBase,
        normalizedAmountQuote,
        rawAmountBase,
        rawAmountQuote,
        baseDecimals: baseMetadata.decimals,
        quoteDecimals: quoteMetadata.decimals,
        priceSource,
        timestamp,
    };
}

/**
 * Compute exit execution in USD.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXIT FLOW:
 * exitValueUSD = normalizedExitAmount * exitPrice
 * grossPnL = exitValueUSD - entryValueUSD
 * netPnL = grossPnL - exitFees - exitSlippage
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * @param entryValueUSD - Original entry value in USD
 * @param currentPositionValueUSD - Current position value in USD
 * @param normalizedAmountBase - Normalized base token amount
 * @param normalizedAmountQuote - Normalized quote token amount
 * @param priceSource - Source of price data
 * @param feePct - Fee percentage (optional)
 * @param slippageBps - Slippage in bps (optional)
 * @returns Exit execution result in USD
 */
export function computeExitExecutionUSD(
    entryValueUSD: number,
    currentPositionValueUSD: number,
    normalizedAmountBase: number,
    normalizedAmountQuote: number,
    priceSource: PriceSource = 'birdeye',
    feePct?: number,
    slippageBps?: number
): ExitExecutionUSD {
    const timestamp = Date.now();
    
    // Calculate fees and slippage on exit
    const exitFeesUSD = applyFeesUSD(currentPositionValueUSD, feePct);
    const exitSlippageUSD = applySlippageUSD(currentPositionValueUSD, slippageBps);
    
    // Net exit value
    const netExitValueUSD = roundUSD(currentPositionValueUSD - exitFeesUSD - exitSlippageUSD);
    
    // PnL calculations
    const grossPnLUSD = roundUSD(currentPositionValueUSD - entryValueUSD);
    const netPnLUSD = roundUSD(netExitValueUSD - entryValueUSD);
    
    // Sanity check for unrealistic PnL
    const pnlPct = (netPnLUSD / entryValueUSD) * 100;
    if (pnlPct > VALUE_NORMALIZATION_CONFIG.maxRealisticPnLPct) {
        logger.warn(
            `[NORMALIZATION] Unusually high PnL detected: ${pnlPct.toFixed(2)}% | ` +
            `Entry=$${entryValueUSD.toFixed(2)} | Exit=$${netExitValueUSD.toFixed(2)}`
        );
    }
    
    return {
        exitValueUSD: roundUSD(currentPositionValueUSD),
        exitFeesUSD,
        exitSlippageUSD,
        netExitValueUSD,
        grossPnLUSD,
        netPnLUSD,
        normalizedAmountBase,
        normalizedAmountQuote,
        priceSource,
        timestamp,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Price data with staleness tracking
 */
export interface ValidatedPrice {
    price: number;
    source: PriceSource;
    fetchedAt: number;
    isStale: boolean;
}

/**
 * Validate price is fresh and usable.
 * 
 * @param price - Price value
 * @param fetchedAt - Timestamp when price was fetched
 * @param source - Price source
 * @returns Validated price with staleness flag
 * @throws NormalizationFailure if price is invalid
 */
export function validatePrice(
    price: number,
    fetchedAt: number,
    source: PriceSource
): ValidatedPrice {
    if (price <= 0) {
        throw new NormalizationFailure(
            'Price is zero or negative',
            { price, source }
        );
    }
    
    const age = Date.now() - fetchedAt;
    const isStale = age > VALUE_NORMALIZATION_CONFIG.maxPriceStalenessMs;
    
    if (isStale) {
        logger.warn(
            `[NORMALIZATION] Price is stale: ${(age / 1000).toFixed(1)}s old | ` +
            `Source=${source} | Price=${price}`
        );
    }
    
    return {
        price,
        source,
        fetchedAt,
        isStale,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HARD FAIL CONDITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate all conditions for trade execution.
 * Throws NormalizationFailure to halt trade if any condition fails.
 * 
 * @param entryValueUSD - Computed entry value
 * @param basePrice - Base token price
 * @param quotePrice - Quote token price
 * @param baseDecimals - Base token decimals (must be resolved)
 * @param quoteDecimals - Quote token decimals (must be resolved)
 * @param priceAge - Age of price data in ms
 */
export function validateTradeConditions(
    entryValueUSD: number,
    basePrice: number,
    quotePrice: number,
    baseDecimals: number | null,
    quoteDecimals: number | null,
    priceAge: number
): void {
    // Check entry value
    if (entryValueUSD <= 0) {
        throw new NormalizationFailure(
            'Entry value is zero or negative',
            { entryValueUSD }
        );
    }
    
    // Check price staleness
    if (priceAge > VALUE_NORMALIZATION_CONFIG.maxPriceStalenessMs) {
        throw new NormalizationFailure(
            'Price feed is stale',
            { priceAge, maxAllowed: VALUE_NORMALIZATION_CONFIG.maxPriceStalenessMs }
        );
    }
    
    // Check decimals are resolved
    if (baseDecimals === null) {
        throw new NormalizationFailure(
            'Base token decimals unresolved',
            { baseDecimals }
        );
    }
    
    if (quoteDecimals === null) {
        throw new NormalizationFailure(
            'Quote token decimals unresolved',
            { quoteDecimals }
        );
    }
    
    // Check prices
    if (basePrice <= 0) {
        throw new NormalizationFailure(
            'Base price is invalid',
            { basePrice }
        );
    }
    
    if (quotePrice <= 0) {
        throw new NormalizationFailure(
            'Quote price is invalid',
            { quotePrice }
        );
    }
    
    logger.debug('[NORMALIZATION] Trade conditions validated successfully');
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate position value from normalized amounts and prices.
 * 
 * @param normalizedBase - Normalized base token amount
 * @param normalizedQuote - Normalized quote token amount
 * @param basePrice - Base token price in USD
 * @param quotePrice - Quote token price in USD
 * @returns Total position value in USD
 */
export function calculatePositionValueUSD(
    normalizedBase: number,
    normalizedQuote: number,
    basePrice: number,
    quotePrice: number
): number {
    const baseValueUSD = tokenAmountToUSD(normalizedBase, basePrice);
    const quoteValueUSD = tokenAmountToUSD(normalizedQuote, quotePrice);
    return poolValueUSD(baseValueUSD, quoteValueUSD);
}

/**
 * Calculate impermanent loss for a position.
 * 
 * @param entryValueUSD - Entry value in USD
 * @param currentValueUSD - Current value in USD
 * @param hodlValueUSD - Value if tokens were held without providing liquidity
 * @returns Impermanent loss as a percentage (negative = loss)
 */
export function calculateImpermanentLoss(
    entryValueUSD: number,
    currentValueUSD: number,
    hodlValueUSD: number
): number {
    if (hodlValueUSD <= 0) return 0;
    
    const il = ((currentValueUSD - hodlValueUSD) / hodlValueUSD) * 100;
    return roundUSD(il);
}

/**
 * Clear token metadata cache (useful for testing or manual refresh)
 */
export function clearMetadataCache(): void {
    tokenMetadataCache.clear();
    logger.info('[NORMALIZATION] Token metadata cache cleared');
}

/**
 * Get cached token metadata (for debugging)
 */
export function getCachedMetadata(mintAddress: string): TokenMetadata | undefined {
    return tokenMetadataCache.get(mintAddress);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log entry execution details in standardized format.
 */
export function logEntryExecution(
    poolName: string,
    execution: EntryExecutionUSD
): void {
    logger.info(
        `[ENTRY] ${poolName} | ` +
        `Size=$${execution.entryValueUSD.toFixed(2)} | ` +
        `Fees=$${execution.entryFeesUSD.toFixed(2)} | ` +
        `Slippage=$${execution.entrySlippageUSD.toFixed(2)} | ` +
        `Net=$${execution.netEntryValueUSD.toFixed(2)} | ` +
        `Source=${execution.priceSource}`
    );
}

/**
 * Log exit execution details in standardized format.
 */
export function logExitExecution(
    poolName: string,
    execution: ExitExecutionUSD,
    entryValueUSD: number
): void {
    const pnlSign = execution.netPnLUSD >= 0 ? '+' : '';
    const pnlPct = ((execution.netPnLUSD / entryValueUSD) * 100).toFixed(2);
    
    logger.info(
        `[EXIT] ${poolName} | ` +
        `Entry=$${entryValueUSD.toFixed(2)} | ` +
        `Exit=$${execution.exitValueUSD.toFixed(2)} | ` +
        `Fees=$${execution.exitFeesUSD.toFixed(2)} | ` +
        `Gross=${execution.grossPnLUSD >= 0 ? '+' : ''}$${execution.grossPnLUSD.toFixed(2)} | ` +
        `Net=${pnlSign}$${execution.netPnLUSD.toFixed(2)} (${pnlSign}${pnlPct}%) | ` +
        `Source=${execution.priceSource}`
    );
}

