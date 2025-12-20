/**
 * Mark-to-Market (MTM) Valuation — Canonical Single Source of Truth
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER-0 CORRECTNESS FIX: Compute real position value including fees
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Eliminate gross PnL = $0.00 bugs by computing TRUE position value.
 * 
 * MTM VALUE MUST INCLUDE:
 *   1. Current underlying token amounts in DLMM bins
 *   2. Current mark price for those tokens
 *   3. Accrued fees (if DLMM SDK provides, use it; else estimate)
 * 
 * INVARIANTS:
 *   - exitAssetValueUsd MUST equal mtmValueUsd at exit-time
 *   - unrealizedPnlUsd = mtmValueUsd - entryNotionalUsd
 *   - grossPnl must NOT be $0.00 if position held > 60s with price movement
 * 
 * DEV_MODE DETECTION:
 *   - If holdTime > 60s and mtmValueUsd == entryValue (±$0.01) on >10 consecutive
 *     exits, log [MTM-ERROR] likely not updating
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

export const MTM_CONFIG = {
    /**
     * Tolerance for detecting unchanged MTM (USD)
     */
    unchangedToleranceUsd: 0.01,
    
    /**
     * Minimum hold time for MTM-ERROR detection (ms)
     */
    minHoldTimeForErrorMs: 60 * 1000, // 60 seconds
    
    /**
     * Consecutive unchanged exits to trigger MTM-ERROR
     */
    maxConsecutiveUnchangedExits: 10,
    
    /**
     * Default fee accrual rate estimate (% of position per hour)
     * Used when SDK doesn't provide fee data
     */
    defaultFeeAccrualRatePctPerHour: 0.15, // 0.15% per hour
    
    /**
     * Log prefix
     */
    logPrefix: '[MTM]',
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool state required for MTM calculation
 */
export interface PoolStateForMTM {
    address: string;
    name: string;
    activeBin: number;
    currentPrice: number;
    liquidityUSD: number;
    feeIntensity: number; // Normalized 0-1 or as provided by SDK
    swapVelocity: number;
    binCount?: number;
}

/**
 * Position state required for MTM calculation
 */
export interface PositionForMTM {
    id: string;
    pool: string;
    entryPrice: number;
    entryNotionalUsd: number; // Original entry size in USD
    entryBin: number;
    entryTime: number;
    entryFeeIntensity?: number;
    // Token amounts if available from SDK
    baseTokenAmount?: number;
    quoteTokenAmount?: number;
    // Fee tracking if available from SDK
    claimedFeesUsd?: number;
    unclaimedFeesUsd?: number;
}

/**
 * Price feed for token valuation
 */
export interface PriceFeed {
    baseTokenPriceUsd: number;
    quoteTokenPriceUsd: number; // Usually 1.0 for stablecoins
    source: 'birdeye' | 'dexscreener' | 'pool' | 'estimated';
    fetchedAt: number;
}

/**
 * Complete MTM valuation result
 */
export interface MTMValuation {
    // Core values
    mtmValueUsd: number;
    feesAccruedUsd: number;
    unrealizedPnlUsd: number;
    
    // Breakdown
    tokenValueUsd: number;
    priceChangeUsd: number;
    
    // Entry reference
    entryNotionalUsd: number;
    
    // Computed ratios
    pnlPercent: number;
    feesAsPercentOfEntry: number;
    
    // Validation
    isValid: boolean;
    validationErrors: string[];
    
    // Metadata
    computedAt: number;
    holdTimeMs: number;
    priceSource: string;
}

/**
 * Position update for persistence
 */
