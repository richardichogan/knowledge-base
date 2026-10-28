CREATE TABLE IF NOT EXISTS ai_workflow_runs (
  id UUID PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('dev','prod')),
  feature TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('user','scheduled','diagnostic')),
  job_id UUID REFERENCES agent_jobs(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted')),
  outcome TEXT CHECK (outcome IN ('ready','review-blocked','published','saved-to-blog')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ai_workflow_runs_window ON ai_workflow_runs(environment, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_workflow_runs_job ON ai_workflow_runs(job_id, attempt);
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS workflow_run_id UUID REFERENCES ai_workflow_runs(id) ON DELETE SET NULL;
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS purpose TEXT CHECK (purpose IN ('user','scheduled','diagnostic'));
CREATE INDEX IF NOT EXISTS ai_usage_log_workflow ON ai_usage_log(workflow_run_id) WHERE workflow_run_id IS NOT NULL;
