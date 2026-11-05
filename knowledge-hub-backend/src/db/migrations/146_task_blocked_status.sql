-- Migration 146: Blocked returns as its own Plan task status, separate from Waiting.
-- Existing Waiting tasks are left unchanged.

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

ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('inbox', 'backlog', 'in-progress', 'blocked', 'waiting', 'completed'));
