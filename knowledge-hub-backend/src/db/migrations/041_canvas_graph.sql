-- 041_canvas_graph.sql
-- A canvas is a network of cards (notes, documents, meetings, chats, ideas)
-- joined by typed connections, not a tree.
--  * canvas_nodes.placed: true once the card has a saved position (x, y);
--    unplaced cards are auto-arranged in the app.
--  * canvas_edges.edge_type is the connection type (free text; presets in the app).
-- Converting the old tree links happens in 042 (kept separate so the running
-- app isn't affected until the new version is deployed).

ALTER TABLE canvas_nodes ADD COLUMN IF NOT EXISTS placed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE canvas_edges ALTER COLUMN edge_type SET DEFAULT 'related';
