-- ═══════════════════════════════════════════════════════════════════════════════
-- USD Normalization Migration
-- Adds fields for chain-accurate USD-based accounting
-- 
-- MISSION: Normalize all PnL and asset accounting to USD values.
-- No more token-to-token comparisons. All values in USD.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Run this migration after capital_tables.sql
-- Safe to run multiple times - uses IF NOT EXISTS

DO $$ 
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- TOKEN METADATA COLUMNS
  -- Store mint addresses and on-chain verified decimals
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- Base token mint address
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'base_mint') THEN
    ALTER TABLE trades ADD COLUMN base_mint TEXT;
    COMMENT ON COLUMN trades.base_mint IS 'Base token mint address for on-chain decimal fetching';
  END IF;
  
  -- Quote token mint address  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'quote_mint') THEN
    ALTER TABLE trades ADD COLUMN quote_mint TEXT;
    COMMENT ON COLUMN trades.quote_mint IS 'Quote token mint address for on-chain decimal fetching';
  END IF;
  
  -- Base token decimals (verified on-chain)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'base_decimals') THEN
    ALTER TABLE trades ADD COLUMN base_decimals SMALLINT;
    COMMENT ON COLUMN trades.base_decimals IS 'Base token decimals (fetched from on-chain SPL metadata)';
  END IF;
  
  -- Quote token decimals (verified on-chain)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'quote_decimals') THEN
    ALTER TABLE trades ADD COLUMN quote_decimals SMALLINT;
    COMMENT ON COLUMN trades.quote_decimals IS 'Quote token decimals (fetched from on-chain SPL metadata)';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- NORMALIZED AMOUNTS (for audit only, NOT for trading logic)
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- Normalized base token amount at entry
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'normalized_amount_base') THEN
    ALTER TABLE trades ADD COLUMN normalized_amount_base NUMERIC(24, 12);
    COMMENT ON COLUMN trades.normalized_amount_base IS 'Normalized base token amount (raw / 10^decimals) - AUDIT ONLY';
  END IF;
  
  -- Normalized quote token amount at entry
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'normalized_amount_quote') THEN
    ALTER TABLE trades ADD COLUMN normalized_amount_quote NUMERIC(24, 12);
    COMMENT ON COLUMN trades.normalized_amount_quote IS 'Normalized quote token amount (raw / 10^decimals) - AUDIT ONLY';
  END IF;
  
  -- Raw base token amount (for historical audit)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'raw_amount_base') THEN
    ALTER TABLE trades ADD COLUMN raw_amount_base NUMERIC(40, 0);
    COMMENT ON COLUMN trades.raw_amount_base IS 'Raw base token amount in atomic units - AUDIT ONLY';
  END IF;
  
  -- Raw quote token amount (for historical audit)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'raw_amount_quote') THEN
    ALTER TABLE trades ADD COLUMN raw_amount_quote NUMERIC(40, 0);
    COMMENT ON COLUMN trades.raw_amount_quote IS 'Raw quote token amount in atomic units - AUDIT ONLY';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- PRICE SOURCE TRACKING
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- Entry price source
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'entry_price_source') THEN
    ALTER TABLE trades ADD COLUMN entry_price_source TEXT DEFAULT 'birdeye';
    COMMENT ON COLUMN trades.entry_price_source IS 'Source of entry price: birdeye, jupiter, pool_mid, oracle, cached';
  END IF;
  
  -- Exit price source
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_price_source') THEN
    ALTER TABLE trades ADD COLUMN exit_price_source TEXT;
    COMMENT ON COLUMN trades.exit_price_source IS 'Source of exit price: birdeye, jupiter, pool_mid, oracle, cached';
  END IF;
  
  -- Entry price fetch timestamp (for staleness detection)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'entry_price_timestamp') THEN
    ALTER TABLE trades ADD COLUMN entry_price_timestamp TIMESTAMPTZ;
    COMMENT ON COLUMN trades.entry_price_timestamp IS 'Timestamp when entry price was fetched (for staleness check)';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- USD CONSISTENCY FIELDS
  -- Primary fields for trading logic - token amounts are secondary
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- Net entry value (after fees and slippage)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'net_entry_value_usd') THEN
    ALTER TABLE trades ADD COLUMN net_entry_value_usd NUMERIC(18, 6);
    COMMENT ON COLUMN trades.net_entry_value_usd IS 'Net entry value in USD after fees and slippage';
  END IF;
  
  -- Net exit value (after fees and slippage)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'net_exit_value_usd') THEN
    ALTER TABLE trades ADD COLUMN net_exit_value_usd NUMERIC(18, 6);
    COMMENT ON COLUMN trades.net_exit_value_usd IS 'Net exit value in USD after fees and slippage';
  END IF;
  
  -- Quote token price at entry (typically 1.0 for stablecoins)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'quote_price_usd') THEN
    ALTER TABLE trades ADD COLUMN quote_price_usd NUMERIC(18, 8) DEFAULT 1.0;
    COMMENT ON COLUMN trades.quote_price_usd IS 'Quote token price in USD at entry (usually 1.0 for stablecoins)';
  END IF;
  
  -- Base token price at exit
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'exit_base_price_usd') THEN
    ALTER TABLE trades ADD COLUMN exit_base_price_usd NUMERIC(24, 12);
    COMMENT ON COLUMN trades.exit_base_price_usd IS 'Base token price in USD at exit';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- PNL PERCENTAGE (for analytics)
  -- ═══════════════════════════════════════════════════════════════════════════
  
  -- PnL as percentage of entry
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trades' AND column_name = 'pnl_percent') THEN
    ALTER TABLE trades ADD COLUMN pnl_percent NUMERIC(12, 6);
    COMMENT ON COLUMN trades.pnl_percent IS 'Net PnL as percentage of entry value';
  END IF;

