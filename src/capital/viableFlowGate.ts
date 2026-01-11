/**
 * Viable Flow Gate — Adaptive Pool Eligibility Filter
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * REPLACES: Hard 24h volume gate (minVolume24h >= 500,000)
 * 
 * PURPOSE:
 * Allow pools with lower 24h volume if they have recent swap activity.
 * This enables entry into emerging high-activity pools that may not have
 * accumulated 24h volume yet but show live trading flow.
 * 
 * DECISION RULE:
 *   REJECT only if BOTH conditions fail:
 *     1. vol24hUsd < MIN_VOL_24H_USD (100k hard floor for dust pools)
 *     AND
 *     2. swapsInLookback < MIN_SWAPS_15M AND swapVelRaw < MIN_SWAP_VEL_RAW
 *        (and/or binVelRaw < MIN_BIN_VEL_RAW)
 * 
 * This gate:
 *   ❌ Does NOT affect scoring
 *   ❌ Does NOT affect kill-switch state
 *   ❌ Does NOT affect future eligibility
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const VIABLE_FLOW_CONFIG = {
    /** Hard floor for 24h volume - reject dust pools (USD) */
    MIN_VOL_24H_USD: 100_000,
    
    /** Minimum swaps in lookback window to prove flow */
    MIN_SWAPS_15M: 12,
    
    /** Minimum raw swap velocity threshold */
    MIN_SWAP_VEL_RAW: 0.01,
    
    /** Minimum raw bin velocity threshold (optional) */
    MIN_BIN_VEL_RAW: 0.05,
    
    /** Lookback window for swap activity (ms) */
    FLOW_LOOKBACK_MS: 15 * 60 * 1000,  // 15 minutes
    
    /** Log sampling rate for ALLOW decisions (1/N) */
    ALLOW_LOG_SAMPLE_RATE: 10,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ViableFlowInput {
    poolAddress: string;
    poolName: string;
    
    /** 24h volume in USD */
    vol24hUsd: number;
    
    /** Number of swaps in the lookback window */
    swapsInLookback: number;
    
    /** Raw swap velocity (swaps/sec or normalized) */
    swapVelRaw: number;
    
    /** Raw bin velocity (optional) */
    binVelRaw?: number;
    
    /** Lookback window used (ms) - for logging */
    lookbackMs?: number;
}

export interface ViableFlowResult {
    allowed: boolean;
    
    /** Which path allowed entry */
    passedVia: 'VOLUME' | 'FLOW' | 'NONE';
    
    /** Individual check results */
    checks: {
        volumeOk: boolean;
        swapsOk: boolean;
        swapVelOk: boolean;
        binVelOk: boolean;
    };
    
