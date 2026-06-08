-- 026_canvas_node_metadata.sql
-- Add url and meta_tags columns to canvas_nodes for richer paste-in cards.
-- meta_tags stores a JSON array of tag label strings, e.g. '["AI","Cloud"]'

ALTER TABLE canvas_nodes
  ADD COLUMN IF NOT EXISTS url       TEXT,
  ADD COLUMN IF NOT EXISTS meta_tags TEXT;
