-- Private task-scoped working memory, not user-profile memory or edited source content.
CREATE TABLE IF NOT EXISTS document_reading_sessions (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  purpose_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  source_version TEXT NOT NULL,
  title TEXT NOT NULL,
  next_cursor TEXT,
  next_offset INTEGER NOT NULL DEFAULT 0,
  total_chars INTEGER NOT NULL,
  memory TEXT NOT NULL DEFAULT '',
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  lease_owner UUID,
  lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, source_kind, source_id, scope_key, purpose_hash)
);
CREATE TABLE IF NOT EXISTS document_reading_chunks (
  review_id UUID NOT NULL REFERENCES document_reading_sessions(id) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  summary TEXT NOT NULL,
  excerpts JSONB NOT NULL,
  PRIMARY KEY (review_id, start_offset),
  CHECK (end_offset >= start_offset)
);
