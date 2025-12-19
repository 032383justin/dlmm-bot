# Adaptive Capital Manager — Migration Guide

## Summary

This upgrade transforms the bot from a conservative prototype to a **capital-efficient, regime-aware, adaptive-capacity production system** that addresses the "fees accrued is painfully slow" problem by intelligently increasing deployed capital while maintaining strict safety controls.

### Key Changes

1. **New Adaptive Capital Manager** (`src/risk/capitalManager.ts`)
   - Dynamic deployment caps: 25% (stress) → 40% (normal) → 60% (unlocked)
   - 35% hard reserve (never deployed)
   - Per-pool concentration caps: 8% (neutral/bull), 5% (bear)
   - Position sizing driven by fee amortization economics
   - Warmup rules after startup and cooldown

2. **Confidence Scoring** (`src/risk/confidenceScore.ts`)
   - Deterministic metrics-based confidence (no ML)
   - Unlocks max capacity when conditions are favorable
   - Tracks exit suppression rate, forced exit rate, health scores, market health

3. **Rate-Limited Logging** (`src/utils/rateLimitedLogger.ts`)
   - Reduces EXIT_TRIGGERED + EXIT-SUPPRESS spam from every 10s to max once per 60s
   - Tracks suppression counts and emits periodic summaries
   - Preserves full observability while reducing noise

4. **Integration Layer** (`src/risk/capitalIntegration.ts`)
   - Drop-in functions for ScanLoop integration
   - Backwards-compatible adapters for existing code

---

## Production Constants

```typescript
// Deployment Caps
MIN_TOTAL_DEPLOY_CAP = 0.25   // 25% — stress/recovery mode
BASE_TOTAL_DEPLOY_CAP = 0.40  // 40% — normal operation
MAX_TOTAL_DEPLOY_CAP = 0.60   // 60% — high confidence only
HARD_RESERVE_PCT = 0.35       // 35% — NEVER deployed

// Per-Pool Caps
PER_POOL_MAX_PCT = 0.08       // 8% — neutral/bull
PER_POOL_MAX_PCT_BEAR = 0.05  // 5% — bear regime
MAX_SINGLE_POSITION_PCT = 0.06 // 6% — single position max

// Position Sizing (USD)
MIN_POSITION_USD = 400        // Avoid tiny positions
TARGET_POSITION_USD_NEUTRAL = 900
TARGET_POSITION_USD_BULL = 1200
TARGET_POSITION_USD_BEAR = 600

// Amortization
TARGET_HOURS_TO_AMORTIZE = 2.5
MAX_HOURS_TO_AMORTIZE = 6.0
```

---

## Integration Steps

### Step 1: Add Imports to ScanLoop

Add to the imports section of `src/runtime/scanLoop.ts`:

```typescript
import {
    initializeCapitalIntegration,
    updateCapitalManagerCycle,
    getAdaptivePositionSize,
    recordPositionEntry,
    recordPositionExit,
    recordExitTriggered,
    recordExitSuppressed,
    recordExitExecuted,
    recordForcedExit,
    recordPositionHealth,
    logFullCapitalStatus,
    getDynamicDeployCapPct,
    CAPITAL_CONFIG,
} from '../risk';
```

### Step 2: Initialize at Startup

In the `start()` method after loading active trades:

```typescript
// Initialize Adaptive Capital Manager
const equity = await capitalManager.getEquity();
const existingPositions = activeTrades.map(t => ({
    poolAddress: t.pool,
    sizeUsd: t.size,
}));
initializeCapitalIntegration(equity, existingPositions);
```

### Step 3: Update Each Cycle

At the start of `runScanCycle()`:

```typescript
// Update capital manager with current state
updateCapitalManagerCycle(
    rotationEquity,
    currentRegime,        // MarketRegime from Tier4
    killSwitchActive,     // boolean from evaluateKillSwitch
    cooldownEndTimeMs,    // from kill switch state
    marketHealth,         // from kill switch debug
    aliveRatio            // from kill switch debug
);
```

### Step 4: Use Adaptive Position Sizing

Replace existing position sizing with:

```typescript
// Get adaptive position size
const sizingResult = getAdaptivePositionSize(
    pool.address,
    pool.name,
    pool.liquidity || 0,
    estimatedEntryFeesUsd,
    estimatedExitFeesUsd,
    estimatedSlippageUsd
);

if (!sizingResult.allowed) {
    logger.info(`[ENTRY-BLOCKED] ${pool.name}: ${sizingResult.reason}`);
    continue;
}

const entrySize = sizingResult.sizeUsd;
```

### Step 5: Record Confidence Events

Throughout the code, record events for confidence calculation:

