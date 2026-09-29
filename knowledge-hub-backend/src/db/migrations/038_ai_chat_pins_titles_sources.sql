-- 038_ai_chat_pins_titles_sources.sql
-- Athena chat sidebar + reply metadata:
--   * pinned        — user can pin chats to the top of the sidebar.
--   * title_locked  — set when the user renames a chat, so the automatic
--                     (AI-generated) title never overwrites their choice.
--   * persona/sources on each message — which persona answered and which
--     of the user's data (Plan, Think, Library…) the reply drew on, so both
--     survive a reload instead of only showing on the live turn.
-- All additive and nullable/defaulted: safe to apply to a live database.

ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS title_locked BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ai_chat_messages ADD COLUMN IF NOT EXISTS persona TEXT;
ALTER TABLE ai_chat_messages ADD COLUMN IF NOT EXISTS sources TEXT[];
