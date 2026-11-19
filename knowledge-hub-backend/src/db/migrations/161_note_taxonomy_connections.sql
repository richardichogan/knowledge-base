-- Historical migrations retain their original column definitions. Live note
-- snapshots now use saved taxonomy membership, never the retired free-text field.
CREATE OR REPLACE VIEW connection_content_versions AS
SELECT n.id::text AS ref_id, 'note'::text AS ref_type,
       COALESCE((SELECT title FROM nodes WHERE ref_id = n.id::text AND ref_type = 'note'), 'Untitled Note') AS title,
       filing.names AS tags,
       md5(jsonb_build_array(n.content, filing.ids, filing.names, n.linked_items)::text) AS content_version,
       n.updated_at AS changed_at
FROM notes n
CROSS JOIN LATERAL (
  SELECT COALESCE(array_agg(t.name ORDER BY t.id), '{}'::text[]) AS names,
         COALESCE(array_agg(t.id ORDER BY t.id), '{}'::uuid[]) AS ids
  FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id
) filing
WHERE n.status = 'active'
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

-- Remove retired values from the existing note mirrors as well as future writes.
WITH filing AS (
  SELECT n.id,
         COALESCE(array_agg(t.name ORDER BY t.name, t.id) FILTER (WHERE t.id IS NOT NULL), '{}'::text[]) AS names,
         COALESCE(array_agg(t.id ORDER BY t.name, t.id) FILTER (WHERE t.id IS NOT NULL), '{}'::uuid[]) AS ids
  FROM notes n LEFT JOIN note_tags nt ON nt.note_id = n.id LEFT JOIN tags t ON t.id = nt.tag_id
  GROUP BY n.id
)
UPDATE content_items ci
SET tags = filing.names,
    metadata = (ci.metadata - 'tags') || jsonb_build_object('taxonomyTagIds', filing.ids)
FROM filing
WHERE ci.source = 'note' AND ci.source_id = filing.id::text
  AND (ci.tags IS DISTINCT FROM filing.names
    OR ci.metadata IS DISTINCT FROM (ci.metadata - 'tags') || jsonb_build_object('taxonomyTagIds', filing.ids));

UPDATE nodes node
SET tags = filing.tags
FROM connection_content_versions filing
WHERE filing.ref_type = 'note' AND node.ref_type = 'note' AND node.ref_id = filing.ref_id
  AND node.tags IS DISTINCT FROM filing.tags;
