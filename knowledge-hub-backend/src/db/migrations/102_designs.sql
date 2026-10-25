-- Parents link existing assets; no source content is copied or migrated.
CREATE TABLE IF NOT EXISTS designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL DEFAULT '' CHECK (char_length(summary) <= 4000),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source_use_case_id UUID UNIQUE REFERENCES use_cases(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'ready', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_designs_project ON designs(project_id);
CREATE TABLE IF NOT EXISTS design_assets (
  design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('note', 'canvas', 'usecase', 'link')),
  source_id TEXT NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 2048),
  role TEXT NOT NULL CHECK (role IN ('use_case', 'spec', 'architecture', 'diagram', 'reference')),
  excluded BOOLEAN NOT NULL DEFAULT false,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (design_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_design_assets_source ON design_assets(source_type, source_id);
