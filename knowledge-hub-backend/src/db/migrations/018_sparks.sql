-- Migration 018: Sparks and Spark Clusters
-- spark_clusters must exist before sparks due to the FK reference.

CREATE TABLE IF NOT EXISTS spark_clusters (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  theme       TEXT        NOT NULL,
  spark_count INTEGER     NOT NULL DEFAULT 0,
  surfaced    BOOLEAN     NOT NULL DEFAULT false,
  surfaced_at TIMESTAMPTZ,
  dismissed   BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sparks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   TEXT,
  source_type TEXT,
  body        TEXT        NOT NULL,
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  cluster_id  UUID        REFERENCES spark_clusters(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  CHECK (
    (source_id IS NULL AND source_type IS NULL) OR
    (source_id IS NOT NULL AND source_type IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_sparks_source  ON sparks(source_id, source_type);
CREATE INDEX IF NOT EXISTS idx_sparks_cluster ON sparks(cluster_id);
CREATE INDEX IF NOT EXISTS idx_sparks_created ON sparks(created_at DESC);
