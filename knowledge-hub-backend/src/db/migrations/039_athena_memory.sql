-- 039_athena_memory.sql
-- Athena's learned memory: standing instructions ("from now on, blog posts
-- include X"), approved example replies (👍), the user profile (moved here
-- from config/static-context.md so it's editable in the app), and feedback.
-- Additive only — safe on a live database.

CREATE TABLE IF NOT EXISTS athena_memories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              TEXT NOT NULL DEFAULT 'instruction'
                      CHECK (kind IN ('instruction', 'example', 'profile')),
  content           TEXT NOT NULL,
  -- Where it applies: everywhere, one persona, one project, or one kind of output.
  scope_type        TEXT NOT NULL DEFAULT 'global'
                      CHECK (scope_type IN ('global', 'persona', 'project', 'output')),
  scope_value       TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'suggested', 'dismissed')),
  origin            TEXT NOT NULL DEFAULT 'chat'
                      CHECK (origin IN ('chat', 'feedback', 'weekly', 'manual', 'profile-import')),
  source_session_id UUID,
  source_excerpt    TEXT,
  last_applied_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_athena_memories_status_scope
  ON athena_memories (status, kind, scope_type, scope_value);

CREATE TABLE IF NOT EXISTS athena_feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID,
  rating         TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  comment        TEXT,
  persona        TEXT,
  reply_excerpt  TEXT,
  memory_id      UUID REFERENCES athena_memories(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
