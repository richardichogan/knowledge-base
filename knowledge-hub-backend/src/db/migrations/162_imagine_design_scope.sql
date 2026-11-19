ALTER TABLE designs
  ADD COLUMN IF NOT EXISTS imagine_scope TEXT NOT NULL DEFAULT 'full-demo'
  CHECK (imagine_scope IN ('full-demo', 'workforce-definition'));
