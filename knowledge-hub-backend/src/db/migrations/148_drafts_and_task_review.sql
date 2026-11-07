-- Migration 148: Slack/Teams message drafts share email_drafts, task-assistance emails move
-- into Plan > Drafts, and Athena reviews active tasks twice each weekday.
ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';
DO $$ BEGIN
  ALTER TABLE email_drafts ADD CONSTRAINT email_drafts_channel_check CHECK (channel IN ('email', 'slack', 'teams'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Task-assistance email results were saved as plain notes; give them draft properties (Copy, Mark sent).
INSERT INTO email_drafts(note_id, task_id, task_generated)
SELECT a.result_note_id, a.task_id, TRUE
FROM task_assistance a JOIN notes n ON n.id = a.result_note_id
WHERE a.proposal->>'kind' = 'email' AND n.status = 'active'
ON CONFLICT (note_id) DO NOTHING;

UPDATE notes n
SET content = jsonb_set(n.content::jsonb, '{contentType}', '"email-draft"')::text, revision = n.revision + 1
FROM task_assistance a
WHERE a.result_note_id = n.id AND a.proposal->>'kind' = 'email' AND n.status = 'active'
  AND note_list_metadata(n.content)->>'contentType' IS DISTINCT FROM 'email-draft';

CREATE INDEX IF NOT EXISTS task_assistance_owner_task_created
  ON task_assistance (task_id, owner_id, created_at DESC);

INSERT INTO managed_jobs(id, enabled, definition, next_at) VALUES
 ('a7000000-0000-4000-8000-000000000005', TRUE,
  '{"name":"Athena task review","kind":"task-review","prompt":"","schedule":{"timezone":"Europe/London","days":[1,2,3,4,5],"times":["10:00","14:00"]},"approval":"automatic","deviceId":"","inputFolder":"","outputFolder":"","outputs":[]}', NOW())
ON CONFLICT DO NOTHING;
INSERT INTO managed_job_revisions(job_id, revision, definition)
 SELECT id, revision, definition FROM managed_jobs WHERE id = 'a7000000-0000-4000-8000-000000000005' ON CONFLICT DO NOTHING;
