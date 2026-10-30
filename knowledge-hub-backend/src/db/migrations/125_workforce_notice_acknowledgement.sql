ALTER TABLE agent_assignment_events ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agent_assignment_events_unacknowledged_idx
  ON agent_assignment_events(assignment_id,assignment_revision) WHERE acknowledged_at IS NULL;
