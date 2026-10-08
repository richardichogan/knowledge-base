ALTER TABLE notes ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS last_history_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS note_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  writing JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  writing_updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reason TEXT NOT NULL CHECK (reason IN ('automatic', 'before_athena', 'before_restore')),
  restored_from UUID
);
CREATE INDEX IF NOT EXISTS idx_note_versions_note_created ON note_versions (note_id, created_at DESC, id DESC);
