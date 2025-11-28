-- ═══════════════════════════════════════════════════════════════════════════════
-- Exit Accounting Schema Patch
-- Adds enriched exit accounting columns to trades table
-- 
-- Safe to run multiple times - uses ADD COLUMN IF NOT EXISTS pattern
-- ═══════════════════════════════════════════════════════════════════════════════

-- PostgreSQL doesn't have ADD COLUMN IF NOT EXISTS, so we use DO blocks
DO $$ 
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- EXIT PRICE TRACKING
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- Exit price source (birdeye, jupiter, pool_mid, oracle, cached)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_price_source') THEN
    ALTER TABLE trades ADD COLUMN exit_price_source TEXT;
    COMMENT ON COLUMN trades.exit_price_source IS 'Source of exit price: birdeye, jupiter, pool_mid, oracle, cached';
  END IF;
  
  -- Exit price (reference price at exit)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_price') THEN
    ALTER TABLE trades ADD COLUMN exit_price NUMERIC(24, 12);
    COMMENT ON COLUMN trades.exit_price IS 'Reference price at exit (pool mid or oracle)';
  END IF;
  
  -- Exit asset value in USD (gross value before fees)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_asset_value_usd') THEN
    ALTER TABLE trades ADD COLUMN exit_asset_value_usd NUMERIC(18, 6);
    COMMENT ON COLUMN trades.exit_asset_value_usd IS 'Gross exit value in USD before fees';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- PNL ACCOUNTING
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- PnL gross (exit_value - entry_value, before fees)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'pnl_gross') THEN
    ALTER TABLE trades ADD COLUMN pnl_gross NUMERIC(18, 6);
    COMMENT ON COLUMN trades.pnl_gross IS 'Gross PnL = exitValueUSD - entryValueUSD (before fees)';
  END IF;
  
  -- PnL net (gross - fees, the actual realized PnL)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'pnl_net') THEN
    ALTER TABLE trades ADD COLUMN pnl_net NUMERIC(18, 6);
    COMMENT ON COLUMN trades.pnl_net IS 'Net PnL = grossPnL - totalFees (realized PnL)';
  END IF;
  
  -- PnL as percentage of entry value
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'pnl_percent') THEN
    ALTER TABLE trades ADD COLUMN pnl_percent NUMERIC(12, 6);
    COMMENT ON COLUMN trades.pnl_percent IS 'Net PnL as percentage of entry value';
  END IF;
  
  -- ═══════════════════════════════════════════════════════════════════════════
  -- EXIT COSTS
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- Exit fees paid in USD
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_fees_paid') THEN
    ALTER TABLE trades ADD COLUMN exit_fees_paid NUMERIC(18, 6);
    COMMENT ON COLUMN trades.exit_fees_paid IS 'Exit fees in USD';
  END IF;
  
  -- Exit slippage in USD
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_slippage_usd') THEN
    ALTER TABLE trades ADD COLUMN exit_slippage_usd NUMERIC(18, 6);
    COMMENT ON COLUMN trades.exit_slippage_usd IS 'Exit slippage cost in USD';
  END IF;
  
  -- Total fees (entry + exit)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'total_fees') THEN
    ALTER TABLE trades ADD COLUMN total_fees NUMERIC(18, 6);
    COMMENT ON COLUMN trades.total_fees IS 'Total fees = entryFees + exitFees';
  END IF;
  
  -- Total slippage (entry + exit)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'total_slippage') THEN
    ALTER TABLE trades ADD COLUMN total_slippage NUMERIC(18, 6);
    COMMENT ON COLUMN trades.total_slippage IS 'Total slippage = entrySlippage + exitSlippage';
  END IF;
  
  -- ═══════════════════════════════════════════════════════════════════════════
  -- NET VALUES
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- Net exit value (after fees and slippage)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'net_exit_value_usd') THEN
    ALTER TABLE trades ADD COLUMN net_exit_value_usd NUMERIC(18, 6);
    COMMENT ON COLUMN trades.net_exit_value_usd IS 'Net exit value after fees and slippage';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- BUFFERED EXIT SUPPORT
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- Exit write pending (for buffered retry)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_write_pending') THEN
    ALTER TABLE trades ADD COLUMN exit_write_pending BOOLEAN DEFAULT FALSE;
    COMMENT ON COLUMN trades.exit_write_pending IS 'True if exit data write failed and needs retry';
  END IF;
  
  -- Exit data buffer (JSON for failed writes)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_data_buffer') THEN
    ALTER TABLE trades ADD COLUMN exit_data_buffer JSONB;
    COMMENT ON COLUMN trades.exit_data_buffer IS 'Buffered exit data for retry on failed writes';
  END IF;

END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES FOR PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_trades_exit_write_pending 
  ON trades(exit_write_pending) 
  WHERE exit_write_pending = TRUE;

CREATE INDEX IF NOT EXISTS idx_trades_pnl_net 
  ON trades(pnl_net) 
  WHERE pnl_net IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Sync pnl_usd to pnl_net for existing records
-- ═══════════════════════════════════════════════════════════════════════════════

UPDATE trades 
SET pnl_net = pnl_usd 
WHERE pnl_usd IS NOT NULL AND pnl_net IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VIEW: Closed trades with full exit accounting
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW trades_exit_accounting AS
SELECT 
  id,
  pool_address,
  pool_name,
  risk_tier,
  status,
  
  -- Entry values
  entry_price,
  entry_asset_value_usd,
  entry_fees_paid,
  entry_slippage_usd,
  entry_price_source,
  
  -- Exit values
  exit_price,
  exit_asset_value_usd,
  net_exit_value_usd,
  exit_fees_paid,
  exit_slippage_usd,
  exit_price_source,
  
  -- PnL breakdown
  pnl_gross,
  pnl_net,
  pnl_usd, -- Legacy alias
  pnl_percent,
  total_fees,
  total_slippage,
  
  -- Timing
  created_at AS entry_time,
  exit_time,
  exit_reason,
  
  -- Retry status
  exit_write_pending
  
FROM trades
WHERE status = 'closed';

COMMENT ON VIEW trades_exit_accounting IS 'View of closed trades with full exit accounting breakdown';

