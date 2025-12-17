/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SCAN LOOP — THE SOLE RUNTIME ORCHESTRATOR
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module is THE ONLY runtime loop in the system.
 * 
 * ARCHITECTURAL RULES:
 * 1. NO module-level mutable state
 * 2. All state is instance properties
 * 3. Only start() runs background loop logic
 * 4. Engine is a STATELESS executor - we invoke it, it never runs on its own
 * 5. Predator is ADVISORY ONLY - it suggests, we decide
 * 
 * ORCHESTRATION RESPONSIBILITIES:
 * - Fetch telemetry
 * - Score pools
 * - Enforce risk gates
 * - Enforce kill switch
 * - Invoke engine.placePools() for entries
 * - Invoke engine.executeExit() for exits
 * - Schedule next cycle
 * 
 * NO engine.update() calls. Engine has NO internal loops.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Pool } from '../core/normalizePools';
import { logAction } from '../db/supabase';
import logger from '../utils/logger';
import { deduplicatePools, isDuplicatePair } from '../utils/arbitrage';
import { ActivePosition, TokenType } from '../types';

import {
    getLiveDLMMState,
    recordSnapshot,
    getPoolHistory,
    logMicrostructureMetrics,
    registerPosition,
    evaluatePositionExit,
    getAlivePoolIds,
    fetchBatchTelemetry,
    cleanup as cleanupTelemetry,
} from '../services/dlmmTelemetry';

import {
    batchScorePools,
    Tier4EnrichedPool,
} from '../scoring/microstructureScoring';

import { discoverDLMMUniverses, enrichedPoolToPool, EnrichedPool } from '../services/dlmmIndexer';
import { 
    shouldRefreshDiscovery, 
    updateDiscoveryCache, 
    getCachedEnrichedPools,
    recordEntry,
    recordNoEntryCycle,
    updateRegime,
    setKillSwitch,
    getDiscoveryCacheStatus,
    PoolMeta,
    CachedEnrichedPool,
    DISCOVERY_REFRESH_MS,
} from '../services/discoveryCache';
import { enterPosition, hasActiveTrade, exitPosition } from '../core/trading';
import {
    evaluateKillSwitch, 
    KillSwitchContext, 
    PoolMetrics,
} from '../core/killSwitch';
import { evaluateMarketSentiment } from '../core/marketSentimentGate';

import {
    registerPool,
    evaluatePredatorEntry,
    registerPredatorTrade,
    handlePredatorExit,
    getPredatorReinjections,
    runPredatorCycle,
    logPredatorCycleSummary,
    clearPredatorState,
    computeMHI,
    getPredatorOpportunities,
    getStructuralExitSignals,
    PREDATOR_CONFIG,
    updateMHIRegime,
    resetVelocityAuditCycle,
} from '../engine/predatorController';
import { ExecutionEngine, ScoredPool, Position } from '../engine/ExecutionEngine';
import { capitalManager } from '../services/capitalManager';
import { loadActiveTradesFromDB, getAllActiveTrades } from '../db/models/Trade';
import {
    checkCapitalGating,
    assignRiskBatch,
    getAllowedPools,
    calculatePortfolioState,
    logPortfolioRiskSummary,
    PORTFOLIO_CONSTRAINTS,
    RiskTier,
    PoolRiskAssignment,
    ActivePosition as RiskActivePosition,
} from '../engine/riskBucketEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 STRATEGIC LAYERS — ADAPTIVE EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
import {
    evaluateEntryGating,
    shouldBlockEntry,
    getCombinedPositionMultiplier,
    shouldForceExitAllPositions,
    getActiveRegimeForLogging,
    createTradingStateFromMetrics,
    EntryGatingInputs,
} from '../capital/tier4EntryGating';

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 DOMINANT — EXPECTANCY-AWARE EXECUTION UPGRADE
// ═══════════════════════════════════════════════════════════════════════════════
import {
    // MODULE 1: EV Gating
    computeExpectedValue,
    passesEVGate,
    logEVGate,
    EV_CONFIG,
    EVResult,
    // MODULE 2: Fee-Harvest Hold Mode
    evaluateHoldMode,
    enterHoldMode,
    exitHoldMode,
    recordHoldFees,
    getPositionState,
    shouldSuppressExit,
    logHoldReject,
    cleanupHoldState,
    getHoldModeSummary,
    PositionState,
    HOLD_CONFIG,
    // MODULE 3: Aggression Scaling
    updateRegimeState as updateAggressionRegime,
    computeAggressionScaling,
    getRegimeAdjustedSize,
    logAggressionAdjustment,
    logAggressionSummary,
    AGGRESSION_CONFIG,
    // MODULE 4: Fee-Bleed Failsafe
    recordTradeOutcome,
    recordNoPositiveEVCycle,
    recordPositiveEVTrade,
    analyzeFeeBleed,
    isFeeBleedDefenseActive,
    getFeeBleedMultipliers,
    applyFeeBleedToEVRatio,
    applyFeeBleedToPositionSize,
    logFeeBleedStatus,
    FEE_BLEED_CONFIG,
    // MODULE 5: Expectancy Telemetry
    recordTradeEntry,
    recordTradeExit,
    recordEntryEvaluation,
    generateCycleSummary,
    logExpectancySummary,
    getHoldPositions,
    TELEMETRY_CONFIG,
    // TIER 5: Controlled Aggression
    // MODULE A: Opportunity Density Detector
    computeODS,
    hasActiveSpike,
    getActiveSpike,
    getAllActiveSpikes,
    getODSSummary,
    ODSResult,
    // MODULE B: Aggression Ladder
    evaluateAggressionLevel,
    getAggressionState,
    getAggressionMultipliers,
    isElevatedAggression,
    getAggressionSummary,
    assertAggressionInvariants,
    AggressionLevel,
    // MODULE C: Capital Concentration Engine
    updateEquity,
    evaluateConcentration,
    recordDeployment,
    recordExit as recordCCEExit,
    getPoolDeployedPercentage,
    getTotalDeployedPercentage,
    getDeploymentSummary,
    assertCCEInvariants,
    // MODULE D: Volatility Skew Harvester
    getVSHAdjustments,
    isVSHHarvesting,
    getVSHSummary,
    shouldVSHSuppressExit,
    // Tier 5 Telemetry
    recordTier5EntryData,
    logTier5Summary,
    isPortfolioConsistent,
    // Tier 5 Validation Summary
    logTier5ValidationSummary,
    getODDValidationStats,
    resetODDValidationStats,
    getTrancheAddStats,
    resetTrancheAddStats,
    getExitSuppressionStats,
    resetExitSuppressionStats,
    assertNoRiskExitsSuppressed,
    // Tier 5 Sizing Trace
    computeFinalEntrySizingBreakdown,
    logSizingTrace,
    getCurrentTrancheIndex,
    // Tier 5 Post-Trade Attribution
    updateTier5SuppressionFlags,
    logTier5AttributionSummary,
    // Pre-Entry Persistence Filter (PEPF)
    evaluatePreEntryPersistence,
    getPersistenceStats,
    resetPersistenceStats,
    logPersistenceSummary,
    recordPEPFEntryData,
    PreEntryPersistenceResult,
    // ═══════════════════════════════════════════════════════════════════════════
    // PORTFOLIO LEDGER — SINGLE SOURCE OF TRUTH
    // ═══════════════════════════════════════════════════════════════════════════
    initializeLedger,
    onPositionOpen,
    onPositionClose,
    onPositionUpdate,
    updateTotalCapital,
    getLedgerState,
    syncFromExternal,
    logLedgerState,
    assertLedgerInvariants,
    assertDeployedReflectsPositions,
    getDeployedPct,
    getAllTierExposures,
    getTierRemainingCapacity,
    getPortfolioRemainingCapacity,
    isLedgerInitialized,
    LedgerPosition,
    TierType,
    // MTM Valuation
    computePositionMtmUsd,
    createDefaultPriceFeed,
    createPositionForMtm,
    PoolStateForMTM,
    // Exit Hysteresis
    isRiskExit,
    shouldSuppressNoiseExit,
    recordSuppressionCheck,
    EXIT_CONFIG,
} from '../capital';
import {
    recordSuccessfulTx,
    recordFailedTx,
    getExecutionQuality,
} from '../execution/qualityOptimizer';
import {
    getActiveRegimePlaybook,
    createRegimeInputs,
    getActiveRegime,
    RegimeInputs,
} from '../regimes/playbooks';
import {
    recordCompletedTrade,
    getPoolSharpe,
    getSharpeRankedPools,
} from '../risk/poolSharpeMemory';
import {
    addDiscoveredPools,
    runUniverseMaintenance,
    filterPoolsThroughAdaptive,
    getAdaptivePoolSelection,
    isPoolAllowedForTrading,
} from '../discovery/adaptive';
import { TIER5_FEATURE_FLAGS, ENABLE_PEPF } from '../config/constants';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS (immutable, safe at module level)
// ═══════════════════════════════════════════════════════════════════════════════

const LOOP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MIN_HOLD_TIME_MS = 4 * 60 * 60 * 1000; // 4 hours
const EXECUTION_MIN_SCORE = 24;
const PERSISTENCE_LOG_INTERVAL = 60_000;
const STATUS_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';

// ═══════════════════════════════════════════════════════════════════════════════
// RISK ARCHITECTURE — SCANLOOP ENFORCED
// ═══════════════════════════════════════════════════════════════════════════════

// Position sizing rules
const RISK_MAX_EQUITY_PER_TRADE = 0.075;   // max 7.5% of equity per trade
const RISK_MAX_POOL_TVL_PCT = 0.03;        // max 3% of pool TVL
const RISK_HARD_MAX_SIZE = 2500;           // hard max $2500
const RISK_HARD_MIN_SIZE = 30;             // hard min $30

// Total portfolio exposure
const RISK_MAX_PORTFOLIO_EXPOSURE = 0.25;  // max 25% of equity deployed

