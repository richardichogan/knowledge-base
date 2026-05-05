-- Migration 016: tag role column
-- Distinguishes filing tags (EP001, IBM Projects, etc.) from concept tags
-- that describe subject matter (Azure, AI, Security etc.).

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'concept'
  CHECK (role IN ('filing', 'concept'));

CREATE INDEX IF NOT EXISTS idx_tags_role ON tags(role);

-- ── Mark known filing tags ────────────────────────────────────────────────────

UPDATE tags SET role = 'filing'
WHERE name IN (
  'Eminence', 'Blog Site', 'Newsletter', 'Podcast',
  'Vibe Coding YouTube',
  'IBM Projects', 'AI FinOps', 'AI Security and Governance',
  'AI Well Architected Framework', 'ATOM', 'IBM Advantage',
  'Imagine', 'MSFT Dashboard',
  'Nelfin', 'Personal', 'Projects', 'Knowledge Hub'
);

-- ── Rename "Projects" → "Independent Ventures" ───────────────────────────────

UPDATE tags
  SET name = 'Independent Ventures',
      slug = 'independent-ventures'
WHERE name = 'Projects';

-- ── Move "Knowledge Hub" under "Independent Ventures" ────────────────────────

UPDATE tags
SET parent_id = (SELECT id FROM tags WHERE name = 'Independent Ventures')
WHERE name = 'Knowledge Hub';

-- ── Add ModelAIr under "Independent Ventures" ────────────────────────────────

INSERT INTO tags (name, slug, role, parent_id, colour)
SELECT
  'ModelAIr',
  'modelair',
  'filing',
  (SELECT id FROM tags WHERE name = 'Independent Ventures'),
  '#be95ff'
WHERE NOT EXISTS (SELECT 1 FROM tags WHERE slug = 'modelair');
