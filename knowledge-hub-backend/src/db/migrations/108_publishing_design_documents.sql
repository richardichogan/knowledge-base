-- Repair the documents created during the publishing Design conversation; retain prior writing.
DO $$
DECLARE owner UUID;
BEGIN
  SELECT id INTO owner FROM designs WHERE parent_note_id='884b0fe6-d75c-4f56-b55e-53da6aa046e1';
  IF owner IS NULL THEN RETURN; END IF;
  IF (SELECT count(*) FROM notes WHERE id IN (
    'e33fd881-8d5b-42bd-b5f3-817cc8f00fe3','a827b50b-17e3-4f95-a960-079f06224f8f'
  ) AND status='active') <> 2 THEN
    RAISE EXCEPTION 'The saved publishing Use Case and Spec must both exist before repairing their Design';
  END IF;
  INSERT INTO design_assets(design_id,source_type,source_id,role,excluded)
  VALUES
    (owner,'note','e33fd881-8d5b-42bd-b5f3-817cc8f00fe3','use_case',false),
    (owner,'note','a827b50b-17e3-4f95-a960-079f06224f8f','spec',false),
    (owner,'note','88640a5a-2aa3-45af-88b0-04636a5eb313','reference',false),
    (owner,'note','0669398b-1306-4c43-9e4d-c71057d58843','reference',false)
  ON CONFLICT(design_id,source_type,source_id)
  DO UPDATE SET role=EXCLUDED.role,excluded=false;
  UPDATE designs SET selections=selections || jsonb_build_object(
    'use_case','e33fd881-8d5b-42bd-b5f3-817cc8f00fe3',
    'spec','a827b50b-17e3-4f95-a960-079f06224f8f'
  ),revision=revision+1,updated_at=NOW() WHERE id=owner;
END $$;
