CREATE TABLE IF NOT EXISTS publishing_feeds (
  id TEXT PRIMARY KEY CHECK(id IN ('bluesky','blog-linkedin')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  policy JSONB NOT NULL DEFAULT '{"timezone":"Europe/London","startHour":8,"endHour":20,"days":[0,1,2,3,4,5,6],"expiryHours":48,"guidance":""}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO publishing_feeds(id) VALUES('bluesky') ON CONFLICT DO NOTHING;
INSERT INTO publishing_feeds(id,policy) VALUES('blog-linkedin',
  '{"timezone":"Europe/London","startHour":8,"endHour":20,"days":[0,1,2,3,4,5,6],"expiryHours":168,"guidance":""}')
  ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS publishing_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  event_key UUID NOT NULL DEFAULT gen_random_uuid(),
  rationale TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','assessing','ready','held','rejected')),
  error TEXT,
  lease UUID,
  lease_until TIMESTAMPTZ,
  assessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS publishing_sources (
  item_id UUID PRIMARY KEY,
  topic_id UUID NOT NULL REFERENCES publishing_topics(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read_at TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS publishing_sources_url ON publishing_sources(url);
CREATE TABLE IF NOT EXISTS publishing_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id UUID NOT NULL REFERENCES publishing_topics(id),
  destination TEXT NOT NULL CHECK(destination IN ('blog','linkedin','bluesky')),
  variant TEXT NOT NULL DEFAULT 'source' CHECK(variant IN ('source','blog')),
  version INTEGER NOT NULL DEFAULT 1,
  content JSONB NOT NULL,
  review TEXT NOT NULL DEFAULT 'pending' CHECK(review IN ('pending','pass','revise','hold')),
  approval TEXT NOT NULL DEFAULT 'pending' CHECK(approval IN ('pending','approved','rejected')),
  held BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT NOT NULL DEFAULT '',
  distinct_argument BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_at TIMESTAMPTZ,
  reviewed_blog_version INTEGER,
  reviewed_feed_revision INTEGER,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(topic_id,destination)
);
CREATE TABLE IF NOT EXISTS publishing_versions (
  draft_id UUID NOT NULL REFERENCES publishing_drafts(id),
  version INTEGER NOT NULL,
  content JSONB NOT NULL,
  reviews JSONB NOT NULL DEFAULT '[]',
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  PRIMARY KEY(draft_id,version)
);
CREATE TABLE IF NOT EXISTS publishing_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity TEXT NOT NULL,
  destination TEXT NOT NULL CHECK(destination IN ('blog','linkedin','bluesky')),
  topic_id UUID REFERENCES publishing_topics(id),
  draft_id UUID REFERENCES publishing_drafts(id),
  version INTEGER,
  account TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending','sent','failed','unconfirmed')),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 1,
  receipt JSONB,
  error TEXT,
  UNIQUE(identity,destination)
);
CREATE INDEX IF NOT EXISTS publishing_deliveries_history ON publishing_deliveries(destination,account,attempted_at DESC);
CREATE INDEX IF NOT EXISTS publishing_topics_work ON publishing_topics(state,created_at);
CREATE INDEX IF NOT EXISTS publishing_topics_event ON publishing_topics(event_key);
CREATE TABLE IF NOT EXISTS publishing_events (
  id BIGSERIAL PRIMARY KEY,
  topic_id UUID REFERENCES publishing_topics(id),
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
