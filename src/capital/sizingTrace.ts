/**
 * Sizing Trace — Canonical Multiplier Breakdown
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * TIER 5: CANONICAL SIZING TRACE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Provide a single, canonical, fully explainable trace log per executed
 * entry showing exactly how final position size was computed.
 * 
 * OUTPUT FORMAT:
 *   [SIZE-TRACE] pool=... base=$X mhi=0.65x ev=PASS feeBleed=1.0x AEL=A2(1.35x) 
 *                CCE=1.5x tranche=2 vsh=1.0x final=$Y
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import logger from '../utils/logger';
import { AggressionLevel } from './aggressionLadder';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Complete sizing breakdown for entry trace
 */
export interface SizingBreakdown {
    // Base inputs
    baseSizeUsd: number;
    poolName: string;
    poolAddress: string;
    
    // MHI Governor
    mhiValue: number;
    mhiMultiplier: number;
    mhiReason: string;
    
    // EV Gate
    evGateDecision: 'PASS' | 'FAIL';
    expectedNetEVUsd: number;
    
    // Fee Bleed
    feeBleedActive: boolean;
    feeBleedMultiplier: number;
    
    // Tier 4 Aggression Scaling
    tier4Multiplier: number;
    tier4Status: 'BOOST' | 'REDUCE' | 'NEUTRAL';
    
    // Tier 5: AEL (Aggression Ladder)
    aelLevel: AggressionLevel;
    aelSizeMultiplier: number;
    
    // Tier 5: CCE (Capital Concentration)
    cceMultiplier: number;
    cceTrancheIndex: number;
    cceCapped: boolean;
    
    // Tier 5: VSH (Volatility Skew Harvester)
    vshBinWidthMultiplier: number;
    vshExitHint: 'NONE' | 'SUPPRESS_NOISE' | 'HOLD_FOR_CHURN';
    vshHarvesting: boolean;
    
    // Final output
    finalSizeUsd: number;
    
