ALTER TABLE email_drafts
  ADD COLUMN IF NOT EXISTS task_generated BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS task_assistance_email_result
  ON task_assistance (result_note_id)
  WHERE result_note_id IS NOT NULL AND proposal->>'kind' = 'email';
