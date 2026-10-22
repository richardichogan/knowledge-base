-- BAU monitoring of knowledge-orchestrated chat turns. Ids, counts and categories only:
-- no user or assistant text is ever stored here.
CREATE TABLE IF NOT EXISTS knowledge_turn_audit (
  id                    BIGSERIAL PRIMARY KEY,
  session_id            TEXT,
  assistant_message_id  TEXT,
  persona               TEXT NOT NULL DEFAULT 'general',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  retrieval_used        BOOLEAN NOT NULL DEFAULT FALSE,
  deterministic_path    BOOLEAN NOT NULL DEFAULT FALSE,
  found_count           INTEGER NOT NULL DEFAULT 0,
  read_count            INTEGER NOT NULL DEFAULT 0,
  cited_count           INTEGER NOT NULL DEFAULT 0,
  families_read         TEXT[] NOT NULL DEFAULT '{}',
  stripped_ids          INTEGER NOT NULL DEFAULT 0,
  unverified_quotes     INTEGER NOT NULL DEFAULT 0,
  repairs_used          INTEGER NOT NULL DEFAULT 0,
  abstained             BOOLEAN NOT NULL DEFAULT FALSE,
  budget_exhausted      TEXT[] NOT NULL DEFAULT '{}',
  partial               BOOLEAN NOT NULL DEFAULT FALSE,
  tool_error_count      INTEGER NOT NULL DEFAULT 0,
  unavailable_sources   TEXT[] NOT NULL DEFAULT '{}',
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  model_rounds          INTEGER NOT NULL DEFAULT 0,
  category              TEXT NOT NULL DEFAULT 'ok'
);

CREATE INDEX IF NOT EXISTS idx_knowledge_turn_audit_created_at ON knowledge_turn_audit (created_at);

CREATE TABLE IF NOT EXISTS knowledge_daily_review (
  review_date      DATE PRIMARY KEY,
  turns            INTEGER NOT NULL DEFAULT 0,
  category_counts  JSONB NOT NULL DEFAULT '{}'::jsonb,
  rates            JSONB NOT NULL DEFAULT '{}'::jsonb,
  worst_turns      JSONB NOT NULL DEFAULT '[]'::jsonb,
  flags            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
