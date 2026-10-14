-- Recoverable canvas deletion.
-- Rows and every dependent diagram/card record remain intact until an explicit
-- permanent delete. Active queries exclude recycled canvases.

ALTER TABLE canvases ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_canvases_deleted_at
  ON canvases(deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_canvases_active_updated
  ON canvases(updated_at DESC)
  WHERE deleted_at IS NULL;