    // Conflict detection (AEL dampening CCE or vice versa)
    hasConflict: boolean;
    conflictDescription?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute final entry sizing with full breakdown.
 * This is the canonical function for all sizing calculations.
 */
export function computeFinalEntrySizingBreakdown(inputs: {
    baseSizeUsd: number;
    poolName: string;
    poolAddress: string;
    
    // MHI
    mhiValue: number;
    mhiMultiplier: number;
    mhiReason: string;
    
    // EV Gate
    evGatePassed: boolean;
    expectedNetEVUsd: number;
    
    // Fee Bleed
    feeBleedActive: boolean;
    feeBleedMultiplier: number;
    
    // Tier 4 Aggression
    tier4Multiplier: number;
    tier4Status: 'BOOST' | 'REDUCE' | 'NEUTRAL';
    
    // Tier 5: AEL
    aelLevel: AggressionLevel;
    aelSizeMultiplier: number;
    
    // Tier 5: CCE
    cceMultiplier: number;
    cceTrancheIndex: number;
    cceAllowedSizeUsd: number;
    
    // Tier 5: VSH
    vshBinWidthMultiplier: number;
    vshExitHint: 'NONE' | 'SUPPRESS_NOISE' | 'HOLD_FOR_CHURN';
    vshHarvesting: boolean;
    
    // Hard caps
    hardMinSizeUsd: number;
    hardMaxSizeUsd: number;
}): SizingBreakdown {
    let size = inputs.baseSizeUsd;
    let hasConflict = false;
    let conflictDescription: string | undefined;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: MHI Governor (sizing reduction for unhealthy microstructure)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const afterMHI = size * inputs.mhiMultiplier;
    size = afterMHI;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: EV Gate (binary pass/fail - no multiplier)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // EV gate is handled before this function - if we reach here, it passed
    // We just record the decision
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Fee Bleed Adjustment (defensive reduction if active)
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (inputs.feeBleedActive) {
        const afterFeeBleed = size * inputs.feeBleedMultiplier;
        size = afterFeeBleed;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Tier 4 Aggression Scaling (regime-adaptive)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const afterTier4 = size * inputs.tier4Multiplier;
    size = afterTier4;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: Tier 5 AEL (Aggression Ladder)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const afterAEL = size * inputs.aelSizeMultiplier;
    size = afterAEL;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: Tier 5 CCE (Capital Concentration)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const afterCCE = size * inputs.cceMultiplier;
    
    // Check for conflict: CCE amplifying but AEL dampening (or vice versa)
    if (inputs.aelSizeMultiplier < 1.0 && inputs.cceMultiplier > 1.0) {
        hasConflict = true;
        conflictDescription = `AEL dampens (${inputs.aelSizeMultiplier.toFixed(2)}x) but CCE amplifies (${inputs.cceMultiplier.toFixed(2)}x)`;
    } else if (inputs.aelSizeMultiplier > 1.0 && inputs.cceMultiplier < 1.0) {
        hasConflict = true;
        conflictDescription = `AEL amplifies (${inputs.aelSizeMultiplier.toFixed(2)}x) but CCE dampens (${inputs.cceMultiplier.toFixed(2)}x)`;
    }
    
    // Cap to CCE allowed size
    const cceCapped = afterCCE > inputs.cceAllowedSizeUsd;
    size = Math.min(afterCCE, inputs.cceAllowedSizeUsd);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 7: Apply hard caps
    // ═══════════════════════════════════════════════════════════════════════════
    
    size = Math.min(size, inputs.hardMaxSizeUsd);
    size = Math.max(size, 0); // Don't go negative
    
    // Floor to integer
    const finalSizeUsd = Math.floor(size);
    
    return {
        baseSizeUsd: inputs.baseSizeUsd,
        poolName: inputs.poolName,
        poolAddress: inputs.poolAddress,
        
        mhiValue: inputs.mhiValue,
        mhiMultiplier: inputs.mhiMultiplier,
        mhiReason: inputs.mhiReason,
        
        evGateDecision: inputs.evGatePassed ? 'PASS' : 'FAIL',
        expectedNetEVUsd: inputs.expectedNetEVUsd,
        
        feeBleedActive: inputs.feeBleedActive,
        feeBleedMultiplier: inputs.feeBleedMultiplier,
        
        tier4Multiplier: inputs.tier4Multiplier,
        tier4Status: inputs.tier4Status,
        
        aelLevel: inputs.aelLevel,
        aelSizeMultiplier: inputs.aelSizeMultiplier,
        
        cceMultiplier: inputs.cceMultiplier,
        cceTrancheIndex: inputs.cceTrancheIndex,
        cceCapped,
        
        vshBinWidthMultiplier: inputs.vshBinWidthMultiplier,
        vshExitHint: inputs.vshExitHint,
        vshHarvesting: inputs.vshHarvesting,
        
        finalSizeUsd,
        
        hasConflict,
        conflictDescription,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log canonical sizing trace.
 * This is the ONLY place position sizing should be logged for entries.
 * 
 * Format:
 * [SIZE-TRACE] pool=SOL-USDC base=$500 mhi=0.65x ev=PASS feeBleed=1.0x 
 *              AEL=A2(1.35x) CCE=1.5x tranche=2 vsh=1.0x final=$878
 */
export function logSizingTrace(breakdown: SizingBreakdown): void {
    const mhiPart = `mhi=${breakdown.mhiMultiplier.toFixed(2)}x`;
    const evPart = `ev=${breakdown.evGateDecision}`;
    const feeBleedPart = breakdown.feeBleedActive 
        ? `feeBleed=${breakdown.feeBleedMultiplier.toFixed(2)}x` 
        : `feeBleed=1.0x`;
    const aelPart = `AEL=${breakdown.aelLevel}(${breakdown.aelSizeMultiplier.toFixed(2)}x)`;
    const ccePart = `CCE=${breakdown.cceMultiplier.toFixed(2)}x`;
    const tranchePart = `tranche=${breakdown.cceTrancheIndex}`;
    const vshPart = breakdown.vshHarvesting 
        ? `vsh=${breakdown.vshBinWidthMultiplier.toFixed(2)}x` 
        : `vsh=off`;
    
    logger.info(
        `[SIZE-TRACE] pool=${breakdown.poolName} base=$${breakdown.baseSizeUsd.toFixed(0)} ` +
        `${mhiPart} ${evPart} ${feeBleedPart} ${aelPart} ${ccePart} ${tranchePart} ${vshPart} ` +
        `final=$${breakdown.finalSizeUsd}`
    );
    
    // Log conflict if detected
    if (breakdown.hasConflict && breakdown.conflictDescription) {
        logger.warn(`[SIZE-TRACE-CONFLICT] ${breakdown.poolName}: ${breakdown.conflictDescription}`);
    }
    
    // Log CCE cap hit
    if (breakdown.cceCapped) {
        logger.debug(`[SIZE-TRACE] ${breakdown.poolName}: CCE capped size to allowed limit`);
    }
}

/**
 * Log detailed sizing breakdown for debugging
 */
export function logSizingBreakdownDebug(breakdown: SizingBreakdown): void {
    logger.debug(
        `[SIZE-BREAKDOWN] ${breakdown.poolName}\n` +
        `  base=$${breakdown.baseSizeUsd.toFixed(2)}\n` +
        `  → MHI: ${breakdown.mhiMultiplier.toFixed(2)}x (${breakdown.mhiReason})\n` +
        `  → EV: ${breakdown.evGateDecision} (expEV=$${breakdown.expectedNetEVUsd.toFixed(2)})\n` +
        `  → FeeBleed: ${breakdown.feeBleedActive ? 'ACTIVE' : 'OFF'} (${breakdown.feeBleedMultiplier.toFixed(2)}x)\n` +
        `  → Tier4: ${breakdown.tier4Status} (${breakdown.tier4Multiplier.toFixed(2)}x)\n` +
        `  → AEL: ${breakdown.aelLevel} (${breakdown.aelSizeMultiplier.toFixed(2)}x)\n` +
        `  → CCE: ${breakdown.cceMultiplier.toFixed(2)}x tranche=${breakdown.cceTrancheIndex} ${breakdown.cceCapped ? '[CAPPED]' : ''}\n` +
        `  → VSH: ${breakdown.vshHarvesting ? 'HARVEST' : 'OFF'} binWidth=${breakdown.vshBinWidthMultiplier.toFixed(2)}x hint=${breakdown.vshExitHint}\n` +
        `  = final=$${breakdown.finalSizeUsd}`
    );
}

