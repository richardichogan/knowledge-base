-- 043_chat_outputs_decisions.sql
-- The chat side panel.
--  * Outputs: deliverables Athena produces in a chat (GHCP prompts, demo specs,
--    user stories …) kept as named documents with versions, so a revision is
--    a new version rather than a whole new reply. The user can edit them too.
--  * Decisions: a running list of what's been decided and what's still open
--    in a chat, kept up to date after each exchange and fed back to Athena.
-- Everything belongs to its chat and is deleted with it.

CREATE TABLE IF NOT EXISTS chat_outputs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  -- prompt | spec | stories | screens | script | document
  kind        TEXT NOT NULL DEFAULT 'document',
  -- markdown (rendered) | text (one copyable block, e.g. a prompt)
  format      TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'text')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_outputs_session ON chat_outputs (session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_output_versions (
  output_id   UUID NOT NULL REFERENCES chat_outputs(id) ON DELETE CASCADE,
  version     INT NOT NULL,
  content     TEXT NOT NULL,
  author      TEXT NOT NULL CHECK (author IN ('athena', 'user')),
  -- What changed in this version, in a line.
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (output_id, version)
);

CREATE TABLE IF NOT EXISTS chat_decisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('decided', 'open')),
  text        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_decisions_session ON chat_decisions (session_id, created_at);

-- NULL = the persona's default (on for Demo Designer, Brainstorm and Blog Post).
ALTER TABLE ai_chat_sessions ADD COLUMN IF NOT EXISTS track_decisions BOOLEAN;
