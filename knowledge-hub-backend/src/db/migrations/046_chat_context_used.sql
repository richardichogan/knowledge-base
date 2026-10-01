-- 046_chat_context_used.sql
--  * context_used: what a reply drew on (project, standing instructions, the
--    document in view, items her searches found, auto-retrieved items, the
--    chat's panels) — shown as the "Used:" line under the reply.
--  * next_steps: 2–3 suggested follow-ups shown as buttons under the reply.
--  * excluded_sources: items he said not to use in this chat ("Don't use
--    this"); left out of searches and auto-retrieval for the rest of the chat.

ALTER TABLE ai_chat_messages ADD COLUMN IF NOT EXISTS context_used JSONB;
ALTER TABLE ai_chat_messages ADD COLUMN IF NOT EXISTS next_steps JSONB;
ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS excluded_sources JSONB NOT NULL DEFAULT '[]'::jsonb;
