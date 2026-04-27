-- Migration 005: Hierarchical tag taxonomy
-- Adds: tags, note_tags, discover_item_tags tables
--       linked_tag_id on tasks
-- Two-level hierarchy only — children cannot be parents

-- ── Tags ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  parent_id  UUID REFERENCES tags(id) ON DELETE RESTRICT,
  colour     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent grandchildren: a tag with a parent_id cannot itself be a parent
CREATE OR REPLACE FUNCTION tags_no_grandchildren()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM tags WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Tag hierarchy is limited to two levels — cannot create a child of a child';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tags_no_grandchildren_trigger ON tags;
CREATE TRIGGER tags_no_grandchildren_trigger
  BEFORE INSERT OR UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION tags_no_grandchildren();

CREATE INDEX IF NOT EXISTS idx_tags_parent_id ON tags (parent_id);
CREATE INDEX IF NOT EXISTS idx_tags_slug      ON tags (slug);

-- ── note_tags junction ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS note_tags (
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  UUID NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags (tag_id);

-- ── discover_item_tags junction ────────────────────────────────────────────────
-- is_primary: exactly one primary tag per discover item (enforced by partial index)

CREATE TABLE IF NOT EXISTS discover_item_tags (
  discover_item_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  tag_id           UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  is_primary       BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (discover_item_id, tag_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discover_item_tags_primary
  ON discover_item_tags (discover_item_id) WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_discover_item_tags_tag_id ON discover_item_tags (tag_id);

-- ── linked_tag_id on tasks ────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'linked_tag_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN linked_tag_id UUID REFERENCES tags(id) ON DELETE SET NULL;
  END IF;
END $$;
