-- Background chat tasks save note edits on the server. The version kept before
-- they run records what the task did (each edit applied or skipped, and why).
ALTER TABLE note_versions DROP CONSTRAINT IF EXISTS note_versions_reason_check;
ALTER TABLE note_versions ADD CONSTRAINT note_versions_reason_check
  CHECK (reason IN ('automatic', 'before_athena', 'before_restore', 'before_github', 'before_athena_task'));
ALTER TABLE note_versions ADD COLUMN IF NOT EXISTS audit JSONB;
