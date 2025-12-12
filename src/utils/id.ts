/**
 * ID Generation Utilities
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: ALL IDs MUST BE GENERATED FRESH PER USE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides centralized UUID generation for trades and positions.
 * 
 * RULES:
 * 1. NEVER reuse IDs across trades
 * 2. NEVER derive IDs from engineId or other static values
 * 3. NEVER cache or memoize generated IDs
 * 4. NEVER use deterministic ID generation
 * 5. Each call MUST return a brand new UUID
 * 
 * This module now delegates to tradeId.ts which uses:
 * - crypto.randomUUID() for cryptographic randomness
 * - process.hrtime.bigint() for nanosecond entropy
 * - Optional retry suffix for collision recovery
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { 
    generateTradeId as generateHardenedTradeId,
    generatePositionId as generateHardenedPositionId,
    generateUUID as generateHardenedUUID 
} from './tradeId';

/**
 * Generate a collision-resistant UUID for a new trade.
 * 
 * CRITICAL: This MUST be called for EVERY new trade.
 * Each invocation returns a completely new, globally unique ID.
 * 
 * Uses hardened generation with:
 * - crypto.randomUUID()
 * - nanosecond timestamp entropy
 * 
 * @param attempt - Optional retry attempt number for collision recovery
 * @returns A collision-resistant unique ID string
 * 
 * @example
 * ```typescript
 * const tradeId = generateTradeId();
 * // Returns: "550e8400-e29b-41d4-a716-446655440000-1234567890123456789"
 * ```
 */
export function generateTradeId(attempt: number = 0): string {
    return generateHardenedTradeId(attempt);
}

/**
 * Generate a collision-resistant UUID for a new position.
 * 
 * CRITICAL: This MUST be called for EVERY new position.
 * Each invocation returns a completely new, globally unique ID.
 * 
 * @param attempt - Optional retry attempt number for collision recovery
 * @returns A collision-resistant unique ID string
 * 
 * @example
 * ```typescript
 * const positionId = generatePositionId();
 * // Returns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8-1234567890123456789"
 * ```
 */
export function generatePositionId(attempt: number = 0): string {
    return generateHardenedPositionId(attempt);
}

/**
 * Generate a collision-resistant UUID for any purpose.
 * 
 * Generic UUID generator for cases where a specific type isn't needed.
 * 
 * @param attempt - Optional retry attempt number for collision recovery
 * @returns A collision-resistant unique ID string
 */
export function generateUUID(attempt: number = 0): string {
    return generateHardenedUUID(attempt);
}

