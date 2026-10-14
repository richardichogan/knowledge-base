-- Migration 072: Plan triage.
-- Blocked and Awaiting feedback merge into a single Waiting status with a
-- free-text "waiting on" note; Athena-created tasks land in a new Inbox status.
-- updated_at is left alone so task health (idle/waiting age) is preserved.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_on TEXT;

-- Drop whichever CHECK currently constrains tasks.status (inline checks are auto-named).
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = 'tasks'::regclass AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

UPDATE tasks
   SET waiting_on = COALESCE(NULLIF(waiting_on, ''), CASE status WHEN 'blocked' THEN 'Blocked' ELSE 'Feedback' END),
       status = 'waiting'
 WHERE status IN ('blocked', 'awaiting-feedback');

ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('inbox', 'backlog', 'in-progress', 'waiting', 'completed'));
