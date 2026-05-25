-- Migration 024: Add partial unique index on url for discovered-article rows.
-- Required by the ON CONFLICT (url) WHERE ... clause in upsertContentItem.

-- First, deduplicate any existing discovered-article rows with the same URL,
-- keeping the most recently updated row.
DELETE FROM content_items
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY url
             ORDER BY updated_at DESC NULLS LAST, id DESC
           ) AS rn
    FROM content_items
    WHERE source = 'discovered-article'
      AND url IS NOT NULL
      AND url != ''
  ) ranked
  WHERE rn > 1
);

-- Now create the partial unique index that ON CONFLICT relies on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_items_discovered_url
  ON content_items (url)
  WHERE source = 'discovered-article'
    AND url IS NOT NULL
    AND url != '';
