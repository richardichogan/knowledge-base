CREATE TABLE IF NOT EXISTS entity_manual_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  a_type TEXT NOT NULL CHECK (a_type IN ('note', 'diagram', 'task')),
  a_id TEXT NOT NULL,
  a_element TEXT NOT NULL DEFAULT '',
  b_type TEXT NOT NULL CHECK (b_type IN ('note', 'diagram', 'task')),
  b_id TEXT NOT NULL,
  b_element TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (a_element = '' OR a_type = 'diagram'),
  CHECK (b_element = '' OR b_type = 'diagram'),
  CHECK ((a_type, a_id, a_element) < (b_type, b_id, b_element)),
  UNIQUE (a_type, a_id, a_element, b_type, b_id, b_element)
);
CREATE INDEX IF NOT EXISTS entity_manual_links_a ON entity_manual_links (a_type, a_id);
CREATE INDEX IF NOT EXISTS entity_manual_links_b ON entity_manual_links (b_type, b_id);
