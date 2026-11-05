ALTER TABLE daily_insights_import_staging
  ADD COLUMN IF NOT EXISTS extraction_stages JSONB NOT NULL DEFAULT '{}'::jsonb;
