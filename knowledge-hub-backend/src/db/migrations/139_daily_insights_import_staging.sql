CREATE TABLE IF NOT EXISTS daily_insights_import_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date DATE NOT NULL,
  content_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  source_path TEXT NOT NULL,
  report_text TEXT NOT NULL,
  source_modified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_date, content_hash)
);
