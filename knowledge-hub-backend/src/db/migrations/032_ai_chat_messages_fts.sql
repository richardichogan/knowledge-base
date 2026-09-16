-- Cross-session Athena memory: lets the assistant recall relevant content
-- from earlier, DIFFERENT chat sessions (not just the current one), so it
-- can cross-reference past conversations the same way it already
-- cross-references the knowledge base library.
-- GIN expression index makes full-text search over ai_chat_messages.content
-- fast at scale instead of sequential-scanning to_tsvector() on every query.
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_fts
  ON ai_chat_messages USING GIN (to_tsvector('english', content));
