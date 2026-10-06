-- 055_diagram_canvases.sql
-- A canvas is now either a 'brainstorm' (the existing card network in
-- canvas_nodes / canvas_edges) or a 'diagram' (a structured flow-chart style
-- document). Existing canvases keep working as brainstorms.
--  * canvases.canvas_type discriminates the two; missing values default to
--    'brainstorm'.
--  * canvas_diagrams holds the current diagram document and its revision
--    (optimistic concurrency: a save must name the revision it was based on).
--  * canvas_diagram_revisions keeps recent saved revisions (pruned in the app).
--  * canvas_diagram_assets stores uploaded PNG / SVG images for image nodes.
--    Bytes are validated before insert and kept in Postgres (capped at 5 MiB
--    each) so they stay private, transactional and are deleted with the canvas.
-- Additive and idempotent.

ALTER TABLE canvases ADD COLUMN IF NOT EXISTS canvas_type TEXT NOT NULL DEFAULT 'brainstorm';
UPDATE canvases SET canvas_type = 'brainstorm' WHERE canvas_type IS NULL OR canvas_type = '';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canvases_canvas_type_check') THEN
    ALTER TABLE canvases ADD CONSTRAINT canvases_canvas_type_check CHECK (canvas_type IN ('brainstorm', 'diagram'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS canvas_diagrams (
  canvas_id  UUID        PRIMARY KEY REFERENCES canvases(id) ON DELETE CASCADE,
  revision   INTEGER     NOT NULL DEFAULT 0 CHECK (revision >= 0),
  document   JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS canvas_diagram_revisions (
  canvas_id  UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  revision   INTEGER     NOT NULL CHECK (revision >= 0),
  document   JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (canvas_id, revision)
);

CREATE TABLE IF NOT EXISTS canvas_diagram_assets (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id    UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  content_type TEXT        NOT NULL CHECK (content_type IN ('image/png', 'image/svg+xml')),
  byte_size    INTEGER     NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  width        INTEGER,
  height       INTEGER,
  sha256       TEXT        NOT NULL,
  data         BYTEA       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (canvas_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_canvas_diagram_assets_canvas ON canvas_diagram_assets(canvas_id);
