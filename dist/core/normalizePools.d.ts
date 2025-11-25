import { RawPoolData } from './scanPools';
export interface Pool {
    address: string;
    name: string;
    mintX: string;
    mintY: string;
    liquidity: number;
    volume1h: number;
    volume4h: number;
    volume24h: number;
    velocity: number;
    fees24h: number;
    apr: number;
    binStep: number;
    baseFee: number;
    createdAt: number;
    holderCount: number;
    topHolderPercent: number;
    isRenounced: boolean;
    riskScore: number;
    dilutionScore: number;
    score: number;
    currentPrice: number;
    binCount: number;
}
export declare const normalizePools: (rawPools: RawPoolData[]) => Promise<Pool[]>;
/**
 * Enrich top candidate pools with real DexScreener data
 * Call this AFTER initial filtering to only fetch data for promising pools
 */
export declare const enrichPoolsWithRealData: (pools: Pool[]) => Promise<Pool[]>;
//# sourceMappingURL=normalizePools.d.ts.map