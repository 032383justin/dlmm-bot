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
 * These functions use Node.js crypto.randomUUID() which provides
 * cryptographically secure random UUIDs (v4).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from 'crypto';

/**
 * Generate a fresh UUID for a new trade.
 * 
 * CRITICAL: This MUST be called for EVERY new trade.
 * Each invocation returns a completely new, globally unique ID.
 * 
 * @returns A fresh UUID v4 string
 * 
 * @example
 * ```typescript
 * const tradeId = generateTradeId();
 * // Returns something like: "550e8400-e29b-41d4-a716-446655440000"
 * ```
 */
export function generateTradeId(): string {
    return randomUUID();
}

/**
 * Generate a fresh UUID for a new position.
 * 
 * CRITICAL: This MUST be called for EVERY new position.
 * Each invocation returns a completely new, globally unique ID.
 * 
 * @returns A fresh UUID v4 string
 * 
 * @example
 * ```typescript
 * const positionId = generatePositionId();
 * // Returns something like: "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
 * ```
 */
export function generatePositionId(): string {
    return randomUUID();
}

/**
 * Generate a fresh UUID for any purpose.
 * 
 * Generic UUID generator for cases where a specific type isn't needed.
 * 
 * @returns A fresh UUID v4 string
 */
export function generateUUID(): string {
    return randomUUID();
}

