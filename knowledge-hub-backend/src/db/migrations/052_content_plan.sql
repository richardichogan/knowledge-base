-- 052_content_plan.sql
-- Publishing rhythm and the daily content pick.
--  * content_schedule: the next podcast recording and newsletter due date. Each rolls forward
--    by interval_days once it passes; the dates are movable ("newsletter's moved to Monday").
--  * content_picks: the single topic suggested in the morning briefing, with its status, so a
--    pick stays until he acts on it or drops it and a dropped one is never suggested again.

CREATE TABLE IF NOT EXISTS content_schedule (
  format        TEXT PRIMARY KEY CHECK (format IN ('podcast', 'newsletter')),
  next_date     DATE NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 14,
  note          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO content_schedule (format, next_date, interval_days, note) VALUES
  ('podcast', '2026-10-05', 14, 'Recorded Mondays at the moment; alternates weeks with the newsletter'),
  ('newsletter', '2026-10-09', 14, 'Due Friday 9 or Monday 12 Oct depending on workload')
ON CONFLICT (format) DO NOTHING;

CREATE TABLE IF NOT EXISTS content_picks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  format      TEXT NOT NULL CHECK (format IN ('blog', 'linkedin', 'newsletter', 'podcast')),
  worth       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped', 'replaced')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_picks_status ON content_picks (status, created_at DESC);
