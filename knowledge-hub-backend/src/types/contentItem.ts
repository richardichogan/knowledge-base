/**
 * Unified content item — the single type that represents any piece of
 * content from any source in the knowledge hub timeline and search index.
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
  | 'github-content-store'
  | 'github-doc'
  | 'graph-calendar'
  | 'graph-todo'
  | 'podcast-episode'
  | 'ai-session'
  | 'email'
  | 'github-action'
  | 'github-release'
  | 'github-deployment'
  | 'github-pr-review'
  | 'gitlab-release'
  | 'gitlab-deployment'
  | 'note'
  | 'discovered-article';

/**
 * Project context for timeline filtering.
 * 'personal' is the fallback when no project matches the source repo/path.
 * All other values are project IDs from the projects table (TEXT primary key).
 * Kept as string so new projects don't require a type change.
 */
export type ProjectContext = string;

/**
 * Unified content item stored in the PostgreSQL index.
 * Every source maps to this shape for timeline display and RAG retrieval.
 */
export interface ContentItem {
  /** UUID primary key, assigned by the database. */
  id: string;
  /** The originating source system. */
  source: ContentSource;
  /** Source-specific identifier (e.g. blob path, commit SHA, Graph event ID). */
  sourceId: string;
  /** Display title. */
  title: string;
  /** Short plain-text summary for timeline display and RAG context. */
  summary: string;
  /** Full plain-text content for FTS indexing. May be truncated for very large items. */
  body: string;
  /** ISO 8601 UTC. Used for timeline ordering. */
  publishedAt: string;
  /** ISO 8601 UTC. When this record was last indexed/updated. */
  indexedAt: string;
  /** URL to the original content, where applicable. */
  url?: string;
  /** Project context — for timeline filtering. */
  projectContext: ProjectContext;
  /** Source-specific metadata (flexible JSON). */
  metadata: Record<string, unknown>;
  /** Tags from the source (CMS tags, GitHub labels, etc.). */
  tags: string[];
  /** Taxonomy tag IDs assigned by the user via discover_item_tags. */
  taxonomyTagIds?: string[];
}

/** Lightweight version used for timeline listing (no body). */
export type ContentItemSummary = Omit<ContentItem, 'body'>;

// ── Notes (Change 002) ────────────────────────────────────────────────────────

/** Ad hoc note created natively in the app. Stored in PostgreSQL, not blob. */
export interface Note {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  linkedItems: string[];
  status: 'active' | 'archived';
  /** Optional FK to projects.id — null means unassigned */
  projectId?: string;
  /** Taxonomy tag UUIDs from the note_tags join table — included in list responses */
  taxonomyTagIds?: string[];
}

export interface CreateNoteInput {
  content: string;
  tags?: string[];
  /** Optional project to associate this note with */
  projectId?: string;
}

// ── Images (Change 003) ───────────────────────────────────────────────────────

/** Screenshot or image captured by the user. Blob lives in kb-images container. */
export interface KnowledgeImage {
  id: string;
  blobUrl: string;
  ocrText?: string;
  visionAnalysis?: string;
  caption?: string;
  createdAt: string;
  tags: string[];
  linkedItems: string[];
}