END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- CONSTRAINT: Ensure USD values are non-null for closed trades
-- ═══════════════════════════════════════════════════════════════════════════════

-- Note: This constraint is informational - not enforced to allow legacy data
-- Future trades MUST have entry_asset_value_usd populated

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES FOR PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_trades_base_mint ON trades(base_mint) WHERE base_mint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trades_pnl_usd ON trades(pnl_usd) WHERE pnl_usd IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trades_pnl_percent ON trades(pnl_percent) WHERE pnl_percent IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VIEW: Trades with normalized USD values
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW trades_usd_normalized AS
SELECT 
  id,
  pool_address,
  pool_name,
  risk_tier,
  leverage,
  status,
  
  -- USD values (primary for trading logic)
  entry_asset_value_usd,
  net_entry_value_usd,
  exit_asset_value_usd,
  net_exit_value_usd,
  entry_fees_paid AS entry_fees_usd,
  exit_fees_paid AS exit_fees_usd,
  entry_slippage_usd,
  exit_slippage_usd,
  total_fees AS total_fees_usd,
  total_slippage AS total_slippage_usd,
  pnl_gross AS gross_pnl_usd,
  pnl_usd AS net_pnl_usd,
  pnl_percent,
  
  -- Token metadata (for audit)
  base_mint,
  quote_mint,
  base_decimals,
  quote_decimals,
  normalized_amount_base,
  normalized_amount_quote,
  
  -- Price tracking
  entry_price,
  exit_price,
  quote_price_usd,
  exit_base_price_usd,
  entry_price_source,
  exit_price_source,
  
  -- Timestamps
  created_at,
  exit_time,
  exit_reason
  
FROM trades
WHERE entry_asset_value_usd IS NOT NULL;

COMMENT ON VIEW trades_usd_normalized IS 'View of trades with normalized USD values for analysis';

-- ═══════════════════════════════════════════════════════════════════════════════
-- FUNCTION: Calculate PnL percentage on update
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION calculate_pnl_percent()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.entry_asset_value_usd IS NOT NULL AND NEW.entry_asset_value_usd > 0 AND NEW.pnl_usd IS NOT NULL THEN
    NEW.pnl_percent := (NEW.pnl_usd / NEW.entry_asset_value_usd) * 100;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS calculate_trades_pnl_percent ON trades;
CREATE TRIGGER calculate_trades_pnl_percent
  BEFORE INSERT OR UPDATE ON trades
  FOR EACH ROW
  EXECUTE FUNCTION calculate_pnl_percent();

-- ═══════════════════════════════════════════════════════════════════════════════
-- DEPRECATED COLUMNS WARNING
-- These columns exist for historical audit but should NOT be used for logic:
--   - entry_token_amount_in (use entry_asset_value_usd instead)
--   - entry_token_amount_out (use normalized_amount_base instead)
--   - net_received_base (use normalized_amount_base instead)
--   - net_received_quote (use normalized_amount_quote instead)
-- ═══════════════════════════════════════════════════════════════════════════════

