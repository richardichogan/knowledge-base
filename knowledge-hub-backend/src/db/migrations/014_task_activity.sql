-- Migration 014: Task activity log + linked items

-- ── Task activity log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task_id ON task_notes (task_id, created_at ASC);

-- ── Task linked items (notes / documents) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('note', 'document')),
  target_id    TEXT NOT NULL,
  target_title TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_task_links_task_id ON task_links (task_id);
