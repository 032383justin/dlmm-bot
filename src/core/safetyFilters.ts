import { STRATEGY_PARAMETERS } from '../config';
import {
  fetchHolderCount,
  fetchTokenMetadata,
  fetchTokenSafetyFlags,
} from '../data/tokens';
import { PoolNormalized } from './scanPools';

export async function isTokenSafe(mint: string): Promise<boolean> {
  try {
    const [metadata, holders, flags] = await Promise.all([
      fetchTokenMetadata(mint),
      fetchHolderCount(mint),
      fetchTokenSafetyFlags(mint),
    ]);

    const holdersSafe = holders >= STRATEGY_PARAMETERS.HOLDER_COUNT_MIN;

    const noMintAuthority =
      metadata.hasMintAuthority === false && flags.hasMintAuthority === false;

    const noFreezeAuthority =
      metadata.hasFreezeAuthority === false && flags.hasFreezeAuthority === false;

    return holdersSafe && noMintAuthority && noFreezeAuthority;
  } catch (error) {
    console.error('Token safety check failed', mint, error);
    return false;
  }
}

export function isPoolAgeSafe(pool: PoolNormalized): boolean {
  return pool.ageDays >= STRATEGY_PARAMETERS.MIN_POOL_AGE_DAYS;
}

export function isPoolTVLSafe(pool: PoolNormalized): boolean {
  return pool.tvl >= STRATEGY_PARAMETERS.MIN_TVL;
}

export function isVolumeSafe(pool: PoolNormalized): boolean {
  return pool.volume24h >= STRATEGY_PARAMETERS.MIN_DAILY_VOLUME;
}

export async function isPoolSafe(pool: PoolNormalized): Promise<boolean> {
  const basicChecks = isPoolAgeSafe(pool) && isPoolTVLSafe(pool) && isVolumeSafe(pool);

  if (!basicChecks) {
    return false;
  }

  const [tokenASafe, tokenBSafe] = await Promise.all([
    isTokenSafe(pool.tokenA),
    isTokenSafe(pool.tokenB),
  ]);

  return tokenASafe && tokenBSafe;
}
