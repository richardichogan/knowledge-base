-- Migration 149: Athena chooses the three unapproved publishing drafts most worth approving each morning.
INSERT INTO managed_jobs(id, enabled, definition, next_at) VALUES
 ('a7000000-0000-4000-8000-000000000006', TRUE,
  '{"name":"Today''s publishing picks","kind":"publishing-picks","prompt":"","schedule":{"timezone":"Europe/London","days":[0,1,2,3,4,5,6],"times":["08:30"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW())
ON CONFLICT DO NOTHING;
INSERT INTO managed_job_revisions(job_id, revision, definition)
 SELECT id, revision, definition FROM managed_jobs WHERE id = 'a7000000-0000-4000-8000-000000000006' ON CONFLICT DO NOTHING;
