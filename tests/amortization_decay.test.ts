/**
 * Amortization Decay Tests
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests for the Cost Amortization Decay feature that prevents COST_NOT_AMORTIZED
 * from hard-blocking exits during prolonged dominance failure.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Test Cases:
 *   1. No decay before 60 min: hold=59m, weakness true -> effectiveCostTarget == baseCostTarget
 *   2. Decay activates after 60 min: hold=3h, weakness true -> effectiveCostTarget < baseCostTarget
 *   3. Floor enforced: hold=24h, weakness true -> effectiveCostTarget >= computed USD floor
 *   4. Telemetry unknown => slower: same holdTime, unknown telemetry => effectiveCostTarget higher
 *   5. Weakness gate false: hold=6h, harmonicExit false -> no decay
 *   6. Exit granted via decay: fees < baseTarget but >= effectiveTarget => allowExit true
 */

import {
    computeAmortizationGate,
    AMORT_DECAY_CONFIG,
    type AmortizationGateInput,
} from '../src/predator/amortization_decay';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

// Default test values
const DEFAULT_BASE_COST_TARGET = 1.00; // $1.00
const DEFAULT_NOTIONAL = 2000; // $2000

/**
 * Create a default test input with sensible defaults.
 * Override any field by passing partial input.
 */
