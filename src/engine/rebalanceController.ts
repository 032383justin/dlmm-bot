/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * REBALANCE CONTROLLER — FEE BULLY MODE CORE STRATEGY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module evaluates active positions for rebalance triggers and executes
 * rebalance actions to maximize fee extraction.
 * 
 * REBALANCE TRIGGERS:
 * 1. Price moved outside active range (bin drift)
 * 2. Fee velocity drops below threshold over rolling window
 * 3. Inventory imbalance exceeds threshold
 * 4. Regime change suggests different range width
 * 
 * REBALANCE ACTION SEQUENCE:
 * 1. Harvest/close position (realize fees)
 * 2. Update DB position with exit_reason = REBALANCE
 * 3. Immediately re-enter with adjusted bin range and size
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import {
    REBALANCE_CONFIG,
    FEE_BULLY_MODE_ENABLED,
    FEE_BULLY_TAGS,
} from '../config/feeBullyConfig';
import { getPoolHistory } from '../services/dlmmTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RebalanceEvaluation {
    shouldRebalance: boolean;
    trigger: RebalanceTrigger | null;
    reason: string;
    suggestedBinWidth: number | null;
    urgency: 'LOW' | 'MEDIUM' | 'HIGH';
}

export type RebalanceTrigger =
    | 'BIN_DRIFT'
    | 'FEE_VELOCITY_DROP'
    | 'INVENTORY_IMBALANCE'
    | 'REGIME_CHANGE';

export interface PositionForRebalance {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    entryTime: number;
    entryBin: number;
    entrySizeUsd: number;
    currentBin: number;
    binWidth: number;
    regime: string;
}

interface FeeVelocitySample {
    timestamp: number;
    feeIntensity: number;
}

