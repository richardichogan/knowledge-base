-- Connection-only snapshots. No content/search index or embedding is modified.
CREATE OR REPLACE VIEW connection_content_versions AS
SELECT id::text AS ref_id, 'note'::text AS ref_type,
       COALESCE((SELECT title FROM nodes WHERE ref_id = notes.id::text AND ref_type = 'note'), 'Untitled Note') AS title,
       tags, md5(jsonb_build_array(content, tags, linked_items)::text) AS content_version,
       updated_at AS changed_at
FROM notes WHERE status = 'active'
UNION ALL
SELECT id::text, 'task', title, tags,
       md5(jsonb_build_array(title, body, tags, project_id)::text), updated_at
FROM tasks
UNION ALL
SELECT id::text, 'spark', CASE WHEN length(body) > 80 THEN LEFT(body, 77) || '…' ELSE body END, tags,
       md5(jsonb_build_array(body, tags, source_id, source_type)::text), created_at
FROM sparks
UNION ALL
SELECT id::text,
       CASE WHEN source = 'discovered-article' THEN 'discover_item'
            WHEN source IN ('github-doc', 'github-content-store', 'user-upload', 'onedrive-document') THEN 'document'
            WHEN source IN ('github-commit', 'gitlab-commit') THEN 'commit'
            WHEN source IN ('github-pr', 'gitlab-mr') THEN 'pull_request'
            WHEN source IN ('github-issue', 'gitlab-issue') THEN 'issue'
            ELSE 'github_item' END,
       title, tags, md5(jsonb_build_array(title, summary, body, tags, project_context, url)::text), updated_at
FROM content_items
WHERE source IN ('discovered-article', 'github-doc', 'github-content-store', 'user-upload', 'onedrive-document',
                 'github-commit', 'gitlab-commit', 'github-pr', 'gitlab-mr', 'github-issue', 'gitlab-issue',
                 'github-action', 'github-release', 'github-deployment', 'github-pr-review')
UNION ALL
SELECT c.id::text, 'canvas', c.title, '{}'::text[],
       md5(jsonb_build_array(c.title, c.description,
         (SELECT jsonb_agg(jsonb_build_array(n.label, n.body, n.ref_type, n.ref_id, n.meta_tags) ORDER BY n.id)
          FROM canvas_nodes n WHERE n.canvas_id = c.id))::text), c.updated_at
FROM canvases c
UNION ALL
SELECT id::text, 'cfp_item', COALESCE(conference_name, 'Untitled CFP'), '{}'::text[],
       md5(jsonb_build_array(conference_name, description, tags)::text), discovered_at
FROM cfp_items;

CREATE TABLE IF NOT EXISTS connection_assessments (
  node_id UUID PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  content_version TEXT,
  assessed_at TIMESTAMPTZ,
  last_attempted_at TIMESTAMPTZ
);

-- Establish a baseline, not an AI backfill of unchanged historical content.
INSERT INTO connection_assessments (node_id, content_version, assessed_at)
SELECT n.id, v.content_version, now()
FROM nodes n
JOIN connection_content_versions v ON v.ref_id = n.ref_id AND v.ref_type = n.ref_type
ON CONFLICT (node_id) DO NOTHING;
