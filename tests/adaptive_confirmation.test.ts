/**
 * Adaptive Snapshot Confirmation Tests
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests for the Execution Friction Reduction feature that implements adaptive
 * snapshot requirements for entry, exit, and redeploy decisions.
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Test Cases:
 *   1. Entry: Fast-path for Tier A/B with good signals (3-5 snapshots)
 *   2. Entry: Default path for non-qualifying entries (15 snapshots)
 *   3. Entry: Bootstrap pools always require full snapshots
 *   4. Exit: Fast-path for HARMONIC_EXIT, DOMINANCE_LOSS, etc. (1-2 snapshots)
 *   5. Exit: Entropy shock bypasses all gating
 *   6. Redeploy: Tier-A targets require only 5 snapshots
 *   7. Safety: Kill switch blocks all entries
 */

import {
    evaluateEntryConfirmation,
    evaluateExitConfirmation,
    evaluateRedeployConfirmation,
    wouldAllowEntry,
    wouldAllowExit,
    wouldAllowRedeploy,
    ADAPTIVE_SNAPSHOT_CONFIG,
    type EntryConfirmationInput,
    type ExitConfirmationInput,
    type RedeployConfirmationInput,
} from '../src/engine/adaptiveSnapshotGating';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function createEntryInput(partial: Partial<EntryConfirmationInput> = {}): EntryConfirmationInput {
    return {
        poolTier: 'A',
        dominanceScore: 0.35,
        dominanceThreshold: 0.25,
        velocitySlope: 0.01,
        entropyTrend: -0.005,
        snapshotCount: 5,
        isBootstrap: false,
        killSwitchActive: false,
        ...partial,
    };
}

function createExitInput(partial: Partial<ExitConfirmationInput> = {}): ExitConfirmationInput {
    return {
        exitReason: 'HARMONIC_EXIT',
        poolTier: 'B',
        snapshotCount: 2,
        healthScore: 0.35,
        killSwitchActive: false,
        entropyShock: false,
        ...partial,
    };
}

