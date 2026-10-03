-- 051_discovery_sources.sql
-- Article discovery moves into Athena: the feeds it reads are listed here
-- (managed from the Discover page). Seeded with the sources the blog site's
-- monitor used, plus Google, OpenAI, AWS and IBM. `title` is what appears as
-- the article's source in Discover (kept identical to the existing articles'
-- source names so the source filter keeps working).

CREATE TABLE IF NOT EXISTS discovery_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  feed_url        TEXT NOT NULL UNIQUE,
  group_name      TEXT NOT NULL DEFAULT 'Other',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error      TEXT,
  last_new_count  INTEGER NOT NULL DEFAULT 0,
  articles_found  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO discovery_sources (title, feed_url, group_name) VALUES
  -- Existing sources (from the blog site's monitor)
  ('The GitHub Blog', 'https://github.blog/feed/', 'GitHub'),
  ('Microsoft Azure Blog', 'https://azure.microsoft.com/en-us/blog/feed/', 'Microsoft'),
  ('All things Azure', 'https://devblogs.microsoft.com/all-things-azure/feed/', 'Microsoft'),
  ('Azure Infrastructure Blog articles', 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=AzureInfrastructureBlog', 'Microsoft'),
  ('Apps on Azure Blog articles', 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=AppsonAzureBlog', 'Microsoft'),
  ('Microsoft Security Blog', 'https://www.microsoft.com/en-us/security/blog/feed/', 'Microsoft'),
  ('Microsoft Entra Blog articles', 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=microsoft-entra-blog', 'Microsoft'),
  ('Microsoft 365 Blog', 'https://www.microsoft.com/en-us/microsoft-365/blog/feed/', 'Microsoft'),
  ('Microsoft Copilot Blog', 'https://www.microsoft.com/en-us/microsoft-copilot/blog/feed/', 'Microsoft'),
  ('Microsoft Power Platform Blog', 'https://www.microsoft.com/en-us/power-platform/blog/feed/', 'Microsoft'),
  ('Microsoft Dynamics 365 Blog', 'https://www.microsoft.com/en-us/dynamics-365/blog/feed/', 'Microsoft'),
  ('Microsoft Research Blog - Microsoft Research', 'https://www.microsoft.com/en-us/research/blog/feed/', 'Microsoft'),
  ('Microsoft UK Stories', 'https://ukstories.microsoft.com/feed/', 'Microsoft'),
  ('MIT Technology Review', 'https://www.technologyreview.com/feed/', 'Analysts and media'),
  ('Thoughtworks Insights', 'https://www.thoughtworks.com/rss/insights.xml', 'Analysts and media'),
  ('McKinsey Insights & Publications', 'https://www.mckinsey.com/insights/rss', 'Analysts and media'),
  -- IBM: the old address (newsroom.ibm.com/rss) never worked; this is the working announcements feed
  ('IBM Newsroom', 'https://newsroom.ibm.com/announcements?pagetemplate=rss', 'IBM'),
  -- New: OpenAI, AWS, Google
  ('OpenAI News', 'https://openai.com/news/rss.xml', 'OpenAI'),
  ('AWS What''s New', 'https://aws.amazon.com/about-aws/whats-new/recent/feed/', 'AWS'),
  ('AWS News Blog', 'https://aws.amazon.com/blogs/aws/feed/', 'AWS'),
  ('AWS Machine Learning Blog', 'https://aws.amazon.com/blogs/machine-learning/feed/', 'AWS'),
  ('Google AI Blog', 'https://blog.google/technology/ai/rss/', 'Google'),
  ('Google DeepMind', 'https://deepmind.google/blog/rss.xml', 'Google'),
  ('Google Cloud Blog', 'https://cloudblog.withgoogle.com/rss/', 'Google')
ON CONFLICT (feed_url) DO NOTHING;
