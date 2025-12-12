/**
 * ID Generation Tests
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Validates that ID generation is always unique and never reused.
 * 
 * ID Format: {uuid}-{nanoseconds} or {uuid}-{nanoseconds}-r{attempt}
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { generateTradeId, generatePositionId, generateUUID } from '../src/utils/id';
import { generateTradeId as generateHardenedTradeId } from '../src/utils/tradeId';

describe('ID Generation', () => {
    describe('generateTradeId', () => {
        test('always returns unique values', () => {
            const a = generateTradeId();
            const b = generateTradeId();
            expect(a).not.toBe(b);
        });

        test('generates collision-resistant format with UUID and nanoseconds', () => {
            const id = generateTradeId();
            // Format: uuid-nanoseconds (uuid is 36 chars, dash, then nanoseconds)
            // UUID v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx (36 chars)
            // Full format: uuid-nanoseconds
            const collisionResistantRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-\d+$/i;
            expect(id).toMatch(collisionResistantRegex);
        });

        test('generates unique values across many calls', () => {
            const ids = new Set<string>();
            const count = 1000;
            
            for (let i = 0; i < count; i++) {
                ids.add(generateTradeId());
            }
            
            expect(ids.size).toBe(count);
        });

        test('includes retry suffix when attempt > 0', () => {
            const retryId = generateTradeId(1);
            // Format: uuid-nanoseconds-r1
            expect(retryId).toMatch(/-r1$/);
        });

        test('different retry attempts produce different suffixes', () => {
            const retry1 = generateTradeId(1);
            const retry2 = generateTradeId(2);
            expect(retry1).toMatch(/-r1$/);
            expect(retry2).toMatch(/-r2$/);
        });
    });

    describe('generatePositionId', () => {
        test('always returns unique values', () => {
            const a = generatePositionId();
            const b = generatePositionId();
            expect(a).not.toBe(b);
        });

        test('generates collision-resistant format', () => {
            const id = generatePositionId();
            const collisionResistantRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-\d+$/i;
            expect(id).toMatch(collisionResistantRegex);
        });

        test('is different from trade IDs generated at same time', () => {
            const tradeId = generateTradeId();
            const positionId = generatePositionId();
            expect(tradeId).not.toBe(positionId);
        });
    });

    describe('generateUUID', () => {
        test('always returns unique values', () => {
            const a = generateUUID();
            const b = generateUUID();
            expect(a).not.toBe(b);
        });

        test('generates collision-resistant format', () => {
            const id = generateUUID();
            const collisionResistantRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-\d+$/i;
            expect(id).toMatch(collisionResistantRegex);
        });
    });

    describe('Hardened Trade ID Generator (tradeId.ts)', () => {
        test('generates IDs with nanosecond entropy', () => {
            const id1 = generateHardenedTradeId();
            const id2 = generateHardenedTradeId();
            
            // Extract nanosecond parts
            const nano1 = id1.split('-').pop();
            const nano2 = id2.split('-').pop();
            
            // Nanoseconds should be different (unless machine is impossibly fast)
            expect(nano1).not.toBe(nano2);
        });

        test('retry IDs have correct suffix format', () => {
            const id0 = generateHardenedTradeId(0);
            const id1 = generateHardenedTradeId(1);
            const id3 = generateHardenedTradeId(3);
            
            expect(id0).not.toMatch(/-r\d+$/);
            expect(id1).toMatch(/-r1$/);
            expect(id3).toMatch(/-r3$/);
        });
    });

    describe('No ID Reuse Verification', () => {
        test('rapid generation produces unique IDs', () => {
            const ids: string[] = [];
            
            // Generate many IDs rapidly
            for (let i = 0; i < 100; i++) {
                ids.push(generateTradeId());
                ids.push(generatePositionId());
                ids.push(generateUUID());
            }
            
            // All should be unique
            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(ids.length);
        });

        test('concurrent generation produces unique IDs', async () => {
            const promises = Array.from({ length: 100 }, () => 
                Promise.resolve(generateTradeId())
            );
            
            const ids = await Promise.all(promises);
            const uniqueIds = new Set(ids);
            
            expect(uniqueIds.size).toBe(ids.length);
        });

        test('nanosecond entropy prevents same-millisecond collisions', () => {
            // Generate IDs as fast as possible to test nanosecond differentiation
            const ids: string[] = [];
            for (let i = 0; i < 10000; i++) {
                ids.push(generateHardenedTradeId());
            }
            
            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(ids.length);
        });
    });

    describe('Collision Recovery', () => {
        test('retry attempts generate completely new IDs', () => {
            const original = generateHardenedTradeId(0);
            const retry1 = generateHardenedTradeId(1);
            const retry2 = generateHardenedTradeId(2);
            
            // All should be unique - even the UUID base is regenerated
            expect(original).not.toBe(retry1);
            expect(retry1).not.toBe(retry2);
            expect(original).not.toBe(retry2);
        });
    });
});

