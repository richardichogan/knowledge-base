-- 049_chat_from_think.sql
-- Marks chats started from a Think note. They belong to their note and stay
-- out of the main chat list; the mark is kept even when a newer chat on the
-- same note takes over the note link (note_id).
ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS from_think BOOLEAN NOT NULL DEFAULT false;
UPDATE ai_chat_sessions SET from_think = true WHERE note_id IS NOT NULL AND from_think = false;
