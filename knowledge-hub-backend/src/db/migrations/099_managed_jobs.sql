CREATE TABLE IF NOT EXISTS managed_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  revision INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  definition JSONB NOT NULL,
  next_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS managed_job_revisions (
  job_id UUID NOT NULL REFERENCES managed_jobs(id),
  revision INTEGER NOT NULL,
  definition JSONB NOT NULL,
  PRIMARY KEY(job_id, revision)
);
CREATE TABLE IF NOT EXISTS managed_job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES managed_jobs(id),
  revision INTEGER NOT NULL,
  definition JSONB NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  occurrence_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  preview BOOLEAN NOT NULL DEFAULT FALSE,
  steps JSONB NOT NULL DEFAULT '[]',
  artifacts JSONB NOT NULL DEFAULT '{}',
  approved_at TIMESTAMPTZ,
  lease UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, occurrence_key)
);
CREATE INDEX IF NOT EXISTS managed_job_due ON managed_jobs(next_at) WHERE enabled AND NOT archived;
CREATE INDEX IF NOT EXISTS managed_job_run_queue ON managed_job_runs(status, created_at);
CREATE TABLE IF NOT EXISTS managed_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID REFERENCES managed_jobs(id),
  run_id UUID REFERENCES managed_job_runs(id),
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS managed_job_event_history ON managed_job_events(job_id, id DESC);
CREATE TABLE IF NOT EXISTS managed_job_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folders JSONB NOT NULL,
  managed_import BOOLEAN NOT NULL DEFAULT FALSE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS managed_job_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO managed_jobs(id, enabled, definition, next_at) VALUES
 ('a7000000-0000-4000-8000-000000000001', TRUE,
  '{"name":"Content sync","kind":"content-sync","prompt":"","schedule":{"timezone":"Europe/London","days":[0,1,2,3,4,5,6],"times":["06:00","13:00"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW()),
 ('a7000000-0000-4000-8000-000000000002', TRUE,
  '{"name":"Weekly Microsoft updates","kind":"weekly-microsoft","prompt":"","schedule":{"timezone":"Europe/London","days":[1],"times":["08:00"]},"approval":"required","deviceId":"","inputFolder":"","outputFolder":"","outputs":["think","slack","blog","bluesky","linkedin"]}', NOW()),
 ('a7000000-0000-4000-8000-000000000003', FALSE,
  '{"name":"M365 Daily Insights","kind":"m365-import","prompt":"","schedule":{"timezone":"Europe/London","days":[1,2,3,4,5],"times":["09:00"]},"approval":"required","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NULL)
ON CONFLICT DO NOTHING;
INSERT INTO managed_job_revisions(job_id, revision, definition)
 SELECT id, revision, definition FROM managed_jobs ON CONFLICT DO NOTHING;
