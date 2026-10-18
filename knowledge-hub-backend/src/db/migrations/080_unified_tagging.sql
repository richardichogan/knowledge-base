-- Migration 080: unify tagging into one model.
--
--   Project  (where it belongs)  projects row, linked 1:1 to a 'filing' tag via tags.project_id
--   Group    (project grouping)  top-level 'filing' tag with project_id NULL (IBM Projects, Eminence, ...)
--   Area     (theme)             top-level 'concept' tag, owns the theme colour
--   Topic    (what it's about)   child 'concept' tag, inherits its area colour (colour NULL)
--
-- Every affected table is copied into schema backup_080 first.

-- ── 0. Backup ─────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS backup_080;
CREATE TABLE IF NOT EXISTS backup_080.tags               AS SELECT * FROM tags;
CREATE TABLE IF NOT EXISTS backup_080.projects           AS SELECT * FROM projects;
CREATE TABLE IF NOT EXISTS backup_080.note_tags          AS SELECT * FROM note_tags;
CREATE TABLE IF NOT EXISTS backup_080.discover_item_tags AS SELECT * FROM discover_item_tags;
CREATE TABLE IF NOT EXISTS backup_080.document_tags      AS SELECT * FROM document_tags;
CREATE TABLE IF NOT EXISTS backup_080.task_tags          AS SELECT * FROM task_tags;
CREATE TABLE IF NOT EXISTS backup_080.content_item_tags  AS SELECT * FROM content_item_tags;
CREATE TABLE IF NOT EXISTS backup_080.cfp_item_tags      AS SELECT * FROM cfp_item_tags;
CREATE TABLE IF NOT EXISTS backup_080.tag_rejections     AS SELECT * FROM tag_rejections;
CREATE TABLE IF NOT EXISTS backup_080.task_linked_tags   AS SELECT id, linked_tag_id FROM tasks WHERE linked_tag_id IS NOT NULL;

-- ── 1. Schema ─────────────────────────────────────────────────────────────────
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_colour_check;
ALTER TABLE projects ADD CONSTRAINT projects_colour_check CHECK (colour = ANY (ARRAY[
  'blue','cyan','teal','green','lime','yellow','orange','red','magenta','purple','indigo','warm-gray','gray'
]));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'folder';

ALTER TABLE tags ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_project_id ON tags (project_id) WHERE project_id IS NOT NULL;

-- ── 2. Helper: merge one tag into another across every junction ───────────────
CREATE OR REPLACE FUNCTION pg_temp.merge_tag(src UUID, dst UUID) RETURNS void AS $$
BEGIN
  IF src IS NULL OR dst IS NULL OR src = dst THEN RETURN; END IF;
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

CREATE OR REPLACE FUNCTION pg_temp.tag_id(tag_name TEXT) RETURNS UUID AS $$
  SELECT id FROM tags WHERE lower(name) = lower(tag_name) ORDER BY parent_id NULLS FIRST LIMIT 1;
$$ LANGUAGE sql;

-- ── 3. New theme areas ────────────────────────────────────────────────────────
INSERT INTO tags (name, slug, role) VALUES
  ('Content and Eminence', 'content-and-eminence', 'concept'),
  ('Personal Finance',     'personal-finance',     'concept'),
  ('Personal Growth',      'personal-growth',      'concept')
ON CONFLICT (slug) DO NOTHING;

-- ── 4. Re-home topics that were filed under project groups ───────────────────
UPDATE tags SET parent_id = pg_temp.tag_id('Content and Eminence'), role = 'concept'
 WHERE name IN ('Blog Maintenance','Content Management System','SEO Preservation','IBM INternal','Editorial Design')
   AND parent_id = pg_temp.tag_id('Eminence');
UPDATE tags SET name = 'IBM Internal' WHERE name = 'IBM INternal';

UPDATE tags SET parent_id = pg_temp.tag_id('Personal Finance'), role = 'concept'
 WHERE name IN ('Equity Release','Mortgage','Financial Services Compensation Scheme (FSCS)','Tax Planning for Retirement',
                'Drawdown Strategies','UK IFA','FCA Register API','Independent Financial Advisor','Pension Planning',
                'UK Personal Finance','Personal Finance Value')
   AND parent_id IN (pg_temp.tag_id('Nelfin'), pg_temp.tag_id('Personal'));

UPDATE tags SET parent_id = pg_temp.tag_id('Personal Growth'), role = 'concept'
 WHERE name IN ('Personal Motivation','Development Journey Reflections','Entrepreneurship','Learning Options',
                'Personal Development','Learning and Development')
   AND parent_id IN (pg_temp.tag_id('Personal'), pg_temp.tag_id('IBM Projects'));

UPDATE tags SET parent_id = pg_temp.tag_id('Security and Identity'), role = 'concept'
 WHERE name = 'IBM Security Events Ingestion';

UPDATE tags SET parent_id = pg_temp.tag_id('Architecture and Method'), role = 'concept'
 WHERE name IN ('Use case','Requirements') AND parent_id IS NULL;

-- News sources are not topics
DELETE FROM tags WHERE parent_id = pg_temp.tag_id('Thoughtworks Insights');
DELETE FROM tags WHERE name = 'Thoughtworks Insights' AND parent_id IS NULL;

-- ── 5. Projects that existed only as tags ────────────────────────────────────
INSERT INTO projects (id, name, category, description) VALUES
  ('atom',                    'ATOM',                          'work',        'IBM ATOM'),
  ('ai-finops',               'AI FinOps',                     'work',        'IBM AI FinOps'),
  ('ai-security-governance',  'AI Security and Governance',    'work',        'IBM AI security and governance'),
  ('ai-well-architected',     'AI Well Architected Framework', 'work',        'IBM AI Well-Architected Framework'),
  ('ibm-advantage',           'IBM Advantage',                 'work',        'IBM Advantage'),
  ('knowledge-hub',           'Knowledge Hub',                 'side-hustle', 'Athena — this Knowledge Hub application'),
  ('modelair',                'ModelAIr',                      'side-hustle', 'ModelAIr web and app'),
  ('auto-queue-app',          'Auto Queue App',                'side-hustle', 'Auto Queue App'),
  ('vibe-coding-youtube',     'Vibe Coding YouTube',           'personal',    'Vibe Coding YouTube channel'),
  ('newsletter',              'Newsletter',                    'personal',    'Newsletter'),
  ('mortgage-app',            'Mortgage App',                  'side-hustle', 'Nelfin mortgage app'),
  ('financial-education-app', 'Financial Education App',       'side-hustle', 'Nelfin financial education app')
ON CONFLICT (id) DO NOTHING;

-- ── 6. Merge duplicate tags ──────────────────────────────────────────────────
SELECT pg_temp.merge_tag(pg_temp.tag_id('ModelAIr Web'), pg_temp.tag_id('ModelAIr'));
SELECT pg_temp.merge_tag(pg_temp.tag_id('ModelAIr App'), pg_temp.tag_id('ModelAIr'));

-- ── 7. Link every project to exactly one filing tag, under its group ─────────
CREATE TEMP TABLE project_identity (
  project_id TEXT PRIMARY KEY, tag_name TEXT, group_name TEXT, colour TEXT, icon TEXT
) ON COMMIT DROP;
INSERT INTO project_identity VALUES
  -- IBM Projects
  ('imagine',                          'Imagine',                       'IBM Projects',         'indigo',  'idea'),
  ('acre',                             'ACRE',                          'IBM Projects',         'teal',    'building'),
  ('atom',                             'ATOM',                          'IBM Projects',         'cyan',    'atom'),
  ('ai-finops',                        'AI FinOps',                     'IBM Projects',         'lime',    'finance'),
  ('ai-security-governance',           'AI Security and Governance',    'IBM Projects',         'red',     'security'),
  ('ai-well-architected',              'AI Well Architected Framework', 'IBM Projects',         'orange',  'blueprint'),
  ('ibm-advantage',                    'IBM Advantage',                 'IBM Projects',         'blue',    'star'),
  ('msft-partner-dashboard',           'MSFT Dashboard',                'IBM Projects',         'blue',    'dashboard'),
  ('ibm-msft-practice',                NULL,                            'IBM Projects',         'blue',    'partnership'),
  ('ikea',                             NULL,                            'IBM Projects',         'yellow',  'store'),
  ('reckitt',                          'Reckitt',                       'IBM Projects',         'magenta', 'flask'),
  -- Eminence
  ('cloudt-with-a-chance-of-insights', 'Podcast',                       'Eminence',             'purple',  'microphone'),
  ('newsletter',                       'Newsletter',                    'Eminence',             'orange',  'email'),
  ('vibe-coding-youtube',              'Vibe Coding YouTube',           'Eminence',             'red',     'video'),
  ('microsoft-cloud-blog',             NULL,                            'Eminence',             'cyan',    'cloud'),
  ('ibm-thought-leadership',           NULL,                            'Eminence',             'blue',    'presentation'),
  ('techbytes',                        NULL,                            'Eminence',             'teal',    'laptop'),
  ('blog-site',                        NULL,                            'Eminence',             'green',   'pen'),
  -- Independent Ventures
  ('knowledge-hub',                    'Knowledge Hub',                 'Independent Ventures', 'purple',  'brain'),
  ('modelair',                         'ModelAIr',                      'Independent Ventures', 'magenta', 'rocket'),
  ('structara-ai',                     NULL,                            'Independent Ventures', 'indigo',  'diagram'),
  ('content-pipeline',                 NULL,                            'Independent Ventures', 'orange',  'flow'),
  ('auto-queue-app',                   'Auto Queue App',                'Independent Ventures', 'yellow',  'queue'),
  -- Nelfin
  ('healthwise',                       'Healthwise',                    'Nelfin',               'green',   'health'),
  ('mortgage-app',                     'Mortgage App',                  'Nelfin',               'lime',    'home'),
  ('financial-education-app',          'Financial Education App',       'Nelfin',               'teal',    'education'),
  ('ifa-project',                      NULL,                            'Nelfin',               'cyan',    'finance'),
  ('neli-blog',                        NULL,                            'Nelfin',               'magenta', 'pen'),
  -- Ungrouped
  ('personal',                         'Personal',                      NULL,                   'gray',    'user');

-- Only rows whose project actually exists
DELETE FROM project_identity pi WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = pi.project_id);

