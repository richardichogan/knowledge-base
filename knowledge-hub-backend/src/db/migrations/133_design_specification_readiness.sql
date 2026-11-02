CREATE TABLE IF NOT EXISTS design_readiness_assessments (
  id UUID PRIMARY KEY,
  design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  report JSONB NOT NULL,
  snapshots JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS design_readiness_latest
  ON design_readiness_assessments(design_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS design_readiness_repairs (
  id UUID PRIMARY KEY,
  design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  assessment_id UUID NOT NULL REFERENCES design_readiness_assessments(id),
  proposal JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','discarded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS design_readiness_one_pending_repair
  ON design_readiness_repairs(design_id) WHERE status='pending';