// Per-tier exposure caps (% of equity)
const TIER_EXPOSURE_CAPS: Record<RiskTier, number> = {
    A: 0.10,  // 10%
    B: 0.08,  // 8%
    C: 0.05,  // 5%
    D: 0.00,  // 0% (blocked)
};

// ═══════════════════════════════════════════════════════════════════════════════
// POOL UNIVERSE LIMIT — PREVENTS OOM KILLS
// ═══════════════════════════════════════════════════════════════════════════════
// 
// CRITICAL: Discovery can return 800+ pools. Hydrating telemetry, scoring,
// and predator metadata for all of them causes RAM to exceed VPS limits.
// This limit is applied BEFORE any enrichment to prevent OOM.
//
// The limit slices pools sorted by base signal (TVL × velocity ratio).
// Only the top POOL_LIMIT pools are processed per cycle.
// ═══════════════════════════════════════════════════════════════════════════════

const POOL_LIMIT = parseInt(process.env.POOL_LIMIT || '50', 10);

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 4 STRATEGIC LAYERS — CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
const TIER4_ADAPTIVE_ENABLED = process.env.TIER4_ADAPTIVE !== 'false'; // Default enabled
const UNIVERSE_MAINTENANCE_INTERVAL = 60 * 60 * 1000; // 1 hour

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS (stateless, pure)
// ═══════════════════════════════════════════════════════════════════════════════

const categorizeToken = (pool: Pool): TokenType => {
    const name = pool.name.toUpperCase();
    if (name.includes('USDC') || name.includes('USDT') || name.includes('DAI')) {
        return 'stable';
    }
    const blueChips = ['SOL', 'BTC', 'WBTC', 'ETH', 'JUP', 'JLP', 'JITOSOL'];
    for (const token of blueChips) {
        if (name === token || name.startsWith(token + '-') || name.endsWith('-' + token)) {
            return 'blue-chip';
        }
    }
    return 'meme';
};

/**
 * Limit pool universe to prevent OOM.
 * Sorts by base signal (TVL × velocity ratio) and slices to POOL_LIMIT.
 * Called BEFORE any telemetry, scoring, or predator enrichment.
 */
const limitPoolUniverse = (pools: EnrichedPool[], limit: number): EnrichedPool[] => {
    if (pools.length <= limit) {
        return pools;
    }
    
    // Sort by base signal: TVL × velocityLiquidityRatio (higher = better)
    // This is a cheap pre-enrichment sort using discovery data only
    const sorted = [...pools].sort((a, b) => {
        const scoreA = (a.tvl || 0) * (a.velocityLiquidityRatio || 0);
        const scoreB = (b.tvl || 0) * (b.velocityLiquidityRatio || 0);
        return scoreB - scoreA;
    });
    
    const limited = sorted.slice(0, limit);
    
    logger.warn(`[POOL-LIMIT] ⚠️ Universe limited: ${pools.length} discovered → ${limited.length} processed (POOL_LIMIT=${limit})`);
    logger.info(`[POOL-LIMIT] Top pool: ${limited[0]?.symbol || limited[0]?.address?.slice(0, 8)} (TVL=$${((limited[0]?.tvl || 0) / 1000).toFixed(0)}k)`);
    
    return limited;
};

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN LOOP CLASS — THE SOLE RUNTIME ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

export class ScanLoop {
    // ═══════════════════════════════════════════════════════════════════════════
    // INSTANCE STATE
    // ═══════════════════════════════════════════════════════════════════════════
    
    private readonly engine: ExecutionEngine;
    private readonly engineId: string;
    private readonly intervalMs: number;
    
    private activePositions: ActivePosition[] = [];
    private trackedPoolAddresses: string[] = [];
    private botStartTime: number = 0;
    private totalSnapshotCount: number = 0;
    private lastPersistenceLogTime: number = 0;
    private lastStatusCheckTime: number = 0;
    
    private initializationComplete: boolean = false;
    private isScanning: boolean = false;
    private isRunning: boolean = false;
    private stopRequested: boolean = false;
    
    private loopTimeout: ReturnType<typeof setTimeout> | null = null;
    
    // Tier 4 Strategic Layers state
    private lastUniverseMaintenanceTime: number = 0;

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════
    
    constructor(engine: ExecutionEngine, engineId: string, intervalMs: number = LOOP_INTERVAL_MS) {
        this.engine = engine;
        this.engineId = engineId;
        this.intervalMs = intervalMs;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Start the scan loop - THE ONLY RUNTIME DRIVER
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('[SCAN-LOOP] Already running, ignoring start()');
            return;
        }
        
        this.isRunning = true;
        this.stopRequested = false;
        this.botStartTime = Date.now();
        this.lastStatusCheckTime = Date.now();
        
        // Load active trades from database
        const activeTrades = await loadActiveTradesFromDB();
        for (const trade of activeTrades) {
            this.activePositions.push({
                poolAddress: trade.pool,
                entryTime: trade.timestamp,
                entryScore: trade.score,
                entryPrice: trade.entryPrice,
                peakScore: trade.score,
                amount: trade.size,
                entryTVL: trade.liquidity,
                entryVelocity: trade.velocity,
                consecutiveCycles: 1,
                consecutiveLowVolumeCycles: 0,
                tokenType: 'meme',
                entryBin: trade.entryBin || 0,
            });
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // PORTFOLIO LEDGER INITIALIZATION — SINGLE SOURCE OF TRUTH
        // ═══════════════════════════════════════════════════════════════════════════
        try {
            const totalCapital = await capitalManager.getEquity();
            
            // Convert DB trades to LedgerPositions
            const ledgerPositions: LedgerPosition[] = activeTrades.map(trade => ({
                tradeId: trade.id,
                pool: trade.pool,
                poolName: trade.poolName || trade.pool.slice(0, 8),
                tier: this.determineTierFromScore(trade.score),
                notionalUsd: trade.size,
                openedAt: trade.timestamp,
            }));
            
            // Sync ledger from external DB state
            syncFromExternal(ledgerPositions, totalCapital, 0);
            
            // Update CCE equity for concentration calculations
            if (TIER5_FEATURE_FLAGS.ENABLE_CCE) {
                updateEquity(totalCapital);
            }
            
            logger.info(`[LEDGER] Initialized from DB: ${ledgerPositions.length} positions, $${totalCapital.toFixed(2)} capital`);
        } catch (err: any) {
            logger.error(`[LEDGER] Failed to initialize: ${err.message} — falling back to manual init`);
            // Fallback: initialize empty if capital manager unavailable
            if (!isLedgerInitialized()) {
                const fallbackCapital = parseFloat(process.env.PAPER_CAPITAL || '10000');
                initializeLedger(fallbackCapital);
            }
        }
        
        this.initializationComplete = true;
        
        logger.info('');
        logger.info('═══════════════════════════════════════════════════════════════════');
        logger.info('✅ SCAN LOOP INITIALIZED — SOLE RUNTIME DRIVER');
        logger.info(`   Engine: ${this.engineId} (STATELESS MODE)`);
        logger.info(`   Active Positions: ${this.activePositions.length}`);
        logger.info(`   Interval: ${this.intervalMs / 1000}s`);
        logger.info('   Engine has NO internal loops — ScanLoop orchestrates ALL');
        logger.info('═══════════════════════════════════════════════════════════════════');
        
        // Start the recursive loop
        await this.loop();
    }
    
    /**
     * Stop the scan loop gracefully
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            logger.info('[SCAN-LOOP] Not running, ignoring stop()');
            return;
        }
        
        logger.info('[SCAN-LOOP] 🛑 Stop requested, waiting for current cycle to complete...');
        this.stopRequested = true;
        
        // Cancel pending timeout
        if (this.loopTimeout) {
            clearTimeout(this.loopTimeout);
            this.loopTimeout = null;
        }
        
        // Wait for current scan to complete (if running)
        const maxWait = 60_000; // 60 seconds max wait
        const startWait = Date.now();
        
        while (this.isScanning && Date.now() - startWait < maxWait) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (this.isScanning) {
            logger.warn('[SCAN-LOOP] ⚠️ Force stopping after timeout');
        }
        
        this.isRunning = false;
        
        logger.info('[SCAN-LOOP] ✅ Stopped');
    }
    
    /**
     * Get current active positions (readonly)
     */
    getActivePositions(): readonly ActivePosition[] {
        return this.activePositions;
    }
    
    /**
     * Check if loop is currently running
     */
    isLoopRunning(): boolean {
        return this.isRunning;
    }
    
