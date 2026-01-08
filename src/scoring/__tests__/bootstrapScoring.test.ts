/**
 * Bootstrap Scoring Sanity Tests
 * 
 * These tests ensure that bootstrap scoring produces non-zero scores
 * for pools with healthy metrics, preventing the "score=0 forever" regression.
 */

import {
    computeBootstrapScore,
    computeBootstrapMHI,
    BootstrapScoreInputs,
    meetsBootstrapEntryThreshold,
} from '../bootstrapScoring';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════

const HEALTHY_POOL: BootstrapScoreInputs = {
    poolAddress: 'TEST_HEALTHY_POOL_ADDRESS',
    poolName: 'SOL-USDC',
    volume24h: 500000,  // $500k volume
    tvl: 300000,        // $300k TVL
    feeRate: 0.003,     // 0.3% fee
    binStep: 10,        // Tight bins
    tokenX: 'SOL',
    tokenY: 'USDC',
};

const LOW_ACTIVITY_POOL: BootstrapScoreInputs = {
    poolAddress: 'TEST_LOW_ACTIVITY_POOL',
    poolName: 'MEME-SOL',
    volume24h: 5000,    // Only $5k volume
    tvl: 10000,         // $10k TVL
    feeRate: 0.001,     // 0.1% fee
    binStep: 100,       // Wide bins
    tokenX: 'MEME',
    tokenY: 'SOL',
};

const ZERO_POOL: BootstrapScoreInputs = {
    poolAddress: 'TEST_ZERO_POOL',
    poolName: 'DEAD-DEAD',
    volume24h: 0,
    tvl: 0,
    feeRate: 0,
    binStep: 0,
    tokenX: 'DEAD',
    tokenY: 'DEAD',
};

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Bootstrap Scoring', () => {
    describe('computeBootstrapScore', () => {
        it('should return non-zero score for healthy pool', () => {
            const result = computeBootstrapScore(HEALTHY_POOL);
            
            expect(result.score).toBeGreaterThan(0);
            expect(result.score).toBeGreaterThan(20); // Should be well above min threshold
            expect(result.isBootstrap).toBe(true);
            expect(result.label).toBe('BOOTSTRAP');
        });

        it('should return score components for healthy pool', () => {
            const result = computeBootstrapScore(HEALTHY_POOL);
            
            expect(result.components.volumeScore).toBeGreaterThan(0);
            expect(result.components.tvlScore).toBeGreaterThan(0);
            expect(result.components.feeRateScore).toBeGreaterThan(0);
            expect(result.components.binStepScore).toBeGreaterThan(0);
            expect(result.components.tokenQualityScore).toBeGreaterThan(0);
        });

        it('should give higher score to high-activity pools', () => {
            const healthyResult = computeBootstrapScore(HEALTHY_POOL);
            const lowResult = computeBootstrapScore(LOW_ACTIVITY_POOL);
            
            expect(healthyResult.score).toBeGreaterThan(lowResult.score);
        });

        it('should handle zero-activity pool gracefully', () => {
            const result = computeBootstrapScore(ZERO_POOL);
            
            // Should return a low score, not crash
            expect(result.score).toBeDefined();
            expect(result.isBootstrap).toBe(true);
        });

        it('should give blue chip bonus to SOL-USDC pair', () => {
            const result = computeBootstrapScore(HEALTHY_POOL);
            
            // Both SOL and USDC are blue chips = 100% token quality
            expect(result.components.tokenQualityScore).toBe(100);
        });
    });

    describe('computeBootstrapMHI', () => {
        it('should return non-zero MHI for healthy pool', () => {
            const result = computeBootstrapMHI(HEALTHY_POOL);
            
            expect(result.mhi).toBeGreaterThan(0);
            expect(result.mhi).toBeLessThanOrEqual(1);
            expect(result.isBootstrap).toBe(true);
        });

        it('should return MHI in valid range [0, 1]', () => {
            const result = computeBootstrapMHI(HEALTHY_POOL);
            
            expect(result.mhi).toBeGreaterThanOrEqual(0);
            expect(result.mhi).toBeLessThanOrEqual(1);
        });
    });

    describe('meetsBootstrapEntryThreshold', () => {
        it('should allow entry for healthy pool with bootstrap score', () => {
            const bootstrapResult = computeBootstrapScore(HEALTHY_POOL);
            
            const result = meetsBootstrapEntryThreshold(
                false, // No valid telemetry
                0,     // No telemetry score
                bootstrapResult.score
            );
            
            expect(result.eligible).toBe(true);
            expect(result.isBootstrap).toBe(true);
            expect(result.score).toBe(bootstrapResult.score);
        });

        it('should prefer telemetry score when available', () => {
            const result = meetsBootstrapEntryThreshold(
                true, // Has valid telemetry
                50,   // Telemetry score of 50
                80    // Bootstrap score of 80 (higher)
            );
            
            // Should use telemetry score, not bootstrap
            expect(result.score).toBe(50);
            expect(result.isBootstrap).toBe(false);
        });

        it('should reject when both scores are below threshold', () => {
            const result = meetsBootstrapEntryThreshold(
                false, // No valid telemetry
                0,     // No telemetry score
                5      // Low bootstrap score
            );
            
            expect(result.eligible).toBe(false);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION PREVENTION: Score=0 Forever
// ═══════════════════════════════════════════════════════════════════════════════

describe('Score=0 Regression Prevention', () => {
    it('CRITICAL: Healthy pool must NEVER have score=0', () => {
        const result = computeBootstrapScore(HEALTHY_POOL);
        
        // This is the critical regression test
        // If this fails, the bot will never enter positions
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).not.toBe(0);
    });

    it('CRITICAL: Bootstrap MHI must NEVER be 0 for healthy pool', () => {
        const result = computeBootstrapMHI(HEALTHY_POOL);
        
        expect(result.mhi).toBeGreaterThan(0);
        expect(result.mhi).not.toBe(0);
    });

    it('CRITICAL: Entry should be allowed for pool with $500k volume', () => {
        const score = computeBootstrapScore(HEALTHY_POOL);
        
        const threshold = meetsBootstrapEntryThreshold(
            false,
            0,
            score.score
        );
        
        expect(threshold.eligible).toBe(true);
    });
});

