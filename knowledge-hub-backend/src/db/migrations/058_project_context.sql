-- Persistent context metadata for projects. Existing project rows remain valid
-- with empty context fields and active/normal defaults.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS goal TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ownership TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS target_end_date DATE,
  ADD COLUMN IF NOT EXISTS importance TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS expected_outputs TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'projects_lifecycle_state_check'
      AND table_name = 'projects'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_lifecycle_state_check
      CHECK (lifecycle_state IN ('active','paused','completed','archived'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'projects_importance_check'
      AND table_name = 'projects'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_importance_check
      CHECK (importance IN ('critical','high','normal','low'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'projects_date_range_check'
      AND table_name = 'projects'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_date_range_check
      CHECK (target_end_date IS NULL OR start_date IS NULL OR target_end_date >= start_date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_lifecycle_state
  ON projects (lifecycle_state);
