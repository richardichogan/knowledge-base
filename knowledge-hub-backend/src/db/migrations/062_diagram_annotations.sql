-- 062_diagram_annotations.sql
-- Diagram annotation support.
--  * diagram_element_notes links Think notes to a single shape, connector or
--    footnote inside a diagram document (element_id is the document id). Rows
--    for elements removed from the document are deleted when the diagram saves.
--  * canvas_diagram_versions keeps named copies of a diagram document. They are
--    stored separately because canvas_diagram_revisions is pruned to the most
--    recent revisions.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS diagram_element_notes (
  canvas_id  UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  element_id UUID        NOT NULL,
  note_id    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (canvas_id, element_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_diagram_element_notes_note ON diagram_element_notes(note_id);

CREATE TABLE IF NOT EXISTS canvas_diagram_versions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id  UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  revision   INTEGER     NOT NULL CHECK (revision >= 0),
  document   JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canvas_diagram_versions_canvas ON canvas_diagram_versions(canvas_id, created_at DESC);
