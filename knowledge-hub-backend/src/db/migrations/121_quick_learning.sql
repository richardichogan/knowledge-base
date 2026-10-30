CREATE TABLE IF NOT EXISTS learning_questions (
  id UUID PRIMARY KEY,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','held')),
  hold_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS learning_sessions (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','ready','failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS learning_sessions_owner ON learning_sessions(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_items (
  session_id UUID NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 4),
  question_id UUID NOT NULL REFERENCES learning_questions(id),
  chosen INTEGER CHECK (chosen BETWEEN 0 AND 3),
  answered_at TIMESTAMPTZ,
  skipped BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (session_id, position),
  UNIQUE (session_id, question_id)
);

CREATE TABLE IF NOT EXISTS learning_messages (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  position INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  evidence JSONB NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (session_id, position) REFERENCES learning_items(session_id, position) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS learning_reports (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  position INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (session_id, position) REFERENCES learning_items(session_id, position) ON DELETE CASCADE
);
