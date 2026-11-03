-- Permanent record of every model call, every user decision on AI work and every user edit of
-- AI-written content, so each agent can learn from its outcomes. Retained permanently by design.
CREATE TABLE IF NOT EXISTS ai_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  environment TEXT NOT NULL,
  agent TEXT NOT NULL,
  feature TEXT NOT NULL,
  persona TEXT,
  session_id TEXT,
  workflow_run_id UUID,
  stage TEXT,
  purpose TEXT,
  deployment TEXT NOT NULL,
  api TEXT NOT NULL,
  request JSONB,
  response JSONB,
  ok BOOLEAN NOT NULL,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_interactions_agent_at ON ai_interactions (agent, at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_interactions_workflow ON ai_interactions (workflow_run_id) WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_interactions_session ON ai_interactions (session_id, at DESC) WHERE session_id IS NOT NULL;

-- What an agent wrote, so a later user save can be compared against it.
CREATE TABLE IF NOT EXISTS ai_authored_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  environment TEXT NOT NULL,
  agent TEXT NOT NULL,
  workflow_run_id UUID,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_authored_target ON ai_authored_content (target_type, target_id, at DESC);

CREATE TABLE IF NOT EXISTS ai_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  environment TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user' CHECK (actor IN ('user', 'system')),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  workflow_run_id UUID,
  session_id TEXT,
  note TEXT,
  ai_content TEXT,
  final_content TEXT,
  diff TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  authored_id UUID REFERENCES ai_authored_content(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_agent_at ON ai_decisions (agent, at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_unreviewed ON ai_decisions (agent, updated_at) WHERE reviewed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_decisions_edit_once ON ai_decisions (authored_id) WHERE kind = 'edit';

-- Lessons learned for one agent are scoped to that agent and only reach its own prompts.
ALTER TABLE athena_memories DROP CONSTRAINT IF EXISTS athena_memories_scope_type_check;
ALTER TABLE athena_memories ADD CONSTRAINT athena_memories_scope_type_check
  CHECK (scope_type IN ('global', 'persona', 'project', 'output', 'agent'));
ALTER TABLE athena_memories DROP CONSTRAINT IF EXISTS athena_memories_origin_check;
ALTER TABLE athena_memories ADD CONSTRAINT athena_memories_origin_check
  CHECK (origin IN ('chat', 'feedback', 'weekly', 'manual', 'profile-import', 'agent-review'));