function createRedeployInput(partial: Partial<RedeployConfirmationInput> = {}): RedeployConfirmationInput {
    return {
        targetPoolTier: 'A',
        currentPoolTier: 'B',
        targetSnapshotCount: 5,
        targetPoolRank: 1,
        currentPoolRank: 3,
        isDeployed: true,
        isBootstrap: false,
        ...partial,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY CONFIRMATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Entry Confirmation', () => {
    describe('Fast-path eligibility', () => {
        it('should allow Tier-A entry with 3 snapshots when conditions are favorable', () => {
            const input = createEntryInput({
                poolTier: 'A',
                dominanceScore: 0.35,
                dominanceThreshold: 0.25,
                velocitySlope: 0.02,
                entropyTrend: -0.01,
                snapshotCount: 3,
            });
            
            const result = evaluateEntryConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.fastPathUsed).toBe(true);
            expect(result.requiredSnapshots).toBe(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.FAST_PATH_SNAPSHOTS_MIN);
        });
        
        it('should allow Tier-B entry with 5 snapshots when conditions are favorable', () => {
            const input = createEntryInput({
                poolTier: 'B',
                dominanceScore: 0.30,
                dominanceThreshold: 0.25,
                velocitySlope: 0.01,
                entropyTrend: 0.0,
                snapshotCount: 5,
            });
            
            const result = evaluateEntryConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.fastPathUsed).toBe(true);
            expect(result.requiredSnapshots).toBe(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.FAST_PATH_SNAPSHOTS_MAX);
        });
        
        it('should reject Tier-A entry with only 2 snapshots', () => {
            const input = createEntryInput({
                poolTier: 'A',
                snapshotCount: 2, // Below minimum of 3
            });
            
            const result = evaluateEntryConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.fastPathUsed).toBe(true);
            expect(result.reason).toContain('INSUFFICIENT');
        });
    });
    
    describe('Default path', () => {
        it('should require 15 snapshots for Tier-C pools', () => {
            const input = createEntryInput({
                poolTier: 'C',
                snapshotCount: 10,
            });
            
            const result = evaluateEntryConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.fastPathUsed).toBe(false);
            expect(result.requiredSnapshots).toBe(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.DEFAULT_SNAPSHOTS);
        });
        
        it('should require 15 snapshots when velocity slope is negative', () => {
            const input = createEntryInput({
                poolTier: 'A',
                velocitySlope: -0.01, // Negative = failing condition
                snapshotCount: 5,
            });
            
            const result = evaluateEntryConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.fastPathUsed).toBe(false);
            expect(result.requiredSnapshots).toBe(15);
        });
        
        it('should require 15 snapshots when dominance score is below threshold', () => {
            const input = createEntryInput({
                poolTier: 'A',
                dominanceScore: 0.20,
                dominanceThreshold: 0.25, // Score below threshold
                snapshotCount: 5,
            });
            
            const result = evaluateEntryConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.fastPathUsed).toBe(false);
        });
    });
    
    describe('Safety overrides', () => {
        it('should block all entries when kill switch is active', () => {
            const input = createEntryInput({
                killSwitchActive: true,
                snapshotCount: 100,
            });
            
            const result = evaluateEntryConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('KILL_SWITCH_ACTIVE');
        });
        
        it('should require full snapshots for bootstrap pools', () => {
            const input = createEntryInput({
                isBootstrap: true,
                poolTier: 'A',
                snapshotCount: 10,
            });
            
            const result = evaluateEntryConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.fastPathUsed).toBe(false);
            expect(result.requiredSnapshots).toBe(ADAPTIVE_SNAPSHOT_CONFIG.SAFETY.BOOTSTRAP_SNAPSHOTS);
        });
        
        it('should allow bootstrap pool with full snapshots', () => {
            const input = createEntryInput({
                isBootstrap: true,
                snapshotCount: 15,
            });
            
            const result = evaluateEntryConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.reason).toContain('BOOTSTRAP_PASSED');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT CONFIRMATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Exit Confirmation', () => {
    describe('Fast-path exits (1-2 snapshots)', () => {
        it('should allow HARMONIC_EXIT with 1 snapshot when health is low', () => {
            const input = createExitInput({
                exitReason: 'HARMONIC_EXIT',
                healthScore: 0.30, // Low health
                snapshotCount: 1,
            });
            
            const result = evaluateExitConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.fastPathUsed).toBe(true);
            expect(result.requiredSnapshots).toBe(1);
        });
        
        it('should allow DOMINANCE_LOSS with 2 snapshots when health is moderate', () => {
            const input = createExitInput({
                exitReason: 'DOMINANCE_LOSS',
                healthScore: 0.50, // Moderate health
                snapshotCount: 2,
            });
            
            const result = evaluateExitConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.fastPathUsed).toBe(true);
            expect(result.requiredSnapshots).toBe(2);
        });
        
        it('should allow VELOCITY_COLLAPSE with 1 snapshot', () => {
            const input = createExitInput({
                exitReason: 'VELOCITY_COLLAPSE',
                healthScore: 0.25,
                snapshotCount: 1,
            });
            
            const result = evaluateExitConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.fastPathUsed).toBe(true);
        });
        
        it('should allow AMORTIZATION_DECAY exits with minimal snapshots', () => {
            const input = createExitInput({
                exitReason: 'AMORT_DECAY_OVERRIDE',
                healthScore: 0.35,
                snapshotCount: 1,
            });
            
            const result = evaluateExitConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.fastPathUsed).toBe(true);
        });
        
        it('should allow MICROSTRUCTURE_EXIT with fast-path', () => {
            const input = createExitInput({
                exitReason: 'MICROSTRUCTURE_EXIT',
                snapshotCount: 2,
            });
            
            const result = evaluateExitConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.fastPathUsed).toBe(true);
        });
    });
    
    describe('Safety overrides', () => {
        it('should bypass all gating for entropy shock', () => {
            const input = createExitInput({
                entropyShock: true,
                snapshotCount: 0,
            });
            
            const result = evaluateExitConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.reason).toBe('ENTROPY_SHOCK_BYPASS');
            expect(result.requiredSnapshots).toBe(0);
        });
    });
    
    describe('Non-fast-path exits', () => {
        it('should require 3 snapshots for unknown exit reasons', () => {
            const input = createExitInput({
                exitReason: 'UNKNOWN_EXIT_TYPE',
                snapshotCount: 2,
            });
            
            const result = evaluateExitConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.fastPathUsed).toBe(false);
            expect(result.requiredSnapshots).toBe(ADAPTIVE_SNAPSHOT_CONFIG.EXIT.DEFAULT_SNAPSHOTS);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REDEPLOY CONFIRMATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Redeploy Confirmation', () => {
    describe('Tier-based fast-path', () => {
        it('should allow Tier-A redeploy with 5 snapshots', () => {
            const input = createRedeployInput({
                targetPoolTier: 'A',
                targetSnapshotCount: 5,
            });
            
            const result = evaluateRedeployConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.fastPathUsed).toBe(true);
            expect(result.requiredSnapshots).toBe(ADAPTIVE_SNAPSHOT_CONFIG.REDEPLOY.TIER_A_SNAPSHOTS);
        });
        
        it('should allow Tier-B redeploy with 8 snapshots', () => {
            const input = createRedeployInput({
                targetPoolTier: 'B',
                targetSnapshotCount: 8,
            });
            
            const result = evaluateRedeployConfirmation(input);
            
            expect(result.allowed).toBe(true);
            expect(result.fastPathUsed).toBe(true);
            expect(result.requiredSnapshots).toBe(ADAPTIVE_SNAPSHOT_CONFIG.REDEPLOY.TIER_B_SNAPSHOTS);
        });
        
        it('should require 12 snapshots for Tier-C targets', () => {
            const input = createRedeployInput({
                targetPoolTier: 'C',
                targetSnapshotCount: 10,
            });
            
            const result = evaluateRedeployConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.fastPathUsed).toBe(false);
            expect(result.requiredSnapshots).toBe(ADAPTIVE_SNAPSHOT_CONFIG.REDEPLOY.DEFAULT_SNAPSHOTS);
        });
    });
    
    describe('Safety overrides', () => {
        it('should require full snapshots for bootstrap targets', () => {
            const input = createRedeployInput({
                isBootstrap: true,
                targetPoolTier: 'A',
                targetSnapshotCount: 10,
            });
            
            const result = evaluateRedeployConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.fastPathUsed).toBe(false);
            expect(result.requiredSnapshots).toBe(ADAPTIVE_SNAPSHOT_CONFIG.SAFETY.BOOTSTRAP_SNAPSHOTS);
        });
    });
    
    describe('Rank improvement', () => {
        it('should block redeploy without rank improvement when deployed', () => {
            const input = createRedeployInput({
                isDeployed: true,
                targetPoolRank: 5,
                currentPoolRank: 3, // Target is worse
                targetSnapshotCount: 10,
            });
            
            const result = evaluateRedeployConfirmation(input);
            
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('rank not improved');
        });
        
        it('should allow redeploy to any rank when not deployed', () => {
            const input = createRedeployInput({
                isDeployed: false,
                targetPoolRank: 5,
                currentPoolRank: undefined,
                targetSnapshotCount: 5,
            });
            
            const result = evaluateRedeployConfirmation(input);
            
            expect(result.allowed).toBe(true);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE FUNCTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Convenience Functions', () => {
    it('wouldAllowEntry should return boolean', () => {
        const input = createEntryInput({ snapshotCount: 5 });
        expect(typeof wouldAllowEntry(input)).toBe('boolean');
    });
    
    it('wouldAllowExit should return boolean', () => {
        const input = createExitInput({ snapshotCount: 2 });
        expect(typeof wouldAllowExit(input)).toBe('boolean');
    });
    
    it('wouldAllowRedeploy should return boolean', () => {
        const input = createRedeployInput({ targetSnapshotCount: 5 });
        expect(typeof wouldAllowRedeploy(input)).toBe('boolean');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Configuration Validation', () => {
    it('should have entry fast-path snapshots less than default', () => {
        expect(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.FAST_PATH_SNAPSHOTS_MIN)
            .toBeLessThan(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.DEFAULT_SNAPSHOTS);
        expect(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.FAST_PATH_SNAPSHOTS_MAX)
            .toBeLessThan(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.DEFAULT_SNAPSHOTS);
    });
    
    it('should have exit max snapshots at most 2', () => {
        expect(ADAPTIVE_SNAPSHOT_CONFIG.EXIT.MAX_SNAPSHOTS_REQUIRED).toBeLessThanOrEqual(2);
    });
    
    it('should have redeploy Tier-A snapshots at most 5', () => {
        expect(ADAPTIVE_SNAPSHOT_CONFIG.REDEPLOY.TIER_A_SNAPSHOTS).toBeLessThanOrEqual(5);
    });
    
    it('should have Tier A/B as eligible entry tiers', () => {
        expect(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.ELIGIBLE_TIERS).toContain('A');
        expect(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.ELIGIBLE_TIERS).toContain('B');
        expect(ADAPTIVE_SNAPSHOT_CONFIG.ENTRY.ELIGIBLE_TIERS).not.toContain('C');
    });
});
