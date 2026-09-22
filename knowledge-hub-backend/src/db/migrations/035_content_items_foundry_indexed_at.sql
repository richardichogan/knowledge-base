-- Migration 035: track when each content_items row was last pushed into the
-- Foundry IQ (Azure AI Search) index, so a scheduled job can find and push
-- everything that isn't there yet (commits, PRs, issues, emails, calendar,
-- GitLab items, etc.) instead of only documents/notes indexed live on write.

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS foundry_indexed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_content_items_foundry_indexed_at
  ON content_items (foundry_indexed_at);
