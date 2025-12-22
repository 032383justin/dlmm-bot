"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const supabase_js_1 = require("@supabase/supabase-js");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// Import run epoch for accounting correctness display
const runEpoch_1 = require("../services/runEpoch");
const app = (0, express_1.default)();
const PORT = 3000;
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');
// ═══════════════════════════════════════════════════════════════════════════════
// OPERATOR-GRADE OBSERVABILITY — DATA AGGREGATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
async function computeFeeAmortizationMetrics(activePositions, logs) {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    // Calculate fees from recent logs
    const feeEvents = logs.filter(l => {
        const details = l.details;
        return (details?.feesAccrued !== undefined || details?.entry_fees_paid !== undefined);
    });
    // Estimate fee velocity (fees per hour over last 24h)
    const recentFees = feeEvents.filter(l => new Date(l.timestamp).getTime() > oneDayAgo);
    let totalFeesLast24h = 0;
    for (const fe of recentFees) {
        const details = fe.details;
        totalFeesLast24h += details?.feesAccrued || details?.entry_fees_paid || 0;
    }
    const feeVelocityPerHour = totalFeesLast24h / 24;
    // Compute amortization for each position
    const positionAmortization = [];
    let totalFeesAccrued = 0;
    let totalCostTarget = 0;
    for (const pos of activePositions) {
        const entryTime = new Date(pos.entryTime).getTime();
        const holdTimeHours = (now - entryTime) / (1000 * 3600);
        // Estimate costs: entry fees + expected exit fees + slippage
        const entryFees = pos.amount * 0.003; // 0.3% entry fee
        const exitFees = pos.amount * 0.003; // 0.3% exit fee
        const slippage = pos.amount * 0.002; // 0.2% total slippage
        const costTarget = (entryFees + exitFees + slippage) * 1.10; // 110% amortization factor
        // Estimate fees accrued based on hold time and estimated fee intensity
        // Fee intensity is typically 0.02-0.10 per hour for good pools
        const estimatedFeeIntensity = 0.05; // Conservative estimate
        const positionShare = 0.01; // Assume ~1% of pool
        const feesAccrued = holdTimeHours * estimatedFeeIntensity * pos.amount * positionShare;
        const amortizationPct = costTarget > 0 ? (feesAccrued / costTarget) * 100 : 0;
        let status = 'red';
        if (amortizationPct >= 100)
            status = 'green';
        else if (amortizationPct >= 50)
            status = 'yellow';
        positionAmortization.push({
            pool: pos.pool,
            poolName: pos.poolName,
            feesAccrued,
            costTarget,
            amortizationPct,
            status,
        });
        totalFeesAccrued += feesAccrued;
        totalCostTarget += costTarget;
    }
    return {
        totalFeesAccrued,
        avgFeesPerPosition: activePositions.length > 0 ? totalFeesAccrued / activePositions.length : 0,
        avgCostTarget: activePositions.length > 0 ? totalCostTarget / activePositions.length : 0,
        avgAmortizationPct: totalCostTarget > 0 ? (totalFeesAccrued / totalCostTarget) * 100 : 0,
        feeVelocityPerHour,
        positionAmortization,
    };
}
function computeExitSuppressionMetrics(logs) {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const recentLogs = logs.filter(l => new Date(l.timestamp).getTime() > oneDayAgo);
    // Count exit signals and executions
    const exitSignals = recentLogs.filter(l => {
        const action = String(l.action || '').toUpperCase();
        const details = l.details;
        return action.includes('EXIT') ||
            details?.exitSignal ||
            details?.shouldExit ||
            String(details?.message || '').includes('EXIT');
    });
    const exitsExecuted = recentLogs.filter(l => {
        const action = String(l.action || '').toUpperCase();
        return action === 'EXIT' || action === 'CLOSED' || action === 'CLOSE';
    });
    // Count suppression reasons from logs
    const suppressionReasons = {
        COST_NOT_AMORTIZED: 0,
        MIN_HOLD: 0,
        HOLD_MODE: 0,
        VSH_SUPPRESSION: 0,
        DEFENSE_MODE: 0,
        OTHER: 0,
    };
    for (const log of recentLogs) {
        const details = log.details;
        const message = String(details?.message || details?.reason || '').toUpperCase();
        if (message.includes('SUPPRESS') || message.includes('BLOCKED')) {
            if (message.includes('COST') || message.includes('AMORTIZ')) {
                suppressionReasons.COST_NOT_AMORTIZED++;
            }
            else if (message.includes('MIN_HOLD') || message.includes('HOLD_TIME')) {
                suppressionReasons.MIN_HOLD++;
            }
            else if (message.includes('HOLD_MODE') || message.includes('HOLD-SUPPRESS')) {
                suppressionReasons.HOLD_MODE++;
            }
            else if (message.includes('VSH')) {
                suppressionReasons.VSH_SUPPRESSION++;
            }
            else if (message.includes('DEFENSE') || message.includes('REGIME')) {
                suppressionReasons.DEFENSE_MODE++;
            }
            else {
                suppressionReasons.OTHER++;
            }
        }
    }
    return {
        exitSignalsTriggered24h: exitSignals.length,
        exitsExecuted24h: exitsExecuted.length,
        suppressedCostNotAmortized: suppressionReasons.COST_NOT_AMORTIZED,
        suppressedMinHold: suppressionReasons.MIN_HOLD,
        suppressedDefenseRegime: suppressionReasons.DEFENSE_MODE,
        suppressedHoldMode: suppressionReasons.HOLD_MODE,
        suppressionReasons,
    };
}
function computeEdgeHealthMetrics(activePositions, logs) {
    // Extract MHI values from logs
    const mhiValues = [];
    const scores = [];
    for (const log of logs.slice(0, 1000)) { // Recent logs
        const details = log.details;
        if (details?.mhi !== undefined)
            mhiValues.push(details.mhi);
        if (details?.score !== undefined)
            scores.push(details.score);
    }
    // Add scores from active positions
    for (const pos of activePositions) {
        if (pos.score)
            scores.push(pos.score);
    }
    const avgMHI = mhiValues.length > 0
        ? mhiValues.reduce((a, b) => a + b, 0) / mhiValues.length
        : 0.5;
    const avgScore = scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 35;
    // MHI distribution
    const mhiDistribution = { green: 0, yellow: 0, red: 0 };
    for (const mhi of mhiValues) {
        if (mhi >= 0.6)
            mhiDistribution.green++;
        else if (mhi >= 0.35)
            mhiDistribution.yellow++;
        else
            mhiDistribution.red++;
    }
    // Calculate EV delta (expected vs realized)
    let expectedPnL = 0;
    let realizedPnL = 0;
    for (const log of logs.slice(0, 500)) {
        const details = log.details;
        if (details?.expectedNetEV !== undefined)
            expectedPnL += details.expectedNetEV;
        if (details?.realizedPnL !== undefined)
            realizedPnL += details.realizedPnL;
        if (details?.pnl !== undefined)
            realizedPnL += details.pnl;
    }
    const evDelta = expectedPnL !== 0 ? (realizedPnL - expectedPnL) / Math.abs(expectedPnL) : 0;
    // Fee dominance ratio: fees / total costs
    let totalFees = 0;
    let totalCosts = 0;
    for (const log of logs.slice(0, 500)) {
        const details = log.details;
        if (details?.feesAccrued !== undefined)
            totalFees += details.feesAccrued;
        if (details?.entry_fees_paid !== undefined)
            totalCosts += details.entry_fees_paid;
        if (details?.exit_fees_paid !== undefined)
            totalCosts += details.exit_fees_paid;
    }
    const feeDominanceRatio = totalCosts > 0 ? totalFees / totalCosts : 1;
    return {
        avgMHI,
        mhiDistribution,
        evDelta,
        feeDominanceRatio,
        avgScore,
    };
}
function computeRegimeStateMetrics(logs) {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    // Find current regime from recent logs
    let currentGlobalRegime = 'NEUTRAL';
    let defenseModeActive = false;
    let killSwitchActive = false;
    for (const log of logs.slice(0, 100)) {
        const details = log.details;
        if (details?.regime) {
            currentGlobalRegime = details.regime;
            break;
        }
        if (details?.globalRegime) {
            currentGlobalRegime = details.globalRegime;
            break;
        }
    }
    // Check for defense/kill switch status
    for (const log of logs.slice(0, 50)) {
        const action = String(log.action || '').toUpperCase();
        const details = log.details;
        if (action.includes('DEFENSE') || details?.defenseModeActive) {
            defenseModeActive = true;
        }
        if (action.includes('KILL') || details?.killSwitchActive) {
            killSwitchActive = true;
        }
    }
    // Track regime transitions
    const recentTransitions = [];
    let lastRegime = '';
    for (let i = logs.length - 1; i >= 0; i--) {
        const log = logs[i];
        if (new Date(log.timestamp).getTime() < oneDayAgo)
            continue;
        const details = log.details;
        const regime = details?.regime || details?.globalRegime;
        if (regime && regime !== lastRegime && lastRegime !== '') {
            recentTransitions.push({
                from: lastRegime,
                to: regime,
                timestamp: log.timestamp,
            });
        }
        if (regime)
            lastRegime = regime;
    }
    // Positions aligned with regime (mock - would need actual position data)
    const positionsAlignedPct = 75; // Placeholder
    return {
        currentGlobalRegime,
        positionsAlignedPct,
        recentTransitions: recentTransitions.slice(-5), // Last 5 transitions
        defenseModeActive,
        killSwitchActive,
    };
}
function computePreEntryFilterMetrics(logs) {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const recentLogs = logs.filter(l => new Date(l.timestamp).getTime() > oneDayAgo);
    let pepfPassCount = 0;
    let pepfRejectCount = 0;
    let tier5RelaxationCount = 0;
    const rejectReasons = {};
    for (const log of recentLogs) {
        const details = log.details;
        const message = String(details?.message || '').toUpperCase();
        const action = String(log.action || '').toUpperCase();
        // PEPF tracking
        if (message.includes('PEPF') || action.includes('PEPF')) {
            if (message.includes('PASS') || details?.pepfPassed) {
                pepfPassCount++;
            }
            else if (message.includes('BLOCK') || message.includes('REJECT')) {
                pepfRejectCount++;
                const reason = details?.blockReason || details?.reason || 'UNKNOWN';
                rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
            }
        }
        // Entry blocks
        if (action.includes('ENTRY-BLOCK') || message.includes('ENTRY-BLOCK')) {
            const reason = details?.reason || details?.blockReason || 'UNKNOWN';
            rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
        }
        // Tier 5 relaxations
        if (details?.tier5Relaxation || message.includes('RELAXATION')) {
            tier5RelaxationCount++;
        }
    }
    // Sort reject reasons by count
    const topRejectReasons = Object.entries(rejectReasons)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    // Count active cooldowns (from exit intent logs)
    const activeCooldowns = recentLogs.filter(l => {
        const details = l.details;
        return details?.inCooldown || String(details?.state || '').includes('COOLDOWN');
    }).length;
    return {
        pepfPassCount,
        pepfRejectCount,
        topRejectReasons,
        activeCooldowns: Math.min(activeCooldowns, 10), // Cap for display
        tier5RelaxationCount,
    };
}
function computePositionEscapeHatchMetrics(activePositions, logs) {
    const now = Date.now();
    const thirtyMinAgo = now - 30 * 60 * 1000;
    // Constants matching escape hatch config
    const EXIT_TTL_MS = 45 * 60 * 1000; // 45 min
    const MAX_SUPPRESSIONS = 60; // 60 in 30 min window
    const MAX_TIME_TO_AMORTIZE_MS = 90 * 60 * 1000; // 90 min
    const metrics = [];
    for (const pos of activePositions) {
        const poolLogs = logs.filter(l => {
            const details = l.details;
            return details?.pool === pos.pool ||
                details?.poolAddress === pos.pool ||
                details?.trade_id === pos.id;
        });
        // Find exit triggered state from recent logs
        let exitTriggeredSince = null;
        let exitState = 'HOLD';
        let suppressCountRolling = 0;
        let feeVelocityUsdPerHr = 0;
        // Look for exit intent logs
        for (const log of poolLogs.slice(0, 200)) {
            const details = log.details;
            const message = String(details?.message || '').toUpperCase();
            const logTime = new Date(log.timestamp).getTime();
            // Track exit triggered since
            if (message.includes('EXIT_TRIGGERED') || message.includes('EXIT-INTENT')) {
                if (!exitTriggeredSince || logTime < exitTriggeredSince) {
                    exitTriggeredSince = logTime;
                }
                exitState = 'EXIT_TRIGGERED';
            }
            // Count suppressions in 30-min window
            if ((message.includes('SUPPRESS') || message.includes('EXIT-SUPPRESS')) && logTime > thirtyMinAgo) {
                suppressCountRolling++;
            }
            // Extract fee velocity if logged
            if (details?.feeVelocity !== undefined) {
                feeVelocityUsdPerHr = details.feeVelocity;
            }
            if (details?.feeVelocityUsdPerHr !== undefined) {
                feeVelocityUsdPerHr = details.feeVelocityUsdPerHr;
            }
            // Check for forced exit pending
            if (message.includes('FORCED_EXIT_PENDING') || message.includes('FORCED_EXIT')) {
                exitState = 'FORCED_EXIT_PENDING';
            }
        }
        // Calculate derived metrics
        const exitTriggeredDurationMs = exitTriggeredSince ? now - exitTriggeredSince : 0;
        const exitTriggeredDurationMin = Math.floor(exitTriggeredDurationMs / 60000);
        // Time to cost target estimate
        const entryTime = new Date(pos.entryTime).getTime();
        const holdTimeHours = (now - entryTime) / (1000 * 3600);
        const costTarget = pos.amount * 0.008 * 1.10; // ~0.8% round-trip * 110%
        const estimatedFeeIntensity = 0.05;
        const positionShare = 0.01;
        const feesAccrued = holdTimeHours * estimatedFeeIntensity * pos.amount * positionShare;
        const remainingCost = costTarget - feesAccrued;
        let timeToCostTargetMin = null;
        let economicStaleness = false;
        if (feeVelocityUsdPerHr > 0.01 && remainingCost > 0) {
            const hoursToAmortize = remainingCost / feeVelocityUsdPerHr;
            timeToCostTargetMin = Math.floor(hoursToAmortize * 60);
            economicStaleness = (hoursToAmortize * 60 * 60 * 1000) > MAX_TIME_TO_AMORTIZE_MS;
        }
        else if (remainingCost <= 0) {
            timeToCostTargetMin = 0;
            economicStaleness = false;
        }
        else {
            timeToCostTargetMin = null; // Infinite
            economicStaleness = true;
        }
        // TTL remaining
        let ttlRemainingMin = null;
        if (exitTriggeredSince && exitState !== 'HOLD') {
            const ttlRemainingMs = EXIT_TTL_MS - exitTriggeredDurationMs;
            ttlRemainingMin = Math.max(0, Math.floor(ttlRemainingMs / 60000));
        }
        // Suppress cap remaining
        const suppressCapRemaining = Math.max(0, MAX_SUPPRESSIONS - suppressCountRolling);
        metrics.push({
            pool: pos.pool,
            poolName: pos.poolName,
            exitState,
            exitTriggeredSince: exitTriggeredSince
                ? new Date(exitTriggeredSince).toISOString()
                : null,
            exitTriggeredDurationMin,
            exitSuppressCountRolling: suppressCountRolling,
            feeVelocityUsdPerHr,
            timeToCostTargetMin,
            economicStaleness,
            ttlRemainingMin,
            suppressCapRemaining,
        });
    }
    return metrics;
}
function computeExposureTimeMetrics(activePositions, currentBalance, totalEquity) {
    const now = Date.now();
    // Calculate position age distribution
    const positionAgeDistribution = { under1h: 0, under4h: 0, under24h: 0, over24h: 0 };
    let totalHoldTimeHours = 0;
    let timeWeightedExposure = 0;
    for (const pos of activePositions) {
        const entryTime = new Date(pos.entryTime).getTime();
        const holdTimeHours = (now - entryTime) / (1000 * 3600);
        totalHoldTimeHours += holdTimeHours;
        // Time-weighted exposure: sum of (position_size × hold_time)
        timeWeightedExposure += pos.amount * holdTimeHours;
        // Age distribution
        if (holdTimeHours < 1)
            positionAgeDistribution.under1h++;
        else if (holdTimeHours < 4)
            positionAgeDistribution.under4h++;
        else if (holdTimeHours < 24)
            positionAgeDistribution.under24h++;
        else
            positionAgeDistribution.over24h++;
    }
    const avgHoldTimeHours = activePositions.length > 0
        ? totalHoldTimeHours / activePositions.length
        : 0;
    const totalDeployed = activePositions.reduce((sum, pos) => sum + pos.amount, 0);
    const idleCapital = totalEquity - totalDeployed;
    const idleCapitalPct = totalEquity > 0 ? (idleCapital / totalEquity) * 100 : 100;
    // Capital efficiency: how much of capital is actively earning
    const capitalEfficiency = totalEquity > 0 ? (totalDeployed / totalEquity) * 100 : 0;
    return {
        timeWeightedExposure,
        avgHoldTimeHours,
        idleCapitalPct,
        capitalEfficiency,
        positionAgeDistribution,
    };
}
app.get('/', async (_req, res) => {
    try {
        const { data: logs, error } = await supabase
            .from('bot_logs')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(10000);
        if (error)
            throw error;
        const now = Date.now();
        const oneDayAgo = now - 24 * 60 * 60 * 1000;
        const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;
        let totalPnL = 0;
        for (const log of logs) {
            const pnl = log.details?.paperPnL;
            if (pnl !== undefined && pnl !== null) {
                totalPnL = pnl;
                break;
            }
        }
        let dailyPnL = 0;
        let weeklyPnL = 0;
        let monthlyPnL = 0;
        // Find the most recent reset point (when paperPnL was 0 or very close to 0)
        // This ensures we don't use old logs from before a reset
        let resetTimestamp = 0;
        for (let i = logs.length - 1; i >= 0; i--) {
            const pnl = logs[i].details?.paperPnL;
            if (pnl !== undefined && pnl !== null && Math.abs(pnl) < 0.01) {
                // Found a reset point (PnL near zero)
                resetTimestamp = new Date(logs[i].timestamp).getTime();
                break;
            }
        }
        // Find the P&L at the START of each time period (oldest log within period)
        let startDailyPnL = null;
        let startWeeklyPnL = null;
        let startMonthlyPnL = null;
        // Loop from oldest to newest to find the first P&L value in each period
        for (let i = logs.length - 1; i >= 0; i--) {
            const log = logs[i];
            const pnl = log.details?.paperPnL;
            if (pnl === undefined || pnl === null)
                continue;
            const timestamp = new Date(log.timestamp).getTime();
            // Skip logs from before the reset
            if (timestamp < resetTimestamp)
                continue;
            // Find the FIRST (oldest) P&L value within each period
            if (timestamp > oneMonthAgo && startMonthlyPnL === null)
                startMonthlyPnL = pnl;
            if (timestamp > oneWeekAgo && startWeeklyPnL === null)
                startWeeklyPnL = pnl;
            if (timestamp > oneDayAgo && startDailyPnL === null)
                startDailyPnL = pnl;
        }
        // Calculate P&L change from start of period to now
        // If we don't have data from that far back (or it's before reset), use total P&L
        dailyPnL = startDailyPnL !== null ? totalPnL - startDailyPnL : totalPnL;
        weeklyPnL = startWeeklyPnL !== null ? totalPnL - startWeeklyPnL : totalPnL;
        monthlyPnL = startMonthlyPnL !== null ? totalPnL - startMonthlyPnL : totalPnL;
        // Calculate wins/losses from EXIT logs
        // Count ALL exits, not just those with paperPnL
        const allExitLogs = logs.filter(l => l.action === 'EXIT');
        const exitLogsWithPnL = allExitLogs.filter(l => l.details?.paperPnL !== undefined);
        let wins = 0;
        let losses = 0;
        let prevPnL = 0;
        // Sort by timestamp ascending to calculate trade-by-trade P&L
        const sortedExits = [...exitLogsWithPnL].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        for (const exit of sortedExits) {
            const currentPnL = exit.details.paperPnL;
            const tradePnL = currentPnL - prevPnL;
            if (tradePnL > 0)
                wins++;
            else if (tradePnL < 0)
                losses++;
            prevPnL = currentPnL;
        }
        // Total trades = ALL exits (including those without PnL tracking)
        const totalTrades = allExitLogs.length;
        const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
        const avgWin = wins > 0 ? totalPnL / wins : 0;
        // ═══════════════════════════════════════════════════════════════════════════════
        // RUN EPOCH ACCOUNTING CORRECTNESS
        // Get run-scoped equity (prevents phantom equity from prior runs)
        // ═══════════════════════════════════════════════════════════════════════════════
        const runEpoch = (0, runEpoch_1.getActiveRunEpoch)();
        const activeRunId = (0, runEpoch_1.getActiveRunId)();
        // Get unrealized PnL from active positions
        const unrealizedPnL = 0; // Placeholder - would need to calculate from positions
        const runEquityState = await (0, runEpoch_1.getRunScopedNetEquity)(unrealizedPnL);
        const historicalDataCheck = await (0, runEpoch_1.checkHistoricalDataOutsideRun)();
        // Use run-scoped values for display
        // NOTE: starting_capital comes from validated run epoch, NOT from env vars
        const startingBalance = runEquityState.starting_capital || 10000;
        const runRealizedPnL = runEquityState.realized_pnl;
        const currentBalance = runEquityState.net_equity || (startingBalance + totalPnL);
        const entryLogs = logs.filter(l => l.action === 'ENTRY');
        const exitLogs = logs.filter(l => l.action === 'EXIT');
        // Build active positions: group by pool, keep most recent entry, check if exited
        const positionMap = new Map();
        // First pass: collect all entries by pool, keeping only the most recent
        for (const entry of entryLogs) {
            const pool = entry.details?.pool;
            const poolName = entry.details?.poolName || pool; // Use name if available, fallback to address
            const amount = entry.details?.amount || 0;
            if (!pool || amount === 0)
                continue;
            const entryTime = new Date(entry.timestamp).getTime();
            const existing = positionMap.get(pool);
            // Keep only the most recent entry for this pool
            if (!existing || new Date(existing.entryTime).getTime() < entryTime) {
                positionMap.set(pool, {
                    pool,
                    poolName,
                    amount,
                    score: entry.details?.score || 0,
                    entryTime: entry.timestamp,
                    type: entry.details?.type || 'unknown'
                });
            }
        }
        // Second pass: remove positions that have been exited AFTER their most recent entry
        for (const [pool, position] of positionMap.entries()) {
            const hasExitedAfter = exitLogs.some(exit => exit.details?.pool === pool &&
                new Date(exit.timestamp) > new Date(position.entryTime));
            if (hasExitedAfter) {
                positionMap.delete(pool);
            }
        }
        const activePositions = Array.from(positionMap.values());
        const totalDeployed = activePositions.reduce((sum, pos) => sum + pos.amount, 0);
        const availableCapital = currentBalance - totalDeployed;
        const toEST = (date) => {
            return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        };
        // ═══════════════════════════════════════════════════════════════════════════════
        // OPERATOR-GRADE OBSERVABILITY — COMPUTE ALL METRICS
        // ═══════════════════════════════════════════════════════════════════════════════
        const feeMetrics = await computeFeeAmortizationMetrics(activePositions, logs);
        const exitSuppressionMetrics = computeExitSuppressionMetrics(logs);
        const edgeHealthMetrics = computeEdgeHealthMetrics(activePositions, logs);
        const regimeMetrics = computeRegimeStateMetrics(logs);
        const preEntryMetrics = computePreEntryFilterMetrics(logs);
        const exposureMetrics = computeExposureTimeMetrics(activePositions, currentBalance, currentBalance);
        const escapeHatchMetrics = computePositionEscapeHatchMetrics(activePositions, logs);
        // Calculate system status
        const lastLogTime = logs.length > 0 ? new Date(logs[0].timestamp).getTime() : 0;
        const timeSinceLastLog = now - lastLogTime;
        let systemStatus = 'SYSTEM ONLINE';
        let statusColor = 'var(--success)';
        if (timeSinceLastLog > 10 * 60 * 1000) { // > 10 mins
            systemStatus = 'SYSTEM OFFLINE';
            statusColor = 'var(--danger)';
        }
        else if (timeSinceLastLog > 5 * 60 * 1000) { // > 5 mins
            systemStatus = 'SYSTEM IDLE';
            statusColor = '#facc15'; // Yellow
        }
        res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>DLMM Bot Terminal</title>
        <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤖</text></svg>">
        <meta http-equiv="refresh" content="30">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg-dark: #050505;
            --bg-card: rgba(20, 20, 30, 0.6);
            --accent-primary: #00f2ff; /* Cyan Neon */
            --accent-secondary: #7000ff; /* Electric Purple */
            --text-primary: #ffffff;
            --text-secondary: #94a3b8;
            --success: #00ffa3;
            --danger: #ff0055;
            --glass-border: 1px solid rgba(255, 255, 255, 0.08);
          }

          * { margin: 0; padding: 0; box-sizing: border-box; }
          
          body {
            font-family: 'Inter', sans-serif;
            background-color: var(--bg-dark);
            background-image: 
              radial-gradient(circle at 10% 20%, rgba(112, 0, 255, 0.15) 0%, transparent 20%),
              radial-gradient(circle at 90% 80%, rgba(0, 242, 255, 0.1) 0%, transparent 20%);
            color: var(--text-primary);
            min-height: 100vh;
            padding: 40px;
          }

          .container { max-width: 1600px; margin: 0 auto; }

          /* Typography */
          .font-mono { font-family: 'JetBrains Mono', monospace; }
          .text-gradient {
            background: linear-gradient(135deg, #fff 0%, #94a3b8 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
          }
          .text-accent { color: var(--accent-primary); }
          .text-success { color: var(--success); }
          .text-danger { color: var(--danger); }
          .text-muted { color: var(--text-secondary); }

          /* Header */
          header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
            padding-bottom: 20px;
            border-bottom: var(--glass-border);
          }
          
          .brand {
            display: flex;
            align-items: center;
            gap: 15px;
          }
          
          .brand-icon {
            width: 40px;
            height: 40px;
            background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 1.2em;
            box-shadow: 0 0 20px rgba(0, 242, 255, 0.3);
          }

          .status-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            background: rgba(255, 255, 255, 0.05);
            padding: 8px 16px;
            border-radius: 20px;
            border: 1px solid ${statusColor};
            font-size: 0.85em;
            color: ${statusColor};
            transition: all 0.3s ease;
          }
          
          .status-dot {
            width: 8px;
            height: 8px;
            background: ${statusColor};
            border-radius: 50%;
            box-shadow: 0 0 10px ${statusColor};
            animation: pulse 2s infinite;
          }

          @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
          }

          /* Hero Section */
          .hero-grid {
            display: grid;
            grid-template-columns: 1.5fr 1fr 1fr;
            gap: 24px;
            margin-bottom: 24px;
          }

          .glass-panel {
            background: var(--bg-card);
            backdrop-filter: blur(20px);
            border: var(--glass-border);
            border-radius: 24px;
            padding: 32px;
            position: relative;
            overflow: hidden;
          }
          
          .glass-panel::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
          }

          .metric-label {
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-secondary);
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .metric-value-lg {
            font-size: 3.5em;
            font-weight: 700;
            letter-spacing: -1px;
            line-height: 1;
          }

          .metric-sub {
            margin-top: 12px;
            font-size: 1.1em;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          /* Performance Strip */
          .perf-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 24px;
            margin-bottom: 24px;
          }

          .mini-card {
            background: rgba(255, 255, 255, 0.03);
            border: var(--glass-border);
            border-radius: 16px;
            padding: 20px;
            transition: transform 0.2s;
          }
          
          .mini-card:hover {
            transform: translateY(-2px);
            background: rgba(255, 255, 255, 0.05);
          }

          .mini-value {
            font-size: 1.8em;
            font-weight: 600;
            margin-top: 8px;
          }

          /* Stats Grid */
          .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 24px;
            margin-bottom: 40px;
          }

          /* Active Positions */
          .positions-container {
            background: var(--bg-card);
            border: var(--glass-border);
            border-radius: 24px;
            padding: 32px;
          }

          .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
          }

          .table-header {
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 1fr;
            padding: 0 24px 16px;
            color: var(--text-secondary);
            font-size: 0.85em;
            text-transform: uppercase;
            letter-spacing: 1px;
            border-bottom: var(--glass-border);
          }

          .position-row {
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 1fr;
            padding: 24px;
            border-bottom: 1px solid rgba(255,255,255,0.03);
            align-items: center;
            transition: background 0.2s;
          }

          .position-row:last-child { border-bottom: none; }
          .position-row:hover { background: rgba(255,255,255,0.02); }

          .token-pair {
            display: flex;
            align-items: center;
            gap: 12px;
          }

          .token-icon {
            width: 32px;
            height: 32px;
            background: rgba(255,255,255,0.1);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8em;
          }

          .progress-bar {
            height: 4px;
            background: rgba(255,255,255,0.1);
            border-radius: 2px;
            margin-top: 8px;
            overflow: hidden;
          }

          .progress-fill {
            height: 100%;
            background: var(--accent-primary);
            box-shadow: 0 0 10px var(--accent-primary);
          }

          /* Refresh Timer */
          #refresh-timer {
            position: fixed;
            top: 0;
            left: 0;
            height: 3px;
            background: var(--accent-primary);
            width: 100%;
            z-index: 1000;
            animation: shrink 30s linear infinite;
          }

          @keyframes shrink {
            from { width: 100%; }
            to { width: 0%; }
          }

          /* ═══════════════════════════════════════════════════════════════
             OPERATOR-GRADE OBSERVABILITY — NEW PANEL STYLES
             ═══════════════════════════════════════════════════════════════ */
          
          .operator-section {
            margin-top: 40px;
            padding-top: 32px;
            border-top: var(--glass-border);
          }
          
          .operator-section-title {
            font-size: 1.2em;
            font-weight: 600;
            letter-spacing: 1px;
            text-transform: uppercase;
            color: var(--accent-primary);
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            gap: 12px;
          }
          
          .operator-section-title::before {
            content: '';
            width: 4px;
            height: 20px;
            background: linear-gradient(180deg, var(--accent-primary), var(--accent-secondary));
            border-radius: 2px;
          }
          
          .operator-grid-3 {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-bottom: 24px;
          }
          
          .operator-grid-2 {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            margin-bottom: 24px;
          }
          
          .operator-panel {
            background: var(--bg-card);
            backdrop-filter: blur(20px);
            border: var(--glass-border);
            border-radius: 16px;
            padding: 20px;
            position: relative;
          }
          
          .operator-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid rgba(255,255,255,0.05);
          }
          
          .operator-panel-title {
            font-size: 0.85em;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
          }
          
          .operator-panel-badge {
            font-size: 0.7em;
            padding: 3px 8px;
            border-radius: 10px;
            font-weight: 600;
            text-transform: uppercase;
          }
          
          .badge-green { background: rgba(0, 255, 163, 0.15); color: var(--success); }
          .badge-yellow { background: rgba(250, 204, 21, 0.15); color: #facc15; }
          .badge-red { background: rgba(255, 0, 85, 0.15); color: var(--danger); }
          .badge-cyan { background: rgba(0, 242, 255, 0.15); color: var(--accent-primary); }
          
          .operator-metric-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid rgba(255,255,255,0.03);
          }
          
          .operator-metric-row:last-child { border-bottom: none; }
          
          .operator-metric-label {
            font-size: 0.85em;
            color: var(--text-secondary);
          }
          
          .operator-metric-value {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 600;
            font-size: 0.95em;
          }
          
          .amortization-bar {
            height: 6px;
            background: rgba(255,255,255,0.1);
            border-radius: 3px;
            margin-top: 4px;
            overflow: hidden;
            position: relative;
          }
          
          .amortization-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.3s ease;
          }
          
          .amortization-fill.red { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
          .amortization-fill.yellow { background: #facc15; box-shadow: 0 0 8px #facc15; }
          .amortization-fill.green { background: var(--success); box-shadow: 0 0 8px var(--success); }
          
          .suppression-stat {
            text-align: center;
            padding: 12px;
            background: rgba(255,255,255,0.02);
            border-radius: 8px;
          }
          
          .suppression-stat-value {
            font-family: 'JetBrains Mono', monospace;
            font-size: 1.6em;
            font-weight: 700;
            color: var(--text-primary);
          }
          
          .suppression-stat-label {
            font-size: 0.7em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
            margin-top: 4px;
          }
          
          .mhi-distribution {
            display: flex;
            gap: 8px;
            margin-top: 12px;
          }
          
          .mhi-bar {
            flex: 1;
            height: 8px;
            border-radius: 4px;
            position: relative;
          }
          
          .mhi-bar.green { background: var(--success); }
          .mhi-bar.yellow { background: #facc15; }
          .mhi-bar.red { background: var(--danger); }
          
          .regime-indicator {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 0.9em;
          }
          
          .regime-indicator.BULL { background: rgba(0, 255, 163, 0.15); color: var(--success); }
          .regime-indicator.BEAR { background: rgba(255, 0, 85, 0.15); color: var(--danger); }
          .regime-indicator.NEUTRAL { background: rgba(0, 242, 255, 0.15); color: var(--accent-primary); }
          
          .position-age-bar {
            display: flex;
            height: 6px;
            border-radius: 3px;
            overflow: hidden;
            margin-top: 8px;
          }
          
          .position-age-segment {
            height: 100%;
          }
          
          .age-under1h { background: var(--success); }
          .age-under4h { background: var(--accent-primary); }
          .age-under24h { background: #facc15; }
          .age-over24h { background: var(--accent-secondary); }
          
          .filter-reason-list {
            margin-top: 12px;
          }
          
          .filter-reason-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            font-size: 0.8em;
          }
          
          .filter-reason-name {
            color: var(--text-secondary);
            max-width: 180px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          
          .filter-reason-count {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 600;
            color: var(--danger);
          }

          @media (max-width: 1200px) {
            .hero-grid { grid-template-columns: 1fr; }
            .perf-grid, .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .operator-grid-3 { grid-template-columns: repeat(2, 1fr); }
          }
          
          @media (max-width: 768px) {
            .perf-grid, .stats-grid { grid-template-columns: 1fr; }
            .table-header { display: none; }
            .position-row { grid-template-columns: 1fr; gap: 16px; }
            .operator-grid-3, .operator-grid-2 { grid-template-columns: 1fr; }
          }
        </style>
      </head>
      <body>
        <div id="refresh-timer"></div>
        <div class="container">
          <header>
            <div class="brand">
              <div class="brand-icon">⚡</div>
              <div>
                <h2 style="font-weight: 600; letter-spacing: -0.5px;">DLMM Terminal</h2>
                <div class="text-muted" style="font-size: 0.85em;">v1.0.0 • Paper Trading</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 16px;">
              ${activeRunId ? `
              <div class="font-mono" style="font-size: 0.75em; padding: 6px 12px; background: rgba(0, 242, 255, 0.1); border-radius: 8px; color: var(--accent-primary);">
                RUN: ${activeRunId.slice(0, 20)}...
              </div>
              ` : ''}
              <div class="status-badge">
                <div class="status-dot"></div>
                ${systemStatus}
              </div>
            </div>
          </header>
          
          ${historicalDataCheck.hasHistoricalData ? `
          <!-- Historical Data Warning Banner -->
          <div style="background: rgba(255, 193, 7, 0.1); border: 1px solid rgba(255, 193, 7, 0.3); border-radius: 12px; padding: 16px 24px; margin-bottom: 24px; display: flex; align-items: center; gap: 16px;">
            <div style="font-size: 1.5em;">⚠️</div>
            <div>
              <div style="font-weight: 600; color: #ffc107; margin-bottom: 4px;">Historical Data Detected</div>
              <div style="font-size: 0.85em; color: var(--text-secondary);">
                ${historicalDataCheck.priorTradeCount} trades from ${historicalDataCheck.priorRunCount} prior run(s) exist in database 
                (Total Historical PnL: $${historicalDataCheck.totalHistoricalPnL.toFixed(2)}). 
                These are <strong>NOT</strong> included in current equity calculations.
              </div>
            </div>
          </div>
          ` : ''}

          <!-- Hero Section -->
          <div class="hero-grid">
            <!-- Main P&L (RUN-SCOPED) -->
            <div class="glass-panel" style="background: linear-gradient(160deg, rgba(20,20,30,0.8) 0%, rgba(0,242,255,0.05) 100%);">
              <div class="metric-label">
                Realized PnL (This Run)
                <span style="font-size: 0.75em; padding: 2px 6px; background: rgba(0, 242, 255, 0.15); border-radius: 4px; color: var(--accent-primary);">RUN-SCOPED</span>
              </div>
              <div class="metric-value-lg font-mono ${runRealizedPnL >= 0 ? 'text-success' : 'text-danger'}">
                ${runRealizedPnL >= 0 ? '+' : ''}$${runRealizedPnL.toFixed(2)}
              </div>
              <div class="metric-sub">
                <span class="${runRealizedPnL >= 0 ? 'text-success' : 'text-danger'} font-mono">
                  ${((runRealizedPnL / startingBalance) * 100).toFixed(2)}% ROI
                </span>
                <span class="text-muted">• This Run Only</span>
              </div>
            </div>

            <!-- Net Equity (RUN-SCOPED) -->
            <div class="glass-panel">
              <div class="metric-label">
                Net Equity
                <span style="font-size: 0.75em; padding: 2px 6px; background: rgba(0, 255, 163, 0.15); border-radius: 4px; color: var(--success);">ACCOUNTING-CORRECT</span>
              </div>
              <div class="metric-value-lg font-mono" style="font-size: 2.5em;">
                $${currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div class="metric-sub text-muted">
                Starting Capital: $${startingBalance.toLocaleString()}
              </div>
            </div>

            <!-- Deployment -->
            <div class="glass-panel">
              <div class="metric-label">Capital Utilization</div>
              <div class="metric-value-lg font-mono" style="font-size: 2.5em;">
                ${((totalDeployed / currentBalance) * 100).toFixed(1)}%
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${((totalDeployed / currentBalance) * 100)}%"></div>
              </div>
              <div class="metric-sub text-muted" style="justify-content: space-between;">
                <span>Deployed: $${totalDeployed.toFixed(0)}</span>
                <span class="text-accent">Free: $${availableCapital.toFixed(0)}</span>
              </div>
            </div>
          </div>

          <!-- Performance Strip -->
          <div class="perf-grid">
            <div class="mini-card">
              <div class="metric-label">24h Profit</div>
              <div class="mini-value font-mono ${dailyPnL >= 0 ? 'text-success' : 'text-danger'}">
                ${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">7d Profit</div>
              <div class="mini-value font-mono ${weeklyPnL >= 0 ? 'text-success' : 'text-danger'}">
                ${weeklyPnL >= 0 ? '+' : ''}$${weeklyPnL.toFixed(2)}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">30d Profit</div>
              <div class="mini-value font-mono ${monthlyPnL >= 0 ? 'text-success' : 'text-danger'}">
                ${monthlyPnL >= 0 ? '+' : ''}$${monthlyPnL.toFixed(2)}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">Win Rate</div>
              <div class="mini-value font-mono text-accent">
                ${winRate.toFixed(1)}%
              </div>
              <div style="font-size: 0.8em; color: var(--text-secondary); margin-top: 4px;">
                ${wins} Wins / ${losses} Losses
              </div>
            </div>
          </div>

          <!-- Secondary Stats -->
          <div class="stats-grid">
            <div class="mini-card">
              <div class="metric-label">Avg Daily Return</div>
              <div class="mini-value font-mono text-success">
                ${(dailyPnL / startingBalance * 100).toFixed(2)}%
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">Avg Trade Win</div>
              <div class="mini-value font-mono text-success">
                +$${avgWin.toFixed(2)}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">Total Trades</div>
              <div class="mini-value font-mono">
                ${totalTrades}
              </div>
            </div>
            <div class="mini-card">
              <div class="metric-label">Active Positions</div>
              <div class="mini-value font-mono text-accent">
                ${activePositions.length}<span style="font-size: 0.6em; color: var(--text-secondary);">/5</span>
              </div>
            </div>
          </div>

          <!-- Active Positions Table -->
          <div class="positions-container">
            <div class="section-header">
              <h3 style="font-weight: 600;">Active Market Positions</h3>
              <div class="text-muted font-mono" style="font-size: 0.85em;">
                Last Updated: ${toEST(new Date()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} EST
              </div>
            </div>

            ${activePositions.length > 0 ? `
              <div class="table-header">
                <div>Pool / Strategy</div>
                <div style="text-align: right;">Allocation</div>
                <div style="text-align: right;">Score</div>
                <div style="text-align: right;">Entry Time</div>
              </div>
              ${activePositions.map(pos => `
                <div class="position-row">
                  <div class="token-pair">
                    <div class="token-icon">⚡</div>
                    <div>
                      <div style="font-weight: 600; color: #fff;">${pos.poolName}</div>
                      <div style="font-size: 0.85em; color: var(--accent-primary);">${pos.type}</div>
                    </div>
                  </div>
                  <div style="text-align: right;">
                    <div class="font-mono" style="font-weight: 600;">$${pos.amount.toFixed(0)}</div>
                    <div style="font-size: 0.8em; color: var(--text-secondary);">${((pos.amount / currentBalance) * 100).toFixed(1)}% alloc</div>
                  </div>
                  <div style="text-align: right;">
                    <div class="font-mono text-accent" style="font-weight: 600;">${pos.score.toFixed(1)}</div>
                    <div style="font-size: 0.8em; color: var(--text-secondary);">/ 100.0</div>
                  </div>
                  <div style="text-align: right;">
                    <div class="font-mono" style="color: var(--text-secondary);">
                      ${toEST(new Date(pos.entryTime)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              `).join('')}
            ` : `
              <div class="empty-state" style="padding: 60px; text-align: center; color: var(--text-secondary);">
                <div style="font-size: 2em; margin-bottom: 16px; opacity: 0.5;">🔭</div>
                <div>Scanning market for opportunities...</div>
              </div>
            `}
          </div>

          <!-- ═══════════════════════════════════════════════════════════════════════════════
               OPERATOR-GRADE OBSERVABILITY SECTION
               Control Plane for Autonomous Capital Deployment
               ═══════════════════════════════════════════════════════════════════════════════ -->
          
          <div class="operator-section">
            <div class="operator-section-title">Control Plane Observability</div>
            
            <!-- Row 1: Fee & Cost Amortization + Exit Suppression + Edge Health -->
            <div class="operator-grid-3">
              
              <!-- Panel 1: Fee & Cost Amortization -->
              <div class="operator-panel">
                <div class="operator-panel-header">
                  <span class="operator-panel-title">Fee Amortization</span>
                  <span class="operator-panel-badge ${feeMetrics.avgAmortizationPct >= 100 ? 'badge-green' : feeMetrics.avgAmortizationPct >= 50 ? 'badge-yellow' : 'badge-red'}">
                    ${feeMetrics.avgAmortizationPct >= 100 ? 'AMORTIZED' : feeMetrics.avgAmortizationPct >= 50 ? 'PARTIAL' : 'ACCRUING'}
                  </span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Total Fees Accrued</span>
                  <span class="operator-metric-value text-success">$${feeMetrics.totalFeesAccrued.toFixed(2)}</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Avg Fee / Position</span>
                  <span class="operator-metric-value">$${feeMetrics.avgFeesPerPosition.toFixed(2)}</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Avg Cost Target</span>
                  <span class="operator-metric-value">$${feeMetrics.avgCostTarget.toFixed(2)}</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Amortization Progress</span>
                  <span class="operator-metric-value ${feeMetrics.avgAmortizationPct >= 100 ? 'text-success' : feeMetrics.avgAmortizationPct >= 50 ? '' : 'text-danger'}">${feeMetrics.avgAmortizationPct.toFixed(1)}%</span>
                </div>
                <div class="amortization-bar">
                  <div class="amortization-fill ${feeMetrics.avgAmortizationPct >= 100 ? 'green' : feeMetrics.avgAmortizationPct >= 50 ? 'yellow' : 'red'}" 
                       style="width: ${Math.min(100, feeMetrics.avgAmortizationPct)}%"></div>
                </div>
                <div class="operator-metric-row" style="margin-top: 8px;">
                  <span class="operator-metric-label">Fee Velocity</span>
                  <span class="operator-metric-value text-accent">$${feeMetrics.feeVelocityPerHour.toFixed(3)}/hr</span>
                </div>
              </div>
              
              <!-- Panel 2: Exit Suppression Diagnostics -->
              <div class="operator-panel">
                <div class="operator-panel-header">
                  <span class="operator-panel-title">Exit Suppression (24h)</span>
                  <span class="operator-panel-badge badge-cyan">${exitSuppressionMetrics.exitSignalsTriggered24h} SIGNALS</span>
                </div>
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;">
                  <div class="suppression-stat">
                    <div class="suppression-stat-value">${exitSuppressionMetrics.exitSignalsTriggered24h}</div>
                    <div class="suppression-stat-label">Triggered</div>
                  </div>
                  <div class="suppression-stat">
                    <div class="suppression-stat-value text-success">${exitSuppressionMetrics.exitsExecuted24h}</div>
                    <div class="suppression-stat-label">Executed</div>
                  </div>
                  <div class="suppression-stat">
                    <div class="suppression-stat-value text-danger">${exitSuppressionMetrics.exitSignalsTriggered24h - exitSuppressionMetrics.exitsExecuted24h}</div>
                    <div class="suppression-stat-label">Suppressed</div>
                  </div>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">COST_NOT_AMORTIZED</span>
                  <span class="operator-metric-value text-danger">${exitSuppressionMetrics.suppressedCostNotAmortized}</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">MIN_HOLD / DEFENSE</span>
                  <span class="operator-metric-value">${exitSuppressionMetrics.suppressedMinHold + exitSuppressionMetrics.suppressedDefenseRegime}</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">HOLD_MODE</span>
                  <span class="operator-metric-value">${exitSuppressionMetrics.suppressedHoldMode}</span>
                </div>
              </div>
              
              <!-- Panel 3: Edge Health Metrics -->
              <div class="operator-panel">
                <div class="operator-panel-header">
                  <span class="operator-panel-title">Edge Health</span>
                  <span class="operator-panel-badge ${edgeHealthMetrics.avgMHI >= 0.6 ? 'badge-green' : edgeHealthMetrics.avgMHI >= 0.35 ? 'badge-yellow' : 'badge-red'}">
                    ${edgeHealthMetrics.avgMHI >= 0.6 ? 'HEALTHY' : edgeHealthMetrics.avgMHI >= 0.35 ? 'DEGRADED' : 'CRITICAL'}
                  </span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Avg MHI (Active)</span>
                  <span class="operator-metric-value ${edgeHealthMetrics.avgMHI >= 0.6 ? 'text-success' : edgeHealthMetrics.avgMHI >= 0.35 ? '' : 'text-danger'}">${(edgeHealthMetrics.avgMHI * 100).toFixed(1)}%</span>
                </div>
                <div style="margin: 12px 0;">
                  <div style="font-size: 0.75em; color: var(--text-secondary); margin-bottom: 4px;">MHI Distribution</div>
                  <div class="mhi-distribution">
                    <div class="mhi-bar green" style="flex: ${edgeHealthMetrics.mhiDistribution.green || 1};" title="🟢 ${edgeHealthMetrics.mhiDistribution.green}"></div>
                    <div class="mhi-bar yellow" style="flex: ${edgeHealthMetrics.mhiDistribution.yellow || 1};" title="🟡 ${edgeHealthMetrics.mhiDistribution.yellow}"></div>
                    <div class="mhi-bar red" style="flex: ${edgeHealthMetrics.mhiDistribution.red || 1};" title="🔴 ${edgeHealthMetrics.mhiDistribution.red}"></div>
                  </div>
                  <div style="display: flex; justify-content: space-between; font-size: 0.7em; margin-top: 4px;">
                    <span class="text-success">🟢 ${edgeHealthMetrics.mhiDistribution.green}</span>
                    <span style="color: #facc15;">🟡 ${edgeHealthMetrics.mhiDistribution.yellow}</span>
                    <span class="text-danger">🔴 ${edgeHealthMetrics.mhiDistribution.red}</span>
                  </div>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">EV Delta (Exp vs Real)</span>
                  <span class="operator-metric-value ${edgeHealthMetrics.evDelta >= 0 ? 'text-success' : 'text-danger'}">${edgeHealthMetrics.evDelta >= 0 ? '+' : ''}${(edgeHealthMetrics.evDelta * 100).toFixed(1)}%</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Fee Dominance Ratio</span>
                  <span class="operator-metric-value">${edgeHealthMetrics.feeDominanceRatio.toFixed(2)}x</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Avg Score</span>
                  <span class="operator-metric-value text-accent">${edgeHealthMetrics.avgScore.toFixed(1)}</span>
                </div>
              </div>
            </div>
            
            <!-- Row 2: Regime State + Pre-Entry Filters + Exposure Intelligence -->
            <div class="operator-grid-3">
              
              <!-- Panel 4: Regime & System State -->
              <div class="operator-panel">
                <div class="operator-panel-header">
                  <span class="operator-panel-title">Regime & System State</span>
                </div>
                <div style="text-align: center; margin: 16px 0;">
                  <div class="regime-indicator ${regimeMetrics.currentGlobalRegime}">
                    ${regimeMetrics.currentGlobalRegime === 'BULL' ? '📈' : regimeMetrics.currentGlobalRegime === 'BEAR' ? '📉' : '➡️'}
                    ${regimeMetrics.currentGlobalRegime}
                  </div>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Positions Aligned</span>
                  <span class="operator-metric-value">${regimeMetrics.positionsAlignedPct}%</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Regime Transitions (24h)</span>
                  <span class="operator-metric-value">${regimeMetrics.recentTransitions.length}</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Defense Mode</span>
                  <span class="operator-metric-value ${regimeMetrics.defenseModeActive ? 'text-danger' : 'text-success'}">${regimeMetrics.defenseModeActive ? '🔴 ON' : '🟢 OFF'}</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Kill Switch</span>
                  <span class="operator-metric-value ${regimeMetrics.killSwitchActive ? 'text-danger' : 'text-success'}">${regimeMetrics.killSwitchActive ? '🔴 ACTIVE' : '🟢 OFF'}</span>
                </div>
              </div>
              
              <!-- Panel 5: Pre-Entry & Tier-5 Filters -->
              <div class="operator-panel">
                <div class="operator-panel-header">
                  <span class="operator-panel-title">Entry Filters (24h)</span>
                  <span class="operator-panel-badge badge-cyan">PEPF</span>
                </div>
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 12px;">
                  <div class="suppression-stat">
                    <div class="suppression-stat-value text-success">${preEntryMetrics.pepfPassCount}</div>
                    <div class="suppression-stat-label">Passed</div>
                  </div>
                  <div class="suppression-stat">
                    <div class="suppression-stat-value text-danger">${preEntryMetrics.pepfRejectCount}</div>
                    <div class="suppression-stat-label">Rejected</div>
                  </div>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Active Cooldowns</span>
                  <span class="operator-metric-value">${preEntryMetrics.activeCooldowns}</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Tier-5 Relaxations</span>
                  <span class="operator-metric-value text-accent">${preEntryMetrics.tier5RelaxationCount}</span>
                </div>
                ${preEntryMetrics.topRejectReasons.length > 0 ? `
                  <div class="filter-reason-list">
                    <div style="font-size: 0.75em; color: var(--text-secondary); margin-bottom: 8px;">Top Reject Reasons</div>
                    ${preEntryMetrics.topRejectReasons.slice(0, 3).map(r => `
                      <div class="filter-reason-item">
                        <span class="filter-reason-name">${r.reason}</span>
                        <span class="filter-reason-count">${r.count}</span>
                      </div>
                    `).join('')}
                  </div>
                ` : ''}
              </div>
              
              <!-- Panel 6: Exposure & Time Intelligence -->
              <div class="operator-panel">
                <div class="operator-panel-header">
                  <span class="operator-panel-title">Exposure Intelligence</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Avg Hold Time</span>
                  <span class="operator-metric-value">${exposureMetrics.avgHoldTimeHours.toFixed(1)}h</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Idle Capital</span>
                  <span class="operator-metric-value ${exposureMetrics.idleCapitalPct > 80 ? 'text-danger' : exposureMetrics.idleCapitalPct > 50 ? '' : 'text-success'}">${exposureMetrics.idleCapitalPct.toFixed(1)}%</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Capital Efficiency</span>
                  <span class="operator-metric-value text-accent">${exposureMetrics.capitalEfficiency.toFixed(1)}%</span>
                </div>
                <div class="operator-metric-row">
                  <span class="operator-metric-label">Time-Weighted Exposure</span>
                  <span class="operator-metric-value">$${exposureMetrics.timeWeightedExposure.toFixed(0)}</span>
                </div>
                <div style="margin-top: 12px;">
                  <div style="font-size: 0.75em; color: var(--text-secondary); margin-bottom: 4px;">Position Age Distribution</div>
                  <div class="position-age-bar">
                    <div class="position-age-segment age-under1h" style="flex: ${exposureMetrics.positionAgeDistribution.under1h || 0.1};"></div>
                    <div class="position-age-segment age-under4h" style="flex: ${exposureMetrics.positionAgeDistribution.under4h || 0.1};"></div>
                    <div class="position-age-segment age-under24h" style="flex: ${exposureMetrics.positionAgeDistribution.under24h || 0.1};"></div>
                    <div class="position-age-segment age-over24h" style="flex: ${exposureMetrics.positionAgeDistribution.over24h || 0.1};"></div>
                  </div>
                  <div style="display: flex; justify-content: space-between; font-size: 0.65em; margin-top: 4px; color: var(--text-secondary);">
                    <span>&lt;1h: ${exposureMetrics.positionAgeDistribution.under1h}</span>
                    <span>&lt;4h: ${exposureMetrics.positionAgeDistribution.under4h}</span>
                    <span>&lt;24h: ${exposureMetrics.positionAgeDistribution.under24h}</span>
                    <span>&gt;24h: ${exposureMetrics.positionAgeDistribution.over24h}</span>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- Per-Position Amortization Status (if positions exist) -->
            ${activePositions.length > 0 ? `
              <div class="positions-container" style="margin-top: 24px;">
                <div class="section-header">
                  <h3 style="font-weight: 600;">Position Amortization Status</h3>
                  <div class="text-muted font-mono" style="font-size: 0.85em;">
                    Exit Eligibility per Position
                  </div>
                </div>
                <div class="table-header" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr;">
                  <div>Pool</div>
                  <div style="text-align: right;">Fees Accrued</div>
                  <div style="text-align: right;">Cost Target</div>
                  <div style="text-align: right;">Amortization</div>
                  <div style="text-align: right;">Exit Status</div>
                </div>
                ${feeMetrics.positionAmortization.map(pa => `
                  <div class="position-row" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr;">
                    <div class="token-pair">
                      <div class="token-icon" style="background: ${pa.status === 'green' ? 'rgba(0,255,163,0.2)' : pa.status === 'yellow' ? 'rgba(250,204,21,0.2)' : 'rgba(255,0,85,0.2)'};">
                        ${pa.status === 'green' ? '✓' : pa.status === 'yellow' ? '◐' : '○'}
                      </div>
                      <div>
                        <div style="font-weight: 600; color: #fff;">${pa.poolName}</div>
                      </div>
                    </div>
                    <div style="text-align: right;">
                      <div class="font-mono text-success">$${pa.feesAccrued.toFixed(2)}</div>
                    </div>
                    <div style="text-align: right;">
                      <div class="font-mono">$${pa.costTarget.toFixed(2)}</div>
                    </div>
                    <div style="text-align: right;">
                      <div class="font-mono ${pa.status === 'green' ? 'text-success' : pa.status === 'yellow' ? '' : 'text-danger'}">${pa.amortizationPct.toFixed(1)}%</div>
                      <div class="amortization-bar" style="width: 60px; margin-left: auto;">
                        <div class="amortization-fill ${pa.status}" style="width: ${Math.min(100, pa.amortizationPct)}%"></div>
                      </div>
                    </div>
                    <div style="text-align: right;">
                      <span class="operator-panel-badge ${pa.status === 'green' ? 'badge-green' : pa.status === 'yellow' ? 'badge-yellow' : 'badge-red'}">
                        ${pa.status === 'green' ? 'EXIT OK' : pa.status === 'yellow' ? 'HOLD' : 'LOCKED'}
                      </span>
                    </div>
                  </div>
                `).join('')}
              </div>
            ` : ''}
            
            <!-- Per-Position Exit Suppression Escape Hatch Status -->
            ${activePositions.length > 0 && escapeHatchMetrics.length > 0 ? `
              <div class="positions-container" style="margin-top: 24px;">
                <div class="section-header">
                  <h3 style="font-weight: 600;">Exit Suppression Safety</h3>
                  <div class="text-muted font-mono" style="font-size: 0.85em;">
                    Escape Hatch Metrics per Position
                  </div>
                </div>
                <div class="table-header" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr 1fr 1fr;">
                  <div>Pool</div>
                  <div style="text-align: center;">Exit State</div>
                  <div style="text-align: right;">Exit Duration</div>
                  <div style="text-align: right;">Suppress Count</div>
                  <div style="text-align: right;">Fee Velocity</div>
                  <div style="text-align: right;">Time to Amortize</div>
                  <div style="text-align: center;">Staleness</div>
                </div>
                ${escapeHatchMetrics.map(eh => {
            const exitStateBadge = eh.exitState === 'HOLD'
                ? 'badge-green'
                : eh.exitState === 'FORCED_EXIT_PENDING'
                    ? 'badge-red'
                    : 'badge-yellow';
            const exitStateLabel = eh.exitState === 'HOLD'
                ? 'HOLD'
                : eh.exitState === 'FORCED_EXIT_PENDING'
                    ? 'FORCE PENDING'
                    : 'EXIT TRIGGERED';
            const ttaDisplay = eh.timeToCostTargetMin === null
                ? '∞'
                : eh.timeToCostTargetMin === 0
                    ? '0 (amortized)'
                    : `${eh.timeToCostTargetMin}min`;
            const suppressWarning = eh.suppressCapRemaining < 20 ? 'text-danger' : eh.suppressCapRemaining < 40 ? '' : 'text-success';
            const ttlWarning = eh.ttlRemainingMin !== null && eh.ttlRemainingMin < 15 ? 'text-danger' : '';
            return `
                  <div class="position-row" style="grid-template-columns: 1.5fr 1fr 1fr 1fr 1fr 1fr 1fr;">
                    <div class="token-pair">
                      <div class="token-icon" style="background: ${eh.exitState === 'HOLD' ? 'rgba(0,255,163,0.2)' : eh.exitState === 'FORCED_EXIT_PENDING' ? 'rgba(255,0,85,0.2)' : 'rgba(250,204,21,0.2)'};">
                        ${eh.exitState === 'HOLD' ? '✓' : eh.exitState === 'FORCED_EXIT_PENDING' ? '⚠' : '◐'}
                      </div>
                      <div>
                        <div style="font-weight: 600; color: #fff;">${eh.poolName}</div>
                      </div>
                    </div>
                    <div style="text-align: center;">
                      <span class="operator-panel-badge ${exitStateBadge}">${exitStateLabel}</span>
                    </div>
                    <div style="text-align: right;">
                      <div class="font-mono ${ttlWarning}">${eh.exitTriggeredDurationMin}min</div>
                      ${eh.ttlRemainingMin !== null ? `<div style="font-size: 0.7em; color: var(--text-secondary);">TTL: ${eh.ttlRemainingMin}min</div>` : ''}
                    </div>
                    <div style="text-align: right;">
                      <div class="font-mono ${suppressWarning}">${eh.exitSuppressCountRolling}/60</div>
                      <div style="font-size: 0.7em; color: var(--text-secondary);">in 30min</div>
                    </div>
                    <div style="text-align: right;">
                      <div class="font-mono text-accent">$${eh.feeVelocityUsdPerHr.toFixed(4)}/hr</div>
                    </div>
                    <div style="text-align: right;">
                      <div class="font-mono ${eh.economicStaleness ? 'text-danger' : ''}">${ttaDisplay}</div>
                    </div>
                    <div style="text-align: center;">
                      <span class="operator-panel-badge ${eh.economicStaleness ? 'badge-red' : 'badge-green'}">
                        ${eh.economicStaleness ? 'STALE' : 'OK'}
                      </span>
                    </div>
                  </div>
                  `;
        }).join('')}
              </div>
            ` : ''}
          </div>
          
        </div>
      </body>
      </html>
    `);
    }
    catch (error) {
        res.status(500).send('Error fetching dashboard data');
    }
});
app.listen(PORT, () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
});
//# sourceMappingURL=server.js.map