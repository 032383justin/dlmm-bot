/**
 * Exit Engine
 * 
 * Tier-3 DLMM strategy: Exit conditions and position closure.
 * 
 * Exit entire pool (close all LPs) if:
 * - pool.liquidityUSD < 500,000
 * - pool.volume24hUSD drops > 60% from previous
 * - activeBin distance from initial > 30
 * - pool.velocity < 0.2 AND fees24h < 500
 */

import logger from '../utils/logger';
import {
    PoolLiquidityPosition,
    ZonePosition,
    getActivePositions,
    getPoolPosition,
    removePosition,
} from './liquidityEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pool metrics for exit evaluation
 */
export interface PoolExitMetrics {
    poolAddress: string;
    liquidityUSD: number;
    volume24hUSD: number;
    previousVolume24hUSD: number;
    activeBin: number;
    velocity: number;
    fees24h: number;
}

/**
 * Exit trigger result
 */
export interface ExitTrigger {
    triggered: boolean;
    reason: ExitReason | null;
    details: string;
}

/**
 * Exit reasons
 */
export type ExitReason =
    | 'LOW_LIQUIDITY'
    | 'VOLUME_DROP'
    | 'BIN_DISTANCE'
    | 'LOW_ACTIVITY';

/**
 * Exit execution result
 */
