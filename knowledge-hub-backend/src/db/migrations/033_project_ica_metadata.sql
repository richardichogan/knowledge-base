-- Migration 033: project type and ICA document collection metadata

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS project_type TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS has_ica_document_collection BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ica_document_collection_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ica_document_collection_id TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'projects_project_type_check'
      AND table_name = 'projects'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_project_type_check
      CHECK (project_type IN ('standard', 'formal-client'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_project_type
  ON projects (project_type);

CREATE INDEX IF NOT EXISTS idx_projects_ica_collection
  ON projects (has_ica_document_collection)
  WHERE has_ica_document_collection = TRUE;
