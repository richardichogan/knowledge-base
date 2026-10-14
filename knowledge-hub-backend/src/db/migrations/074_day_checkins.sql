-- Migration 074: end-of-day check-in and slip tracking.
-- day_checkins records whether the day was wrapped up (or consciously skipped),
-- so the end-of-day banner shows at most once per day.
-- tasks.reschedule_count counts how often a task's due date was pushed later.

CREATE TABLE IF NOT EXISTS day_checkins (
  day        DATE PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('completed', 'skipped')),
  settled    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0;
