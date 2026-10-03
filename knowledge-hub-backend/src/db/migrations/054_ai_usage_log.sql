-- One row per model call: which feature made it, which deployment served it, and how many tokens.
-- Additive (new table only); written fire-and-forget by the model client, never read by the app's own screens.
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id                 BIGSERIAL PRIMARY KEY,
  at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  environment        TEXT NOT NULL DEFAULT 'prod',
  feature            TEXT NOT NULL,
  persona            TEXT,
  session_id         TEXT,
  slot               TEXT NOT NULL,
  deployment         TEXT NOT NULL,
  api                TEXT NOT NULL DEFAULT 'chat',
  prompt_tokens      INT NOT NULL DEFAULT 0,
  cached_tokens      INT NOT NULL DEFAULT 0,
  completion_tokens  INT NOT NULL DEFAULT 0,
  reasoning_tokens   INT NOT NULL DEFAULT 0,
  duration_ms        INT NOT NULL DEFAULT 0,
  ok                 BOOLEAN NOT NULL DEFAULT true,
  error              TEXT
);
CREATE INDEX IF NOT EXISTS ai_usage_log_at_idx ON ai_usage_log (at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_log_feature_idx ON ai_usage_log (feature, at DESC);
