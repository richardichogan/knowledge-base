ALTER TABLE ai_chat_messages
  ADD COLUMN IF NOT EXISTS workforce_event_id UUID REFERENCES agent_assignment_events(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_messages_workforce_event_idx
  ON ai_chat_messages(workforce_event_id) WHERE workforce_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_assignment_events_pending_notice_idx
  ON agent_assignment_events(created_at, id) WHERE delivered_at IS NULL;
