import { PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

type RawPool = {
    name?: string;
    poolId: string;
};

export function adaptPools(raw: RawPool[]) {
    return raw.map((pool: RawPool) => ({
        name: pool.name || "DLMM Pool",

        // always safe pool identifier
        id: pool.poolId,

        mintA: new PublicKey("11111111111111111111111111111111"),
        mintB: new PublicKey("11111111111111111111111111111111"),

        // programId guaranteed — fallback to dummy if env missing
        programId: new PublicKey(
            process.env.RAYDIUM_DLMM_PROGRAM_ID ||
            "11111111111111111111111111111111"
        ),

        authority: new PublicKey("11111111111111111111111111111111"),

        // filler for downstream compatibility
        feeRate: 0,
        tradeFee: 0,
        decimalsA: 6,
        decimalsB: 6,
    }));
}


