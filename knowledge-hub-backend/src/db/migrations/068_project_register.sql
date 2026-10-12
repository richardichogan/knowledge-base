-- Project register: questions, risks and issues tracked per project.
-- Items may be promoted from a chat decision; (project, source) is unique so
-- repeated promotion is idempotent. Promotion never modifies the source.

CREATE TABLE IF NOT EXISTS project_register_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('question', 'risk', 'issue')),
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution  TEXT NOT NULL DEFAULT '',
  owner       TEXT NOT NULL DEFAULT '',
  due_date    DATE,
  task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'chat_decision')),
  source_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_register_project
  ON project_register_items (project_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_register_source
  ON project_register_items (project_id, source_type, source_id)
  WHERE source_id IS NOT NULL;