export interface ExitResult {
    poolAddress: string;
    success: boolean;
    reason: ExitReason;
    zonesExited: number;
    liquidityWithdrawn: number;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exit thresholds per specification
 */
export const EXIT_THRESHOLDS = {
    minLiquidityUSD: 500_000,        // Exit if TVL < $500k
    maxVolumeDropPercent: 60,        // Exit if volume drops > 60%
    maxActiveBinDistance: 30,        // Exit if activeBin drifts > 30 bins
    minVelocity: 0.2,                // Low velocity threshold
    minFees24h: 500,                 // Low fees threshold (combined with velocity)
};

// Track previous volume for drop detection
const previousVolumeMap: Map<string, number> = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT CONDITION CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if liquidity is below threshold
 */
function checkLowLiquidity(metrics: PoolExitMetrics): ExitTrigger {
    if (metrics.liquidityUSD < EXIT_THRESHOLDS.minLiquidityUSD) {
        return {
            triggered: true,
            reason: 'LOW_LIQUIDITY',
            details: `Liquidity $${metrics.liquidityUSD.toLocaleString()} < $${EXIT_THRESHOLDS.minLiquidityUSD.toLocaleString()}`,
        };
    }
    return { triggered: false, reason: null, details: '' };
}

/**
 * Check if volume dropped significantly
 */
function checkVolumeDrop(metrics: PoolExitMetrics): ExitTrigger {
    const previousVolume = metrics.previousVolume24hUSD || previousVolumeMap.get(metrics.poolAddress) || 0;
    
    if (previousVolume === 0) {
        // First observation, store and skip
        previousVolumeMap.set(metrics.poolAddress, metrics.volume24hUSD);
        return { triggered: false, reason: null, details: '' };
    }

    const dropPercent = ((previousVolume - metrics.volume24hUSD) / previousVolume) * 100;

    // Update stored volume
    previousVolumeMap.set(metrics.poolAddress, metrics.volume24hUSD);

    if (dropPercent > EXIT_THRESHOLDS.maxVolumeDropPercent) {
        return {
            triggered: true,
            reason: 'VOLUME_DROP',
            details: `Volume dropped ${dropPercent.toFixed(1)}% (>${EXIT_THRESHOLDS.maxVolumeDropPercent}%)`,
        };
    }

    return { triggered: false, reason: null, details: '' };
}

/**
 * Check if activeBin has drifted too far from initial
 */
function checkBinDistance(metrics: PoolExitMetrics, position: PoolLiquidityPosition): ExitTrigger {
    const initialActiveBin = position.zones[0]?.initialActiveBin ?? position.activeBin;
    const distance = Math.abs(metrics.activeBin - initialActiveBin);

    if (distance > EXIT_THRESHOLDS.maxActiveBinDistance) {
        return {
            triggered: true,
            reason: 'BIN_DISTANCE',
            details: `ActiveBin drifted ${distance} bins (>${EXIT_THRESHOLDS.maxActiveBinDistance})`,
        };
    }

    return { triggered: false, reason: null, details: '' };
}

/**
 * Check for low activity (velocity AND fees both low)
 */
function checkLowActivity(metrics: PoolExitMetrics): ExitTrigger {
    const lowVelocity = metrics.velocity < EXIT_THRESHOLDS.minVelocity;
    const lowFees = metrics.fees24h < EXIT_THRESHOLDS.minFees24h;

    if (lowVelocity && lowFees) {
        return {
            triggered: true,
            reason: 'LOW_ACTIVITY',
            details: `Low activity: velocity=${metrics.velocity.toFixed(2)} (<${EXIT_THRESHOLDS.minVelocity}), fees=$${metrics.fees24h.toFixed(0)} (<$${EXIT_THRESHOLDS.minFees24h})`,
        };
    }

    return { triggered: false, reason: null, details: '' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXIT EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate all exit conditions for a pool
 */
export function evaluateExitConditions(
    metrics: PoolExitMetrics,
    position: PoolLiquidityPosition
): ExitTrigger {
    // Check each condition in order of severity

    // 1. Low liquidity - most critical
    const liquidityCheck = checkLowLiquidity(metrics);
    if (liquidityCheck.triggered) {
        return liquidityCheck;
    }

    // 2. Volume drop - market interest declining
    const volumeCheck = checkVolumeDrop(metrics);
    if (volumeCheck.triggered) {
        return volumeCheck;
    }

    // 3. Bin distance - price moved too far
    const binCheck = checkBinDistance(metrics, position);
    if (binCheck.triggered) {
        return binCheck;
    }

    // 4. Low activity - pool is dying
    const activityCheck = checkLowActivity(metrics);
    if (activityCheck.triggered) {
        return activityCheck;
    }

    return { triggered: false, reason: null, details: '' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Close a single zone position (placeholder for SDK integration)
 */
async function closeZonePosition(zone: ZonePosition): Promise<{ success: boolean; withdrawn: number }> {
    try {
        logger.info(`[EXIT] Closing ${zone.zoneId}`, {
            pool: zone.poolAddress,
            range: `${zone.lowerBin} → ${zone.upperBin}`,
            liquidity: zone.liquidityAmount.toFixed(2),
        });

        // TODO: Replace with actual Meteora DLMM SDK calls
        // const withdrawn = await dlmmPool.removeLiquidity(zone.positionPDA);
        // await dlmmPool.closePosition(zone.positionPDA);

        // Simulate withdrawal
        await new Promise(resolve => setTimeout(resolve, 100));
        const withdrawn = zone.liquidityAmount;

        logger.info(`[EXIT] ✅ ${zone.zoneId} closed, withdrew $${withdrawn.toFixed(2)}`);
        return { success: true, withdrawn };

    } catch (err: any) {
        logger.error(`[EXIT] ❌ Failed to close ${zone.zoneId}`, {
            pool: zone.poolAddress,
            error: err?.message,
        });
        return { success: false, withdrawn: 0 };
    }
}

/**
 * Execute full exit for a pool - close all zones
 */
export async function executePoolExit(
    position: PoolLiquidityPosition,
    reason: ExitReason
): Promise<ExitResult> {
    logger.warn(`[EXIT] 🚨 Exiting pool ${position.poolAddress}`, {
        reason,
        zones: position.zones.length,
        totalLiquidity: position.totalLiquidity.toFixed(2),
    });

    let zonesExited = 0;
    let liquidityWithdrawn = 0;

    // Close all zones
    for (const zone of position.zones) {
        const result = await closeZonePosition(zone);
        if (result.success) {
            zonesExited++;
            liquidityWithdrawn += result.withdrawn;
        }
    }

    // Remove from active positions
    removePosition(position.poolAddress);

    // Clear volume tracking
    previousVolumeMap.delete(position.poolAddress);

    const exitResult: ExitResult = {
        poolAddress: position.poolAddress,
        success: zonesExited > 0,
        reason,
        zonesExited,
        liquidityWithdrawn,
        timestamp: Date.now(),
    };

    if (zonesExited === position.zones.length) {
        logger.info(`[EXIT] ✅ Full exit complete for ${position.poolAddress}`, {
            withdrawn: liquidityWithdrawn.toFixed(2),
        });
    } else {
        logger.warn(`[EXIT] ⚠️ Partial exit for ${position.poolAddress}`, {
            exited: zonesExited,
            total: position.zones.length,
        });
    }

    return exitResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check all positions for exit conditions
 */
export async function checkAllExitConditions(
    metricsMap: Map<string, PoolExitMetrics>
): Promise<ExitResult[]> {
    const positions = getActivePositions();
    const results: ExitResult[] = [];

    for (const position of positions) {
        const metrics = metricsMap.get(position.poolAddress);
        if (!metrics) {
            logger.warn(`[EXIT] No metrics for ${position.poolAddress}`);
            continue;
        }

        const exitTrigger = evaluateExitConditions(metrics, position);

        if (exitTrigger.triggered && exitTrigger.reason) {
            logger.warn(`[EXIT] Exit triggered for ${position.poolAddress}`, {
                reason: exitTrigger.reason,
                details: exitTrigger.details,
            });

            const result = await executePoolExit(position, exitTrigger.reason);
            results.push(result);
        }
    }

    if (results.length > 0) {
        const totalWithdrawn = results.reduce((sum, r) => sum + r.liquidityWithdrawn, 0);
        logger.info(`[EXIT] Exited ${results.length} positions, total withdrawn $${totalWithdrawn.toFixed(2)}`);
    }

    return results;
}

/**
 * Force exit a specific pool
 */
export async function forceExit(poolAddress: string, reason: ExitReason = 'LOW_ACTIVITY'): Promise<ExitResult | null> {
    const position = getPoolPosition(poolAddress);
    if (!position) {
        logger.warn(`[EXIT] No position found for ${poolAddress}`);
        return null;
    }

    logger.warn(`[EXIT] Force exit requested for ${poolAddress}`);
    return executePoolExit(position, reason);
}

/**
 * Get current volume for a pool (for external monitoring)
 */
export function getStoredVolume(poolAddress: string): number | undefined {
    return previousVolumeMap.get(poolAddress);
}

