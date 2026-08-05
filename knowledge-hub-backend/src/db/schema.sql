-- Knowledge Hub — PostgreSQL schema
-- Run via: npm run migrate
-- All timestamps are stored as UTC ISO 8601 strings in timestamptz columns.

-- ── Content items (unified timeline + FTS index) ──────────────────────────────

CREATE TABLE IF NOT EXISTS content_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source           TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL DEFAULT '',
  body             TEXT NOT NULL DEFAULT '',
  published_at     TIMESTAMPTZ NOT NULL,
  indexed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  url              TEXT,
  project_context  TEXT NOT NULL DEFAULT 'personal',
  metadata         JSONB NOT NULL DEFAULT '{}',
  tags             TEXT[] NOT NULL DEFAULT '{}',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Full-text search vector — updated by trigger
  search_vector    TSVECTOR,
  UNIQUE (source, source_id)
);

-- FTS index
CREATE INDEX IF NOT EXISTS idx_content_items_search
  ON content_items USING GIN (search_vector);

-- Source + date index for timeline queries
CREATE INDEX IF NOT EXISTS idx_content_items_source_date
  ON content_items (source, published_at DESC);

-- Project context filter
CREATE INDEX IF NOT EXISTS idx_content_items_project_context
  ON content_items (project_context);

-- Trigger to keep search_vector current
CREATE OR REPLACE FUNCTION content_items_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.body, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_items_tsvector_trigger ON content_items;
CREATE TRIGGER content_items_tsvector_trigger
  BEFORE INSERT OR UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION content_items_search_vector_update();

-- ── Conversation sessions ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  summary_blob_path TEXT
);

-- ── Conversation messages ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_session
  ON conversation_messages (session_id, created_at ASC);

-- ── Write action proposals ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS write_action_proposals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  action_type      TEXT NOT NULL,
  description      TEXT NOT NULL,
  payload          JSONB NOT NULL,
  proposed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'confirmed', 'cancelled', 'executed', 'failed'))
);

-- ── Sync state (per source) ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sync_state (
  source           TEXT PRIMARY KEY,
  last_sync_at     TIMESTAMPTZ,
  last_cursor      TEXT,
  item_count       INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Notes (Change 002) ─────────────────────────────────────────────────────────
-- Ad hoc notes created natively in the app. Stored in PostgreSQL, not blob storage.
-- Immediately indexed for full-text search.

CREATE TABLE IF NOT EXISTS notes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tags             TEXT[] NOT NULL DEFAULT '{}',
  linked_items     UUID[] NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'archived')),
  -- FTS column
  search_vector    TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at
  ON notes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_search
  ON notes USING GIN (search_vector);

CREATE OR REPLACE FUNCTION notes_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', coalesce(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notes_tsvector_trigger ON notes;
CREATE TRIGGER notes_tsvector_trigger
  BEFORE INSERT OR UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_search_vector_update();

-- ── Images (Change 003) ────────────────────────────────────────────────────────
-- Captured screenshots / images. Blob URL stored here; file lives in kb-images container.
-- OCR text extracted via Azure AI Vision and stored for FTS.

