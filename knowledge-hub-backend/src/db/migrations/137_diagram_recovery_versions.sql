ALTER TABLE canvas_diagram_versions
  ADD COLUMN IF NOT EXISTS recovery BOOLEAN NOT NULL DEFAULT false;
