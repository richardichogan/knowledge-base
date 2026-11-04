-- Imagine is a single project: the original 'imagine' project becomes the offering
-- and the separate 'imagine-offering' record created in 141 is removed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id = 'imagine') THEN
    RETURN;
  END IF;

  DELETE FROM project_offering_links WHERE project_id = 'imagine';

  UPDATE projects SET name = 'Imagine', project_type = 'offering', updated_at = NOW()
  WHERE id = 'imagine';
  UPDATE tags SET name = 'Imagine', updated_at = NOW() WHERE project_id = 'imagine';

  IF EXISTS (SELECT 1 FROM projects WHERE id = 'imagine-offering') THEN
    UPDATE project_offering_links SET offering_id = 'imagine' WHERE offering_id = 'imagine-offering';
    DELETE FROM project_offering_links WHERE project_id = 'imagine-offering';
    DELETE FROM tags WHERE project_id = 'imagine-offering' AND slug = 'imagine-offering';
    DELETE FROM projects WHERE id = 'imagine-offering';
  END IF;
END $$;
