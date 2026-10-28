ALTER TABLE canvases
  ADD COLUMN IF NOT EXISTS brainstorm_settings JSONB NOT NULL
  DEFAULT '{"grid":true,"snapToGrid":true,"snapToShapes":true,"gridSize":10}'::jsonb;
