/**
 * Content item types — mirrors the backend ContentItem interface.
 */

export type ContentSource =
  | 'cms-blog'
  | 'cms-newsletter'
  | 'cms-podcast'
  | 'cms-session-summary'
  | 'gitlab-commit'
  | 'gitlab-mr'
  | 'gitlab-issue'
  | 'gitlab-pipeline'
  | 'github-commit'
  | 'github-pr'
  | 'github-issue'
  | 'graph-calendar'
  | 'graph-todo'
  | 'spotify-podcast'
  | 'rss-podcast'
  | 'twitter-post'
  | 'linkedin-post'
  | 'devto-post';

export type ProjectContext =
  | 'personal'
  | 'structara-ai'
  | 'ibm-thought-leadership';

export interface ContentItemSummary {
  id: string;
  source: ContentSource;
  sourceId: string;
  title: string;
  summary: string;
  publishedAt: string;
  url?: string;
  projectContext?: ProjectContext;
  tags?: string[];
}

export interface ContentItem extends ContentItemSummary {
  body?: string;
  metadata?: Record<string, unknown>;
}
