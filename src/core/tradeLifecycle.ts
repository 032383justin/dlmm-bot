/**
 * Trade Lifecycle Sequencing — The Final Layer
 * 
 * 🧠 Core Principle:
 * You don't trade positions. You trade microstructure cycles.
 * 
 * A trade has a life cycle:
 * Scan → Observe → Confirm → Deploy → Farm → Exit → Cooldown
 * 
 * Never skip stages. Never "re-enter immediately."
 * 
 * 🔥 FSM (Finite State Machine):
 * IDLE → OBSERVE → READY → POSITIONED → EXITED → COOLDOWN → IDLE
 * 
 * 🧨 IMPORTANT RULES:
 * - No re-entry during READY or POSITIONED
 * - Never enter from COOLDOWN
 * - No multi-entry stacking
 * - Do not restart cooldown early
 * - Do not size positions by token price or candles
 * - Use BinScores only
 * 
 * 💣 What this achieves:
 * The bot becomes:
 * - conservative when chaos is weak
 * - aggressive when chaos is strong
 * - absent when whales take over
 * - immune to rugs
 * - indifferent to hype
 * - forward-only
 * 
 * It acts like a casino:
 * take money while degeneracy is active,
 * close the table when whales sit down.
 */

import { BinSnapshot } from './dlmmTelemetry';
import { BinScores } from './binScoring';

/**
 * Pool State in the Trade Lifecycle FSM
 */
export enum PoolState {
    IDLE = 'IDLE',           // Not tracking
    OBSERVE = 'OBSERVE',     // Collecting telemetry
    READY = 'READY',         // Validated, ready to enter
    POSITIONED = 'POSITIONED', // Active position
    EXITED = 'EXITED',       // Just exited
    COOLDOWN = 'COOLDOWN'    // Forced pause
}

/**
 * Pool Lifecycle Tracker
 */
export interface PoolLifecycle {
    poolId: string;
    state: PoolState;

    // Telemetry tracking
    binHistory: BinSnapshot[];
    scoresHistory: BinScores[];

    // Validation tracking
    consecutiveGoodCycles: number; // Must be ≥2 for entry

    // Position tracking
    entryTime?: number;
    entryBinRange?: [number, number];
    entryScores?: BinScores;
    capitalDeployed?: number;

    // Exit tracking
    exitTime?: number;
    exitReason?: string;

    // Cooldown tracking
    cooldownUntil?: number;

    // State transition timestamps
    lastStateChange: number;
}

/**
 * Trade Lifecycle Manager
 */
export class TradeLifecycleManager {
    private pools: Map<string, PoolLifecycle> = new Map();

    // Cooldown durations (milliseconds)
    private readonly COOLDOWN_NORMAL = 5 * 60 * 1000;  // 5 minutes
    private readonly COOLDOWN_MEME = 15 * 60 * 1000;   // 15 minutes

    // Validation requirements
    private readonly MIN_CONSECUTIVE_CYCLES = 2;

    /**
     * 1️⃣ Scan Phase: Add pool to tracking
     */
    addPool(poolId: string): void {
        if (!this.pools.has(poolId)) {
            this.pools.set(poolId, {
                poolId,
                state: PoolState.IDLE,
                binHistory: [],
                scoresHistory: [],
                consecutiveGoodCycles: 0,
                lastStateChange: Date.now()
            });
        }
    }

    /**
     * 2️⃣ Telemetry Phase: Push snapshot
     */
    pushSnapshot(poolId: string, snapshot: BinSnapshot): void {
        const pool = this.pools.get(poolId);
        if (!pool) return;

        // Transition IDLE → OBSERVE
        if (pool.state === PoolState.IDLE) {
            pool.state = PoolState.OBSERVE;
            pool.lastStateChange = Date.now();
        }

        // Store snapshot
        pool.binHistory.push(snapshot);

        // Keep only last 20 snapshots (DLMM_HISTORY_LENGTH)
        if (pool.binHistory.length > 20) {
            pool.binHistory.shift();
        }
    }

    /**
     * 3️⃣ Scoring Phase: Push scores
     */
    pushScores(poolId: string, scores: BinScores): void {
        const pool = this.pools.get(poolId);
        if (!pool) return;

        pool.scoresHistory.push(scores);

        // Keep only last 20 scores
        if (pool.scoresHistory.length > 20) {
            pool.scoresHistory.shift();
        }
    }

    /**
     * 4️⃣ Validation Phase: Check if ready for entry
     * 
     * Requirements:
     * - At least 2 consecutive cycles above entry threshold
     * - No whale sweep
     * - No LP migration spike
     * - No crowd collapse
     * 
     * This is 90% of your edge.
     */
    validateEntry(
        poolId: string,
        scores: BinScores,
        entryThreshold: number,
        migration: number,
        crowdCount: number
    ): boolean {
        const pool = this.pools.get(poolId);
        if (!pool || pool.state !== PoolState.OBSERVE) return false;

        // Check if scores meet entry criteria
        const meetsThreshold = scores.total >= entryThreshold;
        const noWhaleSweep = scores.whaleImpact <= 25;
        const noMigration = migration < 0.20;
        const hasCrowd = crowdCount >= 8;

        if (meetsThreshold && noWhaleSweep && noMigration && hasCrowd) {
            pool.consecutiveGoodCycles++;
        } else {
            pool.consecutiveGoodCycles = 0;
        }

        // Transition OBSERVE → READY if validated
        if (pool.consecutiveGoodCycles >= this.MIN_CONSECUTIVE_CYCLES) {
            pool.state = PoolState.READY;
            pool.lastStateChange = Date.now();
            return true;
        }

        return false;
    }

