-- 037_ai_chat_session_note_link.sql
-- Links an AI chat session to the Think note it was started from, so the
-- embedded Athena panel on the Think page can show the right conversation
-- (or none) as the user switches between notes, instead of always showing
-- whatever session happens to be active globally.

ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS note_id TEXT;

-- A note has at most one linked session at a time (the most recently started
-- one — see linkSessionToNote, which clears any prior link before setting a
-- new one).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_chat_sessions_note_id
  ON ai_chat_sessions (note_id) WHERE note_id IS NOT NULL;
