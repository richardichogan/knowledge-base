-- Capture state is separate from the upload index: a successful upload must
-- never suppress a failed structured import. All capture writes commit together.
CREATE TABLE IF NOT EXISTS daily_insights_reports (
  report_date DATE PRIMARY KEY,
  content_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_modified_at TIMESTAMPTZ,
  report_text TEXT NOT NULL,
  result JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_insights_tasks (
  identity_key TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  last_report_date DATE NOT NULL,
  snapshot JSONB,
  source_detail JSONB NOT NULL
);