-- Create a filing tag for projects that never had one
INSERT INTO tags (name, slug, role)
SELECT p.name, p.id, 'filing'
  FROM project_identity pi JOIN projects p ON p.id = pi.project_id
 WHERE pi.tag_name IS NULL
ON CONFLICT (slug) DO NOTHING;
UPDATE project_identity pi SET tag_name = p.name
  FROM projects p WHERE p.id = pi.project_id AND pi.tag_name IS NULL;

-- Nelfin's "Blog" topic is Neli's blog
SELECT pg_temp.merge_tag(
  (SELECT id FROM tags WHERE name = 'Blog' AND parent_id = pg_temp.tag_id('Nelfin')),
  (SELECT id FROM tags WHERE slug = 'neli-blog'));

UPDATE tags t SET
  project_id = pi.project_id,
  role       = 'filing',
  parent_id  = CASE WHEN pi.group_name IS NULL THEN NULL ELSE pg_temp.tag_id(pi.group_name) END,
  name       = p.name,
  updated_at = now()
  FROM project_identity pi JOIN projects p ON p.id = pi.project_id
 WHERE t.id = (SELECT id FROM tags x WHERE lower(x.name) = lower(pi.tag_name) OR x.slug = pi.project_id
               ORDER BY (x.slug = pi.project_id) DESC, (x.role = 'filing') DESC LIMIT 1);

