-- Migration 025: Custom canvas tables (replaces tldraw-based 023_canvases_v2)
-- Drops tldraw canvas_edges and canvases, creates clean custom canvas schema.
-- canvas_nodes is new — was not present in the tldraw build.

-- ── Teardown tldraw tables ─────────────────────────────────────────────────
DROP TABLE IF EXISTS canvas_edges CASCADE;
DROP TABLE IF EXISTS canvases CASCADE;

-- ── canvases ──────────────────────────────────────────────────────────────
-- A named, persistent spatial document.
CREATE TABLE canvases (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL DEFAULT 'Untitled Canvas',
  description TEXT,
  project     TEXT        CHECK (project IN ('personal', 'structara', 'ibm')),
  viewport    JSONB       NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_canvases_updated ON canvases(updated_at DESC);

-- ── canvas_nodes ──────────────────────────────────────────────────────────
-- Positioned items on the canvas surface.
-- node_type: 'hub_ref' | 'text' | 'ai_output'
-- ref_type:  'discover_item' | 'spark' | 'note' | 'content_item' | 'ai_session' (only for hub_ref)
CREATE TABLE canvas_nodes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  node_type   TEXT        NOT NULL CHECK (node_type IN ('hub_ref', 'text', 'ai_output')),
  ref_type    TEXT        CHECK (ref_type IN ('discover_item', 'spark', 'note', 'content_item', 'ai_session')),
  ref_id      TEXT,
  label       TEXT,
  body        TEXT,
  x           NUMERIC     NOT NULL DEFAULT 0,
  y           NUMERIC     NOT NULL DEFAULT 0,
  width       NUMERIC     NOT NULL DEFAULT 280,
  height      NUMERIC     NOT NULL DEFAULT 80,
  colour      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_canvas_nodes_canvas ON canvas_nodes(canvas_id);

-- ── canvas_edges ──────────────────────────────────────────────────────────
-- Typed directed connections between nodes.
-- edge_type: 'relates-to' | 'supports' | 'contradicts' | 'leads-to' | 'part-of'
CREATE TABLE canvas_edges (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id   UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  source_id   UUID        NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  target_id   UUID        NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  edge_type   TEXT        NOT NULL DEFAULT 'relates-to'
                          CHECK (edge_type IN ('relates-to', 'supports', 'contradicts', 'leads-to', 'part-of')),
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_canvas_edges_canvas   ON canvas_edges(canvas_id);
CREATE INDEX idx_canvas_edges_source   ON canvas_edges(source_id);
CREATE INDEX idx_canvas_edges_target   ON canvas_edges(target_id);
