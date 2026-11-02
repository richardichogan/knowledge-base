// An article with a live LinkedIn or Bluesky post stays in Published; it may only move to Blog to plan a follow-up post.
export const POSTED_ARTICLE_SQL = `(metadata->'linkedinPost'->>'status' = 'posted' OR metadata->'blueskyPost'->>'status' = 'posted')`;

export const workflowStateSql = (param: string): string =>
  `CASE WHEN ${param} NOT IN ('published', 'blog') AND ${POSTED_ARTICLE_SQL} THEN 'published' ELSE ${param} END`;
