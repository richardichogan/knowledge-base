CREATE TABLE IF NOT EXISTS sync_runs (
  id UUID PRIMARY KEY,
  claim_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'interrupted')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  results JSONB NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_one_running ON sync_runs ((status)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS sync_runs_started ON sync_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_job_claims (
  job TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (job, period)
);
