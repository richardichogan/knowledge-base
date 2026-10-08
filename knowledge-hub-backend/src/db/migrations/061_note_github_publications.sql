CREATE TABLE IF NOT EXISTS note_github_publications (
  note_id UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_sha TEXT,
  commit_url TEXT,
  synced_fingerprint TEXT,
  synced_revision INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced', 'conflict', 'error')),
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo, path)
);

ALTER TABLE note_versions DROP CONSTRAINT IF EXISTS note_versions_reason_check;
ALTER TABLE note_versions ADD CONSTRAINT note_versions_reason_check
  CHECK (reason IN ('automatic', 'before_athena', 'before_restore', 'before_github'));
