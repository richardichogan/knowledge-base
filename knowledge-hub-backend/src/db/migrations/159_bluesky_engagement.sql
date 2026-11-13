-- Append-only engagement snapshots for sent Bluesky posts, captured daily from the public API.
CREATE TABLE IF NOT EXISTS content_performance (
  id BIGSERIAL PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES publishing_deliveries(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('bluesky')),
  external_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('dev', 'prod')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metrics JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS content_performance_delivery_idx ON content_performance(delivery_id, captured_at DESC);
