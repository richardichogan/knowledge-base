-- A Podcast episode is a Think note (contentType 'podcast-episode') that carries the
-- recording through Prep → Script → Transcript → Show Notes → Campaign.
CREATE TABLE IF NOT EXISTS podcast_episodes (
  note_id UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  recording_date DATE UNIQUE,
  episode_number INT CHECK (episode_number IS NULL OR episode_number > 0),
  prep_session_id UUID,
  script_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
  script_note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
  transcript TEXT,
  transcript_filename TEXT,
  transcript_uploaded_at TIMESTAMPTZ,
  show_notes_session_id UUID,
  show_notes_note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Episodes created through the content-type control get their row immediately, as Designs do.
CREATE OR REPLACE FUNCTION ensure_podcast_episode_row() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF note_list_metadata(NEW.content)->>'contentType'='podcast-episode'
    AND NOT EXISTS(SELECT 1 FROM podcast_episodes WHERE note_id=NEW.id) THEN
    INSERT INTO podcast_episodes(note_id) VALUES(NEW.id) ON CONFLICT(note_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS podcast_episode_note_row ON notes;
CREATE TRIGGER podcast_episode_note_row AFTER INSERT OR UPDATE OF content ON notes
  FOR EACH ROW EXECUTE FUNCTION ensure_podcast_episode_row();
