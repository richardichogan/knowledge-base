-- Taxonomy tags on diagrams (same shape as note_tags).
CREATE TABLE IF NOT EXISTS canvas_tags (
  canvas_id  UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  tag_id     UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (canvas_id, tag_id)
);
CREATE INDEX IF NOT EXISTS canvas_tags_tag_idx ON canvas_tags (tag_id);
