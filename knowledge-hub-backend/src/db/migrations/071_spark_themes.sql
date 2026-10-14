-- Migration 071: Spark themes lifecycle.
-- Clusters become living themes: they grow as related sparks arrive, carry a
-- status, and remember what they became (note, blog post, canvas, project).
-- Individual sparks can also record what they were used in.

ALTER TABLE spark_clusters ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE spark_clusters ADD COLUMN IF NOT EXISTS output_type TEXT;
ALTER TABLE spark_clusters ADD COLUMN IF NOT EXISTS output_ref TEXT;
ALTER TABLE spark_clusters ADD COLUMN IF NOT EXISTS output_title TEXT;
ALTER TABLE spark_clusters ADD COLUMN IF NOT EXISTS output_url TEXT;
ALTER TABLE spark_clusters ADD COLUMN IF NOT EXISTS developed_at TIMESTAMPTZ;
ALTER TABLE spark_clusters ADD COLUMN IF NOT EXISTS last_grown_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE spark_clusters ADD CONSTRAINT spark_clusters_status_check
    CHECK (status IN ('active', 'developed', 'dismissed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE spark_clusters SET status = 'dismissed' WHERE dismissed = true AND status = 'active';
UPDATE spark_clusters c SET spark_count = (SELECT COUNT(*) FROM sparks s WHERE s.cluster_id = c.id);
UPDATE spark_clusters SET last_grown_at = COALESCE(last_grown_at, updated_at, created_at);

ALTER TABLE sparks ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
ALTER TABLE sparks ADD COLUMN IF NOT EXISTS used_type TEXT;
ALTER TABLE sparks ADD COLUMN IF NOT EXISTS used_ref TEXT;
ALTER TABLE sparks ADD COLUMN IF NOT EXISTS used_title TEXT;

CREATE INDEX IF NOT EXISTS idx_spark_clusters_status ON spark_clusters(status);
