ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS origin_trace_id UUID;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS origin_message_id BIGINT
  REFERENCES ai_chat_messages(id) ON DELETE SET NULL;

WITH origins AS (
  SELECT j.id, MIN(t.assistant_message_id) AS message_id
  FROM agent_jobs j
  JOIN ai_turn_traces t ON t.session_id::text = j.conversation_id AND t.assistant_message_id IS NOT NULL
  JOIN ai_turn_trace_events e ON e.trace_id = t.id
  WHERE j.requested_by = 'chat' AND j.status IN ('queued', 'running')
    AND e.kind = 'tool.result' AND e.payload->>'name' = 'hand_off_to_specialist'
    AND strpos(e.payload->>'content', '"jobId":"' || j.id::text || '"') > 0
  GROUP BY j.id
  HAVING COUNT(DISTINCT t.assistant_message_id) = 1
)
UPDATE agent_jobs j SET origin_message_id = origins.message_id
FROM origins WHERE j.id = origins.id AND j.origin_message_id IS NULL;

CREATE INDEX IF NOT EXISTS agent_jobs_origin_trace_idx
  ON agent_jobs (origin_trace_id) WHERE origin_trace_id IS NOT NULL AND origin_message_id IS NULL;
