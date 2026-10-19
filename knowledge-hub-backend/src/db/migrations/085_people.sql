CREATE TABLE IF NOT EXISTS people (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  emails TEXT[] NOT NULL DEFAULT '{}',
  organisation TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  threads TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  source_period TEXT NOT NULL DEFAULT '',
  contact_group TEXT NOT NULL DEFAULT '',
  email_count INTEGER CHECK (email_count IS NULL OR email_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS people_name ON people(lower(name));
CREATE INDEX IF NOT EXISTS people_emails ON people USING GIN(emails);

ALTER TABLE note_entity_links DROP CONSTRAINT IF EXISTS note_entity_links_target_type_check;
ALTER TABLE note_entity_links ADD CONSTRAINT note_entity_links_target_type_check
  CHECK (target_type IN ('spark', 'diagram', 'project', 'task', 'usecase', 'article', 'person'));

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
    WHERE mention->'props'->>'entityType' IN ('spark', 'diagram', 'project', 'task', 'usecase', 'article', 'person')
      AND length(mention->'props'->>'entityId') BETWEEN 1 AND 200
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