    /**
     * 5️⃣ Entry Phase: Execute trade
     * 
     * BUY ONCE. Not multiple entries. Not DCA.
     */
    executeEntry(
        poolId: string,
        activeBin: number,
        scores: BinScores,
        capitalDeployed: number
    ): boolean {
        const pool = this.pools.get(poolId);
        if (!pool || pool.state !== PoolState.READY) return false;

        // Store entry data
        pool.entryTime = Date.now();
        pool.entryBinRange = [activeBin - 3, activeBin + 3];
        pool.entryScores = scores;
        pool.capitalDeployed = capitalDeployed;

        // Transition READY → POSITIONED
        pool.state = PoolState.POSITIONED;
        pool.lastStateChange = Date.now();

        return true;
    }

    /**
     * 6️⃣ Farming Phase: Monitor position
     * 
     * You DO NOT:
     * - chase price
     * - move bins
     * - increase size
     * - manually adjust
     * 
     * You simply let bins fill/refill and take spread.
     * This is market making, not gambling.
     */
    isPositioned(poolId: string): boolean {
        const pool = this.pools.get(poolId);
        return pool?.state === PoolState.POSITIONED;
    }

    /**
     * 7️⃣ Exit Phase: Close position
     * 
     * Do NOT partial exit. Do NOT wait. Do NOT rationalize.
     * Close → Book PnL → Log.
     */
    executeExit(poolId: string, reason: string): boolean {
        const pool = this.pools.get(poolId);
        if (!pool || pool.state !== PoolState.POSITIONED) return false;

        // Store exit data
        pool.exitTime = Date.now();
        pool.exitReason = reason;

        // Transition POSITIONED → EXITED
        pool.state = PoolState.EXITED;
        pool.lastStateChange = Date.now();

        return true;
    }

    /**
     * 8️⃣ Cooldown Phase: Force pause
     * 
     * This is non-negotiable.
     * Never re-enter the same pool immediately.
     * 
     * Reason:
     * When chaos stops → a whale or LP just won the battle.
     * They change the environment.
     * You don't go back to the battlefield immediately.
     * 
     * Cooldown: 5–15 minutes per pool, 15–30 minutes for memes
     */
    startCooldown(poolId: string, isMeme: boolean = false): void {
        const pool = this.pools.get(poolId);
        if (!pool || pool.state !== PoolState.EXITED) return;

        // Set cooldown duration
        const cooldownDuration = isMeme ? this.COOLDOWN_MEME : this.COOLDOWN_NORMAL;
        pool.cooldownUntil = Date.now() + cooldownDuration;

        // Transition EXITED → COOLDOWN
        pool.state = PoolState.COOLDOWN;
        pool.lastStateChange = Date.now();

        // Reset validation tracking
        pool.consecutiveGoodCycles = 0;
    }

    /**
     * Check if cooldown expired and transition back to IDLE
     */
    updateCooldowns(): void {
        const now = Date.now();

        for (const [poolId, pool] of this.pools) {
            if (pool.state === PoolState.COOLDOWN && pool.cooldownUntil) {
                if (now >= pool.cooldownUntil) {
                    // Transition COOLDOWN → IDLE
                    pool.state = PoolState.IDLE;
                    pool.lastStateChange = now;

                    // Clear position data
                    delete pool.entryTime;
                    delete pool.entryBinRange;
                    delete pool.entryScores;
                    delete pool.capitalDeployed;
                    delete pool.exitTime;
                    delete pool.exitReason;
                    delete pool.cooldownUntil;
                }
            }
        }
    }

    /**
     * Get pool lifecycle state
     */
    getPoolState(poolId: string): PoolState | undefined {
        return this.pools.get(poolId)?.state;
    }

    /**
     * Get pool lifecycle data
     */
    getPool(poolId: string): PoolLifecycle | undefined {
        return this.pools.get(poolId);
    }

    /**
     * Remove pool from tracking
     */
    removePool(poolId: string): void {
        this.pools.delete(poolId);
    }

    /**
     * Get all pools in a specific state
     */
    getPoolsByState(state: PoolState): string[] {
        const pools: string[] = [];
        for (const [poolId, pool] of this.pools) {
            if (pool.state === state) {
                pools.push(poolId);
            }
        }
        return pools;
    }
}

/**
 * 🔥 State Transition Rules:
 * 
 * IDLE → OBSERVE
 * When pool selected and first snapshot pushed.
 * 
 * OBSERVE → READY
 * When score > threshold for 2+ consecutive cycles.
 * 
 * READY → POSITIONED
 * Execute trade.
 * 
 * POSITIONED → EXITED
 * Any structural exit trigger fires.
 * 
 * EXITED → COOLDOWN
 * Force pause (5-30 minutes).
 * 
 * COOLDOWN → IDLE
 * Timer expired + score reset.
 * 
 * This removes emotion and human error.
 */
