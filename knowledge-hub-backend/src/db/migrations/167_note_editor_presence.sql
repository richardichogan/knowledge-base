CREATE TABLE IF NOT EXISTS note_editor_presence (
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  editor_id UUID NOT NULL,
  owner_id TEXT NOT NULL,
  registration_id UUID NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, editor_id)
);
