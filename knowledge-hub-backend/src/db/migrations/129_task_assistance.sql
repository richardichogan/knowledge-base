CREATE TABLE IF NOT EXISTS task_assistance (
  id uuid PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  task_signature text NOT NULL,
  task_snapshot jsonb NOT NULL,
  proposal jsonb NOT NULL,
  direction text NOT NULL DEFAULT '',
  approved_at timestamptz,
  result_note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_assistance_task_created ON task_assistance(task_id, created_at DESC);
