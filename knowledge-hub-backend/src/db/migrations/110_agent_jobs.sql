-- Specialist agent jobs: Athena hands work to a registered specialist and carries on.
-- One table for every specialist; the worker pool keeps production and local
-- development (which shares the production database) from running each other's jobs.
CREATE TABLE IF NOT EXISTS agent_jobs (
  id UUID PRIMARY KEY,
  specialist TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_title TEXT NOT NULL DEFAULT '',
  subject_url TEXT NOT NULL DEFAULT '',
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  progress JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB,
  error TEXT,
  depends_on UUID REFERENCES agent_jobs(id) ON DELETE SET NULL,
  conversation_id TEXT,
  requested_by TEXT NOT NULL DEFAULT 'app' CHECK (requested_by IN ('app', 'chat')),
  -- A prerequisite step in a handoff (e.g. the spec before a Blueprint); the last job reports back.
  is_step BOOLEAN NOT NULL DEFAULT FALSE,
  worker_pool TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_jobs_pool_status_idx ON agent_jobs (worker_pool, status, created_at);
CREATE INDEX IF NOT EXISTS agent_jobs_subject_idx ON agent_jobs (subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_jobs_depends_idx ON agent_jobs (depends_on);
