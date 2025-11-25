-- Supabase table for DLMM bin history
-- Stores bin snapshots for active pools only, sampled every 5-10 seconds

CREATE TABLE IF NOT EXISTS bin_history (
  id BIGSERIAL PRIMARY KEY,
  pool TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  active_bin INT NOT NULL,
  bin_liquidity JSONB NOT NULL,
  bin_swaps JSONB NOT NULL,
  refill_time JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast pool + timestamp queries
CREATE INDEX IF NOT EXISTS idx_bin_history_pool_timestamp ON bin_history(pool, timestamp DESC);

-- Index for fast pool queries
CREATE INDEX IF NOT EXISTS idx_bin_history_pool ON bin_history(pool);

-- Optional: Add retention policy to auto-delete old records (keeps last 7 days)
-- Uncomment if you want automatic cleanup to save storage costs
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('delete-old-bin-history', '0 2 * * *', $$
--   DELETE FROM bin_history WHERE created_at < NOW() - INTERVAL '7 days'
-- $$);

COMMENT ON TABLE bin_history IS 'DLMM bin snapshots for active pools only, sampled every 5-10 seconds to minimize database costs';
COMMENT ON COLUMN bin_history.pool IS 'Pool address';
COMMENT ON COLUMN bin_history.timestamp IS 'Unix timestamp in milliseconds';
COMMENT ON COLUMN bin_history.active_bin IS 'Current active bin ID';
COMMENT ON COLUMN bin_history.bin_liquidity IS 'JSON object mapping bin IDs to liquidity amounts';
COMMENT ON COLUMN bin_history.bin_swaps IS 'JSON object mapping bin IDs to swap counts';
COMMENT ON COLUMN bin_history.refill_time IS 'JSON object mapping bin IDs to refill times in ms';
