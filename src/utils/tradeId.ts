/**
 * Trade ID Generation - Collision-Resistant Implementation
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRITICAL: COLLISION-PROOF TRADE ID GENERATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * This module provides hardened UUID generation that eliminates duplicate key
 * violations by combining multiple sources of entropy:
 * 
 * 1. crypto.randomUUID() - Cryptographically secure UUID v4
 * 2. process.hrtime.bigint() - Nanosecond timestamp entropy
 * 3. Optional retry suffix - For collision recovery
 * 
 * USAGE:
 * - Normal generation: generateTradeId()
 * - After collision: generateTradeId(attempt) where attempt > 0
 * 
 * FORMAT:
 * - First attempt: {uuid}-{nanoseconds}
 * - Retry attempts: {uuid}-{nanoseconds}-r{attempt}
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from "crypto";

/**
 * Generates a collision-resistant trade ID using:
 * - crypto.randomUUID() for cryptographic randomness
 * - nanosecond timestamp entropy for uniqueness
 * - optional retry suffix for collision recovery
 * 
 * @param attempt - Retry attempt number (0 for first attempt)
 * @returns Globally unique trade ID
 * 
 * @example
 * ```typescript
 * // Normal generation
 * const id = generateTradeId();
 * // Returns: "550e8400-e29b-41d4-a716-446655440000-1234567890123456789"
 * 
 * // After collision retry
 * const retryId = generateTradeId(1);
 * // Returns: "550e8400-e29b-41d4-a716-446655440000-1234567890123456789-r1"
 * ```
 */
export function generateTradeId(attempt: number = 0): string {
    const base = randomUUID();
    const nano = process.hrtime.bigint().toString();

    // Include attempt number only if > 0 (collision retry)
    return attempt > 0 ? `${base}-${nano}-r${attempt}` : `${base}-${nano}`;
}

/**
 * Generates a collision-resistant position ID using the same algorithm.
 * Position IDs share the same entropy requirements as trade IDs.
 * 
 * @param attempt - Retry attempt number (0 for first attempt)
 * @returns Globally unique position ID
 */
export function generatePositionId(attempt: number = 0): string {
    return generateTradeId(attempt);
}

/**
 * Generates a collision-resistant generic UUID.
 * Uses the same hardened algorithm for any ID requirement.
 * 
 * @param attempt - Retry attempt number (0 for first attempt)
 * @returns Globally unique ID
 */
export function generateUUID(attempt: number = 0): string {
    return generateTradeId(attempt);
}

