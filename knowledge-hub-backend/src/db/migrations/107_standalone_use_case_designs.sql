-- Give the remaining reviewed standalone Use Cases parents without rewriting originals.
DO $$
DECLARE source RECORD; parent UUID;
BEGIN
  FOR source IN
    SELECT n.id,n.project_id,note_list_metadata(n.content)->>'title' AS title
    FROM notes n
    WHERE n.status='active'
      AND note_list_metadata(n.content)->>'contentType'='use-case'
      AND n.id IN (
        '73587e86-1345-4c39-a8cb-aef707c505ab',
        '88640a5a-2aa3-45af-88b0-04636a5eb313',
        'd8b72858-2b7a-4c46-8f1d-03097b7f3b2e',
        'db3b8b39-1a6c-403e-9f40-9ee27219966e'
      )
      AND NOT EXISTS(SELECT 1 FROM designs d WHERE d.source_note_id=n.id OR d.parent_note_id=n.id)
      AND NOT EXISTS(SELECT 1 FROM design_assets a WHERE a.source_type='note' AND a.source_id=n.id::text AND NOT a.excluded)
    ORDER BY n.id
    FOR UPDATE OF n
  LOOP
    INSERT INTO notes(content,project_id)
    VALUES(jsonb_build_object('title',source.title,'contentType','design','contentJson','[]')::text,source.project_id)
    RETURNING id INTO parent;
    UPDATE designs SET source_note_id=source.id WHERE parent_note_id=parent;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Design parent was not created for source %',source.id;
    END IF;
  END LOOP;
END $$;
