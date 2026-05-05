-- Migration 017: pending tag suggestions from AI backfill / per-item tagging
-- When the AI suggests a tag name that doesn't exist in the taxonomy, it lands
-- here for the user to accept, reject, or merge to an existing tag.

CREATE TABLE IF NOT EXISTS pending_tag_suggestions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suggested_name  TEXT NOT NULL,
  suggested_count INTEGER NOT NULL DEFAULT 1,
  example_content TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected', 'merged')),
  merged_to_id    UUID REFERENCES tags(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (suggested_name)
);

CREATE INDEX IF NOT EXISTS idx_pending_suggestions_status
  ON pending_tag_suggestions (status);