UPDATE projects p SET colour = pi.colour, icon = pi.icon, updated_at = now()
  FROM project_identity pi WHERE pi.project_id = p.id;

-- Legacy single linked tag on tasks → task_tags
INSERT INTO task_tags (task_id, tag_id, source)
SELECT id, linked_tag_id, 'manual' FROM tasks WHERE linked_tag_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 8. Colour: areas own the theme colour, topics inherit, projects own theirs
CREATE TEMP TABLE palette (key TEXT PRIMARY KEY, hex TEXT) ON COMMIT DROP;
INSERT INTO palette VALUES
  ('blue','#78a9ff'),('cyan','#33b1ff'),('teal','#3ddbd9'),('green','#6fdc8c'),('lime','#b6d65c'),
  ('yellow','#f1c21b'),('orange','#ff9f5a'),('red','#ff8389'),('magenta','#ff7eb6'),('purple','#be95ff'),
  ('indigo','#a0a4ff'),('warm-gray','#bab0ac'),('gray','#a8a8a8');

UPDATE tags t SET colour = pl.hex, updated_at = now()
  FROM (VALUES
    ('Microsoft Cloud','blue'), ('AI','purple'), ('Security and Identity','red'),
    ('DevOps and Automation','green'), ('Architecture and Method','orange'),
    ('Observability and Data','teal'), ('Industry','yellow'),
    ('Content and Eminence','magenta'), ('Personal Finance','lime'), ('Personal Growth','cyan')
  ) AS area(name, key)
  JOIN palette pl ON pl.key = area.key
 WHERE t.name = area.name AND t.parent_id IS NULL AND t.role = 'concept';

UPDATE tags SET colour = NULL WHERE role = 'concept' AND parent_id IS NOT NULL;
UPDATE tags SET colour = NULL WHERE role = 'filing' AND project_id IS NULL;
UPDATE tags t SET colour = pl.hex
  FROM projects p JOIN palette pl ON pl.key = p.colour
 WHERE t.project_id = p.id;
