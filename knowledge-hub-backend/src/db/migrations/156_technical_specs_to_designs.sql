-- Technical specs are retired: each free-standing spec becomes the Use case of a new Design.
-- Specs already used inside a Design are left untouched; the other tabs stay blank.
DO $$
DECLARE n RECORD; parent UUID;
BEGIN
  FOR n IN
    SELECT id, project_id, note_list_metadata(content)->>'title' AS title FROM notes
    WHERE status='active' AND note_list_metadata(content)->>'contentType'='spec'
      AND NOT EXISTS(SELECT 1 FROM design_assets a WHERE a.source_type='note' AND a.source_id=id::text)
      AND NOT EXISTS(SELECT 1 FROM use_cases u WHERE u.spec_note_id=notes.id)
      AND NOT EXISTS(SELECT 1 FROM designs d WHERE d.source_note_id=notes.id)
      AND NOT EXISTS(SELECT 1 FROM note_links l JOIN designs d ON d.source_note_id=l.source_note_id WHERE l.target_note_id=notes.id)
  LOOP
    INSERT INTO notes(content,project_id)
    VALUES(jsonb_build_object('title',COALESCE(n.title,'Untitled'),'contentType','design','contentJson','[]')::text,n.project_id)
    RETURNING id INTO parent;
    UPDATE designs SET source_note_id=n.id WHERE parent_note_id=parent;
    UPDATE notes SET content=(content::jsonb || '{"contentType":"use-case"}'::jsonb)::text WHERE id=n.id;
  END LOOP;
END $$;
