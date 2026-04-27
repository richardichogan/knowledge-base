-- Migration 007: document taxonomy tags
-- Stores user-assigned taxonomy tags for documents (keyed by repo::path id).

CREATE TABLE IF NOT EXISTS document_tags (
  doc_id     TEXT NOT NULL,
  tag_id     UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (doc_id, tag_id)
);
