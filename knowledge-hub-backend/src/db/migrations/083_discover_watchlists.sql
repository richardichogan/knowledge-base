-- Private comparisons deliberately never enter content_items or the public search index.
CREATE TABLE IF NOT EXISTS discover_watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  baseline_version INTEGER NOT NULL DEFAULT 1,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS discover_watchlist_baselines (
  watchlist_id UUID NOT NULL REFERENCES discover_watchlists(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  baseline JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (watchlist_id, version)
);
CREATE TABLE IF NOT EXISTS discover_watchlist_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id UUID NOT NULL REFERENCES discover_watchlists(id) ON DELETE CASCADE,
  baseline_version INTEGER NOT NULL,
  config JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  window_start TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','changes','no_meaningful_change','insufficient_coverage','failed')),
  summary TEXT NOT NULL DEFAULT '',
  coverage JSONB NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL DEFAULT '[]',
  FOREIGN KEY (watchlist_id, baseline_version) REFERENCES discover_watchlist_baselines(watchlist_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS discover_watchlist_one_running
  ON discover_watchlist_runs(watchlist_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS discover_watchlist_history ON discover_watchlist_runs(watchlist_id, started_at DESC);
CREATE TABLE IF NOT EXISTS discover_watchlist_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES discover_watchlist_runs(id) ON DELETE CASCADE,
  finding JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS discover_interest_weights (
  kind TEXT NOT NULL CHECK (kind IN ('topic','source')),
  term TEXT NOT NULL CHECK (length(term) BETWEEN 1 AND 128),
  weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, term)
);
