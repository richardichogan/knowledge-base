UPDATE discover_watchlists AS w
SET config = jsonb_set(w.config, '{cadence}', '"weekly"'::jsonb),
    revision = w.revision + 1,
    updated_at = NOW(),
    next_run_at = CASE WHEN (w.config->>'paused')::boolean THEN w.next_run_at ELSE
      GREATEST(w.next_run_at, COALESCE((
        SELECT MAX(r.started_at) FROM discover_watchlist_runs AS r
        WHERE r.watchlist_id = w.id
      ) + INTERVAL '7 days', NOW())) END
WHERE w.config->>'cadence' = 'daily';
