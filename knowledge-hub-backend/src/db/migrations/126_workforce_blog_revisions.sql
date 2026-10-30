CREATE OR REPLACE FUNCTION workforce_blog_output_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.input ? 'workforceBlogOutput' AND EXISTS (
    SELECT 1 FROM jsonb_each(OLD.input->'workforceBlogOutput') AS accepted
      WHERE accepted.value IS DISTINCT FROM NEW.input->'workforceBlogOutput'->accepted.key
  ) THEN
    RAISE EXCEPTION 'Accepted workforce blog output revisions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workforce_blog_output_immutable ON agent_jobs;
CREATE TRIGGER workforce_blog_output_immutable BEFORE UPDATE ON agent_jobs
  FOR EACH ROW EXECUTE FUNCTION workforce_blog_output_immutable();
