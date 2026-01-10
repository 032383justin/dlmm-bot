/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DOMINANCE RISK CONTROL — NON-NEGOTIABLE SAFETY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Even in predator mode, these rules are ABSOLUTE:
 * 
 * - No creating bin arrays
 * - No widening during volatility
 * - Immediate exit if dominance breaks
 * - No multi-day bleed allowed
 * 
 * PRESERVES: "Maximum aggression with no catastrophic liquidation or 3+ day drawdowns."
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { PREDATOR_MODE_V1_ENABLED } from '../config/predatorModeV1';
import { getPoolBinState, EscalationState } from './binDominanceEscalation';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type RiskViolation = 
    | 'BIN_ARRAY_CREATION'
    | 'VOLATILITY_WIDENING'
    | 'DOMINANCE_BREAK'
    | 'MULTI_DAY_BLEED'
    | 'MAX_DRAWDOWN_EXCEEDED'
    | 'CAPITAL_LOCK'
    | 'NONE';

export interface RiskCheckResult {
    safe: boolean;
    violation: RiskViolation;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
    action: RiskAction;
    reason: string;
}

export type RiskAction = 
    | 'IMMEDIATE_EXIT'
    | 'BLOCK_ENTRY'
    | 'BLOCK_REBALANCE'
    | 'REDUCE_POSITION'
    | 'CONTINUE'
    | 'WARN';

