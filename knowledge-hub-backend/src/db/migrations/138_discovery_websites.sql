ALTER TABLE discovery_sources
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'feed'
    CHECK (source_kind IN ('feed', 'website')),
  ADD COLUMN IF NOT EXISTS last_warning TEXT;
