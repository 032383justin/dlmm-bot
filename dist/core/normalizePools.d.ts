import { RawPoolData } from './scanPools';
import { NormalizedPool } from '../types/pools';
/**
 * Pool - Extended interface for full microstructure analysis.
 * Extends NormalizedPool with additional fields required for:
 * - Multi-timeframe volume analysis
 * - Bin structure scoring
 * - Risk/safety evaluation
 * - Structural entry/exit signals
 *
 * All downstream modules (scoring, volume, dilution, structural) use this type.
 */
export interface Pool extends NormalizedPool {
    mintX: string;
    mintY: string;
    volume1h: number;
    volume4h: number;
    velocity: number;
    binStep: number;
    baseFee: number;
    binCount: number;
    createdAt: number;
    holderCount: number;
    topHolderPercent: number;
    isRenounced: boolean;
    riskScore: number;
    dilutionScore: number;
    score: number;
    currentPrice: number;
}
export declare const normalizePools: (rawPools: RawPoolData[]) => Promise<Pool[]>;
/**
 * Enrich top candidate pools with real DexScreener data
 * Call this AFTER initial filtering to only fetch data for promising pools
 */
export declare const enrichPoolsWithRealData: (pools: Pool[]) => Promise<Pool[]>;
//# sourceMappingURL=normalizePools.d.ts.map