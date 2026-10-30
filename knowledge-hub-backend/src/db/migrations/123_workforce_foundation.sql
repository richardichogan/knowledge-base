-- Additive storage only. No profile is enabled or historical work reclassified.
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS protocol_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS lease_owner UUID;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS agent_budget_profiles (
  id UUID PRIMARY KEY,
  workflow TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  policy_profile TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  limits JSONB NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  approved_by TEXT NOT NULL CHECK (length(approved_by) > 0),
  approved_at TIMESTAMPTZ NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (workflow, workflow_version, policy_profile, version)
);
CREATE OR REPLACE FUNCTION agent_budget_profile_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD)-'enabled') IS DISTINCT FROM (to_jsonb(NEW)-'enabled') THEN
    RAISE EXCEPTION 'Approved budget profiles are immutable; insert a new approved version';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_budget_profile_immutable ON agent_budget_profiles;
CREATE TRIGGER agent_budget_profile_immutable BEFORE UPDATE ON agent_budget_profiles
  FOR EACH ROW EXECUTE FUNCTION agent_budget_profile_immutable();

CREATE TABLE IF NOT EXISTS agent_assignments (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workflow TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  policy_profile TEXT NOT NULL,
  brief JSONB NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
  commission_signature TEXT NOT NULL,
  request_id TEXT NOT NULL,
  worker_pool TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','waiting','completed','failed','cancelled','superseded')),
  readiness TEXT NOT NULL DEFAULT 'pending' CHECK (readiness IN ('pending','ready','blocked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  budget_profile_id UUID NOT NULL REFERENCES agent_budget_profiles(id),
  deadline TIMESTAMPTZ NOT NULL,
  calls_reserved BIGINT NOT NULL DEFAULT 0 CHECK (calls_reserved >= 0),
  tokens_reserved BIGINT NOT NULL DEFAULT 0 CHECK (tokens_reserved >= 0),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE (owner_id, worker_pool, request_id),
  CHECK (status='completed' OR readiness<>'ready'),
  CHECK (status<>'completed' OR readiness<>'pending')
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_assignment_active_subject_idx
  ON agent_assignments(subject_type,subject_id) WHERE status IN ('queued','running','waiting');
CREATE INDEX IF NOT EXISTS agent_assignments_owner_idx ON agent_assignments(owner_id,created_at DESC);

ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS assignment_id UUID REFERENCES agent_assignments(id);
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS step_key TEXT;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS role_id TEXT;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS task_profile TEXT;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS prompt_version INTEGER;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS output_type TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_assignment_step_idx ON agent_jobs(assignment_id,step_key)
  WHERE assignment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_jobs_expired_lease_idx ON agent_jobs(worker_pool,lease_until)
  WHERE status='running';

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id UUID PRIMARY KEY,
  assignment_id UUID NOT NULL REFERENCES agent_assignments(id),
  producer_job_id UUID NOT NULL REFERENCES agent_jobs(id),
  producer_attempt INTEGER NOT NULL CHECK (producer_attempt > 0),
  artifact_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  content_signature TEXT NOT NULL,
  domain_reference JSONB NOT NULL CHECK (jsonb_typeof(domain_reference) = 'object'),
  source_versions JSONB NOT NULL CHECK (jsonb_typeof(source_versions) = 'array'),
  input_artifact_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(producer_job_id,producer_attempt,artifact_type,content_signature)
);
CREATE INDEX IF NOT EXISTS agent_artifacts_assignment_idx ON agent_artifacts(assignment_id,created_at);
CREATE OR REPLACE FUNCTION agent_artifact_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Workforce artifact references are immutable; append a new artifact';
END;
$$;
DROP TRIGGER IF EXISTS agent_artifact_immutable ON agent_artifacts;
CREATE TRIGGER agent_artifact_immutable BEFORE UPDATE ON agent_artifacts
  FOR EACH ROW EXECUTE FUNCTION agent_artifact_immutable();

CREATE TABLE IF NOT EXISTS agent_budget_reservations (
  id UUID PRIMARY KEY,
  assignment_id UUID NOT NULL REFERENCES agent_assignments(id),
  job_id UUID NOT NULL REFERENCES agent_jobs(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  operation_kind TEXT NOT NULL DEFAULT 'model' CHECK (operation_kind IN ('model','research')),
  tokens_reserved BIGINT NOT NULL CHECK (tokens_reserved >= 0),
  tokens_actual BIGINT CHECK (tokens_actual >= 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','known','unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((operation_kind='model' AND tokens_reserved>0) OR (operation_kind='research' AND tokens_reserved=0))
);
CREATE INDEX IF NOT EXISTS agent_budget_reservations_assignment_idx ON agent_budget_reservations(assignment_id);

CREATE TABLE IF NOT EXISTS agent_assignment_events (
  id UUID PRIMARY KEY,
  assignment_id UUID NOT NULL REFERENCES agent_assignments(id),
  assignment_revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  UNIQUE(assignment_id,assignment_revision,kind)
);
