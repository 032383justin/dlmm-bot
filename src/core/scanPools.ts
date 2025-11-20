const DLMM_POOLS_ENDPOINT = "https://dlmmdata.autoscale.ai/pools";

type FetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
};

type FetchLike = (input: string) => Promise<FetchResponse>;

const fetcher: FetchLike | undefined = (globalThis as unknown as { fetch?: FetchLike }).fetch;

export interface PoolRaw {
  id: string;
  tokenA: string;
  tokenB: string;
  tvl: number;
  volume24h: number;
  feeTier: number;
  createdAt?: string;
}

export interface PoolNormalized {
  id: string;
  tokenA: string;
  tokenB: string;
  tvl: number;
  volume24h: number;
  feeTier: number;
  ageDays: number;
}

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sanitizePoolsPayload = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown[] }).data)) {
    return (payload as { data: unknown[] }).data;
  }

  return [];
};

const mapToPoolRaw = (entry: unknown): PoolRaw | null => {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const pool = entry as Record<string, unknown>;

  const id = pool.id ?? pool.pool_id;
  const tokenA = pool.tokenA ?? pool.token_a_mint;
  const tokenB = pool.tokenB ?? pool.token_b_mint;

  const normalized: PoolRaw = {
    id: typeof id === 'string' ? id : id ? String(id) : '',
    tokenA: typeof tokenA === 'string' ? tokenA : tokenA ? String(tokenA) : '',
    tokenB: typeof tokenB === 'string' ? tokenB : tokenB ? String(tokenB) : '',
    tvl: toNumber(pool.tvl ?? pool.total_value_locked),
    volume24h: toNumber(pool.volume24h ?? pool.volume_24h ?? pool.volume),
    feeTier: toNumber(pool.feeTier ?? pool.fee_tier),
    createdAt:
      typeof pool.createdAt === 'string'
        ? pool.createdAt
        : typeof pool.created_at === 'string'
          ? pool.created_at
          : undefined,
  };

  return normalized.id && normalized.tokenA && normalized.tokenB ? normalized : null;
};

import axios from "axios";

export async function fetchRawPools(): Promise<PoolRaw[]> {
  try {
    const response = await axios.get(DLMM_POOLS_ENDPOINT, {
      timeout: 15000,
      headers: {
        "User-Agent": "dlmm-bot",
        "Accept": "application/json",
      },
      maxRedirects: 0,
      httpsAgent: new (require("https").Agent)({
        rejectUnauthorized: false,  // allows Windows TLS handshake
      }),
    });

    const data = response.data;

    if (!Array.isArray(data)) {
      console.error("Invalid DLMM API response:", data);
      return [];
    }

    return data.map((pool: any) => ({
      id: pool.id,
      tokenA: pool.tokenA,
      tokenB: pool.tokenB,
      tvl: Number(pool.tvl) || 0,
      volume24h: Number(pool.volume24h) || 0,
      feeTier: pool.feeTier || 0,
      createdAt: pool.createdAt || null,
    }));

  } catch (err) {
    console.error("DLMM pool fetch error via Axios:", err);
    return [];
  }
}

const MS_IN_DAY = 86_400_000;

const calculateAgeDays = (createdAt?: string): number => {
  if (!createdAt) {
    return 0;
  }

  const timestamp = Date.parse(createdAt);

  if (Number.isNaN(timestamp)) {
    return 0;
  }

  const diff = Date.now() - timestamp;
  return diff > 0 ? diff / MS_IN_DAY : 0;
};

export function normalizePools(raw: PoolRaw[]): PoolNormalized[] {
  return raw.map((pool) => {
    const tvl = toNumber(pool.tvl);
    const volume = toNumber(pool.volume24h);
    const feeTier = toNumber(pool.feeTier);

    return {
      id: pool.id,
      tokenA: pool.tokenA,
      tokenB: pool.tokenB,
      tvl: tvl >= 0 ? tvl : 0,
      volume24h: volume >= 0 ? volume : 0,
      feeTier: feeTier >= 0 ? feeTier : 0,
      ageDays: calculateAgeDays(pool.createdAt),
    };
  });
}

export async function scanPools(): Promise<PoolNormalized[]> {
  const rawPools = await fetchRawPools();
  return normalizePools(rawPools);
}
