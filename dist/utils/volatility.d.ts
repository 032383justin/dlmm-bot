import { Pool } from '../core/normalizePools';
interface VolatilityData {
    readonly priceRange24h: number;
    readonly volatilityPercent: number;
    readonly classification: 'low' | 'medium' | 'high';
    readonly positionSizeMultiplier: number;
}
/**
 * Calculate 24h price volatility for a pool
 * Uses high/low from 24h volume as proxy for price range
 */
export declare function calculateVolatility(pool: Pool): VolatilityData;
/**
 * Get position size multiplier based on volatility
 */
export declare function getVolatilityMultiplier(pool: Pool): number;
/**
 * Check if pool is too volatile for current risk tolerance
 */
export declare function isExcessivelyVolatile(pool: Pool, maxVolatilityPercent?: number): boolean;
export {};
//# sourceMappingURL=volatility.d.ts.map