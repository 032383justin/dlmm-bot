import { Pool } from '../core/normalizePools';
/**
 * Calculate fee tier score based on how well it matches pool volatility
 * Stable pairs should have low fees, volatile pairs should have high fees
 */
export declare function calculateFeeTierScore(pool: Pool): number;
//# sourceMappingURL=feeTier.d.ts.map