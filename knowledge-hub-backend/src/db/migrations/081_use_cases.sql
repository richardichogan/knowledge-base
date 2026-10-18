-- 081_use_cases.sql
-- Use cases: one idea for one product, tracked from its sources (Discover items,
-- Sparks, notes, canvases) to a spec note in Think, a handoff (a spec file in a
-- GitHub repo, or an Athena Build spec) and the PRs that shipped it.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS use_cases (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary          TEXT        NOT NULL DEFAULT '' CHECK (char_length(summary) <= 4000),
  product_kind     TEXT        NOT NULL CHECK (product_kind IN ('imagine_demo', 'imagine_platform', 'product')),
  project_id       TEXT        REFERENCES projects(id) ON DELETE SET NULL,
  repo             TEXT        CHECK (repo IS NULL OR repo ~ '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'),
  stage            TEXT        NOT NULL DEFAULT 'candidate'
                   CHECK (stage IN ('candidate', 'refining', 'spec_ready', 'handed_off', 'shipped', 'dropped')),
  spec_note_id     UUID,
  build_spec_id    UUID,
  handoff_repo     TEXT,
  handoff_path     TEXT,
  handoff_url      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_use_cases_updated ON use_cases (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_use_cases_stage ON use_cases (stage);

CREATE TABLE IF NOT EXISTS use_case_sources (
  use_case_id UUID        NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
  source_type TEXT        NOT NULL CHECK (source_type IN ('discover', 'spark', 'note', 'canvas')),
  source_id   TEXT        NOT NULL,
  title       TEXT        NOT NULL DEFAULT '',
  url         TEXT,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (use_case_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_use_case_sources_source ON use_case_sources (source_type, source_id);

CREATE TABLE IF NOT EXISTS use_case_links (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  use_case_id UUID        NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL CHECK (url ~ '^https://'),
  title       TEXT        NOT NULL DEFAULT '',
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (use_case_id, url)
);
