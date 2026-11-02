CREATE TABLE IF NOT EXISTS ai_turn_measurements (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('dev','prod')),
  persona TEXT,
  requested_model TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','interrupted')),
  trace_started BOOLEAN NOT NULL DEFAULT FALSE,
  capture_complete BOOLEAN NOT NULL DEFAULT FALSE,
  signals JSONB
);
CREATE INDEX IF NOT EXISTS ai_turn_measurements_window ON ai_turn_measurements(environment, started_at);
CREATE INDEX IF NOT EXISTS ai_turn_measurements_expiry ON ai_turn_measurements(expires_at);

ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS environment TEXT CHECK (environment IN ('dev','prod'));
ALTER TABLE scheduled_job_claims ADD COLUMN IF NOT EXISTS environment TEXT CHECK (environment IN ('dev','prod'));

CREATE TABLE IF NOT EXISTS ai_turn_trace_spans (
  id UUID PRIMARY KEY,
  trace_id UUID NOT NULL REFERENCES ai_turn_traces(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES ai_turn_trace_spans(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','interrupted')),
  attributes JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ai_turn_trace_spans_trace ON ai_turn_trace_spans(trace_id,started_at,id);
ALTER TABLE ai_turn_trace_events ADD COLUMN IF NOT EXISTS span_id UUID REFERENCES ai_turn_trace_spans(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ai_trace_evaluations (
  id UUID PRIMARY KEY,
  trace_id UUID NOT NULL REFERENCES ai_turn_traces(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('dev','prod')),
  method TEXT NOT NULL CHECK (method IN ('deterministic','model')),
  version TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  report JSONB
);
CREATE INDEX IF NOT EXISTS ai_trace_evaluations_trace ON ai_trace_evaluations(trace_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ai_trace_evaluations_running ON ai_trace_evaluations(trace_id) WHERE status='running';
