CREATE TABLE IF NOT EXISTS discover_parking (
  article_id UUID PRIMARY KEY REFERENCES content_items(id) ON DELETE CASCADE,
  newsletter BOOLEAN NOT NULL,
  podcast BOOLEAN NOT NULL,
  parked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (newsletter OR podcast)
);

CREATE INDEX IF NOT EXISTS discover_parking_saved_idx
  ON discover_parking (parked_at DESC, article_id ASC);
