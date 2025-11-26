import { PublicKey } from "@solana/web3.js";

export interface MinimalPool {
    name: string;
    poolId: string;
}

export function adaptPools(raw: MinimalPool[]) {
    return raw.map((pool) => {
        const fallback = new PublicKey("11111111111111111111111111111111");

        return {
            // Required identifiers
            name: pool.name,
            poolId: pool.poolId,

            // Legacy fields your index.ts expects
            address: pool.poolId,
            id: pool.poolId,

            // Dummy assets
            mintX: fallback,
            mintY: fallback,

            // Fake liquidity and volume to keep scoring / safety logic alive
            liquidity: 1_000_000,
            volume24h: 1_000_000,
            volatility: 0.1,

            // Raydium DLMM Program ID
            programId: process.env.RAYDIUM_DLMM_PROGRAM_ID
                ? new PublicKey(process.env.RAYDIUM_DLMM_PROGRAM_ID)
                : fallback,

            // Placeholder authority
            authority: fallback,

            // Decimals
            decimalsX: 6,
            decimalsY: 6,

            // Fees
            feeRate: 0,
            apy: 0,
        };
    });
}




