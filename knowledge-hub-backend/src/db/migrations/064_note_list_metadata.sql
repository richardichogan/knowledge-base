-- Read legacy BlockNote arrays and wrapped writing without modifying stored content.
CREATE OR REPLACE FUNCTION note_list_metadata(saved TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  payload JSONB;
  note_title TEXT := 'Untitled';
  note_type TEXT := 'note';
BEGIN
  BEGIN
    payload := saved::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('title', note_title, 'contentType', note_type);
  END;
  IF jsonb_typeof(payload) = 'object' THEN
    IF jsonb_typeof(payload->'title') = 'string' AND payload->>'title' <> '' THEN
      note_title := payload->>'title';
    END IF;
    IF jsonb_typeof(payload->'contentType') = 'string' THEN note_type := payload->>'contentType'; END IF;
  END IF;
  RETURN jsonb_build_object('title', note_title, 'contentType', note_type);
END;
$$;
