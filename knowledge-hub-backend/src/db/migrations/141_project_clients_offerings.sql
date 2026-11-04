-- 141_project_clients_offerings.sql
-- Projects can now be opportunities or offerings. A project or opportunity has
-- at most one client company plus any number of partners, and may "sell" or be
-- "related to" one offering. Diagrams keep one owning project and can be
-- recorded as used in others.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_type_check;
ALTER TABLE projects ADD CONSTRAINT projects_project_type_check
  CHECK (project_type IN ('project', 'opportunity', 'offering', 'bau', 'aspiration', 'exploration', 'side-project'));

ALTER TABLE company_projects ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'partner';
ALTER TABLE company_projects DROP CONSTRAINT IF EXISTS company_projects_role_check;
ALTER TABLE company_projects ADD CONSTRAINT company_projects_role_check CHECK (role IN ('client', 'partner'));
CREATE UNIQUE INDEX IF NOT EXISTS company_projects_one_client ON company_projects (project_id) WHERE role = 'client';

CREATE TABLE IF NOT EXISTS project_offering_links (
  project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  offering_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL CHECK (relation IN ('sells', 'related')),
  CHECK (project_id <> offering_id)
);
CREATE INDEX IF NOT EXISTS project_offering_links_offering_idx ON project_offering_links (offering_id);

CREATE TABLE IF NOT EXISTS canvas_project_uses (
  canvas_id  UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (canvas_id, project_id)
);
CREATE INDEX IF NOT EXISTS canvas_project_uses_project_idx ON canvas_project_uses (project_id);

-- ── Agreed reorganisation of the existing records ───────────────────────────
-- Applies only where the original IMAGINE project exists, so fresh/test
-- databases receive the schema without seeded business data.
DO $$
DECLARE
  imagine_tag RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id = 'imagine') THEN RETURN; END IF;

  SELECT parent_id, colour INTO imagine_tag FROM tags WHERE project_id = 'imagine' LIMIT 1;

  INSERT INTO companies (id, name)
  SELECT gen_random_uuid(), v.name FROM (VALUES ('Reckitt'), ('IKEA')) AS v(name)
  WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE lower(trim(c.name)) = lower(v.name));

  INSERT INTO projects (id, name, colour, icon, category, priority, project_type, description, lifecycle_state, importance, tags)
  SELECT v.id, v.name, p.colour, p.icon, 'work', 'high', v.kind, v.description, 'active', 'normal', '{}'
  FROM projects p CROSS JOIN (VALUES
    ('imagine-offering', 'Imagine', 'offering', 'IBM offering under development, sold to clients.'),
    ('imagine-turnaround', 'Imagine Turnaround', 'opportunity', 'ADNOC turnaround opportunity selling Imagine.'),
    ('imagine-complaints-process', 'Imagine Complaints Process', 'opportunity', 'Royal London Group complaints process opportunity selling Imagine.')
  ) AS v(id, name, kind, description)
  WHERE p.id = 'imagine' AND NOT EXISTS (SELECT 1 FROM projects x WHERE x.id = v.id);

  INSERT INTO tags (name, slug, role, parent_id, colour, project_id)
  SELECT p.name, p.id, 'filing', imagine_tag.parent_id, imagine_tag.colour, p.id
  FROM projects p
  WHERE p.id IN ('imagine-offering', 'imagine-turnaround', 'imagine-complaints-process')
    AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.project_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.slug = p.id);

  UPDATE projects SET name = 'Imagine development', updated_at = NOW() WHERE id = 'imagine';
  UPDATE projects SET name = 'AI Finance Transformation', updated_at = NOW() WHERE id = 'reckitt';
  UPDATE projects SET name = 'IKEA Imagine', project_type = 'opportunity', updated_at = NOW() WHERE id = 'ikea';
  UPDATE tags t SET name = p.name, updated_at = NOW()
  FROM projects p WHERE t.project_id = p.id AND p.id IN ('imagine', 'reckitt', 'ikea');

  UPDATE company_projects SET role = 'partner'
  WHERE project_id = 'reckitt' AND company_id IN (SELECT id FROM companies WHERE lower(name) IN ('sigmoid', 'bcg', 'epam'));

  INSERT INTO company_projects (company_id, project_id, role)
  SELECT c.id, v.project_id, 'client'
  FROM (VALUES ('reckitt', 'reckitt'), ('ikea', 'ikea'), ('adnoc', 'imagine-turnaround'),
               ('royal london group', 'imagine-complaints-process')) AS v(company, project_id)
  JOIN companies c ON lower(trim(c.name)) = v.company
  WHERE EXISTS (SELECT 1 FROM projects p WHERE p.id = v.project_id)
  ON CONFLICT (company_id, project_id) DO UPDATE SET role = 'client';

  INSERT INTO project_offering_links (project_id, offering_id, relation)
  SELECT v.project_id, 'imagine-offering', v.relation
  FROM (VALUES ('imagine', 'related'), ('reckitt', 'related'), ('ikea', 'sells'),
               ('imagine-turnaround', 'sells'), ('imagine-complaints-process', 'sells')) AS v(project_id, relation)
  WHERE EXISTS (SELECT 1 FROM projects p WHERE p.id = v.project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = 'imagine-offering')
  ON CONFLICT (project_id) DO NOTHING;

  UPDATE notes SET project_id = 'imagine-turnaround', updated_at = NOW()
  WHERE id IN ('3ef0f470-c41b-4c18-9f09-f0a4835a2b64', 'cab7d3f3-9286-4184-b6b0-b9fb39da6b3a')
    AND EXISTS (SELECT 1 FROM projects WHERE id = 'imagine-turnaround');
  UPDATE notes SET project_id = 'imagine-complaints-process', updated_at = NOW()
  WHERE id IN ('a2a64d43-8f8a-43bd-bd7d-29badb2b22f9', 'd48e789b-db6b-423f-9d04-9aa5bcb2b61d')
    AND EXISTS (SELECT 1 FROM projects WHERE id = 'imagine-complaints-process');

  UPDATE tasks SET project_id = 'imagine-turnaround', updated_at = NOW()
  WHERE id IN ('a402160a-025b-4763-8240-5dab667f7ee7', '2797fb33-8346-4a0f-b68f-4c235b3a406c',
               '2096d3bc-4042-45ea-bbf0-8c1795a8d103', '44ac9222-a7e5-4011-b63b-94b00ce2b401',
               '809b5a0e-b26c-4030-90d7-9c1350436ac8')
    AND EXISTS (SELECT 1 FROM projects WHERE id = 'imagine-turnaround');
  UPDATE tasks SET project_id = 'imagine-complaints-process', updated_at = NOW()
  WHERE id IN ('f3f447fb-30cd-418e-a5e2-01d32d7f0e0a', '3f622d4e-9bcf-452f-b0f2-d83e12da8b8e',
               'c453e44d-fc49-4798-aaae-9c321b72d967', '1cef95fc-536a-4be4-aaf4-24b096c5cf39')
    AND EXISTS (SELECT 1 FROM projects WHERE id = 'imagine-complaints-process');
END $$;
