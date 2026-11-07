-- Completing a task archives the unsent drafts Athena generated for it, whichever path completes the task.
CREATE OR REPLACE FUNCTION archive_generated_drafts_on_task_complete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE notes n SET status = 'archived', updated_at = NOW()
    FROM email_drafts e
   WHERE e.note_id = n.id AND e.task_id = NEW.id AND e.task_generated AND e.status = 'draft' AND n.status = 'active';
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS archive_generated_drafts_on_task_complete ON tasks;
CREATE TRIGGER archive_generated_drafts_on_task_complete AFTER UPDATE OF status ON tasks
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION archive_generated_drafts_on_task_complete();

-- Clear drafts left behind by tasks completed before this trigger existed.
UPDATE notes n SET status = 'archived', updated_at = NOW()
  FROM email_drafts e JOIN tasks t ON t.id = e.task_id
 WHERE e.note_id = n.id AND t.status = 'completed' AND e.task_generated AND e.status = 'draft' AND n.status = 'active';
