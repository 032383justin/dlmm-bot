/**
 * Exit Intent Latch — State Machine Stabilization for Exit Thrashing
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONTROL-PLANE FIX: Prevent exit-trigger re-evaluation thrashing
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PROBLEM:
 *   When an exit condition is detected but suppressed (e.g., COST_NOT_AMORTIZED),
 *   the system re-evaluates the same exit condition every tick, causing:
 *   - Log spam (repeated EXIT_TRIGGERED logs)
 *   - CPU thrashing (wasted computation)
 *   - Indefinite badSamples increment
 *   - No stable "suppressed but pending" state
 * 
 * SOLUTION:
 *   1. Latch exit intent on first detection
 *   2. Set cooldown when suppressed
 *   3. Skip re-evaluation during cooldown
 *   4. Only re-evaluate after cooldown if conditions changed materially
 * 
 * EXIT INTENT LIFECYCLE:
 *   1. Exit condition detected → latchExitIntent()
 *   2. If suppressed → setSuppressed() with cooldown
 *   3. During cooldown → isInCooldown() returns true → COMPLETE SHORT-CIRCUIT
 *      - No harmonic checks
 *      - No badSamples updates
 *      - No exit logs
 *   4. After cooldown → checkReEvaluationCriteria() → allow if conditions changed
 *   5. On exit execution or clear → clearExitIntent()
 * 
 * STATE MACHINE:
 *   NONE → LATCHED → SUPPRESSED (in cooldown) → RE_EVALUATE_PENDING → RESOLVED
 *                                  ↓
 *                          cooldown expired → checkReEvaluationCriteria()
 *                                  ↓
 *                          no change → extend cooldown (back to SUPPRESSED)
 *                          changed → allow re-evaluation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// COOLDOWN CONSTANTS (in milliseconds)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get cooldown seconds from environment or default
 */
const getExitSuppressCooldownMs = (): number => {
    const seconds = parseInt(process.env.EXIT_SUPPRESS_COOLDOWN_SECONDS ?? '900', 10);
    return seconds * 1000;
};

