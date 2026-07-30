-- Migration 029: Repo → project-tag mappings for Today GitHub activity grouping

CREATE TABLE IF NOT EXISTS repo_project_mappings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_full_name TEXT NOT NULL UNIQUE,
  project_tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repo_mapping_tag
  ON repo_project_mappings(project_tag_id);
