ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS prep_document_initialized BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION podcast_prep_document_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    UPDATE podcast_episodes SET revision=revision+1,updated_at=NOW() WHERE note_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS podcast_prep_document_revision ON notes;
CREATE TRIGGER podcast_prep_document_revision AFTER UPDATE OF content ON notes
  FOR EACH ROW EXECUTE FUNCTION podcast_prep_document_changed();
