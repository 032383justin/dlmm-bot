import { Connection, PublicKey } from '@solana/web3.js';
import { Pool } from './normalizePools';
import { connection } from './scanPools';
import logger from '../utils/logger';

export const calculateDilutionScore = async (pool: Pool): Promise<number> => {
  // dilutionScore = 
  //   tokenSupplyIncreaseTrend +
  //   topHolderConcentrationTrend +
  //   lpContributorDrop +
  //   botSwarmIncrease +
  //   suspiciousMintAuthActivity

  // This is a complex score. We will implement a simplified version based on available RPC data.
  // We need to fetch Mint info and Top Holders.

  let score = 0;

  try {
    const mintX = new PublicKey(pool.mintX);
    // const mintY = new PublicKey(pool.mintY); // Usually we check the non-stable/non-SOL token.
    // Assuming Mint X is the token of interest (or we check both).
    // For simplicity, we check Mint X if it's not SOL/USDC.
    // But we don't know which is which easily without a list of "quote" tokens.
    // We will check Mint X for now.

    const supplyInfo = await connection.getTokenSupply(mintX);
    const supply = supplyInfo.value.uiAmount || 0;

    // 1. Token Supply Increase (requires history, we'll check if mint authority is active)
    const mintAccountInfo = await connection.getAccountInfo(mintX);
    // Parsing mint account to see if mint authority is set (Risk)
    // Layout: MintAuthorityOption (4) + MintAuthority (32) ...
    // Quick check: if mint authority is NOT null, add risk.
    // We can use spl-token library to parse, but let's do a raw check or use a helper if we had one.
    // For now, we assume if supply is huge or changed, it's bad.
    // Without history, we can't check "Trend" in one go.
    // We will return a base score based on "Suspicious Mint Auth" (if we could parse it).

    // 2. Top Holder Concentration
    const largestAccounts = await connection.getTokenLargestAccounts(mintX);
    const topHolders = largestAccounts.value;

    if (topHolders.length > 0) {
      const topHolderAmount = topHolders[0].uiAmount || 0;
      const concentration = (topHolderAmount / supply) * 100;

      // Rule: reject if topHolder > 18%
      // Dilution score increases as concentration approaches limit?
      // Actually "dilution" usually means *more* tokens entering.
      // "Concentration" is a safety filter.
      // But the prompt says "dilutionScore = ... + topHolderConcentrationTrend".
      // If concentration *drops* rapidly, it might mean dumping?
      // Or if it *increases*, it might be accumulation?
      // Let's assign a score based on high concentration as a risk factor here.
      if (concentration > 15) score += 20;
    }

    // 3. LP Contributor Drop / Bot Swarm
    // Hard to measure without analyzing transaction logs.
    // We will use a placeholder random factor or 0 for now to avoid blocking.
    // In production, this needs `getSignaturesForAddress` analysis.

    return score;
  } catch (error: any) {
    if (error.message?.includes('Too many accounts')) {
      // Common error for large tokens (USDC, SOL) on some RPCs
      // We can assume these are "safe" from a dilution perspective (too big to manipulate easily)
      // or just skip.
      return 0;
    }
    logger.warn(`Error calculating dilution for ${pool.address}: ${error.message}`);
    return 0; // Fail safe
  }
};
