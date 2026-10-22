-- Persisted admin switch for BULK/backfill semantic indexing. Defaults OFF.
-- Normal incremental per-write indexing is never gated by this switch.
CREATE TABLE IF NOT EXISTS knowledge_indexing_settings (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL DEFAULT 'system'
);

INSERT INTO knowledge_indexing_settings (key, enabled) VALUES ('bulk_indexing', FALSE)
ON CONFLICT (key) DO NOTHING;
