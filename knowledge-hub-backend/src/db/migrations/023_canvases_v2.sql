-- Migration 023: Canvas v2
-- Tables: canvases, canvas_edges
-- Tags stored in content_tags (content_type = 'canvas')

CREATE TABLE IF NOT EXISTS canvases (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL DEFAULT 'Untitled Canvas',
  tldraw_snapshot JSONB   NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvases_updated ON canvases(updated_at DESC);

CREATE TABLE IF NOT EXISTS canvas_edges (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id       UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  source_node_id  UUID        NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id  UUID        NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label           TEXT        NOT NULL,
  tldraw_shape_id TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canvas_id, tldraw_shape_id)
);

CREATE INDEX IF NOT EXISTS idx_canvas_edges_canvas ON canvas_edges(canvas_id);
