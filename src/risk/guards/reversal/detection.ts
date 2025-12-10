/**
 * Reverse Entry Guard - Detection Logic
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Detect migration reversals and determine if entry should be blocked.
 * 
 * RULES:
 * - If recent 1-3 confirming signals flip direction relative to last 5-10, block
 * - Require sustained migration for at least 3 consecutive checks
 * - If reversal detected: abort entry, force cooldown 30-120 seconds
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { TradingState } from '../../adaptive_sizing/types';
import { MigrationDirection } from '../../../types';
import { ReversalDetectionResult, ReversalGuardConfig, HistoryTick } from './types';
import { DEFAULT_CONFIG } from './config';
import {
    recordTick,
    getRecentTicks,
    isInCooldown,
    getRemainingCooldown,
    setCooldown,
    countSustainedMigrations,
    detectDirectionFlip,
    getMigrationDirectionHistory,
} from './tracker';
import logger from '../../../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENDED TRADING STATE WITH HISTORY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extended trading state with reversal detection inputs
 */
export interface TradingStateWithReversal extends TradingState {
    /** Pool address for per-pool tracking */
    poolAddress?: string;
    
    /** Current migration direction */
    migrationDirection?: MigrationDirection;
    
    /** Migration direction history (last N ticks) */
    migrationDirectionHistory?: MigrationDirection[];
    
    /** Entropy history (last N ticks) */
    entropyHistory?: number[];
    