    /** Rejection reason (if rejected) */
    reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE — For log sampling
// ═══════════════════════════════════════════════════════════════════════════════

let allowLogCounter = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE GATE EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate Viable Flow Gate
 * 
 * Runs pre-entry, same stage as executionFrictionGate.
 * Replaces hard 24h volume gate with adaptive flow-based eligibility.
 */
export function evaluateViableFlowGate(input: ViableFlowInput): ViableFlowResult {
    const config = VIABLE_FLOW_CONFIG;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: Volume Path (24h volume above hard floor)
    // ═══════════════════════════════════════════════════════════════════════════
    const volumeOk = input.vol24hUsd >= config.MIN_VOL_24H_USD;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: Flow Path (recent swap activity proves viability)
    // ═══════════════════════════════════════════════════════════════════════════
    const swapsOk = input.swapsInLookback >= config.MIN_SWAPS_15M;
    const swapVelOk = input.swapVelRaw >= config.MIN_SWAP_VEL_RAW;
    const binVelOk = input.binVelRaw !== undefined 
        ? input.binVelRaw >= config.MIN_BIN_VEL_RAW 
        : true;  // Pass if not provided
    
    // Flow is OK if we have sufficient swap activity
    const flowOk = swapsOk || swapVelOk || binVelOk;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DECISION: REJECT only if BOTH paths fail
    // ═══════════════════════════════════════════════════════════════════════════
    const allowed = volumeOk || flowOk;
    
    let passedVia: 'VOLUME' | 'FLOW' | 'NONE';
    if (volumeOk) {
        passedVia = 'VOLUME';
    } else if (flowOk) {
        passedVia = 'FLOW';
    } else {
        passedVia = 'NONE';
    }
    
    const checks = {
        volumeOk,
        swapsOk,
        swapVelOk,
        binVelOk,
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LOGGING
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (!allowed) {
        // Log every rejection
        logger.warn(
            `[VIABLE-FLOW] REJECT pool=${input.poolName} ` +
            `vol24h=$${input.vol24hUsd.toFixed(0)} ` +
            `swaps15m=${input.swapsInLookback} ` +
            `swapVelRaw=${input.swapVelRaw.toFixed(4)} ` +
            `binVelRaw=${(input.binVelRaw ?? 0).toFixed(4)} | ` +
            `thresholds: vol>=$${config.MIN_VOL_24H_USD} OR ` +
            `swaps>=${config.MIN_SWAPS_15M} OR vel>=${config.MIN_SWAP_VEL_RAW}`
        );
    } else {
        // Log ALLOW sampled (1/10 to reduce spam)
        allowLogCounter++;
        if (allowLogCounter % config.ALLOW_LOG_SAMPLE_RATE === 0) {
            logger.info(
                `[VIABLE-FLOW] ALLOW pool=${input.poolName} ` +
                `passedVia=${passedVia} ` +
                `vol24h=$${input.vol24hUsd.toFixed(0)} ` +
                `swaps15m=${input.swapsInLookback} ` +
                `swapVelRaw=${input.swapVelRaw.toFixed(4)} ` +
                `binVelRaw=${(input.binVelRaw ?? 0).toFixed(4)}`
            );
        }
    }
    
    return {
        allowed,
        passedVia,
        checks,
        reason: allowed ? undefined : 'INSUFFICIENT_FLOW',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Convert pool metrics to ViableFlowInput
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create ViableFlowInput from pool telemetry
 */
export function createViableFlowInput(
    poolAddress: string,
    poolName: string,
    vol24hUsd: number,
    microMetrics?: {
        swapVelocity?: number;
        binVelocity?: number;
        rawSwapCount?: number;
    },
): ViableFlowInput {
    // Estimate swaps in 15m from raw swap count or swap velocity
    // swapVelocity is typically swaps/sec normalized
    const swapVelRaw = microMetrics?.swapVelocity ?? 0;
    
    // If we have raw swap count, use it
    // Otherwise estimate from velocity (swaps/sec × 15min × 60sec)
    const swapsInLookback = microMetrics?.rawSwapCount ?? 
        Math.round(swapVelRaw * 15 * 60);
    
    return {
        poolAddress,
        poolName,
        vol24hUsd,
        swapsInLookback,
        swapVelRaw,
        binVelRaw: microMetrics?.binVelocity,
        lookbackMs: VIABLE_FLOW_CONFIG.FLOW_LOOKBACK_MS,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Check if volume gate should be bypassed
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Quick check if a pool should bypass strict volume requirements
 * based on active flow metrics
 */
export function hasViableFlow(
    vol24hUsd: number,
    swapVelocity: number,
    binVelocity?: number,
): boolean {
    const config = VIABLE_FLOW_CONFIG;
    
    // If volume is above hard floor, always viable
    if (vol24hUsd >= config.MIN_VOL_24H_USD) {
        return true;
    }
    
    // Check flow metrics
    if (swapVelocity >= config.MIN_SWAP_VEL_RAW) {
        return true;
    }
    
    if (binVelocity !== undefined && binVelocity >= config.MIN_BIN_VEL_RAW) {
        return true;
    }
    
    return false;
}
