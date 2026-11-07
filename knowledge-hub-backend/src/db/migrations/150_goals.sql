-- Migration 150: goal-driven Athena. Stale open decisions can be dropped in the Friday tidy-up, and Athena writes a
-- Monday brief (one move per goal) and a Friday scorecard on a schedule.
ALTER TABLE chat_decisions DROP CONSTRAINT IF EXISTS chat_decisions_status_check;
ALTER TABLE chat_decisions ADD CONSTRAINT chat_decisions_status_check CHECK (status IN ('decided', 'open', 'dropped'));

INSERT INTO managed_jobs(id, enabled, definition, next_at) VALUES
 ('a7000000-0000-4000-8000-000000000007', TRUE,
  '{"name":"Monday goal brief","kind":"goals-brief","prompt":"","schedule":{"timezone":"Europe/London","days":[1],"times":["08:45"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW()),
 ('a7000000-0000-4000-8000-000000000008', TRUE,
  '{"name":"Friday goal scorecard","kind":"goals-scorecard","prompt":"","schedule":{"timezone":"Europe/London","days":[5],"times":["16:00"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW())
ON CONFLICT DO NOTHING;
INSERT INTO managed_job_revisions(job_id, revision, definition)
 SELECT id, revision, definition FROM managed_jobs
  WHERE id IN ('a7000000-0000-4000-8000-000000000007', 'a7000000-0000-4000-8000-000000000008') ON CONFLICT DO NOTHING;
