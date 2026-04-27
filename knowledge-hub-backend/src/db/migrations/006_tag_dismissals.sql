-- Migration 006: tag suggestion dismissals
-- Stores permanently dismissed pending tag suggestions so they never reappear.

CREATE TABLE IF NOT EXISTS tag_suggestion_dismissals (
  suggestion   TEXT PRIMARY KEY,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
