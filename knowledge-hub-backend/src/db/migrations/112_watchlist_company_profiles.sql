CREATE TABLE IF NOT EXISTS discover_watchlist_company_profiles (
  watchlist_id UUID NOT NULL REFERENCES discover_watchlists(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  search_context TEXT NOT NULL DEFAULT '',
  sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  researched_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  PRIMARY KEY (watchlist_id, entity_name)
);
