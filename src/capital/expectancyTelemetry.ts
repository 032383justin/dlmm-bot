/**
 * Expectancy Telemetry — Full Trade Analytics & Observability
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 4 DOMINANT — MANDATORY OBSERVABILITY
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Provide complete visibility into trade expectancy for Tier-4 verification.
 * Every trade must emit full telemetry for post-trade analysis.
 * 
 * PER-TRADE TELEMETRY:
 *   - ExpectedFeeUSD
 *   - ExpectedCostUSD
 *   - ExpectedNetEV
 *   - RealizedFees
 *   - RealizedSlippage
 *   - EV error (expected vs realized)
 * 
 * PER-CYCLE SUMMARY:
 *   [EXPECTANCY]
 *   Avg EV: +$X.XX
 *   Hit Rate: XX%
 *   Fee Dominance Ratio: X.XX
 * 
 * This is REQUIRED for Tier-4 verification.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { MarketRegime } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 VALIDATION FLAGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dev mode flag for strict validation assertions
 */
const DEV_MODE = process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development';

/**
 * Threshold for detecting circular EV model (if error is consistently ~0)
 */
const CIRCULAR_EV_THRESHOLD = 0.01; // 1% - if avg error is less than this, model may be circular

/**
 * Minimum trades required for EV variance analysis
 */
