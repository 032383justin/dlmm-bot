-- Supabase tables for persistent capital management
-- Run this migration to enable persistent capital tracking
-- Safe to run multiple times - uses IF NOT EXISTS and DO $$ blocks

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
  
  -- Entry data (reference prices)
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
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ADD MISSING COLUMNS TO TRADES TABLE (safe migration)
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN
  -- Status column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'status') THEN
    ALTER TABLE trades ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
  END IF;
  
  -- Risk tier columns (Tier 4)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'risk_tier') THEN
    ALTER TABLE trades ADD COLUMN risk_tier TEXT DEFAULT 'C';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'leverage') THEN
    ALTER TABLE trades ADD COLUMN leverage NUMERIC(6, 4) DEFAULT 1.0;
  END IF;
  
  -- Exit data columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_price') THEN
    ALTER TABLE trades ADD COLUMN exit_price NUMERIC(24, 12);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_time') THEN
    ALTER TABLE trades ADD COLUMN exit_time TIMESTAMPTZ;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_reason') THEN
    ALTER TABLE trades ADD COLUMN exit_reason TEXT;
  END IF;
  
  -- TRUE FILL PRICE columns (entry)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'entry_token_amount_in') THEN
    ALTER TABLE trades ADD COLUMN entry_token_amount_in NUMERIC(24, 12);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'entry_token_amount_out') THEN
    ALTER TABLE trades ADD COLUMN entry_token_amount_out NUMERIC(24, 12);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'entry_asset_value_usd') THEN
    ALTER TABLE trades ADD COLUMN entry_asset_value_usd NUMERIC(18, 8);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'entry_fees_paid') THEN
    ALTER TABLE trades ADD COLUMN entry_fees_paid NUMERIC(18, 8) DEFAULT 0;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'entry_slippage_usd') THEN
    ALTER TABLE trades ADD COLUMN entry_slippage_usd NUMERIC(18, 8) DEFAULT 0;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'net_received_base') THEN
    ALTER TABLE trades ADD COLUMN net_received_base NUMERIC(24, 12);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'net_received_quote') THEN
    ALTER TABLE trades ADD COLUMN net_received_quote NUMERIC(24, 12);
  END IF;
  
  -- TRUE FILL PRICE columns (exit)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_asset_value_usd') THEN
    ALTER TABLE trades ADD COLUMN exit_asset_value_usd NUMERIC(18, 8);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_fees_paid') THEN
    ALTER TABLE trades ADD COLUMN exit_fees_paid NUMERIC(18, 8);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_slippage_usd') THEN
    ALTER TABLE trades ADD COLUMN exit_slippage_usd NUMERIC(18, 8);
  END IF;
  
  -- PnL columns (TRUE PnL calculation)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'pnl_usd') THEN
    ALTER TABLE trades ADD COLUMN pnl_usd NUMERIC(18, 8);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'pnl_gross') THEN
    ALTER TABLE trades ADD COLUMN pnl_gross NUMERIC(18, 8);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'total_fees') THEN
    ALTER TABLE trades ADD COLUMN total_fees NUMERIC(18, 8);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'total_slippage') THEN
    ALTER TABLE trades ADD COLUMN total_slippage NUMERIC(18, 8);
  END IF;
  
END $$;

-- Add check constraint for status if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage 
    WHERE table_name = 'trades' AND constraint_name = 'trades_status_check'
  ) THEN
    ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_status_check;
    ALTER TABLE trades ADD CONSTRAINT trades_status_check CHECK (status IN ('open', 'closed', 'cancelled'));
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- Create indexes (IF NOT EXISTS is safe)
CREATE INDEX IF NOT EXISTS idx_trades_pool_address ON trades(pool_address);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_risk_tier ON trades(risk_tier);

COMMENT ON TABLE trades IS 'Persistent trade storage - MANDATORY for bot operation';
COMMENT ON COLUMN trades.id IS 'UUID trade identifier';
COMMENT ON COLUMN trades.pool_address IS 'DLMM pool address';
COMMENT ON COLUMN trades.status IS 'Trade status: open, closed, or cancelled';
COMMENT ON COLUMN trades.risk_tier IS 'Risk bucket tier: A (core), B (momentum), C (speculative), D (forbidden)';
COMMENT ON COLUMN trades.pnl_usd IS 'TRUE PnL: (exit_value - entry_value) - fees';

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

