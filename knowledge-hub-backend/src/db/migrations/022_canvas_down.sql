-- Migration 022: teardown canvas tables from initial canvas build
-- Drops canvases + canvas_edges, removes orphaned canvas nodes/edges/tags

DROP TABLE IF EXISTS canvas_edges CASCADE;
DROP TABLE IF EXISTS canvases CASCADE;

DELETE FROM nodes WHERE ref_type = 'canvas';
DELETE FROM edges WHERE edge_type = 'canvas_connection';
-- content_tags may not exist in all environments — skip gracefully via DO block
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'content_tags') THEN
    DELETE FROM content_tags WHERE content_type = 'canvas';
  END IF;
END $$;
-- canvas_tags junction table from initial build (may not exist)
DROP TABLE IF EXISTS canvas_tags;
