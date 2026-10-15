CREATE TABLE IF NOT EXISTS podcast_prep_runs (
  recording_date DATE PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed')),
  claim_token UUID,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  generated_at TIMESTAMPTZ,
  retry_at TIMESTAMPTZ,
  session_id UUID NOT NULL,
  output_id UUID,
  evidence JSONB,
  warnings JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  acknowledged_at TIMESTAMPTZ
);
