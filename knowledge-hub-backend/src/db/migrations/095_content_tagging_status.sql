-- Records the outcome of auto-tagging each content item, so "nothing fitted"
-- can be told apart from a failed model call, and failures can be retried.
--   tagged   at least one tag applied
--   no_fit   the model looked and no existing tag fitted
--   failed   the model call or parsing failed (retried by the tagging sweep)
--   skipped  the item's policy does not tag it, or there was too little text
--   NULL     never attempted (picked up by the tagging sweep)
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS tagging_status text;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS tagging_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS tagging_attempted_at timestamptz;

-- GitHub docs are excluded: design docs are newly eligible for concept tags even if they
-- already carry a project tag; the sweep marks the rest skipped without a model call.
UPDATE content_items ci SET tagging_status = 'tagged'
 WHERE ci.tagging_status IS NULL
   AND ci.source <> 'github-doc'
   AND EXISTS (SELECT 1 FROM discover_item_tags dit WHERE dit.discover_item_id = ci.id);

CREATE INDEX IF NOT EXISTS idx_content_items_tagging_due
  ON content_items (indexed_at DESC)
  WHERE tagging_status IS NULL OR tagging_status = 'failed';
