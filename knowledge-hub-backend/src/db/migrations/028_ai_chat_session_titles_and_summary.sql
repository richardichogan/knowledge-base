-- 028_ai_chat_session_titles_and_summary.sql
-- Adds sidebar-list metadata (title) and rolling-summary support (summary +
-- summarized_through_id) to ai_chat_sessions, so long-running chats stay
-- cheap to replay to the model without losing full history for display.

ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS summarized_through_id BIGINT NOT NULL DEFAULT 0;
