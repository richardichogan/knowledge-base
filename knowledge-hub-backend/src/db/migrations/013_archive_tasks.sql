-- Migration 013: Task archiving
-- Adds an archived flag to tasks.
-- Completed tasks older than 14 days are archived by a nightly job.
-- Archived tasks are excluded from the board GET query.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'archived'
  ) THEN
    ALTER TABLE tasks ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks (archived, status);
