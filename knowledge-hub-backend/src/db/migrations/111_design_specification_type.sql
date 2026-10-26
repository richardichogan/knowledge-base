ALTER TABLE designs ADD COLUMN IF NOT EXISTS specification_type TEXT
  CHECK (specification_type IN ('standard', 'imagine'));
