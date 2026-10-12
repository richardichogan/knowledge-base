-- Retain the existing task_type column (also present in the base schema).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'standard';
-- One successor per completed occurrence, even if it is reopened and completed again.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurring_parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_recurring_parent
  ON tasks(recurring_parent_id) WHERE recurring_parent_id IS NOT NULL;