    /**
     * Cleanup resources - call after stop()
     */
    async cleanup(): Promise<void> {
        logger.info('[SCAN-LOOP] 🧹 Cleaning up resources...');
        
        // Cleanup telemetry
        cleanupTelemetry();
        
        // Clear predator state
        clearPredatorState();
        
        logger.info('[SCAN-LOOP] ✅ Cleanup complete');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: RECURSIVE LOOP
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Recursive async loop - waits for completion before scheduling next
     */
    private async loop(): Promise<void> {
        if (this.stopRequested) {
            logger.info('[SCAN-LOOP] Loop exiting due to stop request');
            return;
        }
        
        // Run the scan cycle
        await this.runScanCycle();
        
        // Schedule next iteration only if not stopped
        if (!this.stopRequested && this.isRunning) {
            this.loopTimeout = setTimeout(() => this.loop(), this.intervalMs);
        }
    }
    
    /**
     * Run a single scan cycle with overlap protection
     */
    private async runScanCycle(): Promise<void> {
        if (this.isScanning) {
            logger.warn('⏳ Previous scan still running, skipping');
            return;
        }
        
        this.isScanning = true;
        
        try {
            await this.scanCycle();
        } catch (error: any) {
            logger.error(`❌ Scan error: ${error?.message || error}`);
        } finally {
            this.isScanning = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: TELEMETRY HELPERS
    // ═══════════════════════════════════════════════════════════════════════════
    
    private async refreshTelemetry(): Promise<void> {
        if (this.trackedPoolAddresses.length === 0) {
            logger.debug('[TELEMETRY] No pools to refresh');
            return;
        }
        try {
            const telemetryArray = await fetchBatchTelemetry(this.trackedPoolAddresses);
            for (const telemetry of telemetryArray) {
                recordSnapshot(telemetry);
            }
            logger.debug(`[TELEMETRY] Refreshed ${telemetryArray.length}/${this.trackedPoolAddresses.length} pools via SDK`);
        } catch (error) {
            logger.error('[TELEMETRY] SDK refresh failed:', error);
        }
    }
    
    private updateTrackedPools(addresses: string[]): void {
        this.trackedPoolAddresses = addresses;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: POSITION HEALTH CHECK (REPLACES engine.update())
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Evaluate all open positions and exit if needed.
     * THIS REPLACES engine.update() - ScanLoop is now the orchestrator.
     */
    private async evaluateAndExitPositions(scoredPools: ScoredPool[]): Promise<void> {
        // Update pool queue in engine for price updates
        this.engine.updatePoolQueue(scoredPools);
        
        // Get open positions from engine
        const openPositions = this.engine.getOpenPositions();
        
        for (const position of openPositions) {
            // Evaluate position health
            const healthEval = this.engine.evaluatePositionHealth(position.id);
            
            if (healthEval.shouldExit) {
                // ScanLoop decides to exit - invoke engine
                logger.info(`[SCAN-LOOP] Exit signal for ${position.pool.slice(0, 8)}... - ${healthEval.exitType}: ${healthEval.exitReason}`);
                
                const exited = await this.engine.executeExit(
                    position.id,
                    healthEval.exitReason,
                    `SCAN_LOOP_${healthEval.exitType}`
                );
                
                if (exited) {
                    // Remove from our tracking
                    this.activePositions = this.activePositions.filter(
                        ap => ap.poolAddress !== position.pool
                    );
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: ROTATION MANAGER — SCANLOOP RISK GATING
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Calculate current exposure by tier — NOW USES PORTFOLIO LEDGER
     * 
     * @deprecated Internal tracking replaced by getLedgerState().perTier
     */
    private calculateTierExposure(equity: number): Record<RiskTier, number> {
        // Use ledger as single source of truth
        if (isLedgerInitialized()) {
            return getAllTierExposures();
        }
        
        // Fallback to manual calculation if ledger not ready
        const exposure: Record<RiskTier, number> = { A: 0, B: 0, C: 0, D: 0 };
        
        for (const pos of this.activePositions) {
            // Determine tier from entry score
            let tier: RiskTier = 'C';
            if (pos.entryScore >= 40) tier = 'A';
            else if (pos.entryScore >= 32) tier = 'B';
            else if (pos.entryScore >= 24) tier = 'C';
            else tier = 'D';
            
            exposure[tier] += pos.amount;
        }
        
        // Convert to percentage of equity
        return {
            A: exposure.A / equity,
            B: exposure.B / equity,
            C: exposure.C / equity,
            D: exposure.D / equity,
        };
    }
    
    /**
     * Calculate total portfolio exposure as % of equity — NOW USES PORTFOLIO LEDGER
     * 
     * @deprecated Internal tracking replaced by getDeployedPct()
     */
    private calculateTotalExposure(equity: number): number {
        // Use ledger as single source of truth
        if (isLedgerInitialized()) {
            return getDeployedPct();
        }
        
        // Fallback to manual calculation if ledger not ready
        const totalDeployed = this.activePositions.reduce((sum, pos) => sum + pos.amount, 0);
        return totalDeployed / equity;
    }
    
    /**
     * Determine tier for a pool based on microScore
     */
    private determineTier(microScore: number): RiskTier {
        if (microScore >= 40) return 'A';
        if (microScore >= 32) return 'B';
        if (microScore >= 24) return 'C';
        return 'D';
    }
    
    /**
     * Determine tier from score (for ledger position typing)
     */
    private determineTierFromScore(score: number): TierType {
        if (score >= 40) return 'A';
        if (score >= 32) return 'B';
        if (score >= 24) return 'C';
        return 'D';
    }
    
    /**
     * Calculate position size with all risk constraints
     * Returns { size, blocked, reason }
     */
    private calculatePositionSize(
        pool: Tier4EnrichedPool,
        equity: number,
        balance: number,
        tier: RiskTier,
        tierExposure: Record<RiskTier, number>,
        totalExposure: number
    ): { size: number; blocked: boolean; reason: string } {
        const poolName = pool.name;
        const poolTVL = pool.liquidity || 0;
        
        // ═══════════════════════════════════════════════════════════════════
        // TIER D BLOCKED
        // ═══════════════════════════════════════════════════════════════════
        if (tier === 'D') {
            return { size: 0, blocked: true, reason: 'tier D blocked (score < 24)' };
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // CHECK TOTAL PORTFOLIO EXPOSURE (25% max)
        // ═══════════════════════════════════════════════════════════════════
        if (totalExposure >= RISK_MAX_PORTFOLIO_EXPOSURE) {
            return { size: 0, blocked: true, reason: `portfolio exposure ${(totalExposure * 100).toFixed(1)}% >= ${RISK_MAX_PORTFOLIO_EXPOSURE * 100}% max` };
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // CHECK TIER EXPOSURE CAP
        // ═══════════════════════════════════════════════════════════════════
        const tierCap = TIER_EXPOSURE_CAPS[tier];
        if (tierExposure[tier] >= tierCap) {
            return { size: 0, blocked: true, reason: `tier ${tier} exposure ${(tierExposure[tier] * 100).toFixed(1)}% >= ${tierCap * 100}% cap` };
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // CALCULATE SIZE WITH CONSTRAINTS
        // ═══════════════════════════════════════════════════════════════════
        
        // Start with max of 7.5% equity
        let size = equity * RISK_MAX_EQUITY_PER_TRADE;
        
        // Cap at 3% of pool TVL
        if (poolTVL > 0) {
            const tvlCap = poolTVL * RISK_MAX_POOL_TVL_PCT;
            if (tvlCap < size) {
                size = tvlCap;
            }
        }
        
        // Hard max $2500
        if (size > RISK_HARD_MAX_SIZE) {
            size = RISK_HARD_MAX_SIZE;
        }
        
        // Cap to remaining tier capacity
        const remainingTierCapacity = (tierCap - tierExposure[tier]) * equity;
        if (remainingTierCapacity < size) {
            size = remainingTierCapacity;
        }
        
        // Cap to remaining portfolio capacity
        const remainingPortfolioCapacity = (RISK_MAX_PORTFOLIO_EXPOSURE - totalExposure) * equity;
        if (remainingPortfolioCapacity < size) {
            size = remainingPortfolioCapacity;
        }
        
        // Cap to available balance
        if (size > balance) {
            size = balance;
        }
        
        // Hard min $30
        if (size < RISK_HARD_MIN_SIZE) {
            return { size: 0, blocked: true, reason: `calculated size $${size.toFixed(0)} < $${RISK_HARD_MIN_SIZE} min` };
        }
        
        return { size: Math.floor(size), blocked: false, reason: '' };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TIER 4 STRATEGIC LAYERS — HELPER METHODS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Create trading state from pool metrics for Tier 4 gating
     */
    private createTradingStateFromPool(pool: Tier4EnrichedPool): {
        entropy_score: number;
        liquidityFlow_score: number;
        migrationDirection_confidence: number;
        consistency_score: number;
        velocity_score: number;
        execution_quality: number;
    } {
        const microMetrics = pool.microMetrics;
        
        // Compute migration confidence from slope magnitude
        const migrationConfidence = Math.min(1, Math.abs(pool.liquiditySlope ?? 0) * 10);
        
        // Use consistencyScore (0-100) normalized to 0-1
        const consistencyNormalized = (pool.consistencyScore ?? 50) / 100;
        
        return {
            entropy_score: microMetrics?.poolEntropy ?? 0.5,
            liquidityFlow_score: Math.min(1, Math.abs(pool.liquiditySlope ?? 0) / 0.1),
            migrationDirection_confidence: migrationConfidence,
            consistency_score: consistencyNormalized,
            velocity_score: Math.min(1, (pool.velocity || 0) / 100),
            execution_quality: getExecutionQuality().score,
        };
    }
    
    /**
     * Create regime inputs from pool metrics
     */
    private createRegimeInputsFromPool(pool: Tier4EnrichedPool): RegimeInputs {
        const tradingState = this.createTradingStateFromPool(pool);
        const microMetrics = pool.microMetrics;
        
        // Compute migration confidence from slope magnitude
        const migrationConfidence = Math.min(1, Math.abs(pool.liquiditySlope ?? 0) * 10);
        
        // Use consistencyScore (0-100) normalized to 0-1
        const consistencyNormalized = (pool.consistencyScore ?? 50) / 100;
        
        return createRegimeInputs(
            pool.velocitySlope ?? 0,
            pool.liquiditySlope ?? 0,
            pool.entropySlope ?? 0,
            microMetrics?.poolEntropy ?? 0.5,
            pool.velocity ?? 0,
            migrationConfidence,
            consistencyNormalized,
            microMetrics?.feeIntensity ?? 0.05,
            tradingState.execution_quality
        );
    }
    
    /**
     * Run Tier 4 universe maintenance
     */
    private runTier4Maintenance(): void {
        if (!TIER4_ADAPTIVE_ENABLED) return;
        
        const now = Date.now();
        if (now - this.lastUniverseMaintenanceTime < UNIVERSE_MAINTENANCE_INTERVAL) return;
        
        const result = runUniverseMaintenance();
        this.lastUniverseMaintenanceTime = now;
        
        if (result.permanentlyRemoved > 0 || result.expired > 0) {
            logger.info(`[TIER4-MAINTENANCE] Removed ${result.permanentlyRemoved} blocked, expired ${result.expired} stale pools`);
        }
    }
    
    /**
     * Evaluate Tier 4 entry gating for a pool
     */
    private evaluateTier4Entry(
        pool: Tier4EnrichedPool,
        baseSize: number,
        equity: number
    ): { allowed: boolean; finalSize: number; blockReason?: string } {
        if (!TIER4_ADAPTIVE_ENABLED) {
            return { allowed: true, finalSize: baseSize };
        }
        
        const tradingState = this.createTradingStateFromPool(pool);
        const regimeInputs = this.createRegimeInputsFromPool(pool);
        
        const gatingInputs: EntryGatingInputs = {
            poolAddress: pool.address,
            poolName: pool.name,
            tradingState,
            migrationDirection: pool.migrationDirection as 'in' | 'out' | 'neutral' | undefined,
            regimeInputs,
            basePositionSize: baseSize,
            openPositionCount: this.activePositions.length,
            totalEquity: equity,
        };
        
        const result = evaluateEntryGating(gatingInputs);
        
        if (!result.allowed) {
            logger.info(`[TIER4-GATE] ${pool.name} blocked by ${result.blockedBy}: ${result.blockReason}`);
        }
        
        return {
            allowed: result.allowed,
            finalSize: result.finalPositionSize,
            blockReason: result.blockReason,
        };
    }
    
    private async manageRotation(rankedPools: Tier4EnrichedPool[]): Promise<number> {
        const now = Date.now();
        const remainingPositions: ActivePosition[] = [];
        let exitSignalCount = 0;

        let currentBalance: number;
        try {
            currentBalance = await capitalManager.getBalance();
        } catch (err: any) {
            logger.error(`[ROTATION] Failed to get capital: ${err.message}`);
            return 0;
        }

        // Check exits
        for (const pos of this.activePositions) {
            const pool = rankedPools.find(p => p.address === pos.poolAddress);
            if (!pool) {
                remainingPositions.push(pos);
                continue;
            }

            const holdTime = now - pos.entryTime;
            if (pool.score > pos.peakScore) {
                pos.peakScore = pool.score;
            }

            // Microstructure exit check
            const exitSignal = evaluatePositionExit(pos.poolAddress);
            if (exitSignal?.shouldExit) {
                const activeTrades = getAllActiveTrades();
                const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                if (trade) {
                    // ═══════════════════════════════════════════════════════════════
                    // EXIT HYSTERESIS — SUPPRESS NOISE EXITS IF NOT READY
                    // Microstructure exits are NOISE exits (can be suppressed)
                    // ═══════════════════════════════════════════════════════════════
                    if (!isRiskExit(exitSignal.reason)) {
                        const holdTimeMs = now - pos.entryTime;
                        
                        // Quick check: if too young, definitely suppress
                        if (holdTimeMs < EXIT_CONFIG.minHoldMsNoiseExit) {
                            const holdTimeMin = Math.floor(holdTimeMs / 60000);
                            const minHoldMin = Math.floor(EXIT_CONFIG.minHoldMsNoiseExit / 60000);
                            logger.info(
                                `[EXIT-SUPPRESS] reason=MIN_HOLD pool=${pool.name} ` +
                                `holdTime=${holdTimeMin}min < minHold=${minHoldMin}min ` +
                                `trigger="${exitSignal.reason}"`
                            );
                            remainingPositions.push(pos);
                            continue;
                        }
                    }
                    
                    // ═══════════════════════════════════════════════════════════════
                    // MODULE 2: CHECK HOLD MODE EXIT SUPPRESSION
                    // Positions in HOLD mode may suppress certain exit signals
                    // ═══════════════════════════════════════════════════════════════
                    const suppressResult = shouldSuppressExit(trade.id, exitSignal.reason);
                    if (suppressResult.suppress) {
                        logger.info(`[HOLD-SUPPRESS] ${pool.name} - ${suppressResult.reason}`);
                        remainingPositions.push(pos);
                        continue;
                    }
                    
                    // ═══════════════════════════════════════════════════════════════
                    // TIER 5: VSH EXIT SUPPRESSION HINT
                    // VSH provides advisory suppression - HOLD module decides
                    // ═══════════════════════════════════════════════════════════════
                    if (TIER5_FEATURE_FLAGS.ENABLE_CONTROLLED_AGGRESSION && TIER5_FEATURE_FLAGS.ENABLE_VSH) {
                        const vshSuppressResult = shouldVSHSuppressExit(pos.poolAddress, exitSignal.reason);
                        if (vshSuppressResult.suggest) {
                            // VSH suggests suppression, but we defer to HOLD module's judgment
                            // Log for observability but don't force suppression
                            logger.debug(`[VSH-SUPPRESS-HINT] ${pool.name} - ${vshSuppressResult.reason}`);
                        }
                    }
                    
                    const exitResult = await exitPosition(trade.id, {
                        exitPrice: pool.currentPrice,
                        reason: `MICROSTRUCTURE: ${exitSignal.reason}`,
                    }, 'MICROSTRUCTURE_EXIT');
                    if (exitResult.success) {
                        logger.warn(`[MICRO-EXIT] ${pool.name} - ${exitSignal.reason}`);
                        exitSignalCount++;
                        const mhiResult = computeMHI(pos.poolAddress);
                        handlePredatorExit(trade.id, pos.poolAddress, pool.name,
                            `MICROSTRUCTURE: ${exitSignal.reason}`, exitResult.pnl ?? 0,
                            (exitResult.pnl ?? 0) / pos.amount, mhiResult?.mhi,
                            pool.microMetrics?.poolEntropy);
                        
                        // Record trade exit telemetry
                        const holdState = getPositionState(trade.id);
                        recordTradeExit({
                            tradeId: trade.id,
                            realizedFeeUSD: exitResult.trade?.execution?.exitFeesPaid ?? 0,
                            realizedSlippageUSD: exitResult.trade?.execution?.exitSlippageUsd ?? 0,
                            grossPnLUSD: (exitResult.pnl ?? 0) + (exitResult.trade?.execution?.exitFeesPaid ?? 0),
                            netPnLUSD: exitResult.pnl ?? 0,
                            exitReason: `MICROSTRUCTURE: ${exitSignal.reason}`,
                            wasInHoldMode: holdState === 'HOLD',
                            holdModeFees: 0, // TODO: Get from hold state
                        });
                        
                        // Clean up hold state
                        cleanupHoldState(trade.id);
                        
                        // TIER 5: Record CCE exit
                        if (TIER5_FEATURE_FLAGS.ENABLE_CONTROLLED_AGGRESSION && TIER5_FEATURE_FLAGS.ENABLE_CCE) {
                            recordCCEExit(pos.poolAddress, pos.amount, trade.id);
                        }
                        
                        // ═══════════════════════════════════════════════════════════════
                        // PORTFOLIO LEDGER: Record position close
                        // ═══════════════════════════════════════════════════════════════
                        if (isLedgerInitialized()) {
                            onPositionClose(trade.id);
                        }
                    }
                }
                continue;
            }

            // Min hold time check - ENFORCED BY SCANLOOP, NOT ENGINE
            const bypassMinHold = pos.entryScore < 55;
            if (holdTime < MIN_HOLD_TIME_MS && !bypassMinHold) {
                remainingPositions.push(pos);
                continue;
            }

            // Emergency exit
            const scoreCrash = pos.entryScore > 0 ? (pos.entryScore - pool.score) / pos.entryScore : 0;
            const emergencyExit = pool.score < 15 || scoreCrash > 0.50;
            if (emergencyExit) {
                const reason = pool.score < 15 ? 'Emergency: Score Below 15' : 'Emergency: Score Crash (-50%)';
                const activeTrades = getAllActiveTrades();
                const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                if (trade) {
                    const exitResult = await exitPosition(trade.id, { exitPrice: pool.currentPrice, reason }, 'EMERGENCY_EXIT');
                    if (exitResult.success) {
                        logger.warn(`[EMERGENCY] ${pool.name} - ${reason}`);
                        exitSignalCount++;
                        
                        // PORTFOLIO LEDGER: Record position close
                        if (isLedgerInitialized()) {
                            onPositionClose(trade.id);
                        }
                    }
                }
                continue;
            }

            remainingPositions.push(pos);
        }

        // Market crash detection
        if (exitSignalCount >= 3 && this.activePositions.length >= 3) {
            logger.warn(`MARKET CRASH DETECTED: ${exitSignalCount} pools triggering exit.`);
            for (const pos of remainingPositions) {
                const activeTrades = getAllActiveTrades();
                const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                if (trade) {
                    await exitPosition(trade.id, { exitPrice: 0, reason: 'MARKET_CRASH_EXIT' }, 'MARKET_CRASH');
                    
                    // PORTFOLIO LEDGER: Record position close
                    if (isLedgerInitialized()) {
                        onPositionClose(trade.id);
                    }
                }
            }
            this.activePositions = [];
            return 0;
        }

        this.activePositions = remainingPositions;

        // ═══════════════════════════════════════════════════════════════════════════
        // SCANLOOP RISK GATING — ALL DECISIONS MADE HERE
        // ═══════════════════════════════════════════════════════════════════════════

        let rotationBalance: number, rotationEquity: number;
        try {
            rotationBalance = await capitalManager.getBalance();
            rotationEquity = await capitalManager.getEquity();
        } catch (err: any) {
            logger.error(`[ROTATION] Failed to get capital: ${err.message}`);
            return 0;
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // PORTFOLIO LEDGER: Update total capital from external source
        // ═══════════════════════════════════════════════════════════════════════════
        if (isLedgerInitialized()) {
            updateTotalCapital(rotationEquity);
        }

        // Calculate current exposures FROM LEDGER (single source of truth)
        const tierExposure = this.calculateTierExposure(rotationEquity);
        const totalExposure = this.calculateTotalExposure(rotationEquity);
        
        // Log portfolio risk state — VALUES FROM LEDGER
        if (isLedgerInitialized()) {
            const ledgerState = getLedgerState();
            const deployedPct = ledgerState.totalCapitalUsd > 0 
                ? (ledgerState.deployedUsd / ledgerState.totalCapitalUsd) * 100 
                : 0;
            const remainingCapacity = getPortfolioRemainingCapacity(RISK_MAX_PORTFOLIO_EXPOSURE);
            
            logger.info(
                `[RISK] Portfolio: ${deployedPct.toFixed(1)}%/${(RISK_MAX_PORTFOLIO_EXPOSURE * 100).toFixed(0)}% deployed | ` +
                `Balance: $${ledgerState.availableUsd.toFixed(0)} | ` +
                `Equity: $${ledgerState.totalCapitalUsd.toFixed(0)} | ` +
                `Remaining: $${remainingCapacity.toFixed(0)}`
            );
            logger.info(
                `[RISK] Tier exposure: ` +
                `A=${(tierExposure.A * 100).toFixed(1)}%/${(TIER_EXPOSURE_CAPS.A * 100).toFixed(0)}% ` +
                `B=${(tierExposure.B * 100).toFixed(1)}%/${(TIER_EXPOSURE_CAPS.B * 100).toFixed(0)}% ` +
                `C=${(tierExposure.C * 100).toFixed(1)}%/${(TIER_EXPOSURE_CAPS.C * 100).toFixed(0)}%`
            );
            
            // ═══════════════════════════════════════════════════════════════════════════
            // DEV-ONLY ASSERTION: Verify deployed% reflects open positions
            // If open positions exist but deployed=0, ledger is not being updated
            // ═══════════════════════════════════════════════════════════════════════════
            assertDeployedReflectsPositions(remainingPositions.length);
        } else {
            // Fallback logging if ledger not initialized
            logger.info(`[RISK] Portfolio: ${(totalExposure * 100).toFixed(1)}%/${(RISK_MAX_PORTFOLIO_EXPOSURE * 100).toFixed(0)}% deployed | Balance: $${rotationBalance.toFixed(0)} | Equity: $${rotationEquity.toFixed(0)}`);
            logger.info(`[RISK] Tier exposure: A=${(tierExposure.A * 100).toFixed(1)}%/${(TIER_EXPOSURE_CAPS.A * 100).toFixed(0)}% B=${(tierExposure.B * 100).toFixed(1)}%/${(TIER_EXPOSURE_CAPS.B * 100).toFixed(0)}% C=${(tierExposure.C * 100).toFixed(1)}%/${(TIER_EXPOSURE_CAPS.C * 100).toFixed(0)}%`);
        }

        // Check if we have capital to trade
        if (rotationBalance < RISK_HARD_MIN_SIZE) {
            logger.warn(`[ENTRY-REJECT] insufficient balance $${rotationBalance.toFixed(0)} < $${RISK_HARD_MIN_SIZE} min`);
            return 0;
        }

        // Get candidate pools (advisory from risk bucket engine)
        const riskActivePositions: RiskActivePosition[] = this.activePositions.map(pos => {
            const pool = rankedPools.find(p => p.address === pos.poolAddress);
            const microScore = pool?.microScore ?? pos.entryScore;
            const tier = this.determineTier(microScore);
            return { poolAddress: pos.poolAddress, tier, size: pos.amount, entryScore: pos.entryScore };
        });

        const portfolioState = calculatePortfolioState(rotationEquity, rotationBalance, riskActivePositions);
        logPortfolioRiskSummary(portfolioState);

        const poolsForRiskAssignment = rankedPools
            .filter(p => p.hasValidTelemetry && p.isMarketAlive)
            .filter(p => !this.activePositions.find(ap => ap.poolAddress === p.address))
            .map(p => ({
                address: p.address, name: p.name, microScore: p.microScore,
                liquiditySlope: (p as any).liquiditySlope ?? 0,
            }));

        // Get advisory assignments from risk bucket engine
        const riskAssignments = assignRiskBatch(poolsForRiskAssignment, rotationEquity, rotationBalance, riskActivePositions);
        const allowedAssignments = getAllowedPools(riskAssignments);

        // ═══════════════════════════════════════════════════════════════════════════
        // SCANLOOP FINAL GATING — ITERATE CANDIDATES WITH FULL RISK CHECKS
        // ═══════════════════════════════════════════════════════════════════════════
        
        let entriesThisCycle = 0;
        let availableBalance = rotationBalance;
        let currentTierExposure = { ...tierExposure };
        let currentTotalExposure = totalExposure;

        for (const assignment of allowedAssignments) {
            const pool = rankedPools.find(p => p.address === assignment.poolAddress);
            if (!pool) continue;

            const poolName = pool.name;
            const tier = this.determineTier(pool.microScore);
            
            // ═══════════════════════════════════════════════════════════════
            // CHECK: Already have active trade
            // ═══════════════════════════════════════════════════════════════
            if (hasActiveTrade(pool.address)) {
                continue; // Silent skip - already in position
            }

            // ═══════════════════════════════════════════════════════════════
            // CHECK: Duplicate pair
            // ═══════════════════════════════════════════════════════════════
            const activePools = this.activePositions.map(pos => 
                rankedPools.find(p => p.address === pos.poolAddress)
            ).filter((p): p is Tier4EnrichedPool => p !== undefined);

            if (isDuplicatePair(pool, activePools)) {
                logger.info(`[ENTRY-BLOCK] ${poolName} duplicate pair with existing position`);
                continue;
            }

            // ═══════════════════════════════════════════════════════════════
            // CHECK: Predator advisory (ADVISORY ONLY)
            // ═══════════════════════════════════════════════════════════════
            const predatorEval = evaluatePredatorEntry(pool.address, pool.name);
            if (!predatorEval.canEnter) {
                logger.info(`[ENTRY-BLOCK] ${poolName} predator advisory: ${predatorEval.blockedReasons.join(', ')}`);
                continue;
            }

            // ═══════════════════════════════════════════════════════════════
            // SCANLOOP RISK CALCULATION — FINAL DECISION
            // ═══════════════════════════════════════════════════════════════
            const sizeResult = this.calculatePositionSize(
                pool,
                rotationEquity,
                availableBalance,
                tier,
                currentTierExposure,
                currentTotalExposure
            );

            if (sizeResult.blocked) {
                logger.info(`[ENTRY-BLOCK] ${poolName} ${sizeResult.reason}`);
                continue;
            }

            const finalSize = Math.floor(sizeResult.size * predatorEval.finalSizeMultiplier);
            
            // Re-check minimum after predator adjustment
            if (finalSize < RISK_HARD_MIN_SIZE) {
                logger.info(`[ENTRY-BLOCK] ${poolName} size after MHI adjustment $${finalSize} < $${RISK_HARD_MIN_SIZE} min`);
                continue;
            }
            
            // ═══════════════════════════════════════════════════════════════
            // TIER 4 STRATEGIC GATING — FINAL CHECK
            // ═══════════════════════════════════════════════════════════════
            const tier4Result = this.evaluateTier4Entry(pool, finalSize, rotationEquity);
            if (!tier4Result.allowed) {
                logger.info(`[ENTRY-BLOCK] ${poolName} Tier4 gate: ${tier4Result.blockReason}`);
                continue;
            }
            
            // Use Tier4-adjusted final size
            let tier4FinalSize = tier4Result.finalSize;
            if (tier4FinalSize < RISK_HARD_MIN_SIZE) {
                logger.info(`[ENTRY-BLOCK] ${poolName} Tier4 size $${tier4FinalSize} < $${RISK_HARD_MIN_SIZE} min`);
                continue;
            }
            
            // ═══════════════════════════════════════════════════════════════
            // MODULE 1: EXPECTED VALUE (EV) GATING — CRITICAL FILTER
            // Block low-expectancy trades before execution
            // ═══════════════════════════════════════════════════════════════
            const evResult = computeExpectedValue({
                pool,
                positionSizeUSD: tier4FinalSize,
                regime: pool.regime,
            });
            
            // Log EV gate evaluation
            logEVGate(poolName, evResult);
            
            // Record evaluation for telemetry
            recordEntryEvaluation({
                poolAddress: pool.address,
                poolName,
                regime: pool.regime,
                expectedFeeUSD: evResult.expectedFeeRevenueUSD,
                expectedCostUSD: evResult.expectedTotalCostsUSD,
                expectedNetEV: evResult.expectedNetEVUSD,
                passed: evResult.canEnter,
                blockReason: evResult.blockReason,
            });
            
            if (!evResult.canEnter) {
                logger.info(`[ENTRY-BLOCK] ${poolName} EV gate: ${evResult.blockReason}`);
                continue;
            }
            
            // ═══════════════════════════════════════════════════════════════
            // PRE-ENTRY PERSISTENCE FILTER (PEPF)
            // Block entries where EV is positive only for single snapshot
            // Order: EV gate → PEPF → Tier-5 (ODD/AEL/CCE/VSH) → sizing → execute
            // ═══════════════════════════════════════════════════════════════
            let pepfResult: PreEntryPersistenceResult | null = null;
            
            if (ENABLE_PEPF) {
                pepfResult = evaluatePreEntryPersistence({
                    pool,
                    evResult,
                    positionSizeUSD: tier4FinalSize,
                    regime: pool.regime,
                });
                
                if (pepfResult.blocked) {
                    logger.info(`[ENTRY-BLOCK] ${poolName} PEPF: ${pepfResult.blockReason} - ${pepfResult.blockReasonDetail}`);
                    // No aggression escalation, no tranche adds - just skip
                    continue;
                }
            }
            
            // ═══════════════════════════════════════════════════════════════
            // TIER 5: CONTROLLED AGGRESSION — OPPORTUNITY DENSITY EVALUATION
            // Detect rare edge density spikes for aggressive execution
            // ═══════════════════════════════════════════════════════════════
            let odsResult: ODSResult | null = null;
            let aggressionLevel: AggressionLevel = 'A0';
            let concentrationResult: ReturnType<typeof evaluateConcentration> | null = null;
            let vshAdjustments: ReturnType<typeof getVSHAdjustments> | null = null;
            
            if (TIER5_FEATURE_FLAGS.ENABLE_CONTROLLED_AGGRESSION) {
                // Update equity for CCE
                updateEquity(rotationEquity);
                
                // Step 1: Opportunity Density Evaluation (ODD)
                if (TIER5_FEATURE_FLAGS.ENABLE_ODD) {
                    odsResult = computeODS(pool, evResult.canEnter);
                }
                
                // Step 2: VSH Evaluation for eligibility
                if (TIER5_FEATURE_FLAGS.ENABLE_VSH) {
                    vshAdjustments = getVSHAdjustments(pool, evResult.canEnter);
                }
                
                // Step 3: Aggression Ladder Update (AEL)
                const feeIntensity = (pool.microMetrics?.feeIntensity ?? 0) / 100;
                const migrationSlope = (pool as any).liquiditySlope ?? 0;
                const churnQuality = odsResult?.components.raw_churnQuality ?? 0;
                
                const aggressionState = evaluateAggressionLevel(
                    pool.address,
                    poolName,
                    pool.regime,
                    evResult.canEnter,
                    odsResult,
                    vshAdjustments?.isHarvesting ?? false,
                    migrationSlope,
                    churnQuality,
                    feeIntensity
                );
                aggressionLevel = aggressionState.level;
                
                // DEV MODE: Assert aggression invariants
                if (process.env.DEV_MODE === 'true') {
                    assertAggressionInvariants(pool.address, pool.regime, isFeeBleedDefenseActive());
                }
                
                // Step 4: Capital Concentration Checks (CCE)
                if (TIER5_FEATURE_FLAGS.ENABLE_CCE) {
                    concentrationResult = evaluateConcentration(
                        pool.address,
                        poolName,
                        tier4FinalSize,
                        evResult.canEnter,
                        odsResult?.ods ?? 0
                    );
                    
                    // Apply concentration sizing
                    if (concentrationResult.concentrationAllowed && aggressionLevel !== 'A0' && aggressionLevel !== 'A1') {
                        // Use concentrated size, but respect limits
                        const concentratedSize = Math.floor(tier4FinalSize * concentrationResult.concentrationMultiplier);
                        const cappedSize = Math.min(concentratedSize, concentrationResult.allowedSizeUSD);
                        
                        if (cappedSize > tier4FinalSize) {
                            logger.info(`[TIER5-CCE] ${poolName} concentration: $${tier4FinalSize} → $${cappedSize} (${concentrationResult.concentrationMultiplier.toFixed(1)}x at ${aggressionLevel})`);
                            tier4FinalSize = cappedSize;
                        }
                        
                        // DEV MODE: Assert CCE invariants
                        if (process.env.DEV_MODE === 'true') {
                            assertCCEInvariants(pool.address);
                        }
                    }
                }
                
                // Step 5: Apply aggression size multiplier
                const aggressionMultipliers = getAggressionMultipliers(pool.address);
                if (aggressionMultipliers.size !== 1.0) {
                    const aggressionAdjustedSize = Math.floor(tier4FinalSize * aggressionMultipliers.size);
                    if (aggressionAdjustedSize !== tier4FinalSize) {
                        logger.info(`[TIER5-AEL] ${poolName} aggression: $${tier4FinalSize} → $${aggressionAdjustedSize} (${aggressionMultipliers.size.toFixed(2)}x at ${aggressionLevel})`);
                        tier4FinalSize = aggressionAdjustedSize;
                    }
                }
            }
            
            // ═══════════════════════════════════════════════════════════════
            // MODULE 3: REGIME-ADAPTIVE AGGRESSION SCALING (TIER 4)
            // Apply regime-based size adjustments (only after stability)
            // ═══════════════════════════════════════════════════════════════
            const aggressionResult = getRegimeAdjustedSize(tier4FinalSize);
            tier4FinalSize = aggressionResult.adjustedSize;
            
            // Log aggression adjustment if non-neutral
            if (aggressionResult.status !== 'NEUTRAL') {
                logAggressionAdjustment(
                    poolName,
                    tier4Result.finalSize,
                    tier4FinalSize,
                    computeAggressionScaling()
                );
            }
            
            // ═══════════════════════════════════════════════════════════════
            // MODULE 4: FEE-BLEED FAILSAFE ADJUSTMENT
            // Apply defensive sizing if fee-bleed defense is active
            // ═══════════════════════════════════════════════════════════════
            if (isFeeBleedDefenseActive()) {
                tier4FinalSize = applyFeeBleedToPositionSize(tier4FinalSize);
                logger.info(`[FEE-BLEED-DEFENSE] ${poolName} size reduced to $${tier4FinalSize}`);
            }
            
            // Final size check after all adjustments
            if (tier4FinalSize < RISK_HARD_MIN_SIZE) {
                logger.info(`[ENTRY-BLOCK] ${poolName} final size $${tier4FinalSize} < $${RISK_HARD_MIN_SIZE} after adjustments`);
                continue;
            }

            // ═══════════════════════════════════════════════════════════════
            // EXECUTE ENTRY
            // ═══════════════════════════════════════════════════════════════
            const tokenType = categorizeToken(pool);
            const sizingMode = tier === 'A' ? 'aggressive' : 'standard';
            
            const tradeResult = await enterPosition(
                pool as any, 
                sizingMode, 
                tier4FinalSize, // Use Tier4-adjusted size
                rotationEquity, 
                tier, 
                assignment.leverage || 1
            );

            if (tradeResult.success && tradeResult.trade) {
                const tradeSize = tradeResult.trade.size;
                
                // Update tracking
                availableBalance -= tradeSize;
                currentTierExposure[tier] += tradeSize / rotationEquity;
                currentTotalExposure += tradeSize / rotationEquity;
                entriesThisCycle++;
                recordEntry();
                
                // Record positive EV trade for fee-bleed tracking
                recordPositiveEVTrade();

                // Log successful entry
                logger.info(`[ENTRY] ${poolName} size=$${tradeSize.toFixed(0)} tier=${tier} score=${pool.microScore.toFixed(1)}`);

                this.activePositions.push({
                    poolAddress: pool.address, 
                    entryTime: Date.now(), 
                    entryScore: pool.microScore,
                    entryPrice: pool.currentPrice, 
                    peakScore: pool.microScore, 
                    amount: tradeSize,
                    entryTVL: pool.liquidity, 
                    entryVelocity: pool.velocity, 
                    consecutiveCycles: 1,
                    consecutiveLowVolumeCycles: 0, 
                    tokenType,
                    entryBin: 0,
                });
                
                // ═══════════════════════════════════════════════════════════════
                // PORTFOLIO LEDGER: Record position open
                // ═══════════════════════════════════════════════════════════════
                if (isLedgerInitialized()) {
                    onPositionOpen({
                        tradeId: tradeResult.trade.id,
                        pool: pool.address,
                        poolName,
                        tier: this.determineTierFromScore(pool.microScore),
                        notionalUsd: tradeSize,
                        openedAt: Date.now(),
                    });
                }

                const history = getPoolHistory(pool.address);
                const latestState = history.length > 0 ? history[history.length - 1] : null;
                if (latestState) {
                    registerPosition({
                        poolId: pool.address, 
                        entryBin: latestState.activeBin, 
                        entryTime: Date.now(),
                        entryFeeIntensity: pool.microMetrics?.feeIntensity ?? 0,
                        entrySwapVelocity: pool.microMetrics?.swapVelocity ?? 0,
                        entry3mFeeIntensity: pool.microMetrics?.feeIntensity ?? 0,
                        entry3mSwapVelocity: pool.microMetrics?.swapVelocity ?? 0,
                    });
                }
                registerPredatorTrade(tradeResult.trade.id, pool.address);
                
                // ═══════════════════════════════════════════════════════════════
                // MODULE 5: RECORD TRADE ENTRY TELEMETRY
                // ═══════════════════════════════════════════════════════════════
                const mhiResult = computeMHI(pool.address);
                recordTradeEntry({
                    tradeId: tradeResult.trade.id,
                    poolAddress: pool.address,
                    poolName,
                    regime: pool.regime,
                    positionSizeUSD: tradeSize,
                    expectedFeeUSD: evResult.expectedFeeRevenueUSD,
                    expectedCostUSD: evResult.expectedTotalCostsUSD,
                    expectedNetEV: evResult.expectedNetEVUSD,
                    mhi: mhiResult?.mhi ?? 0,
                    tier4Score: pool.microScore,
                    feeIntensity: (pool.microMetrics?.feeIntensity ?? 0) / 100,
                });
                
                // ═══════════════════════════════════════════════════════════════
                // TIER 5: RECORD CONTROLLED AGGRESSION TELEMETRY
                // ═══════════════════════════════════════════════════════════════
                if (TIER5_FEATURE_FLAGS.ENABLE_CONTROLLED_AGGRESSION) {
                    // Get tranche index for this pool
                    const trancheIndex = getCurrentTrancheIndex(pool.address);
                    
                    // Record Tier 5 entry data with tranche and suppression context
                    recordTier5EntryData(tradeResult.trade.id, {
                        odsAtEntry: odsResult?.ods ?? 0,
                        aggressionLevel,
                        poolDeployedPct: getPoolDeployedPercentage(pool.address),
                        wasConcentrated: concentrationResult?.concentrationAllowed ?? false,
                        wasVSHHarvesting: vshAdjustments?.isHarvesting ?? false,
                        trancheIndex,
                        vshSuppressionActive: vshAdjustments?.exitSuppressionHint !== 'NONE',
                        holdSuppressionActive: false, // Will be updated if HOLD is entered
                    });
                    
                    // Record CCE deployment
                    if (TIER5_FEATURE_FLAGS.ENABLE_CCE) {
                        recordDeployment(
                            pool.address,
                            poolName,
                            tradeSize,
                            aggressionLevel,
                            odsResult?.ods ?? 0,
                            tradeResult.trade.id
                        );
                    }
                }
                
                // ═══════════════════════════════════════════════════════════════
                // PEPF: RECORD PERSISTENCE TELEMETRY
                // ═══════════════════════════════════════════════════════════════
                if (ENABLE_PEPF && pepfResult) {
                    recordPEPFEntryData(tradeResult.trade.id, {
                        evStreak: pepfResult.signals.evStreak,
                        fiStreak: pepfResult.signals.feeIntensityStreak,
                        halfLifeSec: pepfResult.signals.edgeHalfLifeSec,
                        amortizationSec: pepfResult.signals.expectedAmortizationSec,
                        tier5Relaxation: pepfResult.tier5Relaxation,
                        decision: 'PASS',
                    });
                } else if (!ENABLE_PEPF) {
                    recordPEPFEntryData(tradeResult.trade.id, {
                        evStreak: 0,
                        fiStreak: 0,
                        halfLifeSec: 0,
                        amortizationSec: 0,
                        tier5Relaxation: false,
                        decision: 'DISABLED',
                    });
                }
                
            } else {
                logger.warn(`[ENTRY-REJECT] ${poolName} trade execution failed`);
            }
        }
        
        return entriesThisCycle;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRIVATE: SCAN CYCLE — THE SOLE ORCHESTRATOR
    // ═══════════════════════════════════════════════════════════════════════════
    
    private async scanCycle(): Promise<void> {
        const startTime = Date.now();
        
        // Reset velocity audit counter for this cycle (rate-limited logging)
        resetVelocityAuditCycle();

        try {
            if (!this.initializationComplete) {
                logger.error('🚨 scanCycle called before initialization');
                return;
            }

            // Periodic status log
            if (Date.now() - this.lastPersistenceLogTime >= PERSISTENCE_LOG_INTERVAL) {
                logger.info(`[STATUS] Engine: ${this.engineId} | Uptime: ${Math.floor((Date.now() - this.botStartTime) / 1000)}s`);
                this.lastPersistenceLogTime = Date.now();
            }

            // Periodic status check (replaces engine's internal status loop)
            if (Date.now() - this.lastStatusCheckTime >= STATUS_CHECK_INTERVAL) {
                await this.engine.printStatus();
                this.lastStatusCheckTime = Date.now();
            }

            logger.info('═══════════════════════════════════════════════════════════════════');
            logger.info('🔄 SCAN CYCLE START (SCANLOOP = SOLE ORCHESTRATOR)');
            logger.info('═══════════════════════════════════════════════════════════════════');

            // STEP 1: CAPITAL GATING - ScanLoop enforces
            let currentBalance: number, totalEquity: number;
            try {
                currentBalance = await capitalManager.getBalance();
                totalEquity = await capitalManager.getEquity();
            } catch (err: any) {
                logger.error(`[CAPITAL] Failed to get balance: ${err.message}`);
                return;
            }

            const capitalGate = checkCapitalGating(currentBalance);
            if (!capitalGate.canTrade) {
                logger.warn(`[CAPITAL GATE] ❌ ${capitalGate.reason}`);
                return;
            }

            // STEP 2: DISCOVERY
            const currentPoolIds = this.activePositions.map(p => p.poolAddress);
            const discoveryCheck = shouldRefreshDiscovery(currentPoolIds);
            let poolUniverse: EnrichedPool[] = [];

            if (!discoveryCheck.shouldRefresh) {
                const cachedPools = getCachedEnrichedPools();
                if (cachedPools && cachedPools.length > 0) {
                    poolUniverse = cachedPools.map(cp => ({ ...cp } as EnrichedPool));
                }
            } else {
                try {
                    poolUniverse = await discoverDLMMUniverses({ minTVL: 200000, minVolume24h: 75000, minTraders24h: 35 });
                    if (poolUniverse.length > 0) {
                        const poolMetas: PoolMeta[] = poolUniverse.map(p => ({
                            address: p.address, name: p.symbol || p.address.slice(0, 8),
                            score: p.velocityLiquidityRatio || 0, mhi: 0, regime: 'NEUTRAL' as const, lastUpdated: Date.now(),
                        }));
                        const cachedEnriched: CachedEnrichedPool[] = poolUniverse.map(p => ({ ...p }));
                        updateDiscoveryCache(poolMetas, discoveryCheck.reason, cachedEnriched);
                    }
                } catch (err: any) {
                    logger.error('[DISCOVERY] Failed:', err?.message);
                    recordNoEntryCycle();
                    return;
                }
            }

            if (!Array.isArray(poolUniverse) || poolUniverse.length === 0) {
                logger.warn('[DISCOVERY] No qualified pools');
                recordNoEntryCycle();
                return;
            }

            // ═══════════════════════════════════════════════════════════════════
            // POOL LIMIT — PREVENT OOM KILLS
            // Applied BEFORE telemetry, scoring, or predator enrichment
            // ═══════════════════════════════════════════════════════════════════
            const rawPoolCount = poolUniverse.length;
            poolUniverse = limitPoolUniverse(poolUniverse, POOL_LIMIT);
            
            if (rawPoolCount > POOL_LIMIT) {
                logger.info(`[MEMORY] Processing ${poolUniverse.length} pools (discarded ${rawPoolCount - poolUniverse.length} to prevent OOM)`);
            }

            // STEP 3: TELEMETRY & SCORING (now limited to POOL_LIMIT pools)
            const pools: Pool[] = poolUniverse.map(ep => enrichedPoolToPool(ep) as Pool);
            const poolAddresses = pools.map(p => p.address);
            this.updateTrackedPools(poolAddresses);

            for (const pool of pools) {
                registerPool(pool.address, pool.name, pool.mintX || '', pool.mintY || '');
            }

            await this.refreshTelemetry();
            const microEnrichedPools = batchScorePools(pools);

            // STEP 4: PREDATOR CYCLE (ADVISORY ONLY)
            const predatorSummary = runPredatorCycle(poolAddresses);
            
            // STEP 4.5: TIER 4 — ADD POOLS TO ADAPTIVE UNIVERSE
            if (TIER4_ADAPTIVE_ENABLED) {
                const poolsForAdaptive = microEnrichedPools.map(p => ({
                    address: p.address,
                    name: p.name,
                    score: p.microScore,
                }));
                addDiscoveredPools(poolsForAdaptive, 'REFRESH');
                
                // Run periodic maintenance
                this.runTier4Maintenance();
            }

            // STEP 5: KILL SWITCH - ScanLoop enforces
            this.totalSnapshotCount += microEnrichedPools.filter(p => p.hasValidTelemetry).length;
            const killSwitchPoolMetrics: PoolMetrics[] = microEnrichedPools
                .filter(p => p.microMetrics)
                .map(p => ({
                    poolId: p.address, swapVelocity: (p.microMetrics?.swapVelocity ?? 0) / 100,
                    liquidityFlowPct: 0, entropy: p.microMetrics?.poolEntropy ?? 0,
                    feeIntensity: (p.microMetrics?.feeIntensity ?? 0) / 100,
                    feeIntensityBaseline60s: 0, microScore: p.microScore,
                }));

            const killDecision = evaluateKillSwitch({
                poolMetrics: killSwitchPoolMetrics, snapshotCount: this.totalSnapshotCount,
                runtimeMs: Date.now() - this.botStartTime, activeTradesCount: this.activePositions.length,
            });

            if (killDecision.killAll) {
                logger.error(`🚨 KILL SWITCH: ${killDecision.reason}`);
                setKillSwitch(true);
                for (const pos of this.activePositions) {
                    const activeTrades = getAllActiveTrades();
                    const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                    if (trade) {
                        await exitPosition(trade.id, { exitPrice: 0, reason: `KILL SWITCH: ${killDecision.reason}` }, 'KILL_SWITCH');
                        
                        // PORTFOLIO LEDGER: Record position close
                        if (isLedgerInitialized()) {
                            onPositionClose(trade.id);
                        }
                    }
                }
                this.activePositions = [];
                return;
            }

            if (killDecision.shouldPause) {
                logger.warn(`⏸️ Trading paused: ${killDecision.reason}`);
                return;
            }
            
            // STEP 5.25: TIER 4 — FORCE EXIT CHECK (CHAOS REGIME)
            if (TIER4_ADAPTIVE_ENABLED && shouldForceExitAllPositions()) {
                logger.warn(`[TIER4-CHAOS] 🔴 Force exit triggered by CHAOS regime`);
                for (const pos of this.activePositions) {
                    const activeTrades = getAllActiveTrades();
                    const trade = activeTrades.find(t => t.pool === pos.poolAddress);
                    if (trade) {
                        await exitPosition(trade.id, { exitPrice: 0, reason: 'CHAOS_REGIME_EXIT' }, 'TIER4_CHAOS');
                        
                        // PORTFOLIO LEDGER: Record position close
                        if (isLedgerInitialized()) {
                            onPositionClose(trade.id);
                        }
                    }
                }
                this.activePositions = [];
                return;
            }

            // STEP 5.5: MARKET SENTIMENT GATE
            const marketSentiment = evaluateMarketSentiment(microEnrichedPools);
            if (marketSentiment.shouldBlock) {
                logger.warn(`[ENTRY-BLOCK] Global sentiment: ${marketSentiment.reason}`);
                recordNoEntryCycle();
                return;
            }

            // STEP 6: POOL PREPARATION
            const sortedPools = microEnrichedPools.sort((a, b) => b.microScore - a.microScore);
            const deduplicatedPools = deduplicatePools(sortedPools) as Tier4EnrichedPool[];

            if (deduplicatedPools.length === 0) {
                recordNoEntryCycle();
                return;
            }

            const scoredPoolsForEngine: ScoredPool[] = deduplicatedPools.map((p: Tier4EnrichedPool) => ({
                address: p.address, score: p.microScore, liquidityUSD: p.liquidity,
                volume24h: p.volume24h, binCount: p.binCount || 1, activeBin: (p as any).activeBin || 0,
                tokenA: { symbol: p.name.split('-')[0] || 'TOKEN', decimals: 9 },
                tokenB: { symbol: p.name.split('-')[1] || 'TOKEN', decimals: 9 },
                microMetrics: p.microMetrics || undefined, isMarketAlive: p.isMarketAlive,
            }));

            // STEP 7: EVALUATE EXISTING POSITIONS (REPLACES engine.update())
            await this.evaluateAndExitPositions(scoredPoolsForEngine);

            // STEP 8: INVOKE ENGINE FOR ENTRIES (if conditions met)
            const bestPool = scoredPoolsForEngine.reduce((best, pool) => pool.score > best.score ? pool : best, scoredPoolsForEngine[0]);

            if (bestPool.score >= EXECUTION_MIN_SCORE && bestPool.isMarketAlive) {
                // ScanLoop invokes engine for entries - engine does NOT run on its own
                await this.engine.placePools(scoredPoolsForEngine);
            }

            // STEP 9: ROTATION (additional entries via risk bucket engine)
            const entriesThisCycle = await this.manageRotation(microEnrichedPools);

            // STEP 10: MONITORING
            if (entriesThisCycle === 0) {
                recordNoEntryCycle();
                recordNoPositiveEVCycle(); // For fee-bleed tracking
            }

            const regimes = microEnrichedPools.slice(0, 10).map(p => p.regime);
            const regimeCounts = { BULL: 0, NEUTRAL: 0, BEAR: 0 };
            for (const r of regimes) if (r && regimeCounts[r] !== undefined) regimeCounts[r]++;
            const dominantRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0][0] as 'BULL' | 'NEUTRAL' | 'BEAR';
            updateRegime(dominantRegime);
            
            // Update MHI regime for regime-adaptive weights
            updateMHIRegime(dominantRegime);
            
            // ═══════════════════════════════════════════════════════════════════
            // TIER 4 DOMINANT — UPDATE ALL TRACKING SYSTEMS
            // ═══════════════════════════════════════════════════════════════════
            
            // MODULE 3: Update aggression regime state
            updateAggressionRegime(dominantRegime);
            
            // MODULE 4: Analyze fee bleed and log status
            analyzeFeeBleed();
            logFeeBleedStatus();
            
            // MODULE 2: Evaluate hold mode for all active positions
            await this.evaluateHoldModeForPositions(microEnrichedPools);
            
            // MODULE 5: Generate and log cycle summary
            const holdSummary = getHoldModeSummary();
            const feeBleedActive = isFeeBleedDefenseActive();
            const feeBleedMultipliers = getFeeBleedMultipliers();
            
            generateCycleSummary(
                this.activePositions.length,
                holdSummary.holdCount,
                feeBleedActive,
                feeBleedMultipliers.evGateMultiplier
            );
            
            // Log aggression summary periodically
            if (Date.now() % 10 === 0) { // Every ~10th cycle
                logAggressionSummary();
            }

            if (!killDecision.killAll && !killDecision.shouldPause) setKillSwitch(false);

            const duration = Date.now() - startTime;
            logger.info(`✅ Scan cycle complete: ${duration}ms | Entries: ${entriesThisCycle}`);
            logPredatorCycleSummary(predatorSummary);
            
            // TIER 4 — LOG ADAPTIVE STATUS
            if (TIER4_ADAPTIVE_ENABLED) {
                const activeRegime = getActiveRegimeForLogging();
                const execQuality = getExecutionQuality();
                const adaptiveSelection = getAdaptivePoolSelection();
                
                logger.info(`[TIER4-STATUS] Regime: ${activeRegime} | ExecQuality: ${(execQuality.score * 100).toFixed(0)}% | ActivePools: ${adaptiveSelection.activePools.length} | Blocked: ${adaptiveSelection.blockedPools.length}`);
                
                // Log hold mode status if any positions are in hold
                if (holdSummary.holdCount > 0) {
                    logger.info(`[HOLD-STATUS] ${holdSummary.holdCount} positions in HOLD | AccumulatedFees: $${holdSummary.totalAccumulatedFees.toFixed(2)} | AvgDuration: ${holdSummary.avgHoldDuration.toFixed(1)}h`);
                }
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // TIER 5: CONTROLLED AGGRESSION CYCLE SUMMARY
            // ═══════════════════════════════════════════════════════════════════
            if (TIER5_FEATURE_FLAGS.ENABLE_CONTROLLED_AGGRESSION) {
                const odsSummary = getODSSummary();
                const aggressionSummary = getAggressionSummary();
                const deploymentSummary = getDeploymentSummary();
                const vshSummary = getVSHSummary();
                
                // Calculate average ODS for active spikes
                const allSpikes = getAllActiveSpikes();
                let avgODS = 0;
                if (allSpikes.size > 0) {
                    let totalODS = 0;
                    for (const spike of allSpikes.values()) {
                        totalODS += spike.ods;
                    }
                    avgODS = totalODS / allSpikes.size;
                }
                
                // Find top aggression level
                const levelOrder: AggressionLevel[] = ['A0', 'A1', 'A2', 'A3', 'A4'];
                let topLevel: AggressionLevel = 'A0';
                for (const level of levelOrder) {
                    if (aggressionSummary.byLevel[level] > 0) {
                        topLevel = level;
                    }
                }
                
                // Log Tier 5 summary using the standard format
                logTier5Summary({
                    aggressionLevel: topLevel,
                    activeSpikes: odsSummary.activeSpikes,
                    topPool: deploymentSummary.topPool?.address,
                    poolDeployedPct: (deploymentSummary.topPool?.deployedPct ?? 0) * 100,
                    totalDeployedPct: deploymentSummary.totalDeployedPct * 100,
                    avgODS,
                    vshHarvestingPools: vshSummary.harvestingPools,
                });
                
                // ═══════════════════════════════════════════════════════════════
                // TIER 5 VALIDATION SUMMARY
                // Log per-cycle validation metrics for controlled aggression
                // ═══════════════════════════════════════════════════════════════
                const oddStats = getODDValidationStats();
                const trancheStats = getTrancheAddStats();
                const exitStats = getExitSuppressionStats();
                
                logTier5ValidationSummary({
                    oddRejectsByReason: oddStats.rejectsByReason,
                    oddConfirmedSpikes: oddStats.confirmedSpikes,
                    oddTotalEvaluations: oddStats.totalEvaluations,
                    aggressionByLevel: aggressionSummary.byLevel,
                    trancheAddsCount: trancheStats.trancheAddsThisCycle,
                    avgEVDeltaTranche1to2: trancheStats.avgEVDeltaTranche1to2,
                    trancheBlockedReasons: trancheStats.blockedReasons,
                    riskSuppressBlocks: exitStats.riskSuppressBlocksThisCycle,
                    noiseExitsSuppressed: exitStats.noiseExitsSuppressedThisCycle,
                    riskExitTypeBlocks: exitStats.riskExitTypeBlocks,
                });
                
                // Log Tier 5 Post-Trade Attribution Summary (rolling 50 trades)
                logTier5AttributionSummary();
                
                // DEV_MODE: Assert no RISK exits were suppressed
                assertNoRiskExitsSuppressed();
                
                // Reset per-cycle stats for next cycle
                resetODDValidationStats();
                resetTrancheAddStats();
                resetExitSuppressionStats();
            }
            
            // ═══════════════════════════════════════════════════════════════════
            // PEPF CYCLE SUMMARY
            // ═══════════════════════════════════════════════════════════════════
            if (ENABLE_PEPF) {
                logPersistenceSummary();
                resetPersistenceStats();
            }

        } catch (error) {
            logger.error('❌ Error in scan cycle:', error);
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MODULE 2: FEE-HARVEST HOLD MODE EVALUATION
    // ═══════════════════════════════════════════════════════════════════════════
    
    /**
     * Evaluate hold mode for all active positions
     * Positions may enter or exit HOLD state based on market conditions
     */
    private async evaluateHoldModeForPositions(rankedPools: Tier4EnrichedPool[]): Promise<void> {
        for (const pos of this.activePositions) {
            const pool = rankedPools.find(p => p.address === pos.poolAddress);
            if (!pool) continue;
            
            const holdDurationHours = (Date.now() - pos.entryTime) / (1000 * 3600);
            
            // Find trade ID for this position
            const activeTrades = getAllActiveTrades();
            const trade = activeTrades.find(t => t.pool === pos.poolAddress);
            if (!trade) continue;
            
            const positionState = getPositionState(trade.id);
            
            // Evaluate hold mode eligibility
            const holdEval = evaluateHoldMode(trade.id, {
                pool,
                positionSizeUSD: pos.amount,
                currentScore: pool.microScore,
                entryScore: pos.entryScore,
                entryRegime: pos.entryRegime ?? 'NEUTRAL',
                currentRegime: pool.regime,
                holdDurationHours,
                priceAtEntry: pos.entryPrice,
                currentPrice: pool.currentPrice ?? pos.entryPrice,
            });
            
            // Handle state transitions
            if (positionState === 'ACTIVE' && holdEval.canEnterHold) {
                // Enter hold mode
                enterHoldMode(
                    trade.id,
                    holdEval.currentEV.expectedNetEVUSD,
                    holdEval.currentScore,
                    holdEval.currentRegime,
                    pool.name
                );
                
                // Update Tier 5 suppression flags for attribution tracking
                if (TIER5_FEATURE_FLAGS.ENABLE_CONTROLLED_AGGRESSION) {
                    updateTier5SuppressionFlags(trade.id, { holdSuppressionActive: true });
                }
            } else if (positionState === 'ACTIVE' && !holdEval.canEnterHold) {
                // Log rejection if there was an attempt
                if (holdEval.holdRejectReason) {
                    logHoldReject(pool.name, holdEval.holdRejectReason);
                }
            } else if (positionState === 'HOLD' && holdEval.shouldExitHold) {
                // Exit hold mode
                exitHoldMode(trade.id, holdEval.holdExitReason ?? 'UNKNOWN', pool.name);
            } else if (positionState === 'HOLD') {
                // Record fees accumulated during hold cycle
                // Estimate fees from fee intensity: feeIntensity * positionShare * 2min
                const positionShare = pool.liquidity > 0 ? pos.amount / pool.liquidity : 0;
                const feeIntensity = (pool.microMetrics?.feeIntensity ?? 0) / 100;
                const estimatedCycleFees = feeIntensity * 120 * positionShare * pool.liquidity; // 120 seconds
                if (estimatedCycleFees > 0) {
                    recordHoldFees(trade.id, estimatedCycleFees);
                }
            }
        }
    }
}
