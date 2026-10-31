CREATE TABLE IF NOT EXISTS deliverable_briefs (
  note_id UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  target_folder TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  produced_content_id UUID REFERENCES content_items(id) ON DELETE SET NULL,
  produced_url TEXT,
  produced_modified_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS deliverable_briefs_target
  ON deliverable_briefs (lower(target_folder || '/' || file_name))
  WHERE target_folder <> '' AND file_name <> '';

CREATE TABLE IF NOT EXISTS email_drafts (
  note_id UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  brief_id UUID REFERENCES deliverable_briefs(note_id) ON DELETE SET NULL,
  recipients_to TEXT NOT NULL DEFAULT '',
  recipients_cc TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  sent_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 0,
  CHECK ((status = 'draft' AND sent_at IS NULL) OR (status = 'sent' AND sent_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS deliverable_briefs_task ON deliverable_briefs(task_id);
CREATE INDEX IF NOT EXISTS email_drafts_task ON email_drafts(task_id);
