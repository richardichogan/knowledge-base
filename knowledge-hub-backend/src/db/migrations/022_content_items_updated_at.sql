-- Migration 022: add updated_at column to content_items
ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
