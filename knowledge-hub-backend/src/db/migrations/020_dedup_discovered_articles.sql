-- Migration 020: Deduplicate discovered-article rows by URL
-- ──────────────────────────────────────────────────────────
-- The discovered-article ingest uses (source, source_id) as the upsert key.
-- However the CMS assigns a new source_id for every feed snapshot, so the
-- same article URL can appear multiple times with different source_ids.
--
-- Fix:
--   1. Delete duplicate rows, keeping the oldest (lowest created_at) per URL.
--   2. Add a partial unique index on url WHERE source='discovered-article'
--      so future ingests conflict on URL and update in place.

-- Step 1: Remove duplicate discovered-article rows, keeping the first-ingested.
DELETE FROM content_items
WHERE source = 'discovered-article'
  AND id NOT IN (
    SELECT DISTINCT ON (url) id
    FROM content_items
    WHERE source = 'discovered-article'
      AND url IS NOT NULL AND url != ''
    ORDER BY url, indexed_at ASC
  )
  AND url IS NOT NULL AND url != '';

-- Step 2: Add a partial unique index so future ingests conflict on URL.
CREATE UNIQUE INDEX IF NOT EXISTS content_items_discovered_url_unique
  ON content_items (url)
  WHERE source = 'discovered-article' AND url IS NOT NULL AND url != '';