function createTestInput(partial: Partial<AmortizationGateInput> = {}): AmortizationGateInput {
    return {
        baseCostTargetUsd: DEFAULT_BASE_COST_TARGET,
        feesAccruedUsd: 0.50, // Default: $0.50 fees (below cost target)
        holdTimeMs: 2 * MS_PER_HOUR, // Default: 2 hours
        healthScore: 0.40, // Default: poor health (below 0.50 threshold)
        badSamples: 3,
        badSamplesRequired: 3,
        harmonicExitTriggered: true,
        velocityRatio: 0.15, // Default: weak velocity (below 0.20 threshold)
        entropyRatio: 0.30, // Default: weak entropy (below 0.35 threshold)
        mtmUnrealizedPnlPct: -0.003, // Default: negative drift
        notionalUsd: DEFAULT_NOTIONAL,
        ...partial,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Amortization Decay', () => {
    // Store original config values to restore after tests
    const originalEnabled = AMORT_DECAY_CONFIG.ENABLED;
    
    beforeAll(() => {
        // Ensure decay is enabled for tests
        (AMORT_DECAY_CONFIG as any).ENABLED = true;
    });
    
    afterAll(() => {
        // Restore original config
        (AMORT_DECAY_CONFIG as any).ENABLED = originalEnabled;
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 1: No decay before 60 minutes
    // ═══════════════════════════════════════════════════════════════════════════
    
    describe('No decay before MIN_DECAY_AGE_MS', () => {
        it('should NOT apply decay when holdTime is 59 minutes even with weakness', () => {
            const input = createTestInput({
                holdTimeMs: 59 * MS_PER_MINUTE, // Just under 60 minutes
                harmonicExitTriggered: true,
                healthScore: 0.30, // Very poor health
                velocityRatio: 0.10, // Very weak velocity
            });
            
            const result = computeAmortizationGate(input);
            
            // Decay should NOT be applied
            expect(result.effectiveCostTargetUsd).toBe(input.baseCostTargetUsd);
            expect(result.debug.decayFactor).toBe(1.0);
            expect(result.debug.amortDecayApplied).toBe(false);
        });
        
        it('should NOT apply decay at exactly 60 minutes', () => {
            const input = createTestInput({
                holdTimeMs: 60 * MS_PER_MINUTE, // Exactly 60 minutes
            });
            
            const result = computeAmortizationGate(input);
            
            // At exactly MIN_DECAY_AGE, decay factor is 1.0 (no decay yet)
            expect(result.debug.decayFactor).toBe(1.0);
            expect(result.debug.decayAgeMin).toBe(0);
        });
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 2: Decay activates after 60 minutes
    // ═══════════════════════════════════════════════════════════════════════════
    
    describe('Decay activates after MIN_DECAY_AGE_MS', () => {
        it('should apply decay when holdTime is 3 hours with weakness', () => {
            const input = createTestInput({
                holdTimeMs: 3 * MS_PER_HOUR, // 3 hours
                harmonicExitTriggered: true,
                healthScore: 0.40,
                velocityRatio: 0.15,
            });
            
            const result = computeAmortizationGate(input);
            
            // After 3 hours (2 hours past min age), with 2-hour half-life,
            // decay should be applied
            expect(result.effectiveCostTargetUsd).toBeLessThan(input.baseCostTargetUsd);
            expect(result.debug.decayFactor).toBeLessThan(1.0);
            expect(result.debug.amortDecayApplied).toBe(true);
        });
        
        it('should halve the effective target after one half-life', () => {
            // With 2-hour half-life (strong telemetry), after 2 hours past min age,
            // decay factor should be 0.5
            const input = createTestInput({
                holdTimeMs: 3 * MS_PER_HOUR, // 60min + 2 hours = 3 hours
                harmonicExitTriggered: true,
                healthScore: 0.40,
                velocityRatio: 0.15, // Known telemetry -> 2-hour half-life
            });
            
            const result = computeAmortizationGate(input);
            
            // Decay factor should be approximately 0.5
            expect(result.debug.decayFactor).toBeCloseTo(0.5, 1);
            expect(result.debug.halfLifeMin).toBe(120); // 2 hours in minutes
        });
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 3: Floor enforced
    // ═══════════════════════════════════════════════════════════════════════════
    
    describe('Floor enforcement', () => {
        it('should not reduce below MIN_TARGET_FLOOR_USD', () => {
            const input = createTestInput({
                holdTimeMs: 24 * MS_PER_HOUR, // 24 hours
                baseCostTargetUsd: 1.00,
                notionalUsd: 1000, // Small notional
            });
            
            const result = computeAmortizationGate(input);
            
            // Floor should be max(0.15, 0.00005 * 1000) = max(0.15, 0.05) = 0.15
            const expectedFloor = Math.max(
                AMORT_DECAY_CONFIG.FLOOR_USD_MIN,
                AMORT_DECAY_CONFIG.FLOOR_NOTIONAL_BPS * input.notionalUsd
            );
            
            expect(result.effectiveCostTargetUsd).toBeGreaterThanOrEqual(expectedFloor);
            expect(result.debug.floorUsd).toBe(expectedFloor);
        });
        
        it('should not reduce more than MAX_TARGET_REDUCTION (85%)', () => {
            const input = createTestInput({
                holdTimeMs: 48 * MS_PER_HOUR, // 48 hours
                baseCostTargetUsd: 10.00, // Higher base to test floor
                notionalUsd: 200000, // Large notional so notional floor is higher
            });
            
            const result = computeAmortizationGate(input);
            
            // Minimum decay factor should be 0.15 (15% of base)
            const minBaseFraction = input.baseCostTargetUsd * AMORT_DECAY_CONFIG.MIN_BASE_TARGET_PCT;
            
            // effectiveCostTarget should be at least the floor
            expect(result.effectiveCostTargetUsd).toBeGreaterThanOrEqual(result.debug.floorUsd);
            
            // Decay factor should not go below MIN_BASE_TARGET_PCT
            expect(result.debug.decayFactor).toBeGreaterThanOrEqual(AMORT_DECAY_CONFIG.MIN_BASE_TARGET_PCT);
        });
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 4: Telemetry unknown => slower decay
    // ═══════════════════════════════════════════════════════════════════════════
    
    describe('Telemetry unknown results in slower decay', () => {
        it('should use 4-hour half-life when telemetry is unknown', () => {
            const holdTime = 3 * MS_PER_HOUR;
            
            // Test with known telemetry
            const inputKnown = createTestInput({
                holdTimeMs: holdTime,
                velocityRatio: 0.15, // Known
                entropyRatio: 0.30, // Known
            });
            
            // Test with unknown telemetry (undefined)
            const inputUnknown = createTestInput({
                holdTimeMs: holdTime,
                velocityRatio: undefined, // Unknown
                entropyRatio: undefined, // Unknown
                mtmUnrealizedPnlPct: -0.005, // PnL drift is the only weakness signal
            });
            
            const resultKnown = computeAmortizationGate(inputKnown);
            const resultUnknown = computeAmortizationGate(inputUnknown);
            
            // Unknown telemetry should use 4-hour half-life (240 minutes)
            expect(resultUnknown.debug.halfLifeMin).toBe(240);
            expect(resultKnown.debug.halfLifeMin).toBe(120);
            
            // With slower decay, effectiveCostTarget should be higher for unknown
            expect(resultUnknown.effectiveCostTargetUsd).toBeGreaterThan(resultKnown.effectiveCostTargetUsd);
        });
        
        it('should have higher effective target with unknown telemetry at same hold time', () => {
            const holdTime = 5 * MS_PER_HOUR;
            
            const inputKnown = createTestInput({
                holdTimeMs: holdTime,
                velocityRatio: 0.10, // Known weak
                entropyRatio: 0.20, // Known weak
            });
            
            const inputUnknown = createTestInput({
                holdTimeMs: holdTime,
                velocityRatio: undefined,
                entropyRatio: undefined,
                mtmUnrealizedPnlPct: -0.01, // Only weakness signal
            });
            
            const resultKnown = computeAmortizationGate(inputKnown);
            const resultUnknown = computeAmortizationGate(inputUnknown);
            
            // Unknown should be more conservative (higher target)
            expect(resultUnknown.effectiveCostTargetUsd).toBeGreaterThan(resultKnown.effectiveCostTargetUsd);
            expect(resultUnknown.debug.telemetryKnown).toBe(false);
            expect(resultKnown.debug.telemetryKnown).toBe(true);
        });
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 5: Weakness gate false => no decay
    // ═══════════════════════════════════════════════════════════════════════════
    
    describe('Weakness gate must be satisfied for decay', () => {
        it('should NOT decay when harmonicExitTriggered is false', () => {
            const input = createTestInput({
                holdTimeMs: 6 * MS_PER_HOUR,
                harmonicExitTriggered: false, // Not triggered
                healthScore: 0.30, // Poor health
                velocityRatio: 0.10, // Weak velocity
            });
            
            const result = computeAmortizationGate(input);
            
            expect(result.effectiveCostTargetUsd).toBe(input.baseCostTargetUsd);
            expect(result.debug.decayFactor).toBe(1.0);
            expect(result.debug.weaknessGate).toBe(false);
            expect(result.debug.amortDecayApplied).toBe(false);
        });
        
        it('should NOT decay when health is good (> 0.50) and badSamples not met', () => {
            const input = createTestInput({
                holdTimeMs: 6 * MS_PER_HOUR,
                harmonicExitTriggered: true,
                healthScore: 0.60, // Good health
                badSamples: 1, // Below required
                badSamplesRequired: 3,
                velocityRatio: 0.10, // Weak velocity
            });
            
            const result = computeAmortizationGate(input);
            
            expect(result.debug.weaknessGate).toBe(false);
            expect(result.debug.decayFactor).toBe(1.0);
        });
        
        it('should NOT decay when no telemetry weakness signal is present', () => {
            const input = createTestInput({
                holdTimeMs: 6 * MS_PER_HOUR,
                harmonicExitTriggered: true,
                healthScore: 0.40, // Poor health
                badSamples: 3,
                badSamplesRequired: 3,
                velocityRatio: 0.50, // Good velocity
                entropyRatio: 0.60, // Good entropy
                mtmUnrealizedPnlPct: 0.01, // Positive drift
            });
            
            const result = computeAmortizationGate(input);
            
            expect(result.debug.weaknessGate).toBe(false);
            expect(result.debug.decayFactor).toBe(1.0);
        });
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // TEST 6: Exit granted via decay
    // ═══════════════════════════════════════════════════════════════════════════
    
    describe('Exit granted via decay override', () => {
        it('should allow exit when fees < baseTarget but >= effectiveTarget', () => {
            // Set up: fees = $0.40, base target = $1.00
            // After decay, effective target should be below $0.40
            const input = createTestInput({
                baseCostTargetUsd: 1.00,
                feesAccruedUsd: 0.40, // Below base, but could be above effective
                holdTimeMs: 5 * MS_PER_HOUR, // 4 hours past min age
                harmonicExitTriggered: true,
                healthScore: 0.30,
                velocityRatio: 0.10,
            });
            
            const result = computeAmortizationGate(input);
            
            // After 4 hours of decay with 2-hour half-life:
            // decayFactor = 0.5^(4/2) = 0.25
            // effectiveTarget = 1.00 * 0.25 = 0.25 (but floor is 0.15)
            // fees = 0.40 >= 0.25, so exit should be allowed
            expect(result.allowExit).toBe(true);
            expect(result.debug.amortDecayApplied).toBe(true);
            expect(result.reason).toBe('AMORT_DECAY_OVERRIDE');
            
            // Verify fees < base but >= effective
            expect(input.feesAccruedUsd).toBeLessThan(input.baseCostTargetUsd);
            expect(input.feesAccruedUsd).toBeGreaterThanOrEqual(result.effectiveCostTargetUsd);
        });
        
        it('should return AMORT_DECAY_OVERRIDE reason when decay enabled exit', () => {
            const input = createTestInput({
                baseCostTargetUsd: 1.00,
                feesAccruedUsd: 0.30,
                holdTimeMs: 6 * MS_PER_HOUR,
                harmonicExitTriggered: true,
                healthScore: 0.20,
                velocityRatio: 0.05,
            });
            
            const result = computeAmortizationGate(input);
            
            if (result.allowExit && input.feesAccruedUsd < input.baseCostTargetUsd) {
                expect(result.reason).toBe('AMORT_DECAY_OVERRIDE');
            }
        });
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ADDITIONAL TESTS: Kill switch and edge cases
    // ═══════════════════════════════════════════════════════════════════════════
    
    describe('Kill switch behavior', () => {
        it('should revert to base behavior when AMORT_DECAY_ENABLED is false', () => {
            // Temporarily disable decay
            const originalEnabled = AMORT_DECAY_CONFIG.ENABLED;
            (AMORT_DECAY_CONFIG as any).ENABLED = false;
            
            const input = createTestInput({
                holdTimeMs: 6 * MS_PER_HOUR,
                feesAccruedUsd: 0.50,
                baseCostTargetUsd: 1.00,
            });
            
            const result = computeAmortizationGate(input);
            
            // Should use base behavior (no decay)
            expect(result.effectiveCostTargetUsd).toBe(input.baseCostTargetUsd);
            expect(result.debug.decayFactor).toBe(1.0);
            expect(result.debug.amortDecayApplied).toBe(false);
            expect(result.reason).toContain('decay disabled');
            
            // Restore
            (AMORT_DECAY_CONFIG as any).ENABLED = originalEnabled;
        });
    });
    
    describe('Weakness signal detection', () => {
        it('should detect VELOCITY_LOW weakness signal', () => {
            const input = createTestInput({
                holdTimeMs: 3 * MS_PER_HOUR,
                velocityRatio: 0.15, // Below 0.20 threshold
                entropyRatio: 0.50, // Above threshold
                mtmUnrealizedPnlPct: 0.01, // Positive
            });
            
            const result = computeAmortizationGate(input);
            
            expect(result.debug.weaknessGate).toBe(true);
            expect(result.debug.weaknessSignals).toContain('VELOCITY_LOW(0.15)');
        });
        
        it('should detect ENTROPY_LOW weakness signal', () => {
            const input = createTestInput({
                holdTimeMs: 3 * MS_PER_HOUR,
                velocityRatio: 0.50, // Above threshold
                entropyRatio: 0.30, // Below 0.35 threshold
                mtmUnrealizedPnlPct: 0.01, // Positive
            });
            
            const result = computeAmortizationGate(input);
            
            expect(result.debug.weaknessGate).toBe(true);
            expect(result.debug.weaknessSignals).toContain('ENTROPY_LOW(0.30)');
        });
        
        it('should detect MTM_DRIFT weakness signal', () => {
            const input = createTestInput({
                holdTimeMs: 3 * MS_PER_HOUR,
                velocityRatio: 0.50, // Above threshold
                entropyRatio: 0.50, // Above threshold
                mtmUnrealizedPnlPct: -0.003, // Below -0.20% threshold
            });
            
            const result = computeAmortizationGate(input);
            
            expect(result.debug.weaknessGate).toBe(true);
            expect(result.debug.weaknessSignals.some(s => s.startsWith('MTM_DRIFT'))).toBe(true);
        });
    });
    
    describe('Debug info completeness', () => {
        it('should include all required debug fields', () => {
            const input = createTestInput();
            const result = computeAmortizationGate(input);
            
            // Verify all debug fields are present
            expect(result.debug).toHaveProperty('baseCostTargetUsd');
            expect(result.debug).toHaveProperty('decayFactor');
            expect(result.debug).toHaveProperty('decayAgeMin');
            expect(result.debug).toHaveProperty('weaknessGate');
            expect(result.debug).toHaveProperty('halfLifeMin');
            expect(result.debug).toHaveProperty('telemetryKnown');
            expect(result.debug).toHaveProperty('weaknessSignals');
            expect(result.debug).toHaveProperty('floorUsd');
            expect(result.debug).toHaveProperty('amortDecayApplied');
            expect(result.debug).toHaveProperty('holdTimeMin');
            expect(result.debug).toHaveProperty('healthScore');
        });
    });
});

