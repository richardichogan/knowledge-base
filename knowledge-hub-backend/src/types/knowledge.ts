/** Shared types for the trustworthy knowledge read foundation (spec 5.1-5.3). */

export const READABLE_KINDS = ['note', 'content-item', 'graph-node', 'project', 'task', 'output'] as const;
export type ReadableKnowledgeKind = (typeof READABLE_KINDS)[number];

/** Kinds that exist in the manifest but have no reader yet. */
export type KnowledgeKind = ReadableKnowledgeKind | (string & { readonly __kind?: never });

export interface KnowledgeRef {
  kind: KnowledgeKind;
  id: string;
}

export type KnowledgeIssueCode =
  | 'version_changed'
  | 'index_stale'
  | 'extraction_partial'
  | 'extraction_failed'
  | 'metadata_only'
  | 'semantic_unavailable'
  | 'budget_exhausted'
  | 'no_transcript'
  | 'unsupported_family'
  | 'exclusions_unavailable'
  | 'out_of_scope';

export interface KnowledgeIssue {
  code: KnowledgeIssueCode;
  message: string;
  retryable: boolean;
}

export interface KnowledgeLocator {
  internalPath: string;
  /** Sanitised, never fetched by the reader. */
  externalUrl?: string;
}

export type KnowledgeExtractionState = 'complete' | 'partial' | 'metadata-only' | 'failed';

export interface KnowledgeRecord {
  ref: KnowledgeRef;
  title: string;
  projectId: string | null;
  fields: Record<string, string | number | boolean | null>;
  origin: string;
  version: string;
  createdAt: string | null;
  updatedAt: string | null;
  locator: KnowledgeLocator;
  extractionState: KnowledgeExtractionState;
  content: string;
  startOffset: number;
  endOffset: number;
  totalChars: number;
  nextCursor: string | null;
  /** True when content is untrusted source data, never instructions. */
  untrusted: true;
}

export interface AccessCoverage {
  totalChars: number;
  returnedChars: number;
  complete: boolean;
}

export type KnowledgeAccess =
  | { status: 'ok'; record: KnowledgeRecord; coverage: AccessCoverage; issues: KnowledgeIssue[] }
  | { status: 'partial'; record: KnowledgeRecord; coverage: AccessCoverage; issues: KnowledgeIssue[] }
  | { status: 'not_found' }
  | { status: 'excluded' }
  | { status: 'unavailable'; code: KnowledgeIssueCode; retryable: boolean; message: string };

export type KnowledgeValidationCode =
  | 'invalid_kind'
  | 'invalid_id'
  | 'invalid_offset'
  | 'invalid_max_chars'
  | 'invalid_cursor'
  | 'cursor_and_offset'
  | 'offset_beyond_end'
  | 'invalid_version';

export class KnowledgeValidationError extends Error {
  public readonly code: KnowledgeValidationCode;

  public constructor(code: KnowledgeValidationCode, message: string) {
    super(message);
    this.name = 'KnowledgeValidationError';
    this.code = code;
  }
}
