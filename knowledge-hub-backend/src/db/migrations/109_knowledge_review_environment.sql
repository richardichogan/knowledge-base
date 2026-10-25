-- Older daily snapshots mixed environments. Leave them unattributed rather than
-- claiming that historical local/test turns were production conversations.
ALTER TABLE knowledge_daily_review
  ADD COLUMN IF NOT EXISTS environment TEXT CHECK (environment IN ('prod', 'dev'));
