-- 048_task_links_chat.sql
-- Plan tasks can link to an Athena chat (e.g. the Demo Designer chat where a
-- use case was designed). target_id is the chat session id. Also adds the
-- "Use case" filing tag used for the use-case (demo) backlog.

ALTER TABLE task_links DROP CONSTRAINT IF EXISTS task_links_target_type_check;
ALTER TABLE task_links ADD CONSTRAINT task_links_target_type_check
  CHECK (target_type IN ('note', 'document', 'chat'));

INSERT INTO tags (name, slug, role, colour)
SELECT 'Use case', 'use-case', 'filing', '#33b1ff'
WHERE NOT EXISTS (SELECT 1 FROM tags WHERE slug = 'use-case');
