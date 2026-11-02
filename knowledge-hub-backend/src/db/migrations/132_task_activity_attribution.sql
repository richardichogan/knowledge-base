ALTER TABLE task_notes ADD COLUMN IF NOT EXISTS activity JSONB;
ALTER TABLE task_notes ADD CONSTRAINT task_notes_activity_object
  CHECK (activity IS NULL OR jsonb_typeof(activity) = 'object');
