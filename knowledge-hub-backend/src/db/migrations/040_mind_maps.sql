-- 040_mind_maps.sql
-- Canvas becomes a mind map linked to Think notes.
--  * canvas_nodes form a tree: parent_id (NULL = the central idea), sort_order
--    among siblings, side ('left'/'right') for the central idea's children,
--    collapsed for hiding a branch. Layout is computed in the app, so x/y are
--    no longer used.
--  * canvas_edges are now cross-links between any two ideas (not the tree).
--  * canvas_notes links a map to one or more Think notes.
-- Additive only; the existing canvas is converted in place.

ALTER TABLE canvas_nodes
  ADD COLUMN IF NOT EXISTS parent_id  UUID REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS side       TEXT CHECK (side IN ('left', 'right')),
  ADD COLUMN IF NOT EXISTS collapsed  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_canvas_nodes_parent ON canvas_nodes(parent_id);

-- Maps belong to projects by id now (was a fixed personal/structara/ibm list).
ALTER TABLE canvases DROP CONSTRAINT IF EXISTS canvases_project_check;

-- Cross-link labels are free text; the old typed values stay valid.
ALTER TABLE canvas_edges DROP CONSTRAINT IF EXISTS canvas_edges_edge_type_check;

CREATE TABLE IF NOT EXISTS canvas_notes (
  canvas_id  UUID        NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  note_id    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (canvas_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_canvas_notes_note ON canvas_notes(note_id);

-- ── Convert existing canvases ────────────────────────────────────────────────
-- Central idea = the first note card (else the first card); every other card
-- becomes one of its branches, in creation order, alternating sides.
WITH roots AS (
  SELECT DISTINCT ON (canvas_id) canvas_id, id AS root_id
    FROM canvas_nodes
   ORDER BY canvas_id, (ref_type = 'note') DESC NULLS LAST, created_at
),
children AS (
  SELECT n.id, r.root_id,
         ROW_NUMBER() OVER (PARTITION BY n.canvas_id ORDER BY n.created_at) AS rn
    FROM canvas_nodes n
    JOIN roots r ON r.canvas_id = n.canvas_id
   WHERE n.id <> r.root_id
     AND NOT EXISTS (SELECT 1 FROM canvas_nodes x WHERE x.canvas_id = n.canvas_id AND x.parent_id IS NOT NULL)
)
UPDATE canvas_nodes n
   SET parent_id  = c.root_id,
       sort_order = c.rn,
       side       = CASE WHEN c.rn % 2 = 1 THEN 'right' ELSE 'left' END
  FROM children c
 WHERE n.id = c.id;

-- A central idea that is a note card links the map to that note.
INSERT INTO canvas_notes (canvas_id, note_id)
SELECT n.canvas_id, n.ref_id
  FROM canvas_nodes n
 WHERE n.parent_id IS NULL AND n.ref_type = 'note' AND n.ref_id IS NOT NULL
ON CONFLICT DO NOTHING;
