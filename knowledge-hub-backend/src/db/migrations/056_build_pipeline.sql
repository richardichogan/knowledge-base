-- 056_build_pipeline.sql
-- Build pipeline: a spec is decomposed into dependency-ordered tasks, each
-- dispatched to a GitHub cloud coding agent (Copilot or Claude) by assigning a
-- GitHub issue. The runner (src/build/buildRunner.ts) tracks the agent's PR,
-- auto-merges when green and releases dependent tasks.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS build_specs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        TEXT        REFERENCES projects(id) ON DELETE SET NULL,
  note_id           UUID,
  chat_output_id    UUID,
  title             TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  spec_markdown     TEXT        NOT NULL DEFAULT '',
  repo              TEXT        NOT NULL CHECK (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  base_branch       TEXT        NOT NULL DEFAULT 'main',
  status            TEXT        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'decomposing', 'decomposed', 'running', 'paused', 'done', 'failed')),
  max_parallel      INTEGER     NOT NULL DEFAULT 2 CHECK (max_parallel BETWEEN 1 AND 5),
  auto_merge        BOOLEAN     NOT NULL DEFAULT TRUE,
  plan_notes        TEXT        NOT NULL DEFAULT '',
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS build_tasks (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id           UUID        NOT NULL REFERENCES build_specs(id) ON DELETE CASCADE,
  seq               INTEGER     NOT NULL,
  title             TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 250),
  body_markdown     TEXT        NOT NULL DEFAULT '',
  agent             TEXT        NOT NULL DEFAULT 'copilot' CHECK (agent IN ('copilot', 'claude')),
  agent_reason      TEXT        NOT NULL DEFAULT '',
  model             TEXT        NOT NULL DEFAULT '',
  size              TEXT        NOT NULL DEFAULT 'M' CHECK (size IN ('S', 'M', 'L')),
  depends_on        UUID[]      NOT NULL DEFAULT '{}',
  status            TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'dispatched', 'pr_open', 'awaiting_approval', 'merged',
                                      'blocked', 'failed', 'cancelled')),
  issue_number      INTEGER,
  issue_url         TEXT,
  pr_number         INTEGER,
  pr_url            TEXT,
  branch            TEXT,
  head_sha          TEXT,
  -- When the runner asked the agent to fix something: the head it saw, so it
  -- waits for a new commit before judging the PR again.
  nudged_sha        TEXT,
  nudged_at         TIMESTAMPTZ,
  -- First time the runner saw the agent finished on the current head (grace period for checks to appear).
  done_seen_at      TIMESTAMPTZ,
  fix_attempts      INTEGER     NOT NULL DEFAULT 0,
  last_error        TEXT,
  dispatched_at     TIMESTAMPTZ,
  merged_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (spec_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_build_tasks_spec ON build_tasks(spec_id);
CREATE INDEX IF NOT EXISTS idx_build_specs_status ON build_specs(status);

CREATE TABLE IF NOT EXISTS build_events (
  id         BIGSERIAL   PRIMARY KEY,
  spec_id    UUID        NOT NULL REFERENCES build_specs(id) ON DELETE CASCADE,
  task_id    UUID        REFERENCES build_tasks(id) ON DELETE CASCADE,
  kind       TEXT        NOT NULL,
  message    TEXT        NOT NULL DEFAULT '',
  payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_build_events_spec ON build_events(spec_id, created_at DESC);
