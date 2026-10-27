CREATE TABLE IF NOT EXISTS podcast_campaigns (
  note_id UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  links JSONB NOT NULL,
  plan JSONB,
  source_revision INTEGER,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'approved', 'paused')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
