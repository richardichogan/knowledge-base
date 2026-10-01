-- 045_chat_alternates.sql
-- "Ask another model": alternative answers to one of Athena's replies from a
-- different model (GPT-4o, GPT-5.4, GPT-6 Astra), shown as tabs on that reply.
-- "Use this one" swaps an alternative into the chat (the replaced answer is
-- kept here as model 'original'), so the conversation continues from it.

CREATE TABLE IF NOT EXISTS chat_alternates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  message_id  BIGINT NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_alternates_message ON chat_alternates (message_id, created_at);
