/**
 * ID Generation Tests
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * Validates that ID generation is always unique and never reused.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { generateTradeId, generatePositionId, generateUUID } from '../src/utils/id';

describe('ID Generation', () => {
    describe('generateTradeId', () => {
        test('always returns unique values', () => {
            const a = generateTradeId();
            const b = generateTradeId();
            expect(a).not.toBe(b);
        });

        test('generates valid UUID format', () => {
            const id = generateTradeId();
            // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            expect(id).toMatch(uuidRegex);
        });

        test('generates unique values across many calls', () => {
            const ids = new Set<string>();
            const count = 1000;
            
            for (let i = 0; i < count; i++) {
                ids.add(generateTradeId());
            }
            
            expect(ids.size).toBe(count);
        });
    });

    describe('generatePositionId', () => {
        test('always returns unique values', () => {
            const a = generatePositionId();
            const b = generatePositionId();
            expect(a).not.toBe(b);
        });

        test('generates valid UUID format', () => {
            const id = generatePositionId();
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            expect(id).toMatch(uuidRegex);
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

        test('generates valid UUID format', () => {
            const id = generateUUID();
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            expect(id).toMatch(uuidRegex);
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
    });
});

