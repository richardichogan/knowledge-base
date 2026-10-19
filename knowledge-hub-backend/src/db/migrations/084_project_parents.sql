-- Migration 084: three parent groups for projects — IBM, Nelfin, Personal.
--
-- Groups are top-level 'filing' tags with project_id NULL; a project belongs to
-- a group through its own filing tag's parent_id (see migration 080).
--
--   IBM Projects          → renamed IBM (all work projects)
--   Eminence              → split: work projects to IBM, personal ones to Personal;
--                           direct uses of the Eminence tag fold into the
--                           'Content and Eminence' theme so nothing is lost
--   Independent Ventures  → side-hustle projects join Nelfin; direct uses fold into Nelfin
--   Personal (new group)  → personal projects; the old ungrouped "Personal"
--                           project becomes "General" inside it
--
-- projects.category is realigned to the group (IBM=work, Nelfin=side-hustle,
-- Personal=personal). Affected rows are copied into schema backup_084 first.

CREATE SCHEMA IF NOT EXISTS backup_084;
CREATE TABLE IF NOT EXISTS backup_084.tags               AS SELECT * FROM tags;
CREATE TABLE IF NOT EXISTS backup_084.projects           AS SELECT * FROM projects;
CREATE TABLE IF NOT EXISTS backup_084.note_tags          AS SELECT * FROM note_tags;
CREATE TABLE IF NOT EXISTS backup_084.discover_item_tags AS SELECT * FROM discover_item_tags;
CREATE TABLE IF NOT EXISTS backup_084.task_tags          AS SELECT * FROM task_tags;

CREATE OR REPLACE FUNCTION pg_temp.group_id(group_name TEXT) RETURNS UUID AS $$
  SELECT id FROM tags
   WHERE lower(name) = lower(group_name) AND role = 'filing' AND parent_id IS NULL AND project_id IS NULL
   LIMIT 1;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION pg_temp.merge_tag(src UUID, dst UUID) RETURNS void AS $$
BEGIN
  IF src IS NULL OR dst IS NULL OR src = dst THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM tags WHERE parent_id = src) THEN RETURN; END IF;
  INSERT INTO note_tags (note_id, tag_id, source) SELECT note_id, dst, source FROM note_tags WHERE tag_id = src ON CONFLICT DO NOTHING;
  INSERT INTO discover_item_tags (discover_item_id, tag_id, is_primary, source)
    SELECT discover_item_id, dst, is_primary, source FROM discover_item_tags WHERE tag_id = src ON CONFLICT DO NOTHING;
  INSERT INTO document_tags (doc_id, tag_id) SELECT doc_id, dst FROM document_tags WHERE tag_id = src ON CONFLICT DO NOTHING;
  INSERT INTO task_tags (task_id, tag_id, source) SELECT task_id, dst, source FROM task_tags WHERE tag_id = src ON CONFLICT DO NOTHING;
  INSERT INTO content_item_tags (content_item_id, tag_id) SELECT content_item_id, dst FROM content_item_tags WHERE tag_id = src ON CONFLICT DO NOTHING;
  INSERT INTO cfp_item_tags (cfp_item_id, tag_id) SELECT cfp_item_id, dst FROM cfp_item_tags WHERE tag_id = src ON CONFLICT DO NOTHING;
  INSERT INTO tag_rejections (content_kind, content_id, tag_id) SELECT content_kind, content_id, dst FROM tag_rejections WHERE tag_id = src ON CONFLICT DO NOTHING;
  UPDATE tasks SET linked_tag_id = dst WHERE linked_tag_id = src;
  UPDATE pending_tag_suggestions SET merged_to_id = dst WHERE merged_to_id = src;
  UPDATE repo_tag_mappings SET tag_id = dst WHERE tag_id = src;
  UPDATE repo_project_mappings SET project_tag_id = dst WHERE project_tag_id = src;
  DELETE FROM tags WHERE id = src;
END;
$$ LANGUAGE plpgsql;

-- ── 1. The three parent groups ──────────────────────────────────────────────
UPDATE tags SET name = 'IBM', updated_at = now()
 WHERE id = pg_temp.group_id('IBM Projects') AND pg_temp.group_id('IBM') IS NULL;

INSERT INTO tags (name, slug, role)
SELECT 'IBM', 'ibm', 'filing'
 WHERE pg_temp.group_id('IBM') IS NULL AND NOT EXISTS (SELECT 1 FROM tags WHERE slug = 'ibm');

INSERT INTO tags (name, slug, role)
SELECT 'Nelfin', 'nelfin-group', 'filing'
 WHERE pg_temp.group_id('Nelfin') IS NULL;

-- The "Personal" name and slug belong to the old ungrouped project's tag, so
-- rename that project to "General" before the group takes the name.
UPDATE projects SET name = 'General', category = 'personal', updated_at = now()
 WHERE id = 'personal' AND name = 'Personal';
UPDATE tags SET name = 'General', updated_at = now()
 WHERE project_id = 'personal' AND name = 'Personal';

INSERT INTO tags (name, slug, role)
SELECT 'Personal', 'personal-projects', 'filing'
 WHERE pg_temp.group_id('Personal') IS NULL AND NOT EXISTS (SELECT 1 FROM tags WHERE slug = 'personal-projects');

-- ── 2. File every project under its parent by category ──────────────────────
UPDATE tags t
   SET parent_id = CASE p.category
                     WHEN 'work'        THEN pg_temp.group_id('IBM')
                     WHEN 'side-hustle' THEN pg_temp.group_id('Nelfin')
                     ELSE                    pg_temp.group_id('Personal')
                   END,
       updated_at = now()
  FROM projects p
 WHERE t.project_id = p.id;

-- ── 3. Retire the old groups without losing anything tagged with them ───────
SELECT pg_temp.merge_tag(pg_temp.group_id('Independent Ventures'), pg_temp.group_id('Nelfin'));
SELECT pg_temp.merge_tag(
  pg_temp.group_id('Eminence'),
  (SELECT id FROM tags WHERE lower(name) = 'content and eminence' AND role = 'concept' ORDER BY parent_id NULLS FIRST LIMIT 1)
);
