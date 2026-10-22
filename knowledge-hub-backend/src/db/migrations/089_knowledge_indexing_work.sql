-- Durable semantic-indexing work for knowledge records (additive; the previous
-- application version ignores these tables). One row per canonical ref, so
-- repeated edits coalesce to the newest revision and a delete row doubles as
-- the tombstone that rejects a late stale index write.
CREATE TABLE IF NOT EXISTS knowledge_indexing_work (
  id               BIGSERIAL PRIMARY KEY,
  ref_kind         TEXT NOT NULL,
  ref_id           TEXT NOT NULL,
  operation        TEXT NOT NULL CHECK (operation IN ('index', 'delete')),
  revision         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'done', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token      TEXT,
  lease_expires_at TIMESTAMPTZ,
  error_code       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  UNIQUE (ref_kind, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_indexing_work_due
  ON knowledge_indexing_work (status, next_attempt_at);

-- Enqueue in the same transaction as the content write, so no edit or delete
-- is ever lost to a later semantic-provider outage or process crash.
CREATE OR REPLACE FUNCTION knowledge_enqueue_content_index() RETURNS trigger AS $$
BEGIN
  INSERT INTO knowledge_indexing_work (ref_kind, ref_id, operation, revision, status, next_attempt_at, updated_at)
  VALUES ('content_item', NEW.id::text, 'index',
          md5(concat_ws(chr(31), NEW.title, NEW.summary, NEW.body, NEW.project_context, array_to_string(NEW.tags, ','))),
          'pending', NOW(), NOW())
  ON CONFLICT (ref_kind, ref_id) DO UPDATE SET
    revision = EXCLUDED.revision, status = 'pending', attempts = 0, error_code = NULL, lease_token = NULL,
    lease_expires_at = NULL, next_attempt_at = EXCLUDED.next_attempt_at, updated_at = EXCLUDED.updated_at, completed_at = NULL
  WHERE knowledge_indexing_work.operation = 'index' AND knowledge_indexing_work.revision <> EXCLUDED.revision;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION knowledge_enqueue_content_delete() RETURNS trigger AS $$
BEGIN
  INSERT INTO knowledge_indexing_work (ref_kind, ref_id, operation, revision, status, next_attempt_at, updated_at)
  VALUES ('content_item', OLD.id::text, 'delete', 'deleted', 'pending', NOW(), NOW())
  ON CONFLICT (ref_kind, ref_id) DO UPDATE SET
    operation = 'delete', revision = 'deleted', status = 'pending', attempts = 0, error_code = NULL, lease_token = NULL,
    lease_expires_at = NULL, next_attempt_at = EXCLUDED.next_attempt_at, updated_at = EXCLUDED.updated_at, completed_at = NULL
  WHERE knowledge_indexing_work.operation <> 'delete';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_enqueue_content_index ON content_items;
CREATE TRIGGER trg_knowledge_enqueue_content_index
  AFTER INSERT OR UPDATE OF title, summary, body, project_context, tags ON content_items
  FOR EACH ROW EXECUTE FUNCTION knowledge_enqueue_content_index();

DROP TRIGGER IF EXISTS trg_knowledge_enqueue_content_delete ON content_items;
CREATE TRIGGER trg_knowledge_enqueue_content_delete
  AFTER DELETE ON content_items
  FOR EACH ROW EXECUTE FUNCTION knowledge_enqueue_content_delete();

-- Chunk hashes already pushed to the passage index, so unchanged passages are
-- never embedded again.
CREATE TABLE IF NOT EXISTS knowledge_indexed_passages (
  parent_id   TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  chunk_hash  TEXT NOT NULL,
  indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parent_id, ordinal)
);