export interface PositionRiskState {
    poolAddress: string;
    poolName: string;
    entryTime: number;
    peakValueUsd: number;
    currentValueUsd: number;
    drawdownPct: number;
    consecutiveLossDays: number;
    lastProfitableDay: number;
    dominanceIntact: boolean;
    binWidthAtEntry: number;
    currentBinWidth: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const RISK_CONTROL_CONFIG = {
    // BIN ARRAY RULE: Never create bin arrays
    BIN_ARRAY_CREATION_BLOCKED: true,
    
    // VOLATILITY WIDENING: Never widen during volatility
    VOLATILITY_WIDENING_BLOCKED: true,
    VOLATILITY_THRESHOLD: 0.10,  // 10% price move
    MAX_BIN_WIDTH_INCREASE: 0,   // 0 = never increase
    
    // DOMINANCE BREAK: Immediate exit
    DOMINANCE_BREAK_EXIT: true,
    DOMINANCE_BREAK_THRESHOLD: 0.50,  // <50% of flow = broken
    
    // MULTI-DAY BLEED: No 3+ day drawdowns
    MAX_CONSECUTIVE_LOSS_DAYS: 2,
    BLEED_THRESHOLD_PER_DAY: 0.05,  // 5% daily loss = bleeding
    
    // MAX DRAWDOWN
    MAX_POSITION_DRAWDOWN: 0.20,  // 20% max per position
    MAX_PORTFOLIO_DRAWDOWN: 0.25, // 25% max portfolio
    
    // CAPITAL LOCK DETECTION
    CAPITAL_LOCK_DURATION_MS: 24 * 60 * 60 * 1000,  // 24 hours no exits
    
    // COOLDOWN AFTER VIOLATION
    VIOLATION_COOLDOWN_MS: 4 * 60 * 60 * 1000,  // 4 hours
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const positionRiskStates = new Map<string, PositionRiskState>();
let lastViolationTime = 0;
let violationCount = 0;

// Daily P&L tracking
interface DailyPnL {
    date: string;  // YYYY-MM-DD
    pnlUsd: number;
    pnlPct: number;
}
const dailyPnLHistory: DailyPnL[] = [];

// ═══════════════════════════════════════════════════════════════════════════════
// CORE RISK CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * RULE 1: No creating bin arrays
 */
export function checkBinArrayCreation(
    requestedBinCount: number,
    currentBinCount: number
): RiskCheckResult {
    if (!RISK_CONTROL_CONFIG.BIN_ARRAY_CREATION_BLOCKED) {
        return safeResult();
    }
    
    // If trying to create more bins than exist
    if (requestedBinCount > currentBinCount && currentBinCount > 0) {
        return {
            safe: false,
            violation: 'BIN_ARRAY_CREATION',
            severity: 'CRITICAL',
            action: 'BLOCK_ENTRY',
            reason: `BIN_ARRAY_BLOCKED: Cannot create ${requestedBinCount} bins (current: ${currentBinCount})`,
        };
    }
    
    // Max 3 bins ever
    if (requestedBinCount > 3) {
        return {
            safe: false,
            violation: 'BIN_ARRAY_CREATION',
            severity: 'CRITICAL',
            action: 'BLOCK_ENTRY',
            reason: `BIN_ARRAY_BLOCKED: Max 3 bins allowed, requested ${requestedBinCount}`,
        };
    }
    
    return safeResult();
}

/**
 * RULE 2: No widening during volatility
 */
export function checkVolatilityWidening(
    poolAddress: string,
    proposedBinWidth: number,
    currentVolatility: number
): RiskCheckResult {
    if (!RISK_CONTROL_CONFIG.VOLATILITY_WIDENING_BLOCKED) {
        return safeResult();
    }
    
    const state = positionRiskStates.get(poolAddress);
    if (!state) return safeResult();
    
    const widthIncrease = proposedBinWidth - state.binWidthAtEntry;
    
    if (widthIncrease > RISK_CONTROL_CONFIG.MAX_BIN_WIDTH_INCREASE && 
        currentVolatility >= RISK_CONTROL_CONFIG.VOLATILITY_THRESHOLD) {
        return {
            safe: false,
            violation: 'VOLATILITY_WIDENING',
            severity: 'HIGH',
            action: 'BLOCK_REBALANCE',
            reason: `VOLATILITY_WIDENING_BLOCKED: Cannot widen from ${state.binWidthAtEntry} to ${proposedBinWidth} during ${(currentVolatility * 100).toFixed(1)}% volatility`,
        };
    }
    
    return safeResult();
}

/**
 * RULE 3: Immediate exit if dominance breaks
 */
export function checkDominanceBreak(poolAddress: string): RiskCheckResult {
    if (!RISK_CONTROL_CONFIG.DOMINANCE_BREAK_EXIT) {
        return safeResult();
    }
    
    const binState = getPoolBinState(poolAddress);
    if (!binState) return safeResult();
    
    // If state is VACATE, dominance has broken
    if (binState.currentState === 'VACATE') {
        return {
            safe: false,
            violation: 'DOMINANCE_BREAK',
            severity: 'CRITICAL',
            action: 'IMMEDIATE_EXIT',
            reason: 'DOMINANCE_BREAK: Pool state is VACATE, immediate exit required',
        };
    }
    
    // Check if our bin still has dominance
    const state = positionRiskStates.get(poolAddress);
    if (state && !state.dominanceIntact) {
        return {
            safe: false,
            violation: 'DOMINANCE_BREAK',
            severity: 'CRITICAL',
            action: 'IMMEDIATE_EXIT',
            reason: 'DOMINANCE_BREAK: Lost bin dominance, immediate exit required',
        };
    }
    
    return safeResult();
}

/**
 * RULE 4: No multi-day bleed allowed
 */
export function checkMultiDayBleed(poolAddress: string): RiskCheckResult {
    const state = positionRiskStates.get(poolAddress);
    if (!state) return safeResult();
    
    if (state.consecutiveLossDays >= RISK_CONTROL_CONFIG.MAX_CONSECUTIVE_LOSS_DAYS) {
        return {
            safe: false,
            violation: 'MULTI_DAY_BLEED',
            severity: 'CRITICAL',
            action: 'IMMEDIATE_EXIT',
            reason: `MULTI_DAY_BLEED: ${state.consecutiveLossDays} consecutive loss days (max: ${RISK_CONTROL_CONFIG.MAX_CONSECUTIVE_LOSS_DAYS})`,
        };
    }
    
    return safeResult();
}

/**
 * RULE 5: Max drawdown check
 */
export function checkMaxDrawdown(poolAddress: string): RiskCheckResult {
    const state = positionRiskStates.get(poolAddress);
    if (!state) return safeResult();
    
    if (state.drawdownPct >= RISK_CONTROL_CONFIG.MAX_POSITION_DRAWDOWN) {
        return {
            safe: false,
            violation: 'MAX_DRAWDOWN_EXCEEDED',
            severity: 'CRITICAL',
            action: 'IMMEDIATE_EXIT',
            reason: `MAX_DRAWDOWN: ${(state.drawdownPct * 100).toFixed(1)}% >= ${(RISK_CONTROL_CONFIG.MAX_POSITION_DRAWDOWN * 100).toFixed(0)}% limit`,
        };
    }
    
    return safeResult();
}

/**
 * RULE 6: Capital lock detection
 */
export function checkCapitalLock(poolAddress: string): RiskCheckResult {
    const state = positionRiskStates.get(poolAddress);
    if (!state) return safeResult();
    
    const holdDuration = Date.now() - state.entryTime;
    
    // If held > 24 hours with negative returns
    if (holdDuration >= RISK_CONTROL_CONFIG.CAPITAL_LOCK_DURATION_MS) {
        if (state.currentValueUsd < state.peakValueUsd * 0.95) {  // 5% below peak
            return {
                safe: false,
                violation: 'CAPITAL_LOCK',
                severity: 'HIGH',
                action: 'IMMEDIATE_EXIT',
                reason: `CAPITAL_LOCK: Position held ${(holdDuration / (60 * 60 * 1000)).toFixed(0)}h with ${(state.drawdownPct * 100).toFixed(1)}% drawdown`,
            };
        }
    }
    
    return safeResult();
}

/**
 * Run ALL risk checks for a position
 */
export function runAllRiskChecks(
    poolAddress: string,
    proposedAction: 'ENTRY' | 'REBALANCE' | 'HOLD' | 'EXIT',
    context: {
        requestedBinCount?: number;
        currentBinCount?: number;
        proposedBinWidth?: number;
        currentVolatility?: number;
    } = {}
): RiskCheckResult {
    // Check in order of severity
    
    // CRITICAL: Dominance break
    const dominanceCheck = checkDominanceBreak(poolAddress);
    if (!dominanceCheck.safe) return dominanceCheck;
    
    // CRITICAL: Multi-day bleed
    const bleedCheck = checkMultiDayBleed(poolAddress);
    if (!bleedCheck.safe) return bleedCheck;
    
    // CRITICAL: Max drawdown
    const drawdownCheck = checkMaxDrawdown(poolAddress);
    if (!drawdownCheck.safe) return drawdownCheck;
    
    // HIGH: Capital lock
    const lockCheck = checkCapitalLock(poolAddress);
    if (!lockCheck.safe) return lockCheck;
    
    // For entries: check bin array creation
    if (proposedAction === 'ENTRY' && context.requestedBinCount !== undefined) {
        const binCheck = checkBinArrayCreation(
            context.requestedBinCount,
            context.currentBinCount || 0
        );
        if (!binCheck.safe) return binCheck;
    }
    
    // For rebalances: check volatility widening
    if (proposedAction === 'REBALANCE' && context.proposedBinWidth !== undefined) {
        const volCheck = checkVolatilityWidening(
            poolAddress,
            context.proposedBinWidth,
            context.currentVolatility || 0
        );
        if (!volCheck.safe) return volCheck;
    }
    
    return safeResult();
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize risk state for a position
 */
export function initializeRiskState(
    poolAddress: string,
    poolName: string,
    entrySizeUsd: number,
    binWidth: number
): void {
    positionRiskStates.set(poolAddress, {
        poolAddress,
        poolName,
        entryTime: Date.now(),
        peakValueUsd: entrySizeUsd,
        currentValueUsd: entrySizeUsd,
        drawdownPct: 0,
        consecutiveLossDays: 0,
        lastProfitableDay: Date.now(),
        dominanceIntact: true,
        binWidthAtEntry: binWidth,
        currentBinWidth: binWidth,
    });
}

/**
 * Update position value (call on each telemetry tick)
 */
export function updatePositionValue(
    poolAddress: string,
    currentValueUsd: number,
    dominanceIntact: boolean
): void {
    const state = positionRiskStates.get(poolAddress);
    if (!state) return;
    
    state.currentValueUsd = currentValueUsd;
    state.dominanceIntact = dominanceIntact;
    
    // Update peak
    if (currentValueUsd > state.peakValueUsd) {
        state.peakValueUsd = currentValueUsd;
    }
    
    // Calculate drawdown
    state.drawdownPct = state.peakValueUsd > 0
        ? (state.peakValueUsd - currentValueUsd) / state.peakValueUsd
        : 0;
}

/**
 * Record daily P&L (call at end of day)
 */
export function recordDailyPnL(poolAddress: string, pnlUsd: number, pnlPct: number): void {
    const state = positionRiskStates.get(poolAddress);
    if (!state) return;
    
    const today = new Date().toISOString().slice(0, 10);
    
    dailyPnLHistory.push({ date: today, pnlUsd, pnlPct });
    
    // Trim history to last 30 days
    while (dailyPnLHistory.length > 30) {
        dailyPnLHistory.shift();
    }
    
    // Update consecutive loss days
    if (pnlPct < -RISK_CONTROL_CONFIG.BLEED_THRESHOLD_PER_DAY) {
        state.consecutiveLossDays++;
    } else if (pnlPct > 0) {
        state.consecutiveLossDays = 0;
        state.lastProfitableDay = Date.now();
    }
}

/**
 * Clear risk state for a position
 */
export function clearRiskState(poolAddress: string): void {
    positionRiskStates.delete(poolAddress);
}

/**
 * Record violation
 */
export function recordViolation(violation: RiskViolation): void {
    lastViolationTime = Date.now();
    violationCount++;
    
    logger.error(
        `[RISK] 🚨 VIOLATION #${violationCount} | ` +
        `type=${violation} | ` +
        `cooldown=${(RISK_CONTROL_CONFIG.VIOLATION_COOLDOWN_MS / (60 * 60 * 1000)).toFixed(0)}h`
    );
}

/**
 * Check if in cooldown after violation
 */
export function isInViolationCooldown(): boolean {
    return Date.now() - lastViolationTime < RISK_CONTROL_CONFIG.VIOLATION_COOLDOWN_MS;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function safeResult(): RiskCheckResult {
    return {
        safe: true,
        violation: 'NONE',
        severity: 'NONE',
        action: 'CONTINUE',
        reason: 'ALL_CHECKS_PASSED',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

export function logRiskStatus(poolAddress: string): void {
    if (!PREDATOR_MODE_V1_ENABLED) return;
    
    const state = positionRiskStates.get(poolAddress);
    if (!state) return;
    
    const riskCheck = runAllRiskChecks(poolAddress, 'HOLD');
    
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`⚠️ RISK STATUS | ${state.poolName}`);
    logger.info('───────────────────────────────────────────────────────────────');
    logger.info(`  Safe: ${riskCheck.safe ? '✅' : '❌'}`);
    logger.info(`  Drawdown: ${(state.drawdownPct * 100).toFixed(1)}% (max: ${(RISK_CONTROL_CONFIG.MAX_POSITION_DRAWDOWN * 100).toFixed(0)}%)`);
    logger.info(`  Consecutive Loss Days: ${state.consecutiveLossDays} (max: ${RISK_CONTROL_CONFIG.MAX_CONSECUTIVE_LOSS_DAYS})`);
    logger.info(`  Dominance Intact: ${state.dominanceIntact ? '✅' : '❌'}`);
    logger.info(`  Bin Width: ${state.currentBinWidth} (entry: ${state.binWidthAtEntry})`);
    
    if (!riskCheck.safe) {
        logger.warn(`  ⚠️ VIOLATION: ${riskCheck.violation}`);
        logger.warn(`  ⚠️ ACTION: ${riskCheck.action}`);
        logger.warn(`  ⚠️ REASON: ${riskCheck.reason}`);
    }
    
    logger.info('───────────────────────────────────────────────────────────────');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    checkBinArrayCreation,
    checkVolatilityWidening,
    checkDominanceBreak,
    checkMultiDayBleed,
    checkMaxDrawdown,
    checkCapitalLock,
    runAllRiskChecks,
    initializeRiskState,
    updatePositionValue,
    recordDailyPnL,
    clearRiskState,
    recordViolation,
    isInViolationCooldown,
    logRiskStatus,
    RISK_CONTROL_CONFIG,
};

