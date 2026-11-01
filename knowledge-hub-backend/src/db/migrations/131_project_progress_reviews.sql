CREATE TABLE IF NOT EXISTS project_progress_reviews (
  id UUID PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (project_id, request_id)
);
CREATE INDEX IF NOT EXISTS project_progress_reviews_history
  ON project_progress_reviews(project_id, created_at DESC, id DESC);
