CREATE TABLE IF NOT EXISTS publishing_schedule (
  draft_id UUID PRIMARY KEY REFERENCES publishing_drafts(id),
  version INTEGER NOT NULL,
  scheduled_at TIMESTAMPTZ,
  reason TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(draft_id,version) REFERENCES publishing_versions(draft_id,version)
);
CREATE INDEX IF NOT EXISTS publishing_schedule_due ON publishing_schedule(scheduled_at)
  WHERE scheduled_at IS NOT NULL;
