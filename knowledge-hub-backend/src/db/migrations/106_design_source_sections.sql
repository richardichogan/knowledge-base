-- Correct the approved initial mapping without rewriting original note types or writing.
WITH corrected AS (
  INSERT INTO design_assets(design_id,source_type,source_id,role,excluded)
  SELECT id,'note',source_note_id::text,'spec',false
  FROM designs
  WHERE source_note_id IN (
    '881a842d-8ae1-4c60-a266-90147a3be866',
    'b028adff-5851-4203-915f-67f2ab889433',
    'c6648add-3d0e-4942-abf0-1c7d833009bf',
    '20cc6121-11f0-4b4a-84d6-8cbdebf1a9fc'
  )
  ON CONFLICT(design_id,source_type,source_id)
  DO UPDATE SET role='spec',excluded=false
  WHERE design_assets.role='use_case' AND NOT design_assets.excluded
  RETURNING design_id,source_id
)
UPDATE designs d
SET selections=CASE WHEN d.selections->>'use_case'=c.source_id
    THEN d.selections-'use_case' ELSE d.selections END,
  revision=d.revision+1,updated_at=NOW()
FROM corrected c WHERE d.id=c.design_id;
