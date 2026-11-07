-- Migration 151: proactive Athena, phases 2 and 3. Deal-desk briefs keep an undoable change log; meeting prep,
-- content packages and the CFP shortlist run on weekday schedules. Nothing is sent by any of these jobs.
CREATE TABLE IF NOT EXISTS deal_desk_updates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       TEXT NOT NULL,
  note_id          UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  trigger          TEXT NOT NULL,
  summary          TEXT NOT NULL,
  changes          JSONB NOT NULL DEFAULT '[]',
  previous_writing JSONB NOT NULL,
  revision_after   INTEGER NOT NULL,
  draft_id         UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deal_desk_updates_project ON deal_desk_updates (project_id, created_at DESC);

INSERT INTO managed_jobs(id, enabled, definition, next_at) VALUES
 ('a7000000-0000-4000-8000-000000000009', TRUE,
  '{"name":"Deal desk briefs","kind":"deal-desk","prompt":"","schedule":{"timezone":"Europe/London","days":[1,2,3,4,5],"times":["10:30"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW()),
 ('a7000000-0000-4000-8000-00000000000a', TRUE,
  '{"name":"Meeting prep and promises","kind":"meeting-prep","prompt":"","schedule":{"timezone":"Europe/London","days":[1,2,3,4,5],"times":["09:40","13:00"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW()),
 ('a7000000-0000-4000-8000-00000000000b', TRUE,
  '{"name":"Content packages","kind":"content-packages","prompt":"","schedule":{"timezone":"Europe/London","days":[1,2,3,4,5],"times":["11:00"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW()),
 ('a7000000-0000-4000-8000-00000000000c', TRUE,
  '{"name":"CFP shortlist","kind":"cfp-shortlist","prompt":"","schedule":{"timezone":"Europe/London","days":[1,2,3,4,5],"times":["09:15"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW())
ON CONFLICT DO NOTHING;
INSERT INTO managed_job_revisions(job_id, revision, definition)
 SELECT id, revision, definition FROM managed_jobs
  WHERE id IN ('a7000000-0000-4000-8000-000000000009', 'a7000000-0000-4000-8000-00000000000a',
               'a7000000-0000-4000-8000-00000000000b', 'a7000000-0000-4000-8000-00000000000c') ON CONFLICT DO NOTHING;
