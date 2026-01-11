-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Runtime State Table
-- ═══════════════════════════════════════════════════════════════════════════════
-- 
-- PURPOSE: Persist runtime state across restarts
-- 
-- Used for:
--   - Bootstrap state persistence (prevent re-triggering on restart)
--   - Future: Other runtime state that should survive restarts
-- 
-- ═══════════════════════════════════════════════════════════════════════════════

-- Create runtime_state table
CREATE TABLE IF NOT EXISTS runtime_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_runtime_state_key ON runtime_state(key);

-- Insert initial bootstrap state rows (empty/inactive)
INSERT INTO runtime_state (key, value) VALUES
    ('bootstrap_active', 'false'),
    ('bootstrap_started_at', ''),
    ('bootstrap_ends_at', ''),
    ('bootstrap_cycles_remaining', '0'),
    ('bootstrap_last_entry_at', '')
ON CONFLICT (key) DO NOTHING;

-- Add comment
COMMENT ON TABLE runtime_state IS 'Persistent runtime state for bot restart safety';