    /** Liquidity flow history (last N ticks) */
    liquidityFlowHistory?: number[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTION LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect if a reversal has occurred that should block entry
 */
export function detectReversal(
    state: TradingStateWithReversal,
    config: ReversalGuardConfig = DEFAULT_CONFIG
): ReversalDetectionResult {
    const poolAddress = state.poolAddress ?? 'global';
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 1: Is pool in cooldown?
    // ═══════════════════════════════════════════════════════════════════════════
    if (isInCooldown(poolAddress)) {
        const remaining = getRemainingCooldown(poolAddress);
        return {
            shouldBlock: true,
            reversalDetected: false,
            cooldownSeconds: remaining,
            cooldownExpiresAt: Date.now() + (remaining * 1000),
            reason: `Pool in cooldown: ${remaining.toFixed(0)}s remaining`,
            recentDirections: getMigrationDirectionHistory(poolAddress, config.recentTickCount),
            sustainedCount: 0,
            requiredSustained: config.minSustainedMigrations,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RECORD CURRENT TICK (if we have data)
    // ═══════════════════════════════════════════════════════════════════════════
    const currentDirection = state.migrationDirection ?? 
        inferMigrationDirection(state.liquidityFlow_score);
    
    recordTick(poolAddress, {
        migrationDirection: currentDirection,
        entropy: state.entropy_score,
        liquidityFlow: state.liquidityFlow_score,
        velocity: state.velocity_score,
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 2: Detect direction flip
    // ═══════════════════════════════════════════════════════════════════════════
    const flipResult = detectDirectionFlip(poolAddress, config);
    
    if (flipResult.flipped) {
        // Direction has flipped - trigger cooldown
        const cooldownDuration = config.cooldownSeconds;
        setCooldown(poolAddress, cooldownDuration, 
            `Direction flip: ${flipResult.historicalDirection} → ${flipResult.recentDirection}`);
        
        logger.warn(`[REVERSAL_GUARD] ⛔ Reversal detected for ${poolAddress.slice(0, 8)}... - ` +
            `${flipResult.historicalDirection} → ${flipResult.recentDirection}`);
        
        return {
            shouldBlock: true,
            reversalDetected: true,
            cooldownSeconds: cooldownDuration,
            cooldownExpiresAt: Date.now() + (cooldownDuration * 1000),
            reason: `Reversal detected: ${flipResult.historicalDirection} → ${flipResult.recentDirection}`,
            recentDirections: getMigrationDirectionHistory(poolAddress, config.recentTickCount),
            sustainedCount: 0,
            requiredSustained: config.minSustainedMigrations,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 3: Require sustained migration
    // ═══════════════════════════════════════════════════════════════════════════
    const sustained = countSustainedMigrations(poolAddress);
    
    if (sustained.direction === 'out') {
        // Outflow direction - always block
        return {
            shouldBlock: true,
            reversalDetected: false,
            cooldownSeconds: 0,
            reason: `Migration direction is outflow (${sustained.count} consecutive)`,
            recentDirections: getMigrationDirectionHistory(poolAddress, config.recentTickCount),
            sustainedCount: sustained.count,
            requiredSustained: config.minSustainedMigrations,
        };
    }
    
    if (sustained.direction === 'in' && sustained.count < config.minSustainedMigrations) {
        // Not enough sustained inflow
        return {
            shouldBlock: true,
            reversalDetected: false,
            cooldownSeconds: 0,
            reason: `Insufficient sustained migration: ${sustained.count}/${config.minSustainedMigrations}`,
            recentDirections: getMigrationDirectionHistory(poolAddress, config.recentTickCount),
            sustainedCount: sustained.count,
            requiredSustained: config.minSustainedMigrations,
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CHECK 4: Detect entropy instability
    // ═══════════════════════════════════════════════════════════════════════════
    const recentTicks = getRecentTicks(poolAddress, config.recentTickCount);
    if (recentTicks.length >= 2) {
        const entropyChange = detectEntropyInstability(recentTicks, config);
        if (entropyChange.unstable) {
            const cooldownDuration = Math.min(
                config.cooldownSeconds * 0.5, // Half cooldown for entropy instability
                config.maxCooldownSeconds
            );
            
            logger.info(`[REVERSAL_GUARD] ⚠️ Entropy instability for ${poolAddress.slice(0, 8)}...`);
            
            return {
                shouldBlock: true,
                reversalDetected: false,
                cooldownSeconds: cooldownDuration,
                cooldownExpiresAt: Date.now() + (cooldownDuration * 1000),
                reason: `Entropy instability: ${(entropyChange.change * 100).toFixed(1)}% change`,
                recentDirections: getMigrationDirectionHistory(poolAddress, config.recentTickCount),
                sustainedCount: sustained.count,
                requiredSustained: config.minSustainedMigrations,
            };
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ALL CHECKS PASSED - Allow entry
    // ═══════════════════════════════════════════════════════════════════════════
    return {
        shouldBlock: false,
        reversalDetected: false,
        cooldownSeconds: 0,
        reason: `Sustained inflow: ${sustained.count} consecutive (≥${config.minSustainedMigrations} required)`,
        recentDirections: getMigrationDirectionHistory(poolAddress, config.recentTickCount),
        sustainedCount: sustained.count,
        requiredSustained: config.minSustainedMigrations,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Infer migration direction from liquidity flow score
 */
function inferMigrationDirection(liquidityFlowScore: number): MigrationDirection {
    if (liquidityFlowScore >= 0.6) return 'in';
    if (liquidityFlowScore <= 0.4) return 'out';
    return 'neutral';
}

/**
 * Detect entropy instability from recent ticks
 */
function detectEntropyInstability(
    ticks: HistoryTick[],
    config: ReversalGuardConfig
): { unstable: boolean; change: number } {
    if (ticks.length < 2) {
        return { unstable: false, change: 0 };
    }
    
    const firstEntropy = ticks[0].entropy;
    const lastEntropy = ticks[ticks.length - 1].entropy;
    
    // Avoid division by zero
    if (firstEntropy === 0) {
        return { unstable: false, change: 0 };
    }
    
    const change = Math.abs(lastEntropy - firstEntropy) / firstEntropy;
    const unstable = change > config.entropyChangeThreshold;
    
    return { unstable, change };
}

/**
 * Check if a specific pool should block entry on reversal
 */
export function shouldBlockEntryOnReversal(
    state: TradingStateWithReversal,
    config: ReversalGuardConfig = DEFAULT_CONFIG
): boolean {
    const result = detectReversal(state, config);
    return result.shouldBlock;
}