const MIN_TRADES_FOR_VARIANCE_CHECK = 5;

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const TELEMETRY_CONFIG = {
    /**
     * Maximum entries to keep in memory
     */
    maxEntries: 500,
    
    /**
     * Rolling window for cycle summaries (ms)
     */
    summaryWindowMs: 60 * 60 * 1000, // 1 hour
    
    /**
     * Log summary every N cycles
     */
    summaryLogInterval: 10,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Complete trade telemetry entry
 */
export interface TradeTelemetry {
    // Identification
    tradeId: string;
    poolAddress: string;
    poolName: string;
    regime: MarketRegime;
    
    // Entry metrics
    entry: {
        timestamp: number;
        positionSizeUSD: number;
        expectedFeeUSD: number;
        expectedCostUSD: number;
        expectedNetEV: number;
        evRatio: number;             // expectedFee / expectedCost
        mhi: number;
        tier4Score: number;
        feeIntensity: number;
    };
    
    // Exit metrics (populated on close)
    exit?: {
        timestamp: number;
        holdDurationMs: number;
        realizedFeeUSD: number;
        realizedSlippageUSD: number;
        realizedCostUSD: number;
        grossPnLUSD: number;
        netPnLUSD: number;
        evError: number;             // realizedNet - expectedEV
        evErrorPct: number;          // evError / abs(expectedEV)
        exitReason: string;
    };
    
    // Analysis flags
    wasPositiveEV: boolean;
    wasHitTarget: boolean;           // netPnL > 0
    wasInHoldMode: boolean;
    holdModeFees: number;            // Fees accumulated during HOLD
    
    // Tier 5: Controlled Aggression tracking
    tier5?: {
        odsAtEntry: number;          // ODS score at entry
        aggressionLevel: string;     // A0-A4
        poolDeployedPct: number;     // % of equity in this pool at entry
        wasConcentrated: boolean;    // Was concentration applied
        wasVSHHarvesting: boolean;   // Was VSH active
        trancheIndex: number;        // 1, 2, or 3
        vshSuppressionActive: boolean; // Was VSH suppression active during trade
        holdSuppressionActive: boolean; // Was HOLD suppression active during trade
    };
}

/**
 * Tier 5 Post-Trade Attribution Record
 * Captures expected vs realized metrics for every closed trade
 */
export interface Tier5PostTradeAttribution {
    // Trade identification
    tradeId: string;
    poolName: string;
    closedAt: number;
    holdDurationMs: number;
    
    // Expected vs Realized - Fees
    expectedFeeUsdAtEntry: number;
    realizedFeesUsd: number;
    feeDelta: number;              // realized - expected
    feeDeltaPct: number;           // feeDelta / expectedFee
    
    // Expected vs Realized - Costs
    expectedCostsUsdAtEntry: number;
    realizedCostsUsd: number;
    costDelta: number;             // realized - expected
    costDeltaPct: number;          // costDelta / expectedCost
    
    // EV Error
    expectedNetEV: number;
    realizedNetPnL: number;
    evError: number;               // realizedNet - expectedNet
    evErrorPct: number;
    
    // Tier 5 Entry Context
    wasA2Plus: boolean;            // Entered at A2, A3, or A4
    aggressionLevel: string;
    wasTranche2Or3: boolean;       // Was this a tranche 2 or 3 add
    trancheIndex: number;
    
    // Suppression Context
    holdSuppressionActive: boolean;
    vshSuppressionActive: boolean;
    
    // Outcome
    isWin: boolean;                // realizedNetPnL > 0
}

/**
 * Cycle summary metrics
 */
export interface CycleSummary {
    cycleNumber: number;
    timestamp: number;
    
    // Entry statistics
    entriesEvaluated: number;
    entriesBlocked: number;
    entriesExecuted: number;
    avgExpectedEV: number;
    
    // Active position statistics
    activePositions: number;
    positionsInHoldMode: number;
    
    // Realized statistics (from recent closed trades)
    closedTrades: number;
    hitRate: number;                  // % of trades with netPnL > 0
    avgRealizedEV: number;
    avgEVError: number;
    feeDominanceRatio: number;        // fees / abs(netPnL)
    
    // Regime breakdown
    regimeBreakdown: Record<MarketRegime, number>;
    
    // Defense status
    feeBleedDefenseActive: boolean;
    evGateMultiplier: number;
    
    // Tier 5: Aggression summary
    tier5Summary?: {
        aggressionLevel: string;     // Current dominant aggression level
        activeSpikes: number;        // Number of active ODS spikes
        topPool?: string;            // Pool with highest aggression
        poolDeployedPct: number;     // Top pool deployed %
        totalDeployedPct: number;    // Total deployed %
        avgODS: number;              // Average ODS across active spikes
        vshHarvestingPools: number;  // Pools being harvested by VSH
    };
}

/**
 * Entry evaluation telemetry (before trade)
 */
export interface EntryEvaluation {
    poolAddress: string;
    poolName: string;
    regime: MarketRegime;
    
    expectedFeeUSD: number;
    expectedCostUSD: number;
    expectedNetEV: number;
    evRatio: number;
    
    passed: boolean;
    blockReason?: string;
    
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

const tradeTelemetryMap = new Map<string, TradeTelemetry>();
const tradeTelemetryHistory: TradeTelemetry[] = [];
const entryEvaluations: EntryEvaluation[] = [];
const cycleSummaries: CycleSummary[] = [];

// Tier 5 Post-Trade Attribution storage (rolling 50 trades)
const tier5AttributionHistory: Tier5PostTradeAttribution[] = [];
const MAX_ATTRIBUTION_HISTORY = 50;

let currentCycleNumber = 0;
let cycleEntriesEvaluated = 0;
let cycleEntriesBlocked = 0;
let cycleEntriesExecuted = 0;
let cycleTotalExpectedEV = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE TELEMETRY RECORDING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record trade entry telemetry
 * Call immediately after trade execution
 */
export function recordTradeEntry(entry: {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    regime: MarketRegime;
    positionSizeUSD: number;
    expectedFeeUSD: number;
    expectedCostUSD: number;
    expectedNetEV: number;
    mhi: number;
    tier4Score: number;
    feeIntensity: number;
}): void {
    const now = Date.now();
    const evRatio = entry.expectedCostUSD > 0 
        ? entry.expectedFeeUSD / entry.expectedCostUSD 
        : 0;
    
    const telemetry: TradeTelemetry = {
        tradeId: entry.tradeId,
        poolAddress: entry.poolAddress,
        poolName: entry.poolName,
        regime: entry.regime,
        
        entry: {
            timestamp: now,
            positionSizeUSD: entry.positionSizeUSD,
            expectedFeeUSD: entry.expectedFeeUSD,
            expectedCostUSD: entry.expectedCostUSD,
            expectedNetEV: entry.expectedNetEV,
            evRatio,
            mhi: entry.mhi,
            tier4Score: entry.tier4Score,
            feeIntensity: entry.feeIntensity,
        },
        
        wasPositiveEV: entry.expectedNetEV > 0,
        wasHitTarget: false,
        wasInHoldMode: false,
        holdModeFees: 0,
    };
    
    tradeTelemetryMap.set(entry.tradeId, telemetry);
    
    // Update cycle stats
    cycleEntriesExecuted++;
    cycleTotalExpectedEV += entry.expectedNetEV;
    
    logger.info(
        `[TELEMETRY-ENTRY] ${entry.poolName} | ` +
        `size=$${entry.positionSizeUSD.toFixed(0)} | ` +
        `expFee=$${entry.expectedFeeUSD.toFixed(2)} | ` +
        `expCost=$${entry.expectedCostUSD.toFixed(2)} | ` +
        `expEV=$${entry.expectedNetEV.toFixed(2)} | ` +
        `ratio=${evRatio.toFixed(2)}× | ` +
        `regime=${entry.regime}`
    );
}

/**
 * Record trade exit telemetry
 * Call immediately after trade close
 */
export function recordTradeExit(exit: {
    tradeId: string;
    realizedFeeUSD: number;
    realizedSlippageUSD: number;
    grossPnLUSD: number;
    netPnLUSD: number;
    exitReason: string;
    wasInHoldMode: boolean;
    holdModeFees: number;
}): void {
    const telemetry = tradeTelemetryMap.get(exit.tradeId);
    if (!telemetry) {
        logger.warn(`[TELEMETRY-EXIT] Trade ${exit.tradeId.slice(0, 8)}... not found in telemetry map`);
        return;
    }
    
    const now = Date.now();
    const holdDurationMs = now - telemetry.entry.timestamp;
    const realizedCostUSD = exit.realizedFeeUSD + exit.realizedSlippageUSD;
    const evError = exit.netPnLUSD - telemetry.entry.expectedNetEV;
    const evErrorPct = Math.abs(telemetry.entry.expectedNetEV) > 0 
        ? evError / Math.abs(telemetry.entry.expectedNetEV) 
        : 0;
    
    telemetry.exit = {
        timestamp: now,
        holdDurationMs,
        realizedFeeUSD: exit.realizedFeeUSD,
        realizedSlippageUSD: exit.realizedSlippageUSD,
        realizedCostUSD,
        grossPnLUSD: exit.grossPnLUSD,
        netPnLUSD: exit.netPnLUSD,
        evError,
        evErrorPct,
        exitReason: exit.exitReason,
    };
    
    telemetry.wasHitTarget = exit.netPnLUSD > 0;
    telemetry.wasInHoldMode = exit.wasInHoldMode;
    telemetry.holdModeFees = exit.holdModeFees;
    
    // Move to history
    tradeTelemetryHistory.push(telemetry);
    tradeTelemetryMap.delete(exit.tradeId);
    
    // Trim history
    while (tradeTelemetryHistory.length > TELEMETRY_CONFIG.maxEntries) {
        tradeTelemetryHistory.shift();
    }
    
    // Log exit telemetry
    const emoji = exit.netPnLUSD >= 0 ? '✅' : '❌';
    const evEmoji = evError >= 0 ? '📈' : '📉';
    
    logger.info(
        `[TELEMETRY-EXIT] ${emoji} ${telemetry.poolName} | ` +
        `net=${exit.netPnLUSD >= 0 ? '+' : ''}$${exit.netPnLUSD.toFixed(2)} | ` +
        `fees=$${exit.realizedFeeUSD.toFixed(2)} | ` +
        `slip=$${exit.realizedSlippageUSD.toFixed(2)} | ` +
        `${evEmoji} evErr=${evError >= 0 ? '+' : ''}$${evError.toFixed(2)} (${(evErrorPct * 100).toFixed(0)}%) | ` +
        `hold=${(holdDurationMs / 1000 / 60).toFixed(1)}min | ` +
        `reason=${exit.exitReason}`
    );
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 5: Record Post-Trade Attribution
    // ═══════════════════════════════════════════════════════════════════════════
    recordTier5PostTradeAttribution(exit.tradeId, telemetry);
}

/**
 * Record entry evaluation (passed or blocked)
 */
export function recordEntryEvaluation(eval_: {
    poolAddress: string;
    poolName: string;
    regime: MarketRegime;
    expectedFeeUSD: number;
    expectedCostUSD: number;
    expectedNetEV: number;
    passed: boolean;
    blockReason?: string;
}): void {
    const evRatio = eval_.expectedCostUSD > 0 
        ? eval_.expectedFeeUSD / eval_.expectedCostUSD 
        : 0;
    
    entryEvaluations.push({
        poolAddress: eval_.poolAddress,
        poolName: eval_.poolName,
        regime: eval_.regime,
        expectedFeeUSD: eval_.expectedFeeUSD,
        expectedCostUSD: eval_.expectedCostUSD,
        expectedNetEV: eval_.expectedNetEV,
        evRatio,
        passed: eval_.passed,
        blockReason: eval_.blockReason,
        timestamp: Date.now(),
    });
    
    // Trim
    while (entryEvaluations.length > TELEMETRY_CONFIG.maxEntries) {
        entryEvaluations.shift();
    }
    
    // Update cycle stats
    cycleEntriesEvaluated++;
    if (!eval_.passed) {
        cycleEntriesBlocked++;
    }
}

/**
 * Record hold mode fee accumulation
 */
export function recordHoldModeFees(tradeId: string, feesUSD: number): void {
    const telemetry = tradeTelemetryMap.get(tradeId);
    if (telemetry) {
        telemetry.holdModeFees += feesUSD;
        telemetry.wasInHoldMode = true;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate and log cycle summary
 * Call at end of each scan cycle
 */
export function generateCycleSummary(
    activePositions: number,
    positionsInHoldMode: number,
    feeBleedDefenseActive: boolean,
    evGateMultiplier: number
): CycleSummary {
    const now = Date.now();
    currentCycleNumber++;
    
    // Get recent closed trades for statistics
    const windowCutoff = now - TELEMETRY_CONFIG.summaryWindowMs;
    const recentClosed = tradeTelemetryHistory.filter(
        t => t.exit && t.exit.timestamp > windowCutoff
    );
    
    // Calculate hit rate and average EV
    const hits = recentClosed.filter(t => t.wasHitTarget).length;
    const hitRate = recentClosed.length > 0 ? hits / recentClosed.length : 0;
    
    let totalRealizedEV = 0;
    let totalEVError = 0;
    let totalFees = 0;
    let totalAbsNetPnL = 0;
    
    for (const trade of recentClosed) {
        if (trade.exit) {
            totalRealizedEV += trade.exit.netPnLUSD;
            totalEVError += trade.exit.evError;
            totalFees += trade.exit.realizedFeeUSD + trade.exit.realizedSlippageUSD;
            totalAbsNetPnL += Math.abs(trade.exit.netPnLUSD);
        }
    }
    
    const avgRealizedEV = recentClosed.length > 0 ? totalRealizedEV / recentClosed.length : 0;
    const avgEVError = recentClosed.length > 0 ? totalEVError / recentClosed.length : 0;
    const feeDominanceRatio = totalAbsNetPnL > 0 ? totalFees / totalAbsNetPnL : 0;
    
    // Regime breakdown of active positions
    const regimeBreakdown: Record<MarketRegime, number> = { BULL: 0, NEUTRAL: 0, BEAR: 0 };
    for (const [, telemetry] of tradeTelemetryMap) {
        regimeBreakdown[telemetry.regime]++;
    }
    
    // Avg expected EV this cycle
    const avgExpectedEV = cycleEntriesExecuted > 0 
        ? cycleTotalExpectedEV / cycleEntriesExecuted 
        : 0;
    
    const summary: CycleSummary = {
        cycleNumber: currentCycleNumber,
        timestamp: now,
        
        entriesEvaluated: cycleEntriesEvaluated,
        entriesBlocked: cycleEntriesBlocked,
        entriesExecuted: cycleEntriesExecuted,
        avgExpectedEV,
        
        activePositions,
        positionsInHoldMode,
        
        closedTrades: recentClosed.length,
        hitRate,
        avgRealizedEV,
        avgEVError,
        feeDominanceRatio,
        
        regimeBreakdown,
        
        feeBleedDefenseActive,
        evGateMultiplier,
    };
    
    cycleSummaries.push(summary);
    while (cycleSummaries.length > 100) {
        cycleSummaries.shift();
    }
    
    // Reset cycle counters
    cycleEntriesEvaluated = 0;
    cycleEntriesBlocked = 0;
    cycleEntriesExecuted = 0;
    cycleTotalExpectedEV = 0;
    
    // Log summary periodically
    if (currentCycleNumber % TELEMETRY_CONFIG.summaryLogInterval === 0) {
        logExpectancySummary(summary);
    }
    
    return summary;
}

/**
 * Log expectancy summary in specified format
 */
export function logExpectancySummary(summary?: CycleSummary): void {
    const s = summary || getLatestCycleSummary();
    if (!s) {
        logger.info('[EXPECTANCY] No data yet');
        return;
    }
    
    logger.info('');
    logger.info('╔═══════════════════════════════════════════════════════════════════╗');
    logger.info('║                    [EXPECTANCY] CYCLE SUMMARY                      ║');
    logger.info('╠═══════════════════════════════════════════════════════════════════╣');
    logger.info(
        `║  Avg EV: ${s.avgRealizedEV >= 0 ? '+' : ''}$${s.avgRealizedEV.toFixed(2).padStart(8)} | ` +
        `Hit Rate: ${(s.hitRate * 100).toFixed(0).padStart(3)}% | ` +
        `Fee Dominance: ${s.feeDominanceRatio.toFixed(2)}           ║`
    );
    logger.info(
        `║  Trades: ${String(s.closedTrades).padStart(3)} closed | ` +
        `${String(s.entriesExecuted).padStart(2)} entries | ` +
        `${String(s.entriesBlocked).padStart(2)} blocked | ` +
        `EV Error: ${s.avgEVError >= 0 ? '+' : ''}$${s.avgEVError.toFixed(2).padStart(6)}  ║`
    );
    logger.info(
        `║  Active: ${String(s.activePositions).padStart(2)} positions | ` +
        `${String(s.positionsInHoldMode).padStart(2)} in HOLD | ` +
        `Defense: ${s.feeBleedDefenseActive ? '🛡️ ON ' : 'OFF'} | ` +
        `EV Gate: ${s.evGateMultiplier.toFixed(1)}×    ║`
    );
    logger.info('╚═══════════════════════════════════════════════════════════════════╝');
    logger.info('');
    
    // Log Tier 5 summary if available
    if (s.tier5Summary) {
        logTier5Summary(s.tier5Summary);
    }
}

/**
 * Log Tier 5 Aggression Summary
 * Format: [AGG-SUMMARY] level=A2 activeSpikes=1 topPool=... poolDeployed=9.8% totalDeployed=18.1% avgODS=2.41
 */
export function logTier5Summary(tier5: CycleSummary['tier5Summary']): void {
    if (!tier5) return;
    
    logger.info(
        `[AGG-SUMMARY] level=${tier5.aggressionLevel} activeSpikes=${tier5.activeSpikes} ` +
        `topPool=${tier5.topPool?.slice(0, 8) ?? 'none'}... ` +
        `poolDeployed=${tier5.poolDeployedPct.toFixed(1)}% ` +
        `totalDeployed=${tier5.totalDeployedPct.toFixed(1)}% ` +
        `avgODS=${tier5.avgODS.toFixed(2)}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 5: VALIDATION SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tier 5 validation summary inputs
 */
export interface Tier5ValidationInputs {
    // ODD stats
    oddRejectsByReason: Record<string, number>;
    oddConfirmedSpikes: number;
    oddTotalEvaluations: number;
    
    // Aggression distribution
    aggressionByLevel: Record<string, number>;
    
    // Tranche stats
    trancheAddsCount: number;
    avgEVDeltaTranche1to2: number;
    trancheBlockedReasons: Record<string, number>;
    
    // Exit suppression stats
    riskSuppressBlocks: number;
    noiseExitsSuppressed: number;
    riskExitTypeBlocks: Record<string, number>;
}

/**
 * Generate and log Tier-5 validation summary.
 * Call at end of each cycle.
 * 
 * Format:
 * [TIER5-VALIDATION] rejects={insufficient_snapshots:3,stale:1} confirms=2 
 *                     trancheAdds=1 avgEVDelta=$0.45 riskSuppressBlocks=0
 */
export function logTier5ValidationSummary(inputs: Tier5ValidationInputs): void {
    // Format ODD rejects
    const rejectParts: string[] = [];
    let totalRejects = 0;
    for (const [reason, count] of Object.entries(inputs.oddRejectsByReason)) {
        if (count > 0) {
            rejectParts.push(`${reason}:${count}`);
            totalRejects += count;
        }
    }
    const rejectsStr = rejectParts.length > 0 ? `{${rejectParts.join(',')}}` : '{}';
    
    // Format aggression distribution
    const aggParts: string[] = [];
    for (const [level, count] of Object.entries(inputs.aggressionByLevel)) {
        if (count > 0) {
            aggParts.push(`${level}:${count}`);
        }
    }
    const aggStr = aggParts.length > 0 ? `{${aggParts.join(',')}}` : '{A0:all}';
    
    // Format tranche blocked reasons (only if there were blocks)
    let trancheBlockStr = '';
    if (Object.keys(inputs.trancheBlockedReasons).length > 0) {
        const blockParts: string[] = [];
        for (const [reason, count] of Object.entries(inputs.trancheBlockedReasons)) {
            if (count > 0) {
                blockParts.push(`${reason}:${count}`);
            }
        }
        if (blockParts.length > 0) {
            trancheBlockStr = ` trancheBlocks={${blockParts.join(',')}}`;
        }
    }
    
    // Format risk exit type blocks (only if there were any)
    let riskBlockStr = '';
    if (inputs.riskSuppressBlocks > 0) {
        const riskParts: string[] = [];
        for (const [riskType, count] of Object.entries(inputs.riskExitTypeBlocks)) {
            if (count > 0) {
                riskParts.push(`${riskType}:${count}`);
            }
        }
        if (riskParts.length > 0) {
            riskBlockStr = ` riskTypes={${riskParts.join(',')}}`;
        }
    }
    
    logger.info(
        `[TIER5-VALIDATION] rejects=${rejectsStr} confirms=${inputs.oddConfirmedSpikes} ` +
        `aggression=${aggStr} ` +
        `trancheAdds=${inputs.trancheAddsCount} avgEVDelta=$${inputs.avgEVDeltaTranche1to2.toFixed(2)} ` +
        `riskSuppressBlocks=${inputs.riskSuppressBlocks} noiseSuppressed=${inputs.noiseExitsSuppressed}` +
        `${trancheBlockStr}${riskBlockStr}`
    );
    
    // DEV_MODE: Detailed validation log
    if (DEV_MODE) {
        logger.debug(
            `[TIER5-VALIDATION-DETAIL]\n` +
            `  ODD: ${inputs.oddTotalEvaluations} evals, ${totalRejects} rejects, ${inputs.oddConfirmedSpikes} confirms\n` +
            `  Tranches: ${inputs.trancheAddsCount} adds, avgEVDelta=$${inputs.avgEVDeltaTranche1to2.toFixed(2)}\n` +
            `  Exits: ${inputs.riskSuppressBlocks} risk blocks, ${inputs.noiseExitsSuppressed} noise suppressed`
        );
    }
}

/**
 * Record Tier 5 entry data for telemetry
 */
export function recordTier5EntryData(
    tradeId: string,
    tier5Data: {
        odsAtEntry: number;
        aggressionLevel: string;
        poolDeployedPct: number;
        wasConcentrated: boolean;
        wasVSHHarvesting: boolean;
        trancheIndex?: number;
        vshSuppressionActive?: boolean;
        holdSuppressionActive?: boolean;
    }
): void {
    const telemetry = tradeTelemetryMap.get(tradeId);
    if (telemetry) {
        telemetry.tier5 = {
            ...tier5Data,
            trancheIndex: tier5Data.trancheIndex ?? 1,
            vshSuppressionActive: tier5Data.vshSuppressionActive ?? false,
            holdSuppressionActive: tier5Data.holdSuppressionActive ?? false,
        };
    }
}

/**
 * Update Tier 5 suppression flags during trade lifecycle
 * Call this when HOLD or VSH suppression is activated
 */
export function updateTier5SuppressionFlags(
    tradeId: string,
    flags: {
        holdSuppressionActive?: boolean;
        vshSuppressionActive?: boolean;
    }
): void {
    const telemetry = tradeTelemetryMap.get(tradeId);
    if (telemetry?.tier5) {
        if (flags.holdSuppressionActive !== undefined) {
            telemetry.tier5.holdSuppressionActive = flags.holdSuppressionActive;
        }
        if (flags.vshSuppressionActive !== undefined) {
            telemetry.tier5.vshSuppressionActive = flags.vshSuppressionActive;
        }
    }
}

/**
 * Update Tier 5 tracking during position lifecycle
 */
export function updateTier5TrackingPeriodic(
    tradeId: string,
    currentODS: number
): void {
    const telemetry = tradeTelemetryMap.get(tradeId);
    if (telemetry && telemetry.tier5) {
        // Track if ODS changed significantly
        // This can be extended for more detailed lifecycle tracking
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get active trades telemetry
 */
export function getActiveTradeTelemetry(): TradeTelemetry[] {
    return Array.from(tradeTelemetryMap.values());
}

/**
 * Get closed trades telemetry
 */
export function getClosedTradeTelemetry(limit: number = 50): TradeTelemetry[] {
    return tradeTelemetryHistory.slice(-limit);
}

/**
 * Get latest cycle summary
 */
export function getLatestCycleSummary(): CycleSummary | undefined {
    return cycleSummaries[cycleSummaries.length - 1];
}

/**
 * Get cycle summaries for window
 */
export function getCycleSummaries(limit: number = 20): CycleSummary[] {
    return cycleSummaries.slice(-limit);
}

/**
 * Get EV accuracy statistics
 */
export function getEVAccuracyStats(): {
    totalTrades: number;
    avgEVError: number;
    avgEVErrorPct: number;
    overestimates: number;     // Trades where realized < expected
    underestimates: number;    // Trades where realized > expected
    evHitRate: number;         // % of trades where sign(realized) == sign(expected)
} {
    const closedWithExit = tradeTelemetryHistory.filter(t => t.exit);
    
    if (closedWithExit.length === 0) {
        return {
            totalTrades: 0,
            avgEVError: 0,
            avgEVErrorPct: 0,
            overestimates: 0,
            underestimates: 0,
            evHitRate: 0,
        };
    }
    
    let totalError = 0;
    let totalErrorPct = 0;
    let overestimates = 0;
    let underestimates = 0;
    let evHits = 0;
    
    for (const trade of closedWithExit) {
        if (!trade.exit) continue;
        
        totalError += trade.exit.evError;
        totalErrorPct += Math.abs(trade.exit.evErrorPct);
        
        if (trade.exit.evError < 0) {
            overestimates++;
        } else {
            underestimates++;
        }
        
        // Check if sign matches
        const expectedSign = trade.entry.expectedNetEV >= 0 ? 1 : -1;
        const realizedSign = trade.exit.netPnLUSD >= 0 ? 1 : -1;
        if (expectedSign === realizedSign) {
            evHits++;
        }
    }
    
    return {
        totalTrades: closedWithExit.length,
        avgEVError: totalError / closedWithExit.length,
        avgEVErrorPct: totalErrorPct / closedWithExit.length,
        overestimates,
        underestimates,
        evHitRate: evHits / closedWithExit.length,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE 5: EXPECTANCY TELEMETRY VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extended telemetry record for MODULE 5 verification
 */
export interface EVVerificationRecord {
    tradeId: string;
    poolAddress: string;
    poolName: string;
    
    // Expected values at entry
    expectedFeeUSD: number;
    expectedCostUSD: number;
    expectedNetEVUSD: number;
    
    // Realized values at exit
    realizedFeesUSD: number;
    realizedSlippageUSD: number;
    realizedNetPnLUSD: number;
    
    // Error analysis
    evErrorUSD: number;  // realizedNetPnLUSD − expectedNetEVUSD
    evErrorPct: number;
    
    timestamp: number;
}

/**
 * MODULE 5: Verify EV model is not circular or underpowered.
 * 
 * If evErrorUSD is consistently ~0 across multiple trades, the EV model
 * may be:
 * 1. Circular (using realized data to estimate expected values)
 * 2. Underpowered (not capturing real market dynamics)
 * 
 * @returns Verification result with warning if model appears problematic
 */
export function verifyEVModelValidity(): {
    valid: boolean;
    warning?: string;
    stats: {
        totalTrades: number;
        avgEvError: number;
        evErrorVariance: number;
        evErrorStdDev: number;
        percentNearZero: number;
    };
} {
    const closedWithExit = tradeTelemetryHistory.filter(t => t.exit);
    
    if (closedWithExit.length < MIN_TRADES_FOR_VARIANCE_CHECK) {
        return {
            valid: true, // Not enough data to validate
            stats: {
                totalTrades: closedWithExit.length,
                avgEvError: 0,
                evErrorVariance: 0,
                evErrorStdDev: 0,
                percentNearZero: 0,
            },
        };
    }
    
    // Collect EV errors
    const evErrors: number[] = [];
    const evErrorPcts: number[] = [];
    
    for (const trade of closedWithExit) {
        if (!trade.exit) continue;
        evErrors.push(trade.exit.evError);
        evErrorPcts.push(Math.abs(trade.exit.evErrorPct));
    }
    
    // Calculate statistics
    const avgEvError = evErrors.reduce((a, b) => a + b, 0) / evErrors.length;
    const avgEvErrorPct = evErrorPcts.reduce((a, b) => a + b, 0) / evErrorPcts.length;
    
    // Calculate variance and standard deviation
    const squaredDiffs = evErrors.map(e => Math.pow(e - avgEvError, 2));
    const evErrorVariance = squaredDiffs.reduce((a, b) => a + b, 0) / evErrors.length;
    const evErrorStdDev = Math.sqrt(evErrorVariance);
    
    // Count trades where error is suspiciously close to zero
    const nearZeroThreshold = 0.05; // 5% of position size
    const avgPositionSize = closedWithExit.reduce((sum, t) => sum + t.entry.positionSizeUSD, 0) / closedWithExit.length;
    const nearZeroCount = evErrors.filter(e => Math.abs(e) < avgPositionSize * nearZeroThreshold).length;
    const percentNearZero = nearZeroCount / evErrors.length;
    
    // Check for circular model warning
    let warning: string | undefined;
    let valid = true;
    
    // Warning conditions:
    // 1. Average error percentage is suspiciously low (< 1%)
    // 2. More than 80% of errors are near zero
    // 3. Standard deviation is very low relative to position sizes
    
    if (avgEvErrorPct < CIRCULAR_EV_THRESHOLD && closedWithExit.length >= MIN_TRADES_FOR_VARIANCE_CHECK) {
        warning = `[EV-WARN] EV model may be circular or underpowered — ` +
            `avgErrorPct=${(avgEvErrorPct * 100).toFixed(2)}% across ${closedWithExit.length} trades`;
        valid = false;
        logger.warn(warning);
    }
    
    if (percentNearZero > 0.80 && closedWithExit.length >= MIN_TRADES_FOR_VARIANCE_CHECK) {
        warning = `[EV-WARN] EV errors consistently near zero — ` +
            `${(percentNearZero * 100).toFixed(0)}% of trades have error < 5% of position size`;
        valid = false;
        logger.warn(warning);
    }
    
    return {
        valid,
        warning,
        stats: {
            totalTrades: closedWithExit.length,
            avgEvError,
            evErrorVariance,
            evErrorStdDev,
            percentNearZero,
        },
    };
}

/**
 * MODULE 5: Get detailed verification records for all closed trades
 */
export function getEVVerificationRecords(limit: number = 50): EVVerificationRecord[] {
    const closedWithExit = tradeTelemetryHistory.filter(t => t.exit).slice(-limit);
    
    return closedWithExit.map(trade => ({
        tradeId: trade.tradeId,
        poolAddress: trade.poolAddress,
        poolName: trade.poolName,
        
        expectedFeeUSD: trade.entry.expectedFeeUSD,
        expectedCostUSD: trade.entry.expectedCostUSD,
        expectedNetEVUSD: trade.entry.expectedNetEV,
        
        realizedFeesUSD: trade.exit!.realizedFeeUSD,
        realizedSlippageUSD: trade.exit!.realizedSlippageUSD,
        realizedNetPnLUSD: trade.exit!.netPnLUSD,
        
        evErrorUSD: trade.exit!.evError,
        evErrorPct: trade.exit!.evErrorPct,
        
        timestamp: trade.exit!.timestamp,
    }));
}

/**
 * MODULE 5: Log EV verification summary
 * Logs error distribution and warns if model appears problematic
 */
export function logEVVerificationSummary(): void {
    const verification = verifyEVModelValidity();
    const accuracy = getEVAccuracyStats();
    
    if (verification.stats.totalTrades < MIN_TRADES_FOR_VARIANCE_CHECK) {
        logger.info(`[EV-VERIFY] Insufficient trades for verification (${verification.stats.totalTrades}/${MIN_TRADES_FOR_VARIANCE_CHECK} required)`);
        return;
    }
    
    const emoji = verification.valid ? '✅' : '⚠️';
    
    logger.info(
        `[EV-VERIFY] ${emoji} Model Verification Summary\n` +
        `  totalTrades=${verification.stats.totalTrades}\n` +
        `  avgEvError=$${verification.stats.avgEvError.toFixed(2)}\n` +
        `  evErrorStdDev=$${verification.stats.evErrorStdDev.toFixed(2)}\n` +
        `  percentNearZero=${(verification.stats.percentNearZero * 100).toFixed(1)}%\n` +
        `  hitRate=${(accuracy.evHitRate * 100).toFixed(1)}%\n` +
        `  overestimates=${accuracy.overestimates} underestimates=${accuracy.underestimates}`
    );
    
    if (verification.warning) {
        logger.warn(verification.warning);
    }
}

/**
 * Get fee breakdown statistics
 */
export function getFeeBreakdownStats(): {
    totalRealizedFees: number;
    totalSlippage: number;
    avgFeePerTrade: number;
    avgSlippagePerTrade: number;
    feeToVolumeRatio: number;
} {
    const closedWithExit = tradeTelemetryHistory.filter(t => t.exit);
    
    if (closedWithExit.length === 0) {
        return {
            totalRealizedFees: 0,
            totalSlippage: 0,
            avgFeePerTrade: 0,
            avgSlippagePerTrade: 0,
            feeToVolumeRatio: 0,
        };
    }
    
    let totalFees = 0;
    let totalSlippage = 0;
    let totalVolume = 0;
    
    for (const trade of closedWithExit) {
        if (!trade.exit) continue;
        
        totalFees += trade.exit.realizedFeeUSD;
        totalSlippage += trade.exit.realizedSlippageUSD;
        totalVolume += trade.entry.positionSizeUSD;
    }
    
    return {
        totalRealizedFees: totalFees,
        totalSlippage,
        avgFeePerTrade: totalFees / closedWithExit.length,
        avgSlippagePerTrade: totalSlippage / closedWithExit.length,
        feeToVolumeRatio: totalVolume > 0 ? (totalFees + totalSlippage) / totalVolume : 0,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 5: POST-TRADE ATTRIBUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record Tier 5 Post-Trade Attribution on every closed trade.
 * This captures expected vs realized metrics for analysis.
 * 
 * Call this in recordTradeExit() after telemetry is updated.
 */
export function recordTier5PostTradeAttribution(
    tradeId: string,
    telemetry: TradeTelemetry
): Tier5PostTradeAttribution | null {
    if (!telemetry.exit) {
        return null;
    }
    
    const tier5 = telemetry.tier5;
    const entry = telemetry.entry;
    const exit = telemetry.exit;
    
    // Calculate deltas
    const feeDelta = exit.realizedFeeUSD - entry.expectedFeeUSD;
    const feeDeltaPct = entry.expectedFeeUSD > 0 
        ? feeDelta / entry.expectedFeeUSD 
        : 0;
    
    const costDelta = exit.realizedCostUSD - entry.expectedCostUSD;
    const costDeltaPct = entry.expectedCostUSD > 0 
        ? costDelta / entry.expectedCostUSD 
        : 0;
    
    // Determine aggression level context
    const aggressionLevel = tier5?.aggressionLevel ?? 'A0';
    const wasA2Plus = aggressionLevel === 'A2' || aggressionLevel === 'A3' || aggressionLevel === 'A4';
    const trancheIndex = tier5?.trancheIndex ?? 1;
    const wasTranche2Or3 = trancheIndex >= 2;
    
    const attribution: Tier5PostTradeAttribution = {
        tradeId,
        poolName: telemetry.poolName,
        closedAt: exit.timestamp,
        holdDurationMs: exit.holdDurationMs,
        
        // Expected vs Realized - Fees
        expectedFeeUsdAtEntry: entry.expectedFeeUSD,
        realizedFeesUsd: exit.realizedFeeUSD,
        feeDelta,
        feeDeltaPct,
        
        // Expected vs Realized - Costs
        expectedCostsUsdAtEntry: entry.expectedCostUSD,
        realizedCostsUsd: exit.realizedCostUSD,
        costDelta,
        costDeltaPct,
        
        // EV Error
        expectedNetEV: entry.expectedNetEV,
        realizedNetPnL: exit.netPnLUSD,
        evError: exit.evError,
        evErrorPct: exit.evErrorPct,
        
        // Tier 5 Entry Context
        wasA2Plus,
        aggressionLevel,
        wasTranche2Or3,
        trancheIndex,
        
        // Suppression Context
        holdSuppressionActive: tier5?.holdSuppressionActive ?? telemetry.wasInHoldMode,
        vshSuppressionActive: tier5?.vshSuppressionActive ?? false,
        
        // Outcome
        isWin: exit.netPnLUSD > 0,
    };
    
    // Add to history (rolling 50)
    tier5AttributionHistory.push(attribution);
    while (tier5AttributionHistory.length > MAX_ATTRIBUTION_HISTORY) {
        tier5AttributionHistory.shift();
    }
    
    // Log individual attribution
    const winEmoji = attribution.isWin ? '✅' : '❌';
    const aelEmoji = wasA2Plus ? '⚡' : '';
    const trancheStr = wasTranche2Or3 ? `T${trancheIndex}` : '';
    const suppressStr = (attribution.holdSuppressionActive ? 'HOLD' : '') + 
                        (attribution.vshSuppressionActive ? 'VSH' : '');
    
    logger.info(
        `[TIER5-ATTR] ${winEmoji} ${telemetry.poolName} ${aelEmoji}${aggressionLevel}${trancheStr} | ` +
        `expFee=$${entry.expectedFeeUSD.toFixed(2)} realFee=$${exit.realizedFeeUSD.toFixed(2)} (${feeDelta >= 0 ? '+' : ''}${(feeDeltaPct * 100).toFixed(0)}%) | ` +
        `expCost=$${entry.expectedCostUSD.toFixed(2)} realCost=$${exit.realizedCostUSD.toFixed(2)} | ` +
        `evErr=${exit.evError >= 0 ? '+' : ''}$${exit.evError.toFixed(2)} | ` +
        `${suppressStr ? `supp=${suppressStr}` : ''}`
    );
    
    // Log rolling 50-trade summary if we have enough data
    if (tier5AttributionHistory.length >= 10 && tier5AttributionHistory.length % 5 === 0) {
        logTier5AttributionSummary();
    }
    
    return attribution;
}

/**
 * Rolling 50-trade summary statistics
 */
export interface Tier5AttributionSummary {
    tradeCount: number;
    winRate: number;
    avgNetPnL: number;
    avgRealizedFees: number;
    avgRealizedSlippage: number;
    evErrorMean: number;
    evErrorStdDev: number;
    a2PlusShare: number;          // % of trades at A2+
    trancheAddsCount: number;     // Count of tranche 2/3 trades
    holdSuppressionCount: number;
    vshSuppressionCount: number;
}

/**
 * Compute rolling 50-trade summary
 */
export function getTier5AttributionSummary(): Tier5AttributionSummary {
    const trades = tier5AttributionHistory;
    const count = trades.length;
    
    if (count === 0) {
        return {
            tradeCount: 0,
            winRate: 0,
            avgNetPnL: 0,
            avgRealizedFees: 0,
            avgRealizedSlippage: 0,
            evErrorMean: 0,
            evErrorStdDev: 0,
            a2PlusShare: 0,
            trancheAddsCount: 0,
            holdSuppressionCount: 0,
            vshSuppressionCount: 0,
        };
    }
    
    // Calculate win rate
    const wins = trades.filter(t => t.isWin).length;
    const winRate = wins / count;
    
    // Calculate averages
    let totalNetPnL = 0;
    let totalFees = 0;
    let totalSlippage = 0;
    let totalEvError = 0;
    let a2PlusCount = 0;
    let trancheAddsCount = 0;
    let holdSuppressionCount = 0;
    let vshSuppressionCount = 0;
    
    for (const t of trades) {
        totalNetPnL += t.realizedNetPnL;
        totalFees += t.realizedFeesUsd;
        totalSlippage += t.realizedCostsUsd - t.realizedFeesUsd; // Slippage = total cost - fees
        totalEvError += t.evError;
        
        if (t.wasA2Plus) a2PlusCount++;
        if (t.wasTranche2Or3) trancheAddsCount++;
        if (t.holdSuppressionActive) holdSuppressionCount++;
        if (t.vshSuppressionActive) vshSuppressionCount++;
    }
    
    const avgNetPnL = totalNetPnL / count;
    const avgRealizedFees = totalFees / count;
    const avgRealizedSlippage = totalSlippage / count;
    const evErrorMean = totalEvError / count;
    const a2PlusShare = a2PlusCount / count;
    
    // Calculate EV error standard deviation
    let sumSquaredDiffs = 0;
    for (const t of trades) {
        sumSquaredDiffs += Math.pow(t.evError - evErrorMean, 2);
    }
    const evErrorStdDev = Math.sqrt(sumSquaredDiffs / count);
    
    return {
        tradeCount: count,
        winRate,
        avgNetPnL,
        avgRealizedFees,
        avgRealizedSlippage,
        evErrorMean,
        evErrorStdDev,
        a2PlusShare,
        trancheAddsCount,
        holdSuppressionCount,
        vshSuppressionCount,
    };
}

/**
 * Log rolling 50-trade summary
 * Format: [TIER5-ATTR] last50 winRate=… avgNet=… avgFee=… avgSlip=… EVerrorMean=… EVerrorStd=… A2+Share=… trancheAdds=…
 */
export function logTier5AttributionSummary(): void {
    const summary = getTier5AttributionSummary();
    
    if (summary.tradeCount < 5) {
        return; // Not enough data
    }
    
    logger.info(
        `[TIER5-ATTR] last${summary.tradeCount} ` +
        `winRate=${(summary.winRate * 100).toFixed(0)}% ` +
        `avgNet=${summary.avgNetPnL >= 0 ? '+' : ''}$${summary.avgNetPnL.toFixed(2)} ` +
        `avgFee=$${summary.avgRealizedFees.toFixed(2)} ` +
        `avgSlip=$${summary.avgRealizedSlippage.toFixed(2)} ` +
        `EVerrorMean=${summary.evErrorMean >= 0 ? '+' : ''}$${summary.evErrorMean.toFixed(2)} ` +
        `EVerrorStd=$${summary.evErrorStdDev.toFixed(2)} ` +
        `A2+Share=${(summary.a2PlusShare * 100).toFixed(0)}% ` +
        `trancheAdds=${summary.trancheAddsCount} ` +
        `holdSupp=${summary.holdSuppressionCount} vshSupp=${summary.vshSuppressionCount}`
    );
}

/**
 * Get attribution history for analysis
 */
export function getTier5AttributionHistory(): readonly Tier5PostTradeAttribution[] {
    return tier5AttributionHistory;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Clear all telemetry (for testing)
 */
export function clearTelemetry(): void {
    tradeTelemetryMap.clear();
    tradeTelemetryHistory.length = 0;
    entryEvaluations.length = 0;
    cycleSummaries.length = 0;
    tier5AttributionHistory.length = 0;
    currentCycleNumber = 0;
    cycleEntriesEvaluated = 0;
    cycleEntriesBlocked = 0;
    cycleEntriesExecuted = 0;
    cycleTotalExpectedEV = 0;
    logger.info('[TELEMETRY] All telemetry cleared');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// TELEMETRY_CONFIG is already exported at declaration

