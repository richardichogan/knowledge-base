CREATE TABLE IF NOT EXISTS ai_turn_traces (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  assistant_message_id BIGINT REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  project_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted')),
  capture_complete BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS ai_turn_traces_session_idx ON ai_turn_traces(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ai_turn_traces_expiry_idx ON ai_turn_traces(expires_at);

CREATE TABLE IF NOT EXISTS ai_turn_trace_events (
  trace_id UUID NOT NULL REFERENCES ai_turn_traces(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL,
  PRIMARY KEY (trace_id, sequence)
);
