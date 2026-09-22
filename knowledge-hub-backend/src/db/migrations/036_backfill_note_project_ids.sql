-- Migration 036: promote legacy taxonomy-only note filing to project_id.
--
-- Notes created before first-class project assignment were grouped using a
-- taxonomy child such as "Imagine". Newer notes use notes.project_id. Besides
-- producing duplicate menu groups with the same label, the legacy rows were
-- omitted by project-scoped Athena retrieval because their content_items
-- mirror still had project_context = 'personal'.

WITH matched_projects AS (
  SELECT DISTINCT ON (n.id)
         n.id AS note_id,
         p.id AS project_id
    FROM notes n
    JOIN note_tags nt ON nt.note_id = n.id
    JOIN tags t ON t.id = nt.tag_id
    JOIN projects p ON lower(trim(p.name)) = lower(trim(t.name))
   WHERE n.project_id IS NULL
   ORDER BY n.id, p.id
)
UPDATE notes n
   SET project_id = matched_projects.project_id
  FROM matched_projects
 WHERE n.id = matched_projects.note_id;

-- Keep the search mirror aligned and force Foundry IQ to re-index these rows
-- under the canonical project scope.
UPDATE content_items ci
   SET project_context = n.project_id,
       updated_at = NOW(),
       foundry_indexed_at = NULL
  FROM notes n
 WHERE ci.source = 'note'
   AND ci.source_id = n.id::text
   AND n.project_id IS NOT NULL
   AND ci.project_context IS DISTINCT FROM n.project_id;
