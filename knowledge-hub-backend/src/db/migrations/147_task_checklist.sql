-- Migration 147: a task can carry a lightweight checklist (title + done tick).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