interface RebalanceState {
    lastRebalanceTime: number;
    rebalanceCount: number;
    feeVelocityHistory: FeeVelocitySample[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE — Per-position rebalance tracking
// ═══════════════════════════════════════════════════════════════════════════════

const rebalanceState = new Map<string, RebalanceState>();
let cycleRebalanceCount = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

export function initializeRebalanceTracking(tradeId: string): void {
    if (!rebalanceState.has(tradeId)) {
        rebalanceState.set(tradeId, {
            lastRebalanceTime: 0,
            rebalanceCount: 0,
            feeVelocityHistory: [],
        });
    }
}

export function cleanupRebalanceTracking(tradeId: string): void {
    rebalanceState.delete(tradeId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEE VELOCITY TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

function recordFeeVelocity(tradeId: string, feeIntensity: number): void {
    const state = rebalanceState.get(tradeId);
    if (!state) return;
    
    const now = Date.now();
    state.feeVelocityHistory.push({ timestamp: now, feeIntensity });
    
    // Prune old samples
    const cutoff = now - REBALANCE_CONFIG.FEE_VELOCITY_WINDOW_MS;
    state.feeVelocityHistory = state.feeVelocityHistory.filter(s => s.timestamp > cutoff);
}

function getFeeVelocityDrop(tradeId: string, currentFeeIntensity: number): number {
    const state = rebalanceState.get(tradeId);
    if (!state || state.feeVelocityHistory.length < 3) return 0;
    
    // Calculate rolling average
    const avg = state.feeVelocityHistory.reduce((sum, s) => sum + s.feeIntensity, 0) 
        / state.feeVelocityHistory.length;
    
    if (avg <= 0) return 0;
    
    // Calculate drop percentage
    return (avg - currentFeeIntensity) / avg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REBALANCE RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════════

function canRebalance(tradeId: string, entryTime: number): { allowed: boolean; reason?: string } {
    const state = rebalanceState.get(tradeId);
    const now = Date.now();
    
    // Check minimum hold time
    const holdTime = now - entryTime;
    if (holdTime < REBALANCE_CONFIG.MIN_HOLD_BEFORE_REBALANCE_MS) {
        return {
            allowed: false,
            reason: `Hold time ${Math.floor(holdTime / 1000)}s < min ${REBALANCE_CONFIG.MIN_HOLD_BEFORE_REBALANCE_MS / 1000}s`,
        };
    }
    
    if (!state) return { allowed: true };
    
    // Check hourly rate limit
    const oneHourAgo = now - 3600000;
    if (state.lastRebalanceTime > oneHourAgo && state.rebalanceCount >= REBALANCE_CONFIG.MAX_REBALANCES_PER_HOUR) {
        return {
            allowed: false,
            reason: `Rate limit: ${state.rebalanceCount} rebalances in last hour`,
        };
    }
    
    // Reset hourly counter if over an hour since last rebalance
    if (state.lastRebalanceTime <= oneHourAgo) {
        state.rebalanceCount = 0;
    }
    
    return { allowed: true };
}

function recordRebalance(tradeId: string): void {
    const state = rebalanceState.get(tradeId);
    if (state) {
        state.lastRebalanceTime = Date.now();
        state.rebalanceCount++;
        state.feeVelocityHistory = []; // Reset fee history on rebalance
    }
    cycleRebalanceCount++;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REBALANCE TRIGGER EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate if a position should be rebalanced.
 */
export function evaluateRebalance(
    position: PositionForRebalance,
    currentFeeIntensity: number,
    inventorySkew: number, // -1 to 1, where 0 is balanced
    currentRegime: string
): RebalanceEvaluation {
    if (!FEE_BULLY_MODE_ENABLED || !REBALANCE_CONFIG.ENABLED) {
        return { shouldRebalance: false, trigger: null, reason: 'Rebalance disabled', suggestedBinWidth: null, urgency: 'LOW' };
    }
    
    // Initialize tracking if needed
    initializeRebalanceTracking(position.tradeId);
    
    // Record fee velocity
    recordFeeVelocity(position.tradeId, currentFeeIntensity);
    
    // Check rate limit
    const rateCheck = canRebalance(position.tradeId, position.entryTime);
    if (!rateCheck.allowed) {
        return { shouldRebalance: false, trigger: null, reason: rateCheck.reason!, suggestedBinWidth: null, urgency: 'LOW' };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRIGGER 1: BIN DRIFT
    // Price moved outside active range
    // ═══════════════════════════════════════════════════════════════════════════
    const binDrift = Math.abs(position.currentBin - position.entryBin);
    const halfWidth = Math.floor(position.binWidth / 2);
    
    if (binDrift >= halfWidth + REBALANCE_CONFIG.BIN_DRIFT_THRESHOLD) {
        logger.info(
            `${FEE_BULLY_TAGS.REBALANCE} BIN_DRIFT detected | ` +
            `pool=${position.poolName} | drift=${binDrift} bins | ` +
            `threshold=${halfWidth + REBALANCE_CONFIG.BIN_DRIFT_THRESHOLD}`
        );
        return {
            shouldRebalance: true,
            trigger: 'BIN_DRIFT',
            reason: `Bin drift ${binDrift} exceeds threshold`,
            suggestedBinWidth: position.binWidth, // Maintain same width
            urgency: 'HIGH',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRIGGER 2: FEE VELOCITY DROP
    // Fee generation slowed significantly
    // ═══════════════════════════════════════════════════════════════════════════
    const feeVelocityDrop = getFeeVelocityDrop(position.tradeId, currentFeeIntensity);
    
    if (feeVelocityDrop >= REBALANCE_CONFIG.FEE_VELOCITY_DROP_THRESHOLD) {
        logger.info(
            `${FEE_BULLY_TAGS.REBALANCE} FEE_VELOCITY_DROP detected | ` +
            `pool=${position.poolName} | drop=${(feeVelocityDrop * 100).toFixed(1)}% | ` +
            `threshold=${(REBALANCE_CONFIG.FEE_VELOCITY_DROP_THRESHOLD * 100).toFixed(1)}%`
        );
        return {
            shouldRebalance: true,
            trigger: 'FEE_VELOCITY_DROP',
            reason: `Fee velocity dropped ${(feeVelocityDrop * 100).toFixed(1)}%`,
            suggestedBinWidth: Math.min(position.binWidth + 2, 20), // Widen slightly
            urgency: 'MEDIUM',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRIGGER 3: INVENTORY IMBALANCE
    // Position is heavily skewed to one side
    // ═══════════════════════════════════════════════════════════════════════════
    const absSkew = Math.abs(inventorySkew);
    
    if (absSkew >= REBALANCE_CONFIG.INVENTORY_IMBALANCE_THRESHOLD) {
        logger.info(
            `${FEE_BULLY_TAGS.REBALANCE} INVENTORY_IMBALANCE detected | ` +
            `pool=${position.poolName} | skew=${(inventorySkew * 100).toFixed(1)}% | ` +
            `threshold=${(REBALANCE_CONFIG.INVENTORY_IMBALANCE_THRESHOLD * 100).toFixed(1)}%`
        );
        return {
            shouldRebalance: true,
            trigger: 'INVENTORY_IMBALANCE',
            reason: `Inventory skew ${(absSkew * 100).toFixed(1)}%`,
            suggestedBinWidth: position.binWidth,
            urgency: 'MEDIUM',
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TRIGGER 4: REGIME CHANGE
    // Market conditions changed significantly
    // ═══════════════════════════════════════════════════════════════════════════
    if (position.regime !== currentRegime) {
        // Determine new bin width based on regime
        let suggestedWidth = position.binWidth;
        if (currentRegime === 'BULL') {
            suggestedWidth = Math.max(position.binWidth - 2, 6); // Tighter in bull
        } else if (currentRegime === 'BEAR') {
            suggestedWidth = Math.min(position.binWidth + 4, 24); // Wider in bear
        }
        
        // Only trigger if width change is significant
        if (Math.abs(suggestedWidth - position.binWidth) >= 2) {
            logger.info(
                `${FEE_BULLY_TAGS.REBALANCE} REGIME_CHANGE detected | ` +
                `pool=${position.poolName} | ${position.regime} -> ${currentRegime} | ` +
                `width ${position.binWidth} -> ${suggestedWidth}`
            );
            return {
                shouldRebalance: true,
                trigger: 'REGIME_CHANGE',
                reason: `Regime changed: ${position.regime} → ${currentRegime}`,
                suggestedBinWidth: suggestedWidth,
                urgency: 'LOW',
            };
        }
    }
    
    // No rebalance needed
    return {
        shouldRebalance: false,
        trigger: null,
        reason: 'Position is optimally positioned',
        suggestedBinWidth: null,
        urgency: 'LOW',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

export function resetCycleRebalanceCount(): void {
    cycleRebalanceCount = 0;
}

export function getCycleRebalanceCount(): number {
    return cycleRebalanceCount;
}

export function markRebalanceExecuted(tradeId: string): void {
    recordRebalance(tradeId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logRebalanceSummary(): void {
    if (!FEE_BULLY_MODE_ENABLED) return;
    
    let totalTracked = 0;
    let totalRebalances = 0;
    
    for (const [_, state] of rebalanceState) {
        totalTracked++;
        totalRebalances += state.rebalanceCount;
    }
    
    if (totalTracked > 0 || cycleRebalanceCount > 0) {
        logger.info(
            `${FEE_BULLY_TAGS.REBALANCE} Summary | ` +
            `thisycle=${cycleRebalanceCount} | ` +
            `tracked=${totalTracked} positions | ` +
            `totalRebalances=${totalRebalances}`
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
    REBALANCE_CONFIG,
};

