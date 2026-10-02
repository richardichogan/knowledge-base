-- 047_chat_files.sql
-- Spreadsheets attached in a chat (.xlsx / .csv). The file itself is kept in
-- the Library (kb-documents blob); this links it to the chat so Athena can
-- load it into the model's code tool (the "calculator") and compute real
-- totals, filters and comparisons instead of estimating. azure_file_id is
-- the copy uploaded to the model's file store, reused across turns.

CREATE TABLE IF NOT EXISTS chat_files (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  content_item_id  TEXT,
  filename         TEXT NOT NULL,
  blob_path        TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  azure_file_id    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_files_session ON chat_files (session_id, created_at);
