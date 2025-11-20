export interface TokenMetadata {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  holders?: number;
  supply?: number;
  hasMintAuthority?: boolean;
  hasFreezeAuthority?: boolean;
}

export async function fetchTokenMetadata(mint: string): Promise<TokenMetadata> {
  // TODO: Replace with on-chain or API lookup.
  return {
    mint,
    symbol: undefined,
    name: undefined,
    decimals: 0,
  };
}

export async function fetchHolderCount(mint: string): Promise<number> {
  // TODO: Query holder count from relevant API.
  return 0;
}

export async function fetchTokenSafetyFlags(
  mint: string,
): Promise<{ hasMintAuthority: boolean; hasFreezeAuthority: boolean }> {
  // TODO: Inspect token metadata for authority flags.
  return {
    hasMintAuthority: false,
    hasFreezeAuthority: false,
  };
}
