ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_type_check;

UPDATE projects
SET project_type = 'project', updated_at = NOW()
WHERE project_type IN ('standard', 'formal-client');

ALTER TABLE projects ALTER COLUMN project_type SET DEFAULT 'project';
ALTER TABLE projects ADD CONSTRAINT projects_project_type_check
  CHECK (project_type IN ('project', 'bau', 'aspiration', 'exploration', 'side-project'));
