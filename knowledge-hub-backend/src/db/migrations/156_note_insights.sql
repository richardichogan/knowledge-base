-- Moment-of-work note insights: one cached background check per saved note version.
CREATE TABLE IF NOT EXISTS note_insights (
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  dismissed TEXT[] NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (note_id, signature)
);
