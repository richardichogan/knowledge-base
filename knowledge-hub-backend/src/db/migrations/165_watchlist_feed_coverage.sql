INSERT INTO discovery_sources (title, feed_url, group_name)
VALUES
  ('Computer Weekly', 'https://www.computerweekly.com/rss/All-Computer-Weekly-content.xml', 'Industry'),
  ('CIO Dive', 'https://www.ciodive.com/feeds/news/', 'Industry'),
  ('HFS Research', 'https://www.horsesforsources.com/feed/', 'Industry'),
  ('RedMonk', 'https://www.redmonk.com/feed', 'Industry'),
  ('Google Cloud Blog', 'https://blog.google/products/google-cloud/rss/', 'Google'),
  ('MCP Blog', 'https://blog.modelcontextprotocol.io/index.xml', 'AI')
ON CONFLICT (feed_url) DO NOTHING;

UPDATE discover_watchlists AS w
SET config = jsonb_set(w.config, '{sourceIds}', added.ids),
    revision = w.revision + 1,
    updated_at = NOW()
FROM (
  SELECT w.id, jsonb_agg(DISTINCT source_id ORDER BY source_id) AS ids
  FROM discover_watchlists AS w
  CROSS JOIN LATERAL (
    SELECT value AS source_id FROM jsonb_array_elements_text(w.config->'sourceIds')
    UNION
    SELECT s.id::text FROM discovery_sources AS s
    WHERE s.is_active AND (
      s.title IN ('InfoQ', 'The Register', 'Computer Weekly', 'CIO Dive', 'HFS Research', 'RedMonk')
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(w.config->'entities') AS entity
        WHERE (lower(entity->>'name') = 'aws' AND s.title IN ('AWS News Blog', 'AWS What''s New', 'AWS Machine Learning Blog'))
          OR (lower(entity->>'name') = 'openai' AND s.title = 'OpenAI News')
          OR (lower(entity->>'name') = 'google cloud' AND s.title IN ('Google Cloud Blog', 'Google AI Blog'))
          OR (lower(entity->>'name') = 'mcp' AND s.title = 'MCP Blog')
      )
    )
  ) AS sources
  GROUP BY w.id
) AS added
WHERE w.id = added.id AND w.config->'sourceIds' IS DISTINCT FROM added.ids;
