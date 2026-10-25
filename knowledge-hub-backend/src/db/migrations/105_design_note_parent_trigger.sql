-- Existing parents do not need a conflicting INSERT on every writing save.
CREATE OR REPLACE FUNCTION ensure_design_note_parent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF note_list_metadata(NEW.content)->>'contentType'='design'
    AND NOT EXISTS(SELECT 1 FROM designs WHERE parent_note_id=NEW.id) THEN
    INSERT INTO designs(id,parent_note_id,title,project_id)
    VALUES(NEW.id,NEW.id,left(COALESCE(NULLIF(note_list_metadata(NEW.content)->>'title',''),'Untitled'),200),NEW.project_id)
    ON CONFLICT(parent_note_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE INDEX IF NOT EXISTS design_feedback_parent ON design_feedback(design_id,created_at);
