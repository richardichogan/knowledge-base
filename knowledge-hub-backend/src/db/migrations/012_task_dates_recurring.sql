-- Migration 012: Task start/end dates + recurring cadence
-- Replaces the single due_date with start_date + end_date,
-- and adds recurring_cadence for repeating tasks.

DO $$
BEGIN
  -- recurring_cadence
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'recurring_cadence'
  ) THEN
    ALTER TABLE tasks
      ADD COLUMN recurring_cadence TEXT
        CHECK (recurring_cadence IN ('daily', 'weekly', 'fortnightly', 'monthly'));
  END IF;

  -- start_date
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'start_date'
  ) THEN
    ALTER TABLE tasks ADD COLUMN start_date DATE;
    -- Migrate existing due_date → start_date
    UPDATE tasks SET start_date = due_date WHERE due_date IS NOT NULL;
  END IF;

  -- end_date
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'end_date'
  ) THEN
    ALTER TABLE tasks ADD COLUMN end_date DATE;
  END IF;
END $$;
