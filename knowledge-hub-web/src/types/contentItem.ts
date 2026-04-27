/**
 * Content item types — mirrors backend ContentItem.
 */

export type ContentSource =
  | 'cms-blog'
  | 'cms-newsletter'
  | 'cms-podcast-show-notes'
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
  | 'email'
  | 'spotify-podcast'
  | 'rss-podcast'
  | 'twitter-post'
  | 'linkedin-post'
  | 'devto-post'
  | 'note'
  | 'image';

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
  taxonomyTagIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface ContentItem extends ContentItemSummary {
  body?: string;
  metadata?: Record<string, unknown>;
}

/** Change 002: Note-specific fields */
export interface Note {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  linkedItems: string[];
  status: 'active' | 'archived';
  /** Optional FK to projects.id */
  projectId?: string;
  /** Taxonomy tag UUIDs from the note_tags join table */
  taxonomyTagIds?: string[];
}

export interface CreateNoteInput {
  content: string;
  tags?: string[];
  projectId?: string;
}

/** Change 003: Image-specific fields */
export interface KnowledgeImage {
  id: string;
  blobUrl: string;
  ocrText?: string;
  caption?: string;
  createdAt: string;
  tags: string[];
  linkedItems: string[];
}
