-- 027_ai_chat_sessions.sql
-- Persists AI chat sessions/messages to Postgres instead of the in-memory
-- Map in routes/ai.ts, which was wiped on every backend restart/redeploy —
-- the single biggest thing killing "conversational" continuity for Athena,
-- since the standalone /chat window is meant to stay open as a daily driver.

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id          UUID PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session
  ON ai_chat_messages (session_id, created_at);
