-- Migration 010: CFP (Call for Papers) items table
-- Stores speaking opportunity announcements surfaced in the Discover feed.

CREATE TABLE IF NOT EXISTS cfp_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source           VARCHAR(50)  NOT NULL,           -- 'callingallpapers' | 'adatosystems'
  conference_name  VARCHAR(500) NOT NULL,
  description      TEXT,
  tags             TEXT[]       DEFAULT '{}',
  event_uri        TEXT,                             -- conference website URL
  cfp_uri          TEXT         NOT NULL,            -- submission link
  cfp_deadline     TIMESTAMPTZ  NOT NULL,
  event_start      TIMESTAMPTZ,
  event_end        TIMESTAMPTZ,
  location         VARCHAR(500),
  is_virtual       BOOLEAN      DEFAULT false,
  relevance_score  FLOAT,                            -- 0.0–1.0, set by AI
  relevance_reason TEXT,                             -- one-sentence AI explanation
  workflow_state   VARCHAR(20)  NOT NULL DEFAULT 'to_review', -- to_review|saved|submitted|archived
  discovered_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  scored_at        TIMESTAMPTZ,
  raw_payload      JSONB,                            -- original API response for debugging

  CONSTRAINT cfp_items_unique_conference UNIQUE (conference_name, event_start)
);

CREATE INDEX IF NOT EXISTS idx_cfp_items_workflow   ON cfp_items (workflow_state);
CREATE INDEX IF NOT EXISTS idx_cfp_items_deadline   ON cfp_items (cfp_deadline);
CREATE INDEX IF NOT EXISTS idx_cfp_items_discovered ON cfp_items (discovered_at DESC);
