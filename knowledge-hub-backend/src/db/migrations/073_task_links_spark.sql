-- Migration 073: Plan tasks can link back to the Spark theme they came from.
ALTER TABLE task_links DROP CONSTRAINT IF EXISTS task_links_target_type_check;
ALTER TABLE task_links ADD CONSTRAINT task_links_target_type_check
  CHECK (target_type IN ('note', 'document', 'chat', 'spark'));
