CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  website text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_unique ON companies (lower(trim(name)));

ALTER TABLE people ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS people_company_id_idx ON people(company_id);

CREATE TABLE IF NOT EXISTS company_projects (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, project_id)
);
CREATE TABLE IF NOT EXISTS person_project_roles (
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT '',
  PRIMARY KEY (person_id, project_id)
);
CREATE INDEX IF NOT EXISTS person_project_roles_company_idx ON person_project_roles(company_id);
CREATE INDEX IF NOT EXISTS person_project_roles_project_idx ON person_project_roles(project_id);

ALTER TABLE note_entity_links DROP CONSTRAINT IF EXISTS note_entity_links_target_type_check;
ALTER TABLE note_entity_links ADD CONSTRAINT note_entity_links_target_type_check
  CHECK (target_type IN ('spark', 'diagram', 'project', 'task', 'usecase', 'article', 'person', 'company'));

CREATE OR REPLACE FUNCTION rebuild_note_links() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE body JSONB;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN RETURN NEW; END IF;
  body := note_link_document(NEW.content);
  DELETE FROM note_links WHERE source_note_id = NEW.id;
  DELETE FROM note_entity_links WHERE source_note_id = NEW.id;
  INSERT INTO note_links(source_note_id, target_note_id)
    SELECT DISTINCT NEW.id, n.id
    FROM jsonb_path_query(body, 'lax $.** ? (@.type == "noteMention")') AS mention
    JOIN notes n ON n.id::text = mention->'props'->>'noteId'
    ON CONFLICT DO NOTHING;
  INSERT INTO note_entity_links(source_note_id, target_type, target_id)
    SELECT DISTINCT NEW.id, mention->'props'->>'entityType', mention->'props'->>'entityId'
    FROM jsonb_path_query(body, 'lax $.** ? (@.type == "entityMention")') AS mention
    WHERE mention->'props'->>'entityType' IN ('spark', 'diagram', 'project', 'task', 'usecase', 'article', 'person', 'company')
      AND length(mention->'props'->>'entityId') BETWEEN 1 AND 200
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
