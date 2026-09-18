-- Migration 034: associate Athena chat conversations with projects.

ALTER TABLE ai_chat_sessions
  ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_project_id
  ON ai_chat_sessions (project_id);