export const EXIT_INTENT_CONFIG = {
    /**
     * Cooldown for harmonic/microstructure exits
     * Updated to 15 minutes (900s) to prevent spam
     * Environment override: EXIT_SUPPRESS_COOLDOWN_SECONDS
     */
    HARMONIC_COOLDOWN_MS: getExitSuppressCooldownMs(),
    
    /**
     * Cooldown for Tier-4 structural exits (5-10 minutes)
     * These are more serious but may still recover
     */
    TIER4_STRUCTURAL_COOLDOWN_MS: 5 * 60_000, // 5 minutes
    
    /**
     * Cooldown for cost amortization suppression
     * Updated to 15 minutes to align with spec
     * Environment override: EXIT_SUPPRESS_COOLDOWN_SECONDS
     */
    COST_AMORTIZATION_COOLDOWN_MS: getExitSuppressCooldownMs(),
    
    /**
     * Cooldown for regime-based suppression (5 minutes)
     */
    REGIME_COOLDOWN_MS: 5 * 60_000, // 5 minutes
    
    /**
     * Default cooldown for unknown suppression types
     * Updated to 15 minutes
     */
    DEFAULT_COOLDOWN_MS: getExitSuppressCooldownMs(),
    
    /**
     * Maximum cooldown extension count
     * Prevents infinite suppression loops
     */
    MAX_COOLDOWN_EXTENSIONS: 3,
    
    /**
     * Log prefix for observability
     */
    LOG_PREFIX: '[EXIT-INTENT]',
    
    /**
     * Enable silent mode for suppressed intents (no repeated logs)
     * When true, cooldown cycles are completely silent
     */
    SILENT_COOLDOWN: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exit reason categories for cooldown selection
 */
export type ExitReasonCategory = 
    | 'HARMONIC'
    | 'MICROSTRUCTURE'
    | 'TIER4_STRUCTURAL'
    | 'COST_AMORTIZATION'
    | 'REGIME'
    | 'RECOVERY'    // Crash-recovery exits (RECOVERY_EXIT, MTM_ERROR_EXIT)
    | 'UNKNOWN';

/**
 * Suppression reason for tracking
 */
export type SuppressionType =
    | 'COST_NOT_AMORTIZED'
    | 'MIN_HOLD_TIME'
    | 'HOLD_MODE'
    | 'VSH_SUPPRESSION'
    | 'OTHER';

/**
 * Exit intent state machine states
 */
export type ExitIntentState = 
    | 'LATCHED'        // Exit condition detected, not yet suppressed
    | 'SUPPRESSED'     // Exit suppressed, in cooldown
    | 'PENDING_REEVAL' // Cooldown expired, waiting for re-evaluation
    | 'RESOLVED';      // Exit executed or cleared

/**
 * Exit intent state per trade
 */
export interface ExitIntent {
    tradeId: string;
    poolAddress: string;
    
    /** Exit reason that triggered the intent */
    reason: string;
    
    /** Category of exit for cooldown selection */
    category: ExitReasonCategory;
    
    /** Timestamp when exit was first detected */
    detectedAt: number;
    
    /** Current state machine state */
    state: ExitIntentState;
    
    /** Whether exit is currently suppressed */
    suppressed: boolean;
    
    /** Type of suppression applied */
    suppressionType?: SuppressionType;
    
    /** Cooldown end timestamp (suppressed until this time) */
    suppressedUntil?: number;
    
    /** Number of cooldown extensions applied */
    cooldownExtensions: number;
    
    /** Metrics at detection for change comparison */
    detectionMetrics: ExitIntentMetrics;
    
    /** Whether intent has been logged (once per latch) */
    logged: boolean;
    
    /** Whether suppression has been logged (once per suppression) */
    suppressionLogged: boolean;
    
    /** Track if this intent has ever been suppressed (for attribution) */
    wasEverSuppressed: boolean;
}

/**
 * Metrics captured at exit detection for re-evaluation comparison
 */
export interface ExitIntentMetrics {
    regime?: string;
    feeAccrued?: number;
    tierScore?: number;
    healthScore?: number;
    badSamples?: number;
}

/**
 * Result of re-evaluation check
 */
export interface ReEvaluationResult {
    shouldReEvaluate: boolean;
    reason: string;
    changedMetrics: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In-memory exit intent storage
 * Map: tradeId -> ExitIntent
 */
const exitIntentMap = new Map<string, ExitIntent>();

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify exit reason into a category for cooldown selection
 */
export function classifyExitReason(reason: string): ExitReasonCategory {
    const reasonLower = reason.toLowerCase();
    
    if (reasonLower.includes('harmonic') || 
        reasonLower.includes('health') ||
        reasonLower.includes('badsample')) {
        return 'HARMONIC';
    }
    
    if (reasonLower.includes('microstructure') ||
        reasonLower.includes('fee_intensity') ||
        reasonLower.includes('swap_velocity') ||
        reasonLower.includes('bin_offset')) {
        return 'MICROSTRUCTURE';
    }
    
    if (reasonLower.includes('tier4') ||
        reasonLower.includes('score_drop') ||
        reasonLower.includes('migration')) {
        return 'TIER4_STRUCTURAL';
    }
    
    if (reasonLower.includes('cost') ||
        reasonLower.includes('amortiz')) {
        return 'COST_AMORTIZATION';
    }
    
    if (reasonLower.includes('regime')) {
        return 'REGIME';
    }
    
    // Recovery exits (crash-safe recovery)
    if (reasonLower.includes('recovery') ||
        reasonLower.includes('reconcile') ||
        reasonLower.includes('mtm_error')) {
        return 'RECOVERY';
    }
    
    return 'UNKNOWN';
}

/**
 * Get cooldown duration based on exit category
 */
export function getCooldownForCategory(category: ExitReasonCategory): number {
    switch (category) {
        case 'HARMONIC':
        case 'MICROSTRUCTURE':
            return EXIT_INTENT_CONFIG.HARMONIC_COOLDOWN_MS;
        case 'TIER4_STRUCTURAL':
            return EXIT_INTENT_CONFIG.TIER4_STRUCTURAL_COOLDOWN_MS;
        case 'COST_AMORTIZATION':
            return EXIT_INTENT_CONFIG.COST_AMORTIZATION_COOLDOWN_MS;
        case 'REGIME':
            return EXIT_INTENT_CONFIG.REGIME_COOLDOWN_MS;
        case 'RECOVERY':
            // Recovery exits happen at startup — no cooldown needed
            return 0;
        default:
            return EXIT_INTENT_CONFIG.DEFAULT_COOLDOWN_MS;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if there's an active exit intent for a trade
 */
export function hasExitIntent(tradeId: string): boolean {
    return exitIntentMap.has(tradeId);
}

/**
 * Get exit intent for a trade
 */
export function getExitIntent(tradeId: string): ExitIntent | undefined {
    return exitIntentMap.get(tradeId);
}

/**
 * Check if exit intent is in cooldown (should skip re-evaluation)
 */
export function isInCooldown(tradeId: string): boolean {
    const intent = exitIntentMap.get(tradeId);
    if (!intent || !intent.suppressed || !intent.suppressedUntil) {
        return false;
    }
    return Date.now() < intent.suppressedUntil;
}

/**
 * Latch exit intent on first detection.
 * Returns true if this is a new intent, false if already latched.
 * 
 * STATE TRANSITION: NONE → LATCHED
 */
export function latchExitIntent(
    tradeId: string,
    poolAddress: string,
    reason: string,
    metrics: ExitIntentMetrics
): boolean {
    // If already latched with same reason, don't re-latch
    const existing = exitIntentMap.get(tradeId);
    if (existing && existing.reason === reason) {
        return false; // Already latched
    }
    
    const category = classifyExitReason(reason);
    
    const intent: ExitIntent = {
        tradeId,
        poolAddress,
        reason,
        category,
        detectedAt: Date.now(),
        state: 'LATCHED',
        suppressed: false,
        cooldownExtensions: 0,
        detectionMetrics: metrics,
        logged: false,
        suppressionLogged: false,
        wasEverSuppressed: false,
    };
    
    exitIntentMap.set(tradeId, intent);
    
    // Log once on first detection
    logExitIntent(intent, poolAddress);
    intent.logged = true;
    
    return true;
}

/**
 * Mark exit intent as suppressed with cooldown.
 * 
 * STATE TRANSITION: LATCHED → SUPPRESSED
 * 
 * When suppressed:
 * - badSamples will be frozen (caller must call freezeBadSamples)
 * - No exit logs during cooldown
 * - Position remains ACTIVE
 * - Capital remains DEPLOYED
 */
export function setSuppressed(
    tradeId: string,
    suppressionType: SuppressionType,
    customCooldownMs?: number
): void {
    const intent = exitIntentMap.get(tradeId);
    if (!intent) {
        return;
    }
    
    const now = Date.now();
    const cooldownMs = customCooldownMs ?? getCooldownForCategory(intent.category);
    
    intent.state = 'SUPPRESSED';
    intent.suppressed = true;
    intent.suppressionType = suppressionType;
    intent.suppressedUntil = now + cooldownMs;
    intent.wasEverSuppressed = true;
    
    // Log suppression once (first time suppressed for this intent)
    if (!intent.suppressionLogged) {
        logExitSuppressed(intent, cooldownMs);
        intent.suppressionLogged = true;
    }
}

/**
 * Extend cooldown if still suppressed after expiry.
 * 
 * STATE: Remains in SUPPRESSED state with extended cooldown.
 * 
 * @returns true if cooldown was extended, false if max extensions reached
 */
export function extendCooldown(tradeId: string): boolean {
    const intent = exitIntentMap.get(tradeId);
    if (!intent || !intent.suppressed) {
        return false;
    }
    
    if (intent.cooldownExtensions >= EXIT_INTENT_CONFIG.MAX_COOLDOWN_EXTENSIONS) {
        // Transition to PENDING_REEVAL - must re-evaluate now
        intent.state = 'PENDING_REEVAL';
        logger.warn(
            `${EXIT_INTENT_CONFIG.LOG_PREFIX} Max cooldown extensions reached for ` +
            `trade=${tradeId.slice(0, 8)}... — state=PENDING_REEVAL`
        );
        return false;
    }
    
    const now = Date.now();
    const extensionMs = getCooldownForCategory(intent.category);
    intent.suppressedUntil = now + extensionMs;
    intent.cooldownExtensions++;
    
    // Only log if not in silent mode
    if (!EXIT_INTENT_CONFIG.SILENT_COOLDOWN) {
        logCooldownExtended(intent);
    }
    
    return true;
}

/**
 * Clear exit intent (on execution or manual clear).
 * 
 * STATE TRANSITION: Any → RESOLVED (and removed)
 */
export function clearExitIntent(tradeId: string): void {
    const intent = exitIntentMap.get(tradeId);
    if (intent) {
        intent.state = 'RESOLVED';
        logger.debug(
            `${EXIT_INTENT_CONFIG.LOG_PREFIX} RESOLVED trade=${tradeId.slice(0, 8)}... ` +
            `wasEverSuppressed=${intent.wasEverSuppressed}`
        );
    }
    exitIntentMap.delete(tradeId);
}

/**
 * Check if the exit intent should completely short-circuit exit evaluation.
 * 
 * Returns true if:
 * - Intent exists AND is suppressed AND is in cooldown
 * 
 * When this returns true, the caller MUST NOT:
 * - Perform any exit evaluation logic
 * - Increment badSamples
 * - Log any exit messages
 */
export function shouldShortCircuitExit(tradeId: string): boolean {
    const intent = exitIntentMap.get(tradeId);
    if (!intent) {
        return false; // No intent, proceed with normal evaluation
    }
    
    // If suppressed and in cooldown, completely short-circuit
    if (intent.suppressed && intent.suppressedUntil && Date.now() < intent.suppressedUntil) {
        return true;
    }
    
    return false;
}

/**
 * Get the current state of an exit intent
 */
export function getExitIntentState(tradeId: string): ExitIntentState | null {
    const intent = exitIntentMap.get(tradeId);
    return intent?.state ?? null;
}

/**
 * Check if re-evaluation criteria are met after cooldown.
 * 
 * STATE CONSIDERATIONS:
 * - If SUPPRESSED and in cooldown → don't re-evaluate
 * - If SUPPRESSED and cooldown expired → check for material changes
 * - If PENDING_REEVAL → force re-evaluation (max extensions reached)
 */
export function checkReEvaluationCriteria(
    tradeId: string,
    currentMetrics: ExitIntentMetrics
): ReEvaluationResult {
    const intent = exitIntentMap.get(tradeId);
    
    if (!intent) {
        return {
            shouldReEvaluate: true,
            reason: 'No exit intent latched',
            changedMetrics: [],
        };
    }
    
    // If still in cooldown, don't re-evaluate (this should be caught by shouldShortCircuitExit)
    if (isInCooldown(tradeId)) {
        const remaining = (intent.suppressedUntil! - Date.now()) / 1000;
        return {
            shouldReEvaluate: false,
            reason: `Still in cooldown (${remaining.toFixed(0)}s remaining)`,
            changedMetrics: [],
        };
    }
    
    // If PENDING_REEVAL, max extensions reached, must re-evaluate
    if (intent.state === 'PENDING_REEVAL') {
        return {
            shouldReEvaluate: true,
            reason: 'Max cooldown extensions reached - forced re-evaluation',
            changedMetrics: [],
        };
    }
    
    // Check for material changes
    const changedMetrics: string[] = [];
    const detection = intent.detectionMetrics;
    
    // Regime flip (significant change)
    if (detection.regime && currentMetrics.regime && 
        detection.regime !== currentMetrics.regime) {
        changedMetrics.push(`regime: ${detection.regime}→${currentMetrics.regime}`);
    }
    
    // Fee accrual increased meaningfully (>20%)
    if (detection.feeAccrued !== undefined && 
        currentMetrics.feeAccrued !== undefined &&
        currentMetrics.feeAccrued > detection.feeAccrued * 1.2) {
        changedMetrics.push(`fees: $${detection.feeAccrued.toFixed(2)}→$${currentMetrics.feeAccrued.toFixed(2)}`);
    }
    
    // Tier score degraded further (>10% worse)
    if (detection.tierScore !== undefined && 
        currentMetrics.tierScore !== undefined &&
        currentMetrics.tierScore < detection.tierScore * 0.9) {
        changedMetrics.push(`tierScore: ${detection.tierScore.toFixed(1)}→${currentMetrics.tierScore.toFixed(1)}`);
    }
    
    // Health score improved significantly (+0.15 or more)
    if (detection.healthScore !== undefined && 
        currentMetrics.healthScore !== undefined &&
        currentMetrics.healthScore > detection.healthScore + 0.15) {
        changedMetrics.push(`healthScore: ${detection.healthScore.toFixed(2)}→${currentMetrics.healthScore.toFixed(2)}`);
    }
    
    // Only re-evaluate if material changes detected
    // If no changes, extend cooldown and continue suppression
    const shouldReEvaluate = changedMetrics.length > 0;
    
    return {
        shouldReEvaluate,
        reason: changedMetrics.length > 0 
            ? `Material changes detected: ${changedMetrics.join(', ')}`
            : 'No material changes - extend cooldown',
        changedMetrics,
    };
}

/**
 * Get all active exit intents (for debugging/monitoring)
 */
export function getAllExitIntents(): Map<string, ExitIntent> {
    return new Map(exitIntentMap);
}

/**
 * Get summary of exit intents for logging
 */
export function getExitIntentSummary(): {
    total: number;
    suppressed: number;
    inCooldown: number;
    byState: Record<ExitIntentState, number>;
    byCategory: Record<ExitReasonCategory, number>;
} {
    const intents = Array.from(exitIntentMap.values());
    const now = Date.now();
    
    const byCategory: Record<ExitReasonCategory, number> = {
        HARMONIC: 0,
        MICROSTRUCTURE: 0,
        TIER4_STRUCTURAL: 0,
        COST_AMORTIZATION: 0,
        REGIME: 0,
        RECOVERY: 0,
        UNKNOWN: 0,
    };
    
    const byState: Record<ExitIntentState, number> = {
        LATCHED: 0,
        SUPPRESSED: 0,
        PENDING_REEVAL: 0,
        RESOLVED: 0,
    };
    
    let suppressed = 0;
    let inCooldown = 0;
    
    for (const intent of intents) {
        byCategory[intent.category]++;
        byState[intent.state]++;
        if (intent.suppressed) {
            suppressed++;
            if (intent.suppressedUntil && now < intent.suppressedUntil) {
                inCooldown++;
            }
        }
    }
    
    return {
        total: intents.length,
        suppressed,
        inCooldown,
        byState,
        byCategory,
    };
}

/**
 * Clear all exit intents (for cleanup/reset)
 */
export function clearAllExitIntents(): void {
    exitIntentMap.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

function logExitIntent(intent: ExitIntent, poolName: string): void {
    logger.warn(
        `${EXIT_INTENT_CONFIG.LOG_PREFIX} 🎯 trade=${intent.tradeId.slice(0, 8)}... ` +
        `pool=${poolName} reason="${intent.reason}" ` +
        `category=${intent.category}`
    );
}

function logExitSuppressed(intent: ExitIntent, cooldownMs: number): void {
    const cooldownSec = cooldownMs / 1000;
    logger.info(
        `[EXIT-SUPPRESSED] trade=${intent.tradeId.slice(0, 8)}... ` +
        `reason=${intent.suppressionType} cooldown=${cooldownSec}s ` +
        `category=${intent.category}`
    );
}

function logCooldownExtended(intent: ExitIntent): void {
    const remainingSec = intent.suppressedUntil 
        ? (intent.suppressedUntil - Date.now()) / 1000 
        : 0;
    logger.info(
        `[EXIT-COOLDOWN-EXT] trade=${intent.tradeId.slice(0, 8)}... ` +
        `extension=${intent.cooldownExtensions}/${EXIT_INTENT_CONFIG.MAX_COOLDOWN_EXTENSIONS} ` +
        `remaining=${remainingSec.toFixed(0)}s`
    );
}

/**
 * Log re-evaluation result after cooldown
 */
export function logReEvaluationResult(
    tradeId: string,
    result: ReEvaluationResult,
    action: 'EXECUTE' | 'EXTEND_COOLDOWN' | 'CLEAR'
): void {
    const intent = exitIntentMap.get(tradeId);
    if (!intent) return;
    
    logger.info(
        `[EXIT-REEVAL] trade=${tradeId.slice(0, 8)}... ` +
        `action=${action} ` +
        `changes=[${result.changedMetrics.join(', ') || 'none'}] ` +
        `reason="${result.reason}"`
    );
}

