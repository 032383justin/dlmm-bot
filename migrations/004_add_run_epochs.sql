-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 004: Run Epochs — Accounting Correctness
-- ═══════════════════════════════════════════════════════════════════════════════
-- 
-- PURPOSE:
-- - Introduce run_id / epoch_id for scoping all equity calculations
-- - Prevent phantom equity, double-counting, and reset artifacts
-- - Each bot startup creates a new run epoch
-- 
-- CHANGES:
-- 1. Create run_epochs table to track each bot run
-- 2. Add run_id column to trades table
-- 3. Add run_id column to positions table
-- 
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE: run_epochs
-- Tracks each bot startup and its accounting context
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS run_epochs (
    run_id TEXT PRIMARY KEY,                    -- Unique run identifier (e.g., run_1734567890_abc123)
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    starting_capital NUMERIC NOT NULL,          -- Capital at start of this run
    paper_capital_provided BOOLEAN DEFAULT FALSE, -- Whether PAPER_CAPITAL was explicitly set
    parent_run_id TEXT,                         -- Previous run (for continuation chains)
    status TEXT NOT NULL DEFAULT 'active',      -- 'active' or 'closed'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT run_epochs_status_check CHECK (status IN ('active', 'closed'))
);

-- Index for quick lookup of active run
CREATE INDEX IF NOT EXISTS idx_run_epochs_status ON run_epochs(status);
CREATE INDEX IF NOT EXISTS idx_run_epochs_started_at ON run_epochs(started_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ALTER trades TABLE: Add run_id column
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE trades ADD COLUMN IF NOT EXISTS run_id TEXT;

-- Index for filtering trades by run
CREATE INDEX IF NOT EXISTS idx_trades_run_id ON trades(run_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ALTER positions TABLE: Add run_id column
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE positions ADD COLUMN IF NOT EXISTS run_id TEXT;

-- Index for filtering positions by run
CREATE INDEX IF NOT EXISTS idx_positions_run_id ON positions(run_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- COMMENTS for documentation
-- ═══════════════════════════════════════════════════════════════════════════════
COMMENT ON TABLE run_epochs IS 'Tracks each bot startup session for accounting correctness. All equity calculations should be scoped to the active run_id.';
COMMENT ON COLUMN run_epochs.run_id IS 'Unique identifier for this run (format: run_{timestamp}_{uuid})';
COMMENT ON COLUMN run_epochs.starting_capital IS 'Capital at the start of this run - used as baseline for equity calculations';
COMMENT ON COLUMN run_epochs.paper_capital_provided IS 'True if PAPER_CAPITAL was explicitly set in environment, indicating a fresh start';
COMMENT ON COLUMN run_epochs.parent_run_id IS 'Previous run ID for continuation chains (when no PAPER_CAPITAL provided)';
COMMENT ON COLUMN run_epochs.status IS 'active = currently running, closed = gracefully shutdown';

COMMENT ON COLUMN trades.run_id IS 'Run epoch this trade belongs to - for scoped PnL calculations';
COMMENT ON COLUMN positions.run_id IS 'Run epoch this position belongs to - for scoped equity calculations';

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION COMPLETE
-- ═══════════════════════════════════════════════════════════════════════════════

