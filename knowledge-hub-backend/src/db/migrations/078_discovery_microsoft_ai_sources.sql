-- 078_discovery_microsoft_ai_sources.sql
-- Primary Microsoft/GitHub AI announcement feeds that Discover was missing:
-- Microsoft-Decision-1 (Foundry Blog), Copilot local sandboxing GA (GitHub
-- Changelog) and Copilot Managed Runtime (Copilot Studio blog) never reached
-- Discover because none of these feeds were sources. The old Microsoft Copilot
-- Blog address now redirects to an HTML page; the Copilot Studio feed is the
-- working replacement for its product announcements.

INSERT INTO discovery_sources (title, feed_url, group_name) VALUES
  ('Microsoft Foundry Blog', 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=azure-ai-foundry-blog', 'Microsoft'),
  ('Microsoft Copilot Studio Blog', 'https://www.microsoft.com/en-us/microsoft-copilot/blog/copilot-studio/feed/', 'Microsoft'),
  ('GitHub Changelog', 'https://github.blog/changelog/feed/', 'GitHub')
ON CONFLICT (feed_url) DO NOTHING;

-- Tech Community product-group blogs (Foundry, Entra, Azure...) and locale-prefixed
-- microsoft.com product blogs were classed as Community/Unknown, which capped their
-- score at 60% and down-weighted their rank. Re-queue the last fortnight's for scoring
-- under the corrected classification; low-rated ones are re-shelved by the scorer.
UPDATE content_items
   SET relevance_explanation = NULL,
       workflow_state = CASE WHEN workflow_state = 'shelved' THEN 'to-review' ELSE workflow_state END,
       metadata = (metadata - 'shelvedAt' - 'shelvedReason') || jsonb_build_object('scoreAttempts', 0)
 WHERE source = 'discovered-article'
   AND published_at > NOW() - INTERVAL '14 days'
   AND COALESCE(metadata->>'sourceAuthorityTier', '') <> 'Microsoft/GitHub Official'
   AND (workflow_state = 'to-review' OR (workflow_state = 'shelved' AND metadata->>'shelvedReason' = 'low'))
   AND (
     (url ILIKE '%techcommunity.microsoft.com%' AND (url ILIKE '%/ba-p/%' OR url ILIKE '%/blog/%'))
     OR url ~* '//(www\.)?microsoft\.com/[a-z]{2}-[a-z]{2}/[^?#]*blog'
   );
