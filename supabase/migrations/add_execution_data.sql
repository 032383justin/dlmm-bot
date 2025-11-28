-- Migration: Add execution data fields for true fill price tracking
-- Run this AFTER capital_tables.sql

-- ═══════════════════════════════════════════════════════════════════════════════
-- ADD RISK TIER COLUMNS TO TRADES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE trades ADD COLUMN IF NOT EXISTS risk_tier TEXT DEFAULT 'C';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS leverage NUMERIC(8, 4) DEFAULT 1.0;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ADD EXECUTION DATA COLUMNS - TRUE FILL PRICES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Entry execution data
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_token_amount_in NUMERIC(24, 12);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_token_amount_out NUMERIC(24, 12);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_asset_value_usd NUMERIC(18, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_fees_paid NUMERIC(18, 8) DEFAULT 0;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_slippage_usd NUMERIC(18, 8) DEFAULT 0;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS net_received_base NUMERIC(24, 12);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS net_received_quote NUMERIC(24, 12);

-- Exit execution data
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_asset_value_usd NUMERIC(18, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_fees_paid NUMERIC(18, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_slippage_usd NUMERIC(18, 8);

-- PnL breakdown
ALTER TABLE trades ADD COLUMN IF NOT EXISTS pnl_gross NUMERIC(18, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS total_fees NUMERIC(18, 8);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS total_slippage NUMERIC(18, 8);

-- ═══════════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN trades.risk_tier IS 'Risk tier: A (Core), B (Momentum), C (Speculative), D (Noise)';
COMMENT ON COLUMN trades.leverage IS 'Leverage multiplier applied to position size';
COMMENT ON COLUMN trades.entry_token_amount_in IS 'Amount of token spent at entry';
COMMENT ON COLUMN trades.entry_token_amount_out IS 'Amount of token received at entry';
COMMENT ON COLUMN trades.entry_asset_value_usd IS 'Total USD value at entry (actual fill)';
COMMENT ON COLUMN trades.entry_fees_paid IS 'Fees paid at entry in USD';
COMMENT ON COLUMN trades.entry_slippage_usd IS 'Slippage cost at entry in USD';
COMMENT ON COLUMN trades.net_received_base IS 'Net base token received after fees';
COMMENT ON COLUMN trades.net_received_quote IS 'Net quote token received after fees';
COMMENT ON COLUMN trades.exit_asset_value_usd IS 'Total USD value at exit (actual fill)';
COMMENT ON COLUMN trades.exit_fees_paid IS 'Fees paid at exit in USD';
COMMENT ON COLUMN trades.exit_slippage_usd IS 'Slippage cost at exit in USD';
COMMENT ON COLUMN trades.pnl_gross IS 'Gross PnL before fees (exit - entry value)';
COMMENT ON COLUMN trades.total_fees IS 'Total fees paid (entry + exit)';
COMMENT ON COLUMN trades.total_slippage IS 'Total slippage (entry + exit)';

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEX FOR RISK TIER QUERIES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_trades_risk_tier ON trades(risk_tier);

