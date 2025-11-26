import { Pool } from './normalizePools';
import { DLMMTelemetry, BinSnapshot } from './dlmmTelemetry';
import { BinScore, BinScores } from './binScoring';
import { evaluateFusionEntry } from './fusionEntry';

export interface StructuralEntrySignal {
    shouldEnter: boolean;
    reason: string;
    confidence: number;
    binScore: BinScore;
}

export interface EntryDecision {
    enter: boolean;
    lowerBin: number;
    upperBin: number;
    reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSITION GATE SYSTEM
// Pre-entry filter based on microstructure transitions (compression → expansion)
// This determines WHEN to fire, not IF to fire (scoring handles that)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Transition telemetry attached to pool from index.ts
 */
export interface TransitionTelemetry {
    velocitySlope: number;
    liquiditySlope: number;
    entropySlope: number;
    prevVelocity?: number;
    prevLiquidity?: number;
    prevEntropy?: number;
}

/**
 * Result of transition gate evaluation
 */
export interface TransitionGateResult {
    allowed: boolean;
    reason: string;
    expansionPulse: boolean;  // True if breakout microstructure detected
    telemetry: {
        velocitySlope: number | null;
        liquiditySlope: number | null;
        entropySlope: number | null;
    };
}

// Transition gate thresholds
const TRANSITION_THRESHOLDS = {
    // Standard gate thresholds - all must pass
    velocitySlope: 0.08,    // 8% velocity increase minimum
    liquiditySlope: 0.05,   // 5% liquidity increase minimum
    entropySlope: 0.03,     // 3% entropy increase minimum
    
    // Expansion pulse thresholds - breakout detection (bypass volume gating)
    expansionVelocity: 0.15,  // 15% velocity surge
    expansionEntropy: 0.06,   // 6% entropy surge
};

/**
 * Evaluate Transition Gate - Pre-entry filter based on microstructure transitions.
 * 
 * This gate ensures we only enter when the pool shows favorable compression → expansion.
 * Must pass BEFORE structural entry logic is executed.
 * 
 * @param pool - Pool with attached transition telemetry
 * @returns TransitionGateResult with allowed status and telemetry
 */
export function evaluateTransitionGate(pool: Pool): TransitionGateResult {
    // Extract transition telemetry from pool (attached by index.ts)
    const velocitySlope = (pool as any).velocitySlope as number | undefined;
    const liquiditySlope = (pool as any).liquiditySlope as number | undefined;
    const entropySlope = (pool as any).entropySlope as number | undefined;
    const prevVelocity = (pool as any).prevVelocity as number | undefined;
    const prevLiquidity = (pool as any).prevLiquidity as number | undefined;
    
    // ─────────────────────────────────────────────────────────────────────────────
    // DEFAULT BEHAVIOR: No history = pass gate
    // First cycle for a pool should not be blocked
    // ─────────────────────────────────────────────────────────────────────────────
    if (
        prevLiquidity === undefined || 
        prevVelocity === undefined || 
        velocitySlope === undefined ||
        liquiditySlope === undefined ||
        entropySlope === undefined
    ) {
        return {
            allowed: true,
            reason: 'TRANSITION: no history – pass (first cycle)',
            expansionPulse: false,
            telemetry: {
                velocitySlope: velocitySlope ?? null,
                liquiditySlope: liquiditySlope ?? null,
                entropySlope: entropySlope ?? null,
            }
        };
    }
    
    // ─────────────────────────────────────────────────────────────────────────────
    // EXPANSION PULSE DETECTION (Fast-Track)
    // Breakout microstructure event → bypass volume/velocity gating
    // This replicates elite DLMM bots that front-run liquidity squeezes
    // ─────────────────────────────────────────────────────────────────────────────
    const isExpansionPulse = (
        velocitySlope >= TRANSITION_THRESHOLDS.expansionVelocity &&
        entropySlope >= TRANSITION_THRESHOLDS.expansionEntropy
    );
    
    if (isExpansionPulse) {
        return {
            allowed: true,
            reason: `🔥 EXPANSION PULSE: vel=${(velocitySlope * 100).toFixed(1)}%, ent=${(entropySlope * 100).toFixed(1)}% → fast-track entry`,
            expansionPulse: true,
            telemetry: {
                velocitySlope,
                liquiditySlope,
                entropySlope,
            }
        };
    }
    
    // ─────────────────────────────────────────────────────────────────────────────
    // STANDARD TRANSITION GATE
    // All conditions must be met for favorable compression → expansion
    // ─────────────────────────────────────────────────────────────────────────────
    const velocityPass = velocitySlope >= TRANSITION_THRESHOLDS.velocitySlope;
    const liquidityPass = liquiditySlope >= TRANSITION_THRESHOLDS.liquiditySlope;
    const entropyPass = entropySlope >= TRANSITION_THRESHOLDS.entropySlope;
    
    const allPass = velocityPass && liquidityPass && entropyPass;
    
    if (allPass) {
        return {
            allowed: true,
            reason: `TRANSITION: favorable expansion - vel=${(velocitySlope * 100).toFixed(1)}%, liq=${(liquiditySlope * 100).toFixed(1)}%, ent=${(entropySlope * 100).toFixed(1)}%`,
            expansionPulse: false,
            telemetry: {
                velocitySlope,
                liquiditySlope,
                entropySlope,
            }
        };
    }
    
    // ─────────────────────────────────────────────────────────────────────────────
    // GATE FAILED - Reject entry
    // ─────────────────────────────────────────────────────────────────────────────
    const failedConditions: string[] = [];
    if (!velocityPass) failedConditions.push(`vel=${(velocitySlope * 100).toFixed(1)}%<${(TRANSITION_THRESHOLDS.velocitySlope * 100)}%`);
    if (!liquidityPass) failedConditions.push(`liq=${(liquiditySlope * 100).toFixed(1)}%<${(TRANSITION_THRESHOLDS.liquiditySlope * 100)}%`);
    if (!entropyPass) failedConditions.push(`ent=${(entropySlope * 100).toFixed(1)}%<${(TRANSITION_THRESHOLDS.entropySlope * 100)}%`);
    
    return {
        allowed: false,
        reason: `TRANSITION: unfavorable - ${failedConditions.join(', ')}`,
        expansionPulse: false,
        telemetry: {
            velocitySlope,
            liquiditySlope,
            entropySlope,
        }
    };
}

export function evaluateEntry(scores: BinScores, history: BinSnapshot[], currentActiveBin: number = 0): EntryDecision {
    // 🧠 PRINCIPLE: Enter only when the battlefield is favorable — not when price is moving.
    // You do not enter because price is rising.
    // You enter because liquidity is being destroyed and the market must oscillate.
    // Memes ≠ trending assets. Memes = panic machines → harvest the rhythm.

    const ENTRY_SCORE_THRESHOLD = 65;

    const {
        exhaustion,
        oscillation,
        latency,
        whaleImpact,
        total
    } = scores;

    // ⚠️ WHAT NOT TO DO (enforced by design):
    // ❌ Do not enter on volume
    // ❌ Do not enter on APR
    // ❌ Do not enter on pump
    // ❌ Do not enter on candle
    // ❌ Do not enter on token hype
    // ❌ Do not enter "because score > X"
    // ✅ Enter because you're farming BEHAVIOR, not guessing direction

    // 🚀 STRUCTURAL ENTRY CRITERIA - ALL 4 MUST BE TRUE:

    // 1️⃣ Exhaustion ≥ 35
    // Liquidity is being eaten aggressively in active bin ± 3.
    // This creates a vacuum → humans rush in → oscillation.
    if (exhaustion < 35) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Exhaustion too low: ${exhaustion.toFixed(1)} < 35 (no liquidity vacuum)`
        };
    }

    // 2️⃣ Oscillation ≥ 50
    // The market has proven it returns to center repeatedly.
    // Not a theory → actual behavior.
    if (oscillation < 50) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Oscillation too low: ${oscillation.toFixed(1)} < 50 (trending market, not oscillating)`
        };
    }

    // 3️⃣ Latency ≥ 1.5
    // LPs are slow to refill.
    // This is the opportunity window.
    if (latency < 1.5) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Latency too low: ${latency.toFixed(1)} < 1.5 (LPs too fast, no opportunity)`
        };
    }

    // 4️⃣ WhaleImpact ≤ 25 (normalized: 100 - whaleImpact*10)
    // No large directional single-sweep.
    // We don't fight trends. We farm chaos.
    const whaleImpactNormalized = Math.max(0, 100 - (whaleImpact * 10));
    if (whaleImpactNormalized < 25) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Whale impact too high: ${whaleImpact} bins crossed (directional slaughter, not symmetrical)`
        };
    }

    // 5️⃣ Total Score ≥ 65
    // Final safety check
    if (total < ENTRY_SCORE_THRESHOLD) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Total score ${total.toFixed(1)} < ${ENTRY_SCORE_THRESHOLD}`
        };
    }

    // 6️⃣ Fusion Logic (Starvation + Entropy)
    // Extract required parameters for fusion entry check
    const starvation = history.length >= 3; // Simplified check
    const entropy = 1.5; // Default moderate entropy
    const maxBinsCrossed = scores.whaleImpact;
    const migration = 0; // Default no migration
    const uniqueWallets = 5; // Default moderate wallet count

    const fusionDecision = evaluateFusionEntry(
        starvation,
        entropy,
        maxBinsCrossed,
        migration,
        uniqueWallets,
        currentActiveBin
    );
    if (!fusionDecision.enter) {
        return {
            enter: false,
            lowerBin: 0,
            upperBin: 0,
            reason: `Fusion Entry Rejected: ${fusionDecision.reason}`
        };
    }

    // ✅ ALL CONDITIONS MET - ENTER THE KILL ZONE

    // ✂️ ENTRY BIN RANGE: activeBin ± 3
    // You are hugging the fight, not "the whole pool range."
    // Static bins kill bots. Localized bins print money.
    const lowerBin = currentActiveBin - 3;
    const upperBin = currentActiveBin + 3;

    return {
        enter: true,
        lowerBin,
        upperBin,
        reason: `Microstructure favorable: exhaustion=${exhaustion.toFixed(1)}, oscillation=${oscillation.toFixed(1)}, latency=${latency.toFixed(1)}, whaleImpact=${whaleImpact}`
    };
}

export async function checkStructuralEntry(
    pool: Pool,
    telemetry: DLMMTelemetry,
    binScore: BinScore
): Promise<StructuralEntrySignal> {
    // TODO: Determine if pool structure is favorable for entry
    throw new Error('Not implemented');
}

export function detectBinImbalance(telemetry: DLMMTelemetry): boolean {
    // TODO: Detect favorable bin imbalance patterns
    throw new Error('Not implemented');
}

export function detectLiquidityConcentration(telemetry: DLMMTelemetry): boolean {
    // TODO: Detect strong liquidity concentration
    throw new Error('Not implemented');
}
