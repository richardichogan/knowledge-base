-- Review packets: an explicit, ordered selection of a project's notes, chat outputs
-- and chat decisions. Each item captures the source content and a version identity
-- at creation time so the packet is reproducible and later source changes are visible.
-- Approval is a recorded state only; it never publishes, posts or starts work.

CREATE TABLE IF NOT EXISTS review_packets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  approved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_packets_project ON review_packets (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS review_packet_items (
  packet_id           UUID NOT NULL REFERENCES review_packets(id) ON DELETE CASCADE,
  position            INT NOT NULL CHECK (position >= 0),
  source_type         TEXT NOT NULL CHECK (source_type IN ('note', 'output', 'decision')),
  source_id           TEXT NOT NULL,
  label               TEXT NOT NULL,
  captured_identity   TEXT NOT NULL,
  captured_content    TEXT NOT NULL,
  href                TEXT NOT NULL,
  checked             BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (packet_id, position),
  UNIQUE (packet_id, source_type, source_id)
);
