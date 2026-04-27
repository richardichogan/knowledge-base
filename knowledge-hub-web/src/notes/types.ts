/**
 * notes/types.ts — domain types for the Notes feature.
 */

import type { ContentType } from './constants';

export interface NoteDocument {
  /** UUID — matches `notes.id` in PostgreSQL */
  id: string;
  title: string;
  contentType: ContentType;
  /** Raw BlockNote JSON (serialised Block[]) stored as string */
  contentJson: string;
  /** Path in GitHub content repo once synced; null until first push */
  githubPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteListItem {
  id: string;
  title: string;
  contentType: ContentType;
  updatedAt: string;
  /** Taxonomy tag UUIDs — populated from note_tags join in list response */
  tagIds?: string[];
}

export interface GitHubPushPayload {
  markdown: string;
  filePath: string;
  commitMessage: string;
}
