-- 044_chat_screens.sql
-- Screenshots pasted into a chat are kept with it (the Screens panel) instead
-- of being thrown away after one message: read once (the text is reused in
-- later turns), ordered into a journey for "Review this journey", and marked
-- up (boxes + a note) to ask about a specific area. Images live in the
-- private chat-screens blob container; rows (and, via the app, blobs) are
-- deleted with the chat.

CREATE TABLE IF NOT EXISTS chat_screens (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  blob_name            TEXT NOT NULL,
  content_type         TEXT NOT NULL,
  -- Step name in the journey (starts as the file name).
  name                 TEXT NOT NULL,
  position             INT NOT NULL DEFAULT 0,
  in_journey           BOOLEAN NOT NULL DEFAULT TRUE,
  -- The detailed read of the screen, reused instead of re-reading.
  reading              TEXT,
  -- Marked-up copy (boxes drawn on it) and what he wrote about them.
  annotated_blob_name  TEXT,
  annotation_note      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_screens_session ON chat_screens (session_id, position);
