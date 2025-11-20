-- Positions table
CREATE TABLE IF NOT EXISTS positions (
  poolId TEXT PRIMARY KEY,
  amount NUMERIC,
  isActive BOOLEAN,
  enteredAt TIMESTAMPTZ,
  exitAt TIMESTAMPTZ
);

-- Pools table
CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  tokenA TEXT,
  tokenB TEXT,
  tvl NUMERIC,
  daily_volume NUMERIC,
  fee_tier NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pool snapshots
CREATE TABLE IF NOT EXISTS pool_snapshots (
  id SERIAL PRIMARY KEY,
  pool_id TEXT,
  tvl NUMERIC,
  volume_1h NUMERIC,
  volume_24h NUMERIC,
  score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Logs
CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  level TEXT,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance table
CREATE TABLE IF NOT EXISTS performance (
  id SERIAL PRIMARY KEY,
  poolId TEXT,
  entryAmount NUMERIC,
  currentAmount NUMERIC,
  roi NUMERIC,
  pnl NUMERIC,
  lastUpdated TIMESTAMPTZ
);