CREATE TABLE IF NOT EXISTS kb_images (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blob_url         TEXT NOT NULL,
  ocr_text         TEXT NOT NULL DEFAULT '',
  vision_analysis  TEXT NOT NULL DEFAULT '',
  caption          TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tags             TEXT[] NOT NULL DEFAULT '{}',
  linked_items     UUID[] NOT NULL DEFAULT '{}',
  -- FTS on caption, vision_analysis, and OCR text
  search_vector    TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_kb_images_created_at
  ON kb_images (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_images_search
  ON kb_images USING GIN (search_vector);

CREATE OR REPLACE FUNCTION kb_images_search_vector_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.caption, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.vision_analysis, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.ocr_text, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kb_images_tsvector_trigger ON kb_images;
CREATE TRIGGER kb_images_tsvector_trigger
  BEFORE INSERT OR UPDATE ON kb_images
  FOR EACH ROW EXECUTE FUNCTION kb_images_search_vector_update();

-- ── Relationships (Change 005 — Tier 3, schema only) ──────────────────────────
-- Surfaces edges between content items for the future knowledge graph view.
-- No application code reads this in Tier 1 or Tier 2.

CREATE TABLE IF NOT EXISTS relationships (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id          UUID NOT NULL,
  from_type        TEXT NOT NULL CHECK (from_type IN ('content_item', 'note', 'image')),
  to_id            UUID NOT NULL,
  to_type          TEXT NOT NULL CHECK (to_type IN ('content_item', 'note', 'image')),
  relationship     TEXT NOT NULL,
  -- e.g. 'blog-to-commit', 'session-to-deliverable', 'podcast-to-show-notes',
  --      'thematically-related', 'note-to-blog-draft'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata         JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_relationships_from
  ON relationships (from_type, from_id);

CREATE INDEX IF NOT EXISTS idx_relationships_to
  ON relationships (to_type, to_id);

-- ── Projects (Change 006) ─────────────────────────────────────────────────────
-- Local project definitions. Purely local — never synced from GitLab/GitHub.
-- gitlabPaths and githubRepos are TEXT[] used to match timeline items to projects.

CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  colour           TEXT NOT NULL DEFAULT 'gray'
                   CHECK (colour IN ('blue','cyan','teal','purple','green','magenta','warm-gray','gray','red')),
  category         TEXT NOT NULL DEFAULT 'work'
                   CHECK (category IN ('work','personal','side-hustle')),
  priority         TEXT NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low','medium','high')),
  description      TEXT NOT NULL DEFAULT '',
  gitlab_paths     TEXT[] NOT NULL DEFAULT '{}',
  github_repos     TEXT[] NOT NULL DEFAULT '{}',
  links            JSONB NOT NULL DEFAULT '[]',
  tags             TEXT[] NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_category
  ON projects (category);

CREATE INDEX IF NOT EXISTS idx_projects_priority
  ON projects (priority);

-- ── Global tags (Change 007) ──────────────────────────────────────────────────
-- Canonical tag registry — grows automatically as tags are used anywhere in the
-- app (notes, projects). usage_count is incremented on each upsert so popular
-- tags float to the top of autocomplete lists.

CREATE TABLE IF NOT EXISTS global_tags (
  tag          TEXT PRIMARY KEY,
  usage_count  INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tasks (Change 008) ────────────────────────────────────────────────────────
-- User-managed tasks that can be pushed to Microsoft To Do or GitHub Issues.

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'backlog'
               CHECK (status IN ('backlog','in-progress','blocked','awaiting-feedback','completed')),
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  priority     TEXT NOT NULL DEFAULT 'normal'
               CHECK (priority IN ('low','normal','high','urgent')),
  due_date     DATE,
  external_url TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_priority   ON tasks (priority);

-- Add project_id to notes so a note can be associated with one project.
-- Nullable — existing notes have no project assignment.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'notes' AND column_name = 'project_id'
  ) THEN
    ALTER TABLE notes ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── CFP items (Change 010) ────────────────────────────────────────────────────
-- Stores Call for Papers speaking opportunities surfaced in the Discover feed.

CREATE TABLE IF NOT EXISTS cfp_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source           VARCHAR(50)  NOT NULL,
  conference_name  VARCHAR(500) NOT NULL,
  description      TEXT,
  tags             TEXT[]       DEFAULT '{}',
  event_uri        TEXT,
  cfp_uri          TEXT         NOT NULL,
  cfp_deadline     TIMESTAMPTZ  NOT NULL,
  event_start      TIMESTAMPTZ,
  event_end        TIMESTAMPTZ,
  location         VARCHAR(500),
  is_virtual       BOOLEAN      DEFAULT false,
  relevance_score  FLOAT,
  relevance_reason TEXT,
  workflow_state   VARCHAR(20)  NOT NULL DEFAULT 'to_review',
  discovered_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  scored_at        TIMESTAMPTZ,
  raw_payload      JSONB,

  CONSTRAINT cfp_items_unique_conference UNIQUE (conference_name, event_start)
);

CREATE INDEX IF NOT EXISTS idx_cfp_items_workflow   ON cfp_items (workflow_state);
CREATE INDEX IF NOT EXISTS idx_cfp_items_deadline   ON cfp_items (cfp_deadline);
CREATE INDEX IF NOT EXISTS idx_cfp_items_discovered ON cfp_items (discovered_at DESC);

-- ── Certification Practice Scores (Change 021) ───────────────────────────────

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'standard';

CREATE TABLE IF NOT EXISTS cert_practice_scores (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_code TEXT        NOT NULL,
  score     INT         NOT NULL,
  task_id   TEXT        REFERENCES tasks(id) ON DELETE SET NULL,
  notes     TEXT,
  taken_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cert_scores_code ON cert_practice_scores (cert_code);
CREATE INDEX IF NOT EXISTS idx_cert_scores_time ON cert_practice_scores (taken_at DESC);

