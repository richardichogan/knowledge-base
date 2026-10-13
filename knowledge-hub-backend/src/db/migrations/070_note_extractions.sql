-- Records what was done with a passage of a note (Spark, task, canvas, new note, Athena
-- discussion) so the passage can be marked in the editor and link to the result.
CREATE TABLE IF NOT EXISTS note_extractions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id      UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  quote        TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('spark', 'task', 'canvas', 'note', 'athena')),
  target_type  TEXT,
  target_id    TEXT,
  target_label TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_extractions_note ON note_extractions (note_id, created_at);
