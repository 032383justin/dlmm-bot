/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXIT SPAM COOLDOWN — Fix repeated exit trigger noise
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PROBLEM:
 * From logs: exits trigger repeatedly, then suppressed due to "cost_not_amortized",
 * causing noisy loops and log spam.
 * 
 * SOLUTION:
 * If EXIT_TRIGGERED but suppressed for COST_NOT_AMORTIZED:
 *   - Do NOT re-trigger the same exit reason more than once per cooldownExitCheckMs
 *   - Store exitSuppressedUntil timestamp on position state
 *   - Log once, then go quiet until next check window
 * 
 * This prevents exit spam while maintaining proper exit behavior.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export const EXIT_COOLDOWN_CONFIG = {
    /** Enable exit spam cooldown */
    ENABLED: true,
    
    /** Cooldown period between same-reason exit checks (ms) */
    COOLDOWN_MS: 60 * 1000,  // 60 seconds
    
    /** Cooldown period for cost_not_amortized specifically (ms) */
    COST_NOT_AMORTIZED_COOLDOWN_MS: 5 * 60 * 1000,  // 5 minutes
    
    /** Cooldown period for score/MHI exits (ms) */
    SCORE_EXIT_COOLDOWN_MS: 10 * 60 * 1000,  // 10 minutes
    
    /** Cooldown period for velocity exits (ms) */
    VELOCITY_EXIT_COOLDOWN_MS: 5 * 60 * 1000,  // 5 minutes
    
    /** Exit reasons that get extended cooldown */
    EXTENDED_COOLDOWN_REASONS: [
        'COST_NOT_AMORTIZED',
        'MIN_HOLD_NOT_MET',
        'FEE_AMORTIZATION_BLOCKED',
    ],
    
    /** Exit reasons that should log once and suppress */
    LOG_ONCE_REASONS: [
        'SCORE_DROP',
        'MHI_DROP',
        'VELOCITY_DIP',
        'FEE_VELOCITY_LOW',
        'SWAP_VELOCITY_LOW',
    ],
    
    /** Maximum suppression count before forcing log */
    MAX_SUPPRESSION_COUNT: 10,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ExitCooldownState {
    poolAddress: string;
    
    /** Map of exit reason -> cooldown info */
    cooldowns: Map<string, {
        suppressedUntil: number;
        suppressionCount: number;
        firstTriggeredAt: number;
        lastTriggeredAt: number;
    }>;
}

export interface ExitCooldownCheck {
    /** Is this exit reason on cooldown? */
    onCooldown: boolean;
    
    /** Should we log this exit attempt? */
    shouldLog: boolean;
    
    /** Cooldown remaining (ms) */
    cooldownRemainingMs: number;
    
    /** Times this exit has been suppressed */
    suppressionCount: number;
    
    /** Reason for cooldown */
    reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

const exitCooldownStates = new Map<string, ExitCooldownState>();

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get cooldown duration for an exit reason.
 */
function getCooldownDuration(exitReason: string): number {
    const config = EXIT_COOLDOWN_CONFIG;
    const upperReason = exitReason.toUpperCase();
    
    // Extended cooldown for specific reasons
    if (config.EXTENDED_COOLDOWN_REASONS.some(r => upperReason.includes(r))) {
        return config.COST_NOT_AMORTIZED_COOLDOWN_MS;
    }
    
    // Score-based exits
    if (upperReason.includes('SCORE') || upperReason.includes('MHI')) {
        return config.SCORE_EXIT_COOLDOWN_MS;
    }
    
    // Velocity-based exits
    if (upperReason.includes('VELOCITY')) {
        return config.VELOCITY_EXIT_COOLDOWN_MS;
    }
    
    return config.COOLDOWN_MS;
}

/**
 * Check if an exit reason is on cooldown.
 */
export function checkExitCooldown(
    poolAddress: string,
    exitReason: string
): ExitCooldownCheck {
    if (!EXIT_COOLDOWN_CONFIG.ENABLED) {
        return {
            onCooldown: false,
            shouldLog: true,
            cooldownRemainingMs: 0,
            suppressionCount: 0,
        };
    }
    
    const now = Date.now();
    const state = exitCooldownStates.get(poolAddress);
    
    if (!state) {
        return {
            onCooldown: false,
            shouldLog: true,
            cooldownRemainingMs: 0,
            suppressionCount: 0,
        };
    }
    
    const normalizedReason = normalizeExitReason(exitReason);
    const cooldownInfo = state.cooldowns.get(normalizedReason);
    
    if (!cooldownInfo) {
        return {
            onCooldown: false,
            shouldLog: true,
            cooldownRemainingMs: 0,
            suppressionCount: 0,
        };
    }
    
    // Check if still on cooldown
    if (now < cooldownInfo.suppressedUntil) {
        const remaining = cooldownInfo.suppressedUntil - now;
        
        // Check if we should force log due to max suppression
        const shouldForceLog = cooldownInfo.suppressionCount >= EXIT_COOLDOWN_CONFIG.MAX_SUPPRESSION_COUNT;
        
        return {
            onCooldown: true,
            shouldLog: shouldForceLog,
            cooldownRemainingMs: remaining,
            suppressionCount: cooldownInfo.suppressionCount,
            reason: `Suppressed (${cooldownInfo.suppressionCount}x) until ${new Date(cooldownInfo.suppressedUntil).toISOString()}`,
        };
    }
    
    // Cooldown expired
    return {
        onCooldown: false,
        shouldLog: true,
        cooldownRemainingMs: 0,
        suppressionCount: cooldownInfo.suppressionCount,
    };
}

/**
 * Record a suppressed exit (sets cooldown).
 */
export function recordSuppressedExit(
    poolAddress: string,
    exitReason: string,
    suppressionReason: string
): void {
    if (!EXIT_COOLDOWN_CONFIG.ENABLED) return;
    
    const now = Date.now();
    const normalizedReason = normalizeExitReason(exitReason);
    const cooldownDuration = getCooldownDuration(suppressionReason);
    
    // Get or create state
    let state = exitCooldownStates.get(poolAddress);
    if (!state) {
        state = {
            poolAddress,
            cooldowns: new Map(),
        };
        exitCooldownStates.set(poolAddress, state);
    }
    
    // Get or create cooldown info
    let cooldownInfo = state.cooldowns.get(normalizedReason);
    if (!cooldownInfo) {
        cooldownInfo = {
            suppressedUntil: 0,
            suppressionCount: 0,
            firstTriggeredAt: now,
            lastTriggeredAt: now,
        };
    }
    
    // Update cooldown
    cooldownInfo.suppressedUntil = now + cooldownDuration;
    cooldownInfo.suppressionCount++;
    cooldownInfo.lastTriggeredAt = now;
    
    state.cooldowns.set(normalizedReason, cooldownInfo);
    
    // Log first occurrence and periodic updates
    const isFirstOccurrence = cooldownInfo.suppressionCount === 1;
    const isPeriodic = cooldownInfo.suppressionCount % EXIT_COOLDOWN_CONFIG.MAX_SUPPRESSION_COUNT === 0;
    
    if (isFirstOccurrence) {
        logger.info(
            `[EXIT-COOLDOWN] SUPPRESSED | pool=${poolAddress.slice(0, 8)} | ` +
            `reason=${exitReason} | suppressedBy=${suppressionReason} | ` +
            `cooldown=${(cooldownDuration / 60000).toFixed(0)}m`
        );
    } else if (isPeriodic) {
        logger.info(
            `[EXIT-COOLDOWN] STILL_SUPPRESSED | pool=${poolAddress.slice(0, 8)} | ` +
            `reason=${exitReason} | count=${cooldownInfo.suppressionCount} | ` +
            `duration=${((now - cooldownInfo.firstTriggeredAt) / 60000).toFixed(0)}m`
        );
    }
}

/**
 * Clear exit cooldown for a specific reason.
 */
export function clearExitCooldown(poolAddress: string, exitReason?: string): void {
    if (exitReason) {
        const state = exitCooldownStates.get(poolAddress);
        if (state) {
            state.cooldowns.delete(normalizeExitReason(exitReason));
        }
    } else {
        exitCooldownStates.delete(poolAddress);
    }
}

/**
 * Clear all cooldowns for a pool (on position close).
 */
export function clearAllCooldowns(poolAddress: string): void {
    exitCooldownStates.delete(poolAddress);
}

/**
 * Get cooldown summary for a pool.
 */
export function getCooldownSummary(poolAddress: string): {
    activeCooldowns: number;
    totalSuppressions: number;
    reasons: string[];
} {
    const state = exitCooldownStates.get(poolAddress);
    if (!state) {
        return { activeCooldowns: 0, totalSuppressions: 0, reasons: [] };
    }
    
    const now = Date.now();
    let activeCooldowns = 0;
    let totalSuppressions = 0;
    const reasons: string[] = [];
    
    for (const [reason, info] of state.cooldowns) {
        totalSuppressions += info.suppressionCount;
        if (now < info.suppressedUntil) {
            activeCooldowns++;
            reasons.push(reason);
        }
    }
    
    return { activeCooldowns, totalSuppressions, reasons };
}

/**
 * Normalize exit reason for grouping similar exits.
 */
function normalizeExitReason(exitReason: string): string {
    const upper = exitReason.toUpperCase();
    
    // Group score-related exits
    if (upper.includes('SCORE_DROP') || upper.includes('TIER4_SCORE')) {
        return 'SCORE_EXIT';
    }
    
    // Group MHI exits
    if (upper.includes('MHI')) {
        return 'MHI_EXIT';
    }
    
    // Group velocity exits
    if (upper.includes('FEE_VELOCITY') || upper.includes('SWAP_VELOCITY')) {
        return 'VELOCITY_EXIT';
    }
    
    // Group regime exits
    if (upper.includes('REGIME')) {
        return 'REGIME_EXIT';
    }
    
    // Group amortization exits
    if (upper.includes('AMORTIZ') || upper.includes('PAYBACK')) {
        return 'AMORTIZATION_EXIT';
    }
    
    return upper;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wrapper to check exit with cooldown logic.
 * Returns whether the exit should be processed or suppressed.
 */
export function shouldProcessExit(
    poolAddress: string,
    exitReason: string,
    suppressionReason?: string
): { process: boolean; log: boolean } {
    const cooldownCheck = checkExitCooldown(poolAddress, exitReason);
    
    if (cooldownCheck.onCooldown) {
        return {
            process: false,
            log: cooldownCheck.shouldLog,
        };
    }
    
    // If there's a suppression reason, record it
    if (suppressionReason) {
        recordSuppressedExit(poolAddress, exitReason, suppressionReason);
        return {
            process: false,
            log: true,  // Log first suppression
        };
    }
    
    return {
        process: true,
        log: true,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log exit cooldown status for all pools.
 */
export function logExitCooldownStatus(): void {
    const pools = Array.from(exitCooldownStates.keys());
    if (pools.length === 0) {
        logger.debug('[EXIT-COOLDOWN] No active cooldowns');
        return;
    }
    
    let totalActive = 0;
    let totalSuppressions = 0;
    
    for (const poolAddress of pools) {
        const summary = getCooldownSummary(poolAddress);
        totalActive += summary.activeCooldowns;
        totalSuppressions += summary.totalSuppressions;
    }
    
    logger.info(
        `[EXIT-COOLDOWN-STATUS] pools=${pools.length} | ` +
        `activeCooldowns=${totalActive} | totalSuppressions=${totalSuppressions}`
    );
}

export default {
    EXIT_COOLDOWN_CONFIG,
    checkExitCooldown,
    recordSuppressedExit,
    clearExitCooldown,
    clearAllCooldowns,
    getCooldownSummary,
    shouldProcessExit,
    logExitCooldownStatus,
};

