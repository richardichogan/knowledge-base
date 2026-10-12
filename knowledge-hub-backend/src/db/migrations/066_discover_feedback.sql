CREATE TABLE IF NOT EXISTS discover_feedback (
  request_id UUID PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('too-high','too-low','not-relevant','already-covered','incorrect-classification')),
  explanation TEXT NOT NULL DEFAULT '' CHECK (length(explanation) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS discover_feedback_item_created ON discover_feedback (item_id,created_at DESC);
