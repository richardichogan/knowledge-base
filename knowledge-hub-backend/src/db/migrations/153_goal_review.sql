-- Migration 153: monthly goal review. Runs on Mondays; only the first run in a calendar month proposes
-- adjustments (targets, deadlines, workstream links) for Richard to accept or dismiss. Nothing changes until accepted.
INSERT INTO managed_jobs(id, enabled, definition, next_at) VALUES
 ('a7000000-0000-4000-8000-00000000000d', TRUE,
  '{"name":"Monthly goal review","kind":"goal-review","prompt":"","schedule":{"timezone":"Europe/London","days":[1],"times":["09:30"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW())
ON CONFLICT DO NOTHING;
INSERT INTO managed_job_revisions(job_id, revision, definition)
 SELECT id, revision, definition FROM managed_jobs WHERE id = 'a7000000-0000-4000-8000-00000000000d' ON CONFLICT DO NOTHING;
