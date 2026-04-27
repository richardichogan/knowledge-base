-- 009_task_tags.sql
-- Many-to-many join table for tasks ↔ taxonomy tags.

DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'tasks' AND column_name = 'id';

  IF col_type = 'uuid' THEN
    EXECUTE '
      CREATE TABLE IF NOT EXISTS task_tags (
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag_id  UUID NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
        PRIMARY KEY (task_id, tag_id)
      )';
  ELSE
    EXECUTE '
      CREATE TABLE IF NOT EXISTS task_tags (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag_id  UUID NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
        PRIMARY KEY (task_id, tag_id)
      )';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);

-- Migrate existing linked_tag_id into the new table
INSERT INTO task_tags (task_id, tag_id)
SELECT id, linked_tag_id FROM tasks WHERE linked_tag_id IS NOT NULL
ON CONFLICT DO NOTHING;
