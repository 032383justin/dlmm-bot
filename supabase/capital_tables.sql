-- Supabase tables for persistent capital management
-- Run this migration to enable persistent capital tracking

-- ═══════════════════════════════════════════════════════════════════════════════
-- CAPITAL STATE TABLE - Single row storing current capital state
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS capital_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  available_balance NUMERIC(18, 8) NOT NULL DEFAULT 10000,
  locked_balance NUMERIC(18, 8) NOT NULL DEFAULT 0,
  total_realized_pnl NUMERIC(18, 8) NOT NULL DEFAULT 0,
  initial_capital NUMERIC(18, 8) NOT NULL DEFAULT 10000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Ensure only one row exists
  CONSTRAINT single_row CHECK (id = 1)
);

-- Insert default row if not exists
INSERT INTO capital_state (id, available_balance, locked_balance, total_realized_pnl, initial_capital)
VALUES (1, 10000, 0, 0, 10000)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE capital_state IS 'Single-row table storing current capital state for the bot';
COMMENT ON COLUMN capital_state.available_balance IS 'Capital available for new trades';
COMMENT ON COLUMN capital_state.locked_balance IS 'Capital locked in active trades';
COMMENT ON COLUMN capital_state.total_realized_pnl IS 'Cumulative realized profit/loss';
COMMENT ON COLUMN capital_state.initial_capital IS 'Starting capital for reference';

-- ═══════════════════════════════════════════════════════════════════════════════
-- CAPITAL LOCKS TABLE - Tracks capital locked per trade
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS capital_locks (
  id BIGSERIAL PRIMARY KEY,
  trade_id TEXT NOT NULL UNIQUE,
  amount NUMERIC(18, 8) NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capital_locks_trade_id ON capital_locks(trade_id);

COMMENT ON TABLE capital_locks IS 'Tracks capital locked for each active trade';
COMMENT ON COLUMN capital_locks.trade_id IS 'Unique identifier of the trade';
COMMENT ON COLUMN capital_locks.amount IS 'Amount of capital locked for this trade';

-- ═══════════════════════════════════════════════════════════════════════════════
-- TRADES TABLE - Persistent trade storage (MANDATORY)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  pool_address TEXT NOT NULL,
  pool_name TEXT,
  
  -- Entry data
  entry_price NUMERIC(24, 12) NOT NULL,
  size NUMERIC(18, 8) NOT NULL,
  bin INTEGER,
  score NUMERIC(8, 4),
  v_slope NUMERIC(12, 8),
  l_slope NUMERIC(12, 8),
  e_slope NUMERIC(12, 8),
  
  -- Additional entry metrics
  liquidity NUMERIC(18, 4),
  velocity NUMERIC(12, 8),
  entropy NUMERIC(12, 8),
  mode TEXT DEFAULT 'standard',
  
  -- Exit data (NULL until trade is closed)
  exit_price NUMERIC(24, 12),
  pnl_usd NUMERIC(18, 8),
  exit_time TIMESTAMPTZ,
  exit_reason TEXT,
  
  -- Status
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_pool_address ON trades(pool_address);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at DESC);

COMMENT ON TABLE trades IS 'Persistent trade storage - MANDATORY for bot operation';
COMMENT ON COLUMN trades.id IS 'UUID trade identifier';
COMMENT ON COLUMN trades.pool_address IS 'DLMM pool address';
COMMENT ON COLUMN trades.status IS 'Trade status: open, closed, or cancelled';

-- ═══════════════════════════════════════════════════════════════════════════════
-- BOT STATE TABLE - General bot state storage
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE bot_state IS 'General key-value storage for bot state';

-- ═══════════════════════════════════════════════════════════════════════════════
-- BOT LOGS TABLE - Action logging
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bot_logs (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  details JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_logs_action ON bot_logs(action);
CREATE INDEX IF NOT EXISTS idx_bot_logs_timestamp ON bot_logs(timestamp DESC);

COMMENT ON TABLE bot_logs IS 'Action log for bot operations';

-- ═══════════════════════════════════════════════════════════════════════════════
-- POOL SNAPSHOTS TABLE - Historical pool data
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pool_snapshots (
  id BIGSERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL,
  data JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pool_snapshots_pool_address ON pool_snapshots(pool_address);
CREATE INDEX IF NOT EXISTS idx_pool_snapshots_timestamp ON pool_snapshots(timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIGGER: Update updated_at on trades modification
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_trades_updated_at ON trades;
CREATE TRIGGER update_trades_updated_at
    BEFORE UPDATE ON trades
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

