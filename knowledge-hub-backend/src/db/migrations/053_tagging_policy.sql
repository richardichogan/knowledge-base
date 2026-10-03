-- 053_tagging_policy.sql
-- Auto-tagging, reworked.
--  * tags carry where they came from ('user' or 'auto'), so auto tags can be shown as such and a removed
--    auto tag is remembered (tag_rejections) and never re-applied to that item;
--  * auto_tag_state remembers what each note/task was last tagged from, so edits re-tag only when the
--    content really changed;
--  * suggestions count DISTINCT items (item_keys) instead of repeat tagging runs, and keep why one was
--    dismissed so a clean-up can be undone.

ALTER TABLE note_tags          ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE task_tags          ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE discover_item_tags ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';

CREATE TABLE IF NOT EXISTS tag_rejections (
  content_kind TEXT NOT NULL,
  content_id   TEXT NOT NULL,
  tag_id       UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (content_id, tag_id)
);

CREATE TABLE IF NOT EXISTS auto_tag_state (
  content_kind TEXT NOT NULL,
  content_id   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  tagged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (content_kind, content_id)
);

ALTER TABLE pending_tag_suggestions ADD COLUMN IF NOT EXISTS item_keys TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE pending_tag_suggestions ADD COLUMN IF NOT EXISTS evidence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_tag_suggestions ADD COLUMN IF NOT EXISTS dismissed_reason TEXT;
ALTER TABLE pending_tag_suggestions ADD COLUMN IF NOT EXISTS previous_status TEXT;
-- Suggestions made before this change: their count is the best evidence we have.
UPDATE pending_tag_suggestions SET evidence = suggested_count WHERE evidence = 0;
