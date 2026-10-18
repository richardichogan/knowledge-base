CREATE TABLE IF NOT EXISTS note_links (
  source_note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_note_id, target_note_id)
);
CREATE INDEX IF NOT EXISTS note_links_target ON note_links(target_note_id);

CREATE TABLE IF NOT EXISTS note_entity_links (
  source_note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('spark', 'diagram', 'project')),
  target_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_note_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS note_entity_links_target ON note_entity_links(target_type, target_id);

CREATE OR REPLACE FUNCTION note_link_document(raw TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE body JSONB;
BEGIN
  body := raw::jsonb;
  IF jsonb_typeof(body) = 'object' AND jsonb_typeof(body->'contentJson') = 'string' THEN
    body := (body->>'contentJson')::jsonb;
  END IF;
  IF jsonb_typeof(body) = 'array' THEN RETURN body; END IF;
  RETURN '[]'::jsonb;
EXCEPTION WHEN invalid_text_representation THEN
  -- Legacy plain-text notes have no structured links to index.
  RETURN '[]'::jsonb;
END $$;

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
    WHERE mention->'props'->>'entityType' IN ('spark', 'diagram', 'project')
      AND length(mention->'props'->>'entityId') BETWEEN 1 AND 200
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS notes_rebuild_links ON notes;
CREATE TRIGGER notes_rebuild_links AFTER INSERT OR UPDATE OF content ON notes
  FOR EACH ROW EXECUTE FUNCTION rebuild_note_links();

-- Also rebuild links in existing writing without changing its revision or dates.
INSERT INTO note_links(source_note_id, target_note_id)
  SELECT DISTINCT source.id, target.id FROM notes source
  CROSS JOIN LATERAL jsonb_path_query(note_link_document(source.content), 'lax $.** ? (@.type == "noteMention")') AS mention
  JOIN notes target ON target.id::text = mention->'props'->>'noteId'
  ON CONFLICT DO NOTHING;
INSERT INTO note_entity_links(source_note_id, target_type, target_id)
  SELECT DISTINCT source.id, mention->'props'->>'entityType', mention->'props'->>'entityId' FROM notes source
  CROSS JOIN LATERAL jsonb_path_query(note_link_document(source.content), 'lax $.** ? (@.type == "entityMention")') AS mention
  WHERE mention->'props'->>'entityType' IN ('spark', 'diagram', 'project')
    AND length(mention->'props'->>'entityId') BETWEEN 1 AND 200
  ON CONFLICT DO NOTHING;
