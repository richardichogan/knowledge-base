-- Decision semantics (additive only: the previous app version keeps working against these columns/tables).
-- Historic chat_decisions rows keep NULL acceptance => "acceptance: unknown". Nothing here is backfilled.

-- Acceptance is only ever written after an explicit user confirmation (see services/semantic/decisionStore.ts).
ALTER TABLE chat_decisions ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE chat_decisions ADD COLUMN IF NOT EXISTS acceptance_origin TEXT
  CHECK (acceptance_origin IS NULL OR acceptance_origin = 'user_confirmed');
-- Explicit, user-set review date. NULL = no review date (not applicable), never a guess.
ALTER TABLE chat_decisions ADD COLUMN IF NOT EXISTS review_date DATE;

-- Typed relationships that have no existing link storage: task -> decision (implements),
-- decision -> decision (supersedes, with effective date) and decision -> source (supported_by).
-- belongs_to / recorded_in / risk affects are read from existing columns (chat session project,
-- chat_decisions.session_id, project_register_items.source_id/task_id), not copied here.
CREATE TABLE IF NOT EXISTS semantic_edges (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship   TEXT NOT NULL CHECK (relationship IN ('implements', 'supersedes', 'supported_by')),
  from_kind      TEXT NOT NULL,
  from_id        TEXT NOT NULL,
  to_kind        TEXT NOT NULL,
  to_id          TEXT NOT NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('explicit', 'user_confirmed', 'inferred')),
  effective_at   TIMESTAMPTZ,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (relationship, from_kind, from_id, to_kind, to_id)
);
CREATE INDEX IF NOT EXISTS idx_semantic_edges_to ON semantic_edges (relationship, to_kind, to_id);
CREATE INDEX IF NOT EXISTS idx_semantic_edges_from ON semantic_edges (relationship, from_kind, from_id);

-- Minimal rule evaluation state for optional monitoring (disabled by default). Holds refs, outcomes and
-- input revisions only; the live records stay the source of truth.
CREATE TABLE IF NOT EXISTS semantic_rule_state (
  rule_id             TEXT NOT NULL,
  rule_version        INT NOT NULL,
  entity_kind         TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  last_outcome        TEXT NOT NULL CHECK (last_outcome IN ('matched', 'not_matched', 'unknown')),
  last_known_outcome  TEXT CHECK (last_known_outcome IS NULL OR last_known_outcome IN ('matched', 'not_matched')),
  input_revision      TEXT NOT NULL,
  evaluated_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (rule_id, rule_version, entity_kind, entity_id)
);

CREATE TABLE IF NOT EXISTS semantic_notifications (
  idempotency_key  TEXT PRIMARY KEY,
  rule_id          TEXT NOT NULL,
  rule_version     INT NOT NULL,
  entity_kind      TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
