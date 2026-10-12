-- Distinguishes a call whose provider reported token usage from one where usage was absent.
-- Existing rows cannot be classified, so they stay unmeasured rather than being counted as zero tokens.
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS usage_known BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS ai_usage_log_env_at_idx ON ai_usage_log (environment, at DESC);
