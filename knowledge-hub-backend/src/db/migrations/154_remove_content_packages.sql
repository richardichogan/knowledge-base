-- Migration 154: remove the Content packages feature. It duplicated the Publishing jobs and the podcast campaign and
-- filled Think with generated notes. Deletes the job and its history, archives any remaining package notes, rejects
-- package drafts still awaiting approval (never anything approved, scheduled or delivered) and drops its state.
DELETE FROM managed_job_events WHERE job_id = 'a7000000-0000-4000-8000-00000000000b'
  OR run_id IN (SELECT id FROM managed_job_runs WHERE job_id = 'a7000000-0000-4000-8000-00000000000b');
DELETE FROM managed_job_runs WHERE job_id = 'a7000000-0000-4000-8000-00000000000b';
DELETE FROM managed_job_revisions WHERE job_id = 'a7000000-0000-4000-8000-00000000000b';
DELETE FROM managed_jobs WHERE id = 'a7000000-0000-4000-8000-00000000000b';

UPDATE notes SET status = 'archived', updated_at = NOW() WHERE 'content-package' = ANY(tags) AND status = 'active';

WITH topics AS (
  SELECT (p->>'topicId')::uuid AS id
  FROM sync_state s, jsonb_array_elements((s.last_cursor::jsonb)->'packages') p
  WHERE s.source = 'content-packages' AND COALESCE(p->>'topicId', '') <> ''
), open_topics AS (
  SELECT t.id FROM topics t
  WHERE NOT EXISTS (SELECT 1 FROM publishing_drafts d WHERE d.topic_id = t.id AND d.approval = 'approved')
    AND NOT EXISTS (SELECT 1 FROM publishing_deliveries x WHERE x.topic_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM publishing_schedule s JOIN publishing_drafts d ON d.id = s.draft_id WHERE d.topic_id = t.id)
), rejected AS (
  UPDATE publishing_drafts SET approval = 'rejected', held = TRUE, reason = 'Content packages feature removed.', updated_at = NOW()
  WHERE topic_id IN (SELECT id FROM open_topics) AND approval = 'pending' RETURNING topic_id
), closed AS (
  UPDATE publishing_topics SET state = 'rejected', error = 'Content packages feature removed.'
  WHERE id IN (SELECT id FROM open_topics) RETURNING id
)
INSERT INTO publishing_events(topic_id, actor, event, detail)
SELECT id, 'system', 'draft-topic-rejected', '{"reason":"Content packages feature removed.","sourceRetained":true}'::jsonb FROM closed;

DELETE FROM sync_state WHERE source = 'content-packages';
UPDATE sync_state SET last_cursor = (
  jsonb_set(last_cursor::jsonb, '{entries}', COALESCE((
    SELECT jsonb_agg(e) FROM jsonb_array_elements(last_cursor::jsonb->'entries') e WHERE e->>'type' <> 'content-package'), '[]'::jsonb))
  #- '{disabled,content-package}' #- '{reenabledAt,content-package}'
)::text
WHERE source = 'proactive-ledger' AND last_cursor IS NOT NULL;
