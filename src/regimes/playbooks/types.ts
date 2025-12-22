/**
 * Regime Playbook Engine - Type Definitions
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * PURPOSE: Define mode-specific trading behaviors based on market regime.
 * 
 * REGIMES:
 * - TREND: Strong directional movement → larger size, slower exit, extended targets
 * - CHOP: Range-bound, oscillating → reduced size, faster exits, smaller holds
 * - CHAOS: High entropy, unpredictable → block entries, exit positions, cooldown
 * - NEUTRAL: Normal conditions → standard behavior
 * - HIGH_VELOCITY: High activity with direction → allow larger entries with stacking
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/**
 * Active regime types
 */
export type RegimeType = 'TREND' | 'CHOP' | 'CHAOS' | 'NEUTRAL' | 'HIGH_VELOCITY';

/**
 * Market classification inputs for regime detection
 */
export interface RegimeInputs {
    /** Velocity slope (first derivative of activity) */
    velocitySlope: number;
    
    /** Liquidity slope (first derivative of TVL) */
    liquiditySlope: number;
    
    /** Entropy slope (first derivative of entropy) */
    entropySlope: number;
    
    /** Current entropy score (0-1) */
    entropy: number;
    
    /** Current velocity score (normalized 0-100) */
    velocity: number;
    
    /** Migration direction confidence (0-1) */
    migrationConfidence: number;
    
    /** Consistency score (0-1) */
    consistency: number;
    
    /** Fee intensity (normalized) */
    feeIntensity: number;
    
    /** Execution quality score (0-1) */
    executionQuality: number;
}

/**
 * Regime-specific playbook parameters
 */
export interface PlaybookParameters {
    /** Regime type */
    regime: RegimeType;
    
    /** Size multiplier (relative to base) */
    sizeMultiplier: number;
    
    /** Exit score threshold (lower = faster exit) */
    exitThreshold: number;
    
    /** Hold window multiplier (1 = normal, <1 = shorter) */
    holdWindowMultiplier: number;
    
    /** Allow extended profit targets */
    allowExtendedTargets: boolean;
    
    /** Allow position stacking */
    allowStacking: boolean;
    
    /** Stacking requires execution quality threshold */
    stackingExecutionQualityThreshold: number;
    
    /** Entry cooldown (seconds) */
    entryCooldownSeconds: number;
    
    /** Maximum concurrent positions allowed */
    maxConcurrentPositions: number;
    
    /** Block all new entries */
    blockEntries: boolean;
    
    /** Force exit all positions */
    forceExitAll: boolean;
    
    /** Regime cooldown after force exit (seconds) */
    regimeCooldownSeconds: number;
    
    /** Description for logging */
    description: string;
}

/**
 * Regime detection result
 */
export interface RegimeDetectionResult {
    /** Detected regime */
    regime: RegimeType;
    
    /** Confidence in detection (0-1) */
    confidence: number;
    
    /** Active playbook */
    playbook: PlaybookParameters;
    
    /** Reason for classification */
    reason: string;
    
    /** Whether trading is allowed */
    allowTrading: boolean;
    
    /** Timestamp of detection */
    timestamp: number;
    
    /** Regime transition detected */
    transitionDetected: boolean;
    
    /** Previous regime (if transition) */
    previousRegime?: RegimeType;
}

/**
 * Hysteresis buffer thresholds
 * 
 * These buffers are ADDED to thresholds when considering a regime switch.
 * This prevents noisy flips near threshold boundaries.
 */
export interface HysteresisBuffer {
    /** Buffer for entropy threshold (CHAOS detection) */
    entropy: number;
    
    /** Buffer for velocity threshold (HIGH_VELOCITY detection) */
    velocity: number;
    
    /** Buffer for slope threshold (TREND detection) */
    slope: number;
    
    /** Buffer for consistency threshold (CHOP detection) */
    consistency: number;
}

/**
 * Regime playbook configuration
 */
export interface PlaybookConfig {
    /** Threshold for detecting CHAOS regime */
    chaosEntropyThreshold: number;
    
    /** Threshold for detecting TREND regime */
    trendSlopeThreshold: number;
    
    /** Threshold for detecting CHOP regime */
    chopConsistencyThreshold: number;
    
    /** Threshold for HIGH_VELOCITY regime */
    highVelocityThreshold: number;
    
    /** Execution quality threshold for HIGH_VELOCITY stacking */
    stackingExecutionQualityMin: number;
    
    /** Minimum samples for regime detection */
    minSamplesForDetection: number;
    
    /** Regime stability window (ms) */
    stabilityWindowMs: number;
    
    /** Cooldown after CHAOS exit (ms) */
    chaosCooldownMs: number;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // HYSTERESIS SETTINGS — Prevent noisy regime flips
    // ═══════════════════════════════════════════════════════════════════════════
    
    /** Minimum time (ms) in current regime before switching is allowed */
    minDwellTimeMs: number;
    
    /** Number of consecutive confirmations required to switch regime */
    consecutiveConfirmations: number;
    
    /** Size of rolling confirmation window */
    confirmationWindowSize: number;
    
    /** Hysteresis buffer added to thresholds for switching */
    hysteresisBuffer: HysteresisBuffer;
}

/**
 * Regime transition event
 */
export interface RegimeTransition {
    /** Previous regime */
    from: RegimeType;
    
    /** New regime */
    to: RegimeType;
    
    /** Transition timestamp */
    timestamp: number;
    
    /** Reason for transition */
    reason: string;
}

