-- Migration 015: add target_url to task_links so linked items can be opened
ALTER TABLE task_links ADD COLUMN IF NOT EXISTS target_url TEXT NOT NULL DEFAULT '';