export interface MTMPositionUpdate {
    tradeId: string;
    mtmValueUsd: number;
    feesAccruedUsd: number;
    unrealizedPnlUsd: number;
    updatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE — MTM-ERROR DETECTION & STALENESS TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

let consecutiveUnchangedExitCount = 0;
const recentExitMTMs: Array<{ tradeId: string; mtmValueUsd: number; entryNotionalUsd: number; holdTimeMs: number }> = [];

/**
 * Per-position MTM cache for staleness detection
 * Tracks: last bin, last snapshot timestamp, consecutive unchanged count
 */
interface PositionMtmCache {
    lastBin: number;
    lastSnapshotTs: number;
    lastMtmValue: number;
    consecutiveUnchanged: number;
    lastExitWatcherCycle: number;
}

const positionMtmCache: Map<string, PositionMtmCache> = new Map();

// Threshold for forcing refresh
const FORCE_REFRESH_CONSECUTIVE_THRESHOLD = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// BIN-AWARE PRICING — ACCURATE MTM PRICE SOURCE
// ═══════════════════════════════════════════════════════════════════════════════

// Tick spacing estimate for bin-to-price conversion
const TICK_SPACING_ESTIMATE = 0.0001;

/**
 * Compute price from active bin (bin-aware pricing)
 * This is the canonical price source for MTM - NOT cached pool spot
 * 
 * @param activeBin - Current active bin from pool state
 * @param entryBin - Entry bin for the position
 * @param entryPrice - Entry price for fallback
 * @returns Current price based on bin position
 */
function computeBinAwarePrice(activeBin: number, entryBin: number, entryPrice: number): number {
    // Bin delta determines price change relative to entry
    const binDelta = activeBin - entryBin;
    
    // Price change is proportional to bin movement
    // Each bin step represents TICK_SPACING_ESTIMATE price change
    const priceChange = binDelta * TICK_SPACING_ESTIMATE;
    
    // Compute current price from entry price + bin-based delta
    const binAwarePrice = entryPrice * (1 + priceChange);
    
    return Math.max(0, binAwarePrice);
}

/**
 * Check if MTM cache should be invalidated for a position
 * Invalidate when: bin changes, snapshot advances, or too many unchanged values
 */
function shouldInvalidateMtmCache(
    positionId: string,
    currentBin: number,
    snapshotTs: number,
    exitWatcherCycle: number
): boolean {
    const cached = positionMtmCache.get(positionId);
    if (!cached) return true; // No cache = needs fresh computation
    
    // Invalidate if bin position changed
    if (cached.lastBin !== currentBin) {
        return true;
    }
    
    // Invalidate if snapshot timestamp advanced
    if (snapshotTs > cached.lastSnapshotTs) {
        return true;
    }
    
    // Invalidate if exit watcher cycle advanced and consecutive unchanged exceeded
    if (exitWatcherCycle > cached.lastExitWatcherCycle && 
        cached.consecutiveUnchanged >= FORCE_REFRESH_CONSECUTIVE_THRESHOLD) {
        return true;
    }
    
    return false;
}

/**
 * Update MTM cache for a position after computation
 */
function updateMtmCache(
    positionId: string,
    bin: number,
    snapshotTs: number,
    mtmValue: number,
    entryNotionalUsd: number,
    exitWatcherCycle: number
): void {
    const cached = positionMtmCache.get(positionId);
    const isUnchanged = Math.abs(mtmValue - entryNotionalUsd) < MTM_CONFIG.unchangedToleranceUsd;
    
    if (cached) {
        // Track consecutive unchanged values
        const consecutiveUnchanged = isUnchanged ? cached.consecutiveUnchanged + 1 : 0;
        
        positionMtmCache.set(positionId, {
            lastBin: bin,
            lastSnapshotTs: snapshotTs,
            lastMtmValue: mtmValue,
            consecutiveUnchanged,
            lastExitWatcherCycle: exitWatcherCycle,
        });
    } else {
        positionMtmCache.set(positionId, {
            lastBin: bin,
            lastSnapshotTs: snapshotTs,
            lastMtmValue: mtmValue,
            consecutiveUnchanged: isUnchanged ? 1 : 0,
            lastExitWatcherCycle: exitWatcherCycle,
        });
    }
}

/**
 * Get consecutive unchanged count for a position
 */
export function getPositionUnchangedCount(positionId: string): number {
    return positionMtmCache.get(positionId)?.consecutiveUnchanged ?? 0;
}

/**
 * Clear MTM cache for a position (call on exit)
 */
export function clearPositionMtmCache(positionId: string): void {
    positionMtmCache.delete(positionId);
}

// Global exit watcher cycle counter
let exitWatcherCycleCounter = 0;

/**
 * Increment exit watcher cycle (call from exit watcher loop)
 */
export function incrementExitWatcherCycle(): void {
    exitWatcherCycleCounter++;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE MTM COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute Mark-to-Market valuation for a position
 * 
 * THIS IS THE CANONICAL MTM FUNCTION — ALL EXIT VALUES MUST USE THIS
 * 
 * CRITICAL: Uses bin-aware pricing (active bin vs entry bin), NOT cached pool spot.
 * This ensures MTM reflects actual position movement, not stale price data.
 * 
 * @param position - Position to value
 * @param poolState - Current pool state
 * @param priceFeed - Current token prices
 * @returns MTMValuation with all computed values
 */
export function computePositionMtmUsd(
    position: PositionForMTM,
    poolState: PoolStateForMTM,
    priceFeed: PriceFeed
): MTMValuation {
    const now = Date.now();
    const holdTimeMs = now - position.entryTime;
    const validationErrors: string[] = [];
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Validate inputs
    // ═══════════════════════════════════════════════════════════════════════════
    if (position.entryNotionalUsd <= 0) {
        validationErrors.push(`Invalid entryNotionalUsd: ${position.entryNotionalUsd}`);
    }
    if (priceFeed.baseTokenPriceUsd <= 0) {
        validationErrors.push(`Invalid baseTokenPriceUsd: ${priceFeed.baseTokenPriceUsd}`);
    }
    if (position.entryPrice <= 0) {
        validationErrors.push(`Invalid entryPrice: ${position.entryPrice}`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Calculate price change value using BIN-AWARE PRICING
    // 
    // CRITICAL: Use active bin vs entry bin for price delta, NOT cached pool spot.
    // This ensures MTM reflects actual position movement in the bin range.
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Check if we need to force refresh due to staleness
    const shouldForceRefresh = shouldInvalidateMtmCache(
        position.id,
        poolState.activeBin,
        priceFeed.fetchedAt,
        exitWatcherCycleCounter
    );
    
    // Compute bin-aware price from active bin position
    // This is more accurate than using cached poolState.currentPrice
    const binAwarePrice = computeBinAwarePrice(
        poolState.activeBin,
        position.entryBin,
        position.entryPrice
    );
    
    // Use bin-aware price as primary source, fall back to pool price if bins unavailable
    const currentPrice = poolState.activeBin !== 0 
        ? binAwarePrice 
        : (poolState.currentPrice > 0 ? poolState.currentPrice : priceFeed.baseTokenPriceUsd);
    
    const priceChangeRatio = position.entryPrice > 0 
        ? (currentPrice - position.entryPrice) / position.entryPrice
        : 0;
    
    const priceChangeUsd = position.entryNotionalUsd * priceChangeRatio;
    
    // Log if forced refresh was triggered
    if (shouldForceRefresh) {
        const cached = positionMtmCache.get(position.id);
        if (cached && cached.consecutiveUnchanged >= FORCE_REFRESH_CONSECUTIVE_THRESHOLD) {
            logger.debug(
                `${MTM_CONFIG.logPrefix} FORCED_REFRESH for ${position.id.slice(0, 8)}... ` +
                `(${cached.consecutiveUnchanged} consecutive unchanged, bin=${poolState.activeBin})`
            );
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Calculate token value
    // If we have actual token amounts from SDK, use those
    // Otherwise, estimate based on entry notional and price change
    // ═══════════════════════════════════════════════════════════════════════════
    let tokenValueUsd: number;
    
    if (position.baseTokenAmount !== undefined && position.quoteTokenAmount !== undefined) {
        // SDK provided token amounts — compute precise value
        const baseValue = position.baseTokenAmount * priceFeed.baseTokenPriceUsd;
        const quoteValue = position.quoteTokenAmount * priceFeed.quoteTokenPriceUsd;
        tokenValueUsd = baseValue + quoteValue;
    } else {
        // Estimate token value from price change
        // For LP positions, impermanent loss creates non-linear relationship
        // Simplified model: assume linear for small moves, IL adjustment for larger moves
        const ilAdjustment = computeImpermanentLossAdjustment(priceChangeRatio);
        tokenValueUsd = position.entryNotionalUsd * (1 + priceChangeRatio) * ilAdjustment;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Calculate accrued fees
    // Priority: SDK unclaimed fees > SDK claimed fees > estimation
    // ═══════════════════════════════════════════════════════════════════════════
    let feesAccruedUsd: number;
    
    if (position.unclaimedFeesUsd !== undefined && position.unclaimedFeesUsd > 0) {
        // SDK provides unclaimed fees — use directly
        feesAccruedUsd = position.unclaimedFeesUsd + (position.claimedFeesUsd ?? 0);
    } else if (position.claimedFeesUsd !== undefined && position.claimedFeesUsd > 0) {
        // Only claimed fees available
        feesAccruedUsd = position.claimedFeesUsd;
    } else {
        // Estimate fees from feeIntensity and hold time
        feesAccruedUsd = estimateAccruedFees(
            position.entryNotionalUsd,
            holdTimeMs,
            poolState.feeIntensity,
            poolState.liquidityUSD,
            poolState.swapVelocity
        );
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: Compute final MTM value
    // MTM = tokenValue + accruedFees
    // ═══════════════════════════════════════════════════════════════════════════
    const mtmValueUsd = tokenValueUsd + feesAccruedUsd;
    const unrealizedPnlUsd = mtmValueUsd - position.entryNotionalUsd;
    
    // Compute ratios
    const pnlPercent = position.entryNotionalUsd > 0 
        ? (unrealizedPnlUsd / position.entryNotionalUsd) * 100 
        : 0;
    const feesAsPercentOfEntry = position.entryNotionalUsd > 0 
        ? (feesAccruedUsd / position.entryNotionalUsd) * 100 
        : 0;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: Validate result
    // ═══════════════════════════════════════════════════════════════════════════
    if (mtmValueUsd < 0) {
        validationErrors.push(`MTM value cannot be negative: ${mtmValueUsd}`);
    }
    if (feesAccruedUsd < 0) {
        validationErrors.push(`Fees cannot be negative: ${feesAccruedUsd}`);
    }
    
    const isValid = validationErrors.length === 0;
    
    if (!isValid) {
        logger.warn(`${MTM_CONFIG.logPrefix} Validation errors for ${position.id.slice(0, 8)}...: ${validationErrors.join(', ')}`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 7: Update MTM cache for staleness tracking
    // ═══════════════════════════════════════════════════════════════════════════
    const finalMtmValue = roundUsd(mtmValueUsd);
    updateMtmCache(
        position.id,
        poolState.activeBin,
        priceFeed.fetchedAt,
        finalMtmValue,
        position.entryNotionalUsd,
        exitWatcherCycleCounter
    );
    
    return {
        mtmValueUsd: finalMtmValue,
        feesAccruedUsd: roundUsd(feesAccruedUsd),
        unrealizedPnlUsd: roundUsd(unrealizedPnlUsd),
        tokenValueUsd: roundUsd(tokenValueUsd),
        priceChangeUsd: roundUsd(priceChangeUsd),
        entryNotionalUsd: position.entryNotionalUsd,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
        feesAsPercentOfEntry: Math.round(feesAsPercentOfEntry * 100) / 100,
        isValid,
        validationErrors,
        computedAt: now,
        holdTimeMs,
        priceSource: priceFeed.source,
    };
}

/**
 * Compute MTM at exit time — wrapper that validates and logs
 * 
 * THIS MUST BE USED FOR ALL EXIT VALUE CALCULATIONS
 * 
 * @param position - Position being exited
 * @param poolState - Current pool state
 * @param priceFeed - Current prices
 * @returns MTM valuation (for exitAssetValueUsd)
 */
export function computeExitMtmUsd(
    position: PositionForMTM,
    poolState: PoolStateForMTM,
    priceFeed: PriceFeed
): MTMValuation {
    const mtm = computePositionMtmUsd(position, poolState, priceFeed);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MTM-ERROR DETECTION
    // ═══════════════════════════════════════════════════════════════════════════
    const isUnchanged = Math.abs(mtm.mtmValueUsd - mtm.entryNotionalUsd) < MTM_CONFIG.unchangedToleranceUsd;
    const isLongEnoughHold = mtm.holdTimeMs > MTM_CONFIG.minHoldTimeForErrorMs;
    
    if (isUnchanged && isLongEnoughHold) {
        consecutiveUnchangedExitCount++;
        
        recentExitMTMs.push({
            tradeId: position.id,
            mtmValueUsd: mtm.mtmValueUsd,
            entryNotionalUsd: mtm.entryNotionalUsd,
            holdTimeMs: mtm.holdTimeMs,
        });
        
        // Keep only last N exits for diagnostics
        if (recentExitMTMs.length > 20) {
            recentExitMTMs.shift();
        }
        
        if (consecutiveUnchangedExitCount >= MTM_CONFIG.maxConsecutiveUnchangedExits) {
            logMtmError(position, mtm);
        }
    } else {
        // Reset counter on valid MTM change
        consecutiveUnchangedExitCount = 0;
    }
    
    // Log exit MTM
    logExitMtm(position, mtm);
    
    return mtm;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEE ESTIMATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Estimate accrued fees when SDK doesn't provide them
 * 
 * Uses feeIntensity from pool telemetry to estimate fee accrual
 * 
 * @param entryNotionalUsd - Position size at entry
 * @param holdTimeMs - Time position has been open
 * @param feeIntensity - Current pool fee intensity (0-100 or normalized)
 * @param poolLiquidityUsd - Total pool liquidity
 * @param swapVelocity - Swaps per second
 * @returns Estimated fees accrued in USD
 */
export function estimateAccruedFees(
    entryNotionalUsd: number,
    holdTimeMs: number,
    feeIntensity: number,
    poolLiquidityUsd: number,
    swapVelocity: number
): number {
    const holdTimeHours = holdTimeMs / (1000 * 3600);
    
    // Position share of pool
    const positionShare = poolLiquidityUsd > 0 
        ? Math.min(entryNotionalUsd / poolLiquidityUsd, 1)
        : 0;
    
    // Normalize feeIntensity if provided as 0-100
    const normalizedFeeIntensity = feeIntensity > 1 ? feeIntensity / 100 : feeIntensity;
    
    // Base fee rate from config
    const baseFeeRatePctPerHour = MTM_CONFIG.defaultFeeAccrualRatePctPerHour;
    
    // Adjust fee rate based on pool activity
    // Higher feeIntensity and swapVelocity = more fees
    const activityMultiplier = 1 + (normalizedFeeIntensity * 2) + (swapVelocity * 0.5);
    
    // Calculate estimated fees
    // Fees = positionSize * positionShare * feeRate * holdTime * activityMultiplier
    const estimatedFees = entryNotionalUsd * positionShare * (baseFeeRatePctPerHour / 100) * holdTimeHours * activityMultiplier;
    
    return Math.max(0, estimatedFees);
}

/**
 * Compute impermanent loss adjustment factor
 * 
 * For concentrated liquidity, IL can be significant
 * Simplified model for now — can be enhanced with bin range data
 * 
 * @param priceChangeRatio - (currentPrice - entryPrice) / entryPrice
 * @returns Adjustment multiplier (0-1, where 1 = no IL)
 */
function computeImpermanentLossAdjustment(priceChangeRatio: number): number {
    // For small price moves (< 5%), IL is negligible
    if (Math.abs(priceChangeRatio) < 0.05) {
        return 1.0;
    }
    
    // Simplified IL formula for concentrated liquidity
    // IL = 2 * sqrt(priceRatio) / (1 + priceRatio) - 1
    const priceRatio = 1 + priceChangeRatio;
    if (priceRatio <= 0) return 0.5; // Edge case: price went to 0
    
    const ilFactor = (2 * Math.sqrt(priceRatio)) / (1 + priceRatio);
    
    // Clamp to reasonable range
    return Math.max(0.5, Math.min(1.0, ilFactor));
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log MTM valuation at exit
 */
function logExitMtm(position: PositionForMTM, mtm: MTMValuation): void {
    const pnlSign = mtm.unrealizedPnlUsd >= 0 ? '+' : '';
    const holdTimeMin = Math.floor(mtm.holdTimeMs / 60000);
    
    logger.info(
        `${MTM_CONFIG.logPrefix} EXIT_MTM tradeId=${position.id.slice(0, 8)}... ` +
        `entryValue=$${mtm.entryNotionalUsd.toFixed(2)} ` +
        `mtmValue=$${mtm.mtmValueUsd.toFixed(2)} ` +
        `unrealizedPnL=${pnlSign}$${mtm.unrealizedPnlUsd.toFixed(2)} (${pnlSign}${mtm.pnlPercent.toFixed(2)}%) ` +
        `feesAccrued=$${mtm.feesAccruedUsd.toFixed(2)} (${mtm.feesAsPercentOfEntry.toFixed(2)}%) ` +
        `holdTime=${holdTimeMin}min ` +
        `priceSource=${mtm.priceSource}`
    );
}

/**
 * Log [MTM-ERROR] when detecting likely broken MTM updates
 */
function logMtmError(position: PositionForMTM, mtm: MTMValuation): void {
    logger.error(
        `[MTM-ERROR] LIKELY NOT UPDATING — ${consecutiveUnchangedExitCount} consecutive exits with unchanged MTM\n` +
        `  tradeId=${position.id.slice(0, 8)}...\n` +
        `  entryNotionalUsd=$${mtm.entryNotionalUsd.toFixed(2)}\n` +
        `  mtmValueUsd=$${mtm.mtmValueUsd.toFixed(2)}\n` +
        `  delta=$${Math.abs(mtm.mtmValueUsd - mtm.entryNotionalUsd).toFixed(4)}\n` +
        `  holdTimeMs=${mtm.holdTimeMs}\n` +
        `  Recent exits: ${JSON.stringify(recentExitMTMs.slice(-5))}`
    );
    
    // In DEV_MODE, also throw to catch in tests
    if (DEV_MODE && consecutiveUnchangedExitCount >= MTM_CONFIG.maxConsecutiveUnchangedExits + 5) {
        throw new Error(`[MTM-ERROR] ${consecutiveUnchangedExitCount} consecutive fee-only losses — MTM not computing correctly`);
    }
}

/**
 * Log MTM update during position lifecycle
 */
export function logMtmUpdate(
    tradeId: string,
    poolName: string,
    mtm: MTMValuation
): void {
    const pnlSign = mtm.unrealizedPnlUsd >= 0 ? '+' : '';
    
    logger.debug(
        `${MTM_CONFIG.logPrefix} UPDATE ${poolName.slice(0, 12)} ` +
        `mtm=$${mtm.mtmValueUsd.toFixed(2)} ` +
        `pnl=${pnlSign}$${mtm.unrealizedPnlUsd.toFixed(2)} ` +
        `fees=$${mtm.feesAccruedUsd.toFixed(2)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PNL LOGGING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log [PNL_USD] with MTM-based values
 * 
 * Replaces the old logging that showed Gross=$0.00
 */
export function logPnlUsdWithMtm(
    tradeId: string,
    poolName: string,
    mtm: MTMValuation,
    exitFeesUsd: number,
    entryFeesUsd: number
): void {
    const grossFromMtm = mtm.mtmValueUsd - mtm.entryNotionalUsd;
    const totalFees = entryFeesUsd + exitFeesUsd;
    const netPnl = grossFromMtm - totalFees;
    
    const grossSign = grossFromMtm >= 0 ? '+' : '';
    const netSign = netPnl >= 0 ? '+' : '';
    
    logger.info(
        `[PNL_USD] tradeId=${tradeId.slice(0, 8)}... pool=${poolName}\n` +
        `  entryNotionalUsd=$${mtm.entryNotionalUsd.toFixed(2)}\n` +
        `  mtmValueUsd=$${mtm.mtmValueUsd.toFixed(2)}\n` +
        `  feesAccruedUsd=$${mtm.feesAccruedUsd.toFixed(2)}\n` +
        `  unrealizedPnlUsd=${grossSign}$${mtm.unrealizedPnlUsd.toFixed(2)}\n` +
        `  grossFromMtm=${grossSign}$${grossFromMtm.toFixed(2)}\n` +
        `  entryFees=$${entryFeesUsd.toFixed(2)} exitFees=$${exitFeesUsd.toFixed(2)}\n` +
        `  netPnL=${netSign}$${netPnl.toFixed(2)}`
    );
}

/**
 * Log [TRADE-EXIT] with MTM-based values
 */
export function logTradeExitWithMtm(
    tradeId: string,
    poolName: string,
    mtm: MTMValuation,
    exitReason: string,
    caller: string
): void {
    const grossFromMtm = mtm.mtmValueUsd - mtm.entryNotionalUsd;
    const grossSign = grossFromMtm >= 0 ? '+' : '';
    const holdTimeMin = Math.floor(mtm.holdTimeMs / 60000);
    
    logger.info(
        `[TRADE-EXIT] via ${caller}\n` +
        `  tradeId=${tradeId.slice(0, 8)}... pool=${poolName}\n` +
        `  reason="${exitReason}"\n` +
        `  entryNotionalUsd=$${mtm.entryNotionalUsd.toFixed(2)}\n` +
        `  mtmValueUsd=$${mtm.mtmValueUsd.toFixed(2)}\n` +
        `  feesAccruedUsd=$${mtm.feesAccruedUsd.toFixed(2)}\n` +
        `  unrealizedPnlUsd=${grossSign}$${mtm.unrealizedPnlUsd.toFixed(2)}\n` +
        `  grossFromMtm=${grossSign}$${grossFromMtm.toFixed(2)}\n` +
        `  holdTime=${holdTimeMin}min`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Round USD to 2 decimal places
 */
function roundUsd(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Get consecutive unchanged exit count (for diagnostics)
 */
export function getConsecutiveUnchangedExitCount(): number {
    return consecutiveUnchangedExitCount;
}

/**
 * Reset MTM error tracking (for tests)
 */
export function resetMtmErrorTracking(): void {
    consecutiveUnchangedExitCount = 0;
    recentExitMTMs.length = 0;
}

/**
 * Get recent exit MTMs (for diagnostics)
 */
export function getRecentExitMTMs(): typeof recentExitMTMs {
    return [...recentExitMTMs];
}

/**
 * Create default price feed from pool state
 */
export function createDefaultPriceFeed(poolState: PoolStateForMTM): PriceFeed {
    return {
        baseTokenPriceUsd: poolState.currentPrice,
        quoteTokenPriceUsd: 1.0, // Assume stablecoin quote
        source: 'pool',
        fetchedAt: Date.now(),
    };
}

/**
 * Create position for MTM from trade data
 */
export function createPositionForMtm(
    id: string,
    pool: string,
    entryPrice: number,
    entryNotionalUsd: number,
    entryBin: number,
    entryTime: number,
    entryFeeIntensity?: number
): PositionForMTM {
    return {
        id,
        pool,
        entryPrice,
        entryNotionalUsd,
        entryBin,
        entryTime,
        entryFeeIntensity,
    };
}

