-- Migration 021: Canvas — spatial freeform boards

CREATE TABLE IF NOT EXISTS canvases (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL DEFAULT 'New Canvas',
  tldraw_snapshot JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvases_updated ON canvases(updated_at DESC);

-- Junction table for canvas taxonomy tags (same pattern as note_tags)
CREATE TABLE IF NOT EXISTS canvas_tags (
  canvas_id UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  tag_id    UUID NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  PRIMARY KEY (canvas_id, tag_id)
);