```typescript
// On exit triggered
recordExitTriggered();

// On exit suppressed
recordExitSuppressed();

// On exit executed
recordExitExecuted();

// On forced exit
recordForcedExit();

// On position health check
recordPositionHealth(healthScore);
```

### Step 6: Record Position Entries/Exits

```typescript
// After successful entry
recordPositionEntry(poolAddress, sizeUsd);

// After successful exit
recordPositionExit(poolAddress, sizeUsd, feesAccruedUsd, holdTimeMs);
```

---

## Environment Variables

No new environment variables required. The system uses the existing:
- `PAPER_CAPITAL` — Initial equity
- `PAPER_TRADING` — Paper trading mode

Optional tuning (not required):
```env
# Disable capital manager (emergency only)
DISABLE_ADAPTIVE_CAPITAL=true
```

---

## Sanity Checklist

After deployment, verify in logs:

### 1. Dynamic Cap Values Printed
```
[CAPITAL-MGR] 🟡 cap=40% deployed=12.3% avail=27.7% reserve=35% conf=68% regime=NEUTRAL poolCap=8%
```

### 2. Reduced Log Spam
- No more repeated `[EXIT-SUPPRESS]` every 10s for same trade
- Instead see: `[EXIT-SUPPRESS] pool=... reason=COST_NOT_AMORTIZED ... (suppressed=12 last60s)`

### 3. Position Sizes Increased
```
[POSITION] Adaptive size: $900 (was ~$200-300)
```

### 4. Amortization Time Reduced
```
[SIZING] costTarget=$3.50 expectedFeeRate=$0.35/hr estimatedAmortization=2.5h
```
vs previous 8-12+ hours

### 5. No Cap Violations
- No `[CAPITAL-MGR-INVARIANT]` error logs
- Deployed % never exceeds dynamic cap
- Reserve always maintained at 35%+

### 6. Confidence Score Tracking
```
[CONFIDENCE] score=72% exitSuppress=85% forcedExit=5% health=68% mktHealth=42 aliveRatio=45%
```

### 7. Warmup Behavior
After restart, first 15 minutes show:
```
[CAPITAL-MGR] 🌡️ cap=25% ... warmup=45%
```

### 8. Regime-Aware Caps
- BULL: poolCap=8%, larger positions
- BEAR: poolCap=5%, smaller positions
- Stress: cap drops to 25%

### 9. Max Capacity Unlock
When confidence high:
```
[CAPITAL-MGR] 🟢 cap=60% ... UNLOCKED
```

### 10. Log Summary Emissions
Every 5 minutes:
```
[LOG-SUMMARY] Suppressed logs: EXIT-SUPPRESS=47(3 keys) | EXIT-TRIGGERED=12(3 keys)
```

---

## Rollback Procedure

If issues arise:

1. Set `DISABLE_ADAPTIVE_CAPITAL=true` in environment
2. Restart bot
3. The system will fall back to existing sizing logic

Or revert the ScanLoop imports and use the original `calculatePositionSize()` method.

---

## Architecture Notes

### Capital Flow
```
Total Equity ($10,000)
├── Hard Reserve (35%) = $3,500 — NEVER DEPLOYED
└── Deployable (65%) = $6,500
    ├── Current Dynamic Cap (40%) = $4,000
    │   ├── Currently Deployed = $1,230
    │   └── Available Capacity = $2,770
    └── Max Unlockable (60%) = $6,000 (when confidence high)
```

### Position Sizing Flow
```
1. Compute base size from regime target ($900 neutral)
2. Adjust for amortization requirements
3. Apply warmup scaling if active
4. Apply regime multipliers
5. Cap to per-pool max (8%)
6. Cap to portfolio remaining capacity
7. Cap to hard reserve
8. Enforce minimum ($400) or skip entry
```

### Confidence Unlock Requirements (ALL must be true for 45 min window)
- marketHealth >= 35
- aliveRatio >= 35%
- forcedExitRate <= 10%
- exitSuppressionRate >= 60%
- avgHealthScore >= 55%

---

## Files Changed/Added

### New Files
- `src/risk/capitalManager.ts` — Adaptive capital manager
- `src/risk/confidenceScore.ts` — Confidence scoring
- `src/risk/capitalIntegration.ts` — ScanLoop integration bridge
- `src/utils/rateLimitedLogger.ts` — Rate-limited logging

### Modified Files
- `src/risk/index.ts` — Added new exports
- `src/capital/exitHysteresis.ts` — Use rate-limited logging

### No Changes Required (backwards compatible)
- `src/runtime/scanLoop.ts` — Integration is additive
- `src/engine/ExecutionEngine.ts` — No changes needed
- `src/services/capitalManager.ts` — Existing DB manager unchanged

