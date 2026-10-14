CREATE TABLE IF NOT EXISTS diagram_drilldowns (
  canvas_id UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  node_id UUID NOT NULL,
  child_canvas_id UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  PRIMARY KEY (canvas_id, node_id),
  UNIQUE (child_canvas_id),
  CHECK (canvas_id <> child_canvas_id)
);

-- Retain associations when a shape is deleted so undo/restore can reconnect it.
-- Child diagrams remain ordinary canvases and are never deleted with a shape.
