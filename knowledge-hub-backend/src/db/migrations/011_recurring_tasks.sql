-- Migration 011: Recurring tasks
-- Adds a recurring_cadence column to tasks.
-- When a recurring task is completed, the backend automatically creates
-- the next instance (same title/body/project/priority/tags) with a new due date.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'recurring_cadence'
  ) THEN
    ALTER TABLE tasks
      ADD COLUMN recurring_cadence TEXT
        CHECK (recurring_cadence IN ('daily', 'weekly', 'fortnightly', 'monthly'));
  END IF;
END $$;
