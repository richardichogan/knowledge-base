-- Migration 008: repo-to-tag mappings
-- Maps GitHub repos / GitLab paths to taxonomy tags.
-- Replaces the old "project" concept for the purpose of auto-tagging timeline items.

CREATE TABLE IF NOT EXISTS repo_tag_mappings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id       UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  github_repos TEXT[] NOT NULL DEFAULT '{}',
  gitlab_paths TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rtm_tag_id ON repo_tag_mappings(tag_id);
