import type { Pool } from 'pg';
import { KNOWLEDGE_FAMILIES } from '../../ai/knowledge/manifest.js';
import { parseNoteContent } from '../../utils/noteContent.js';
import { renderNoteAsText } from '../noteTextService.js';
import {
  KnowledgeValidationError, READABLE_KINDS,
  type KnowledgeAccess, type KnowledgeExtractionState, type KnowledgeIssue, type KnowledgeLocator,
  type KnowledgeRecord, type ReadableKnowledgeKind,
} from '../../types/knowledge.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
  DEFAULT_PAGE_CHARS, MAX_OFFSET, MAX_PAGE_CHARS, pageEnd, projectMetadata, sanitizeText, sanitizeUrl, snapOffset, versionOf,
} from './projections.js';
import { isExcluded, type ExclusionLoader } from './exclusions.js';

export interface ReadArgs {
  kind: string;
  id: string;
  cursor?: string;
  offset?: number;
  maxChars?: number;
  outputVersion?: number;
}

export interface ReadContext {
  sessionId: string;
  /** Server-side strict project scope ("only project X"); never model-supplied. */
  strictProjectId?: string | null;
  loadExcluded: ExclusionLoader;
}

interface Canonical {
  kind: ReadableKnowledgeKind;
  id: string;
  aliases: string[];
}

interface Loaded {
  title: string;
  text: string;
  projectId: string | null;
  fields: Record<string, string | number | boolean | null>;
  origin: string;
  createdAt: string | null;
  updatedAt: string | null;
  locator: KnowledgeLocator;
  extractionState: KnowledgeExtractionState;
  issues: KnowledgeIssue[];
  versionSalt?: string;
}

interface NoteRow { content: string; project_id: string | null; created_at: Date; updated_at: Date; status: string | null }
interface ItemRow {
  title: string | null; summary: string | null; body: string | null; url: string | null; source: string | null;
  project_context: string | null; metadata: Record<string, unknown> | null; published_at: Date | null; updated_at: Date | null;
}
interface TaskRow {
  title: string; body: string | null; status: string; priority: string; project_id: string | null;
  due_date: Date | string | null; created_at: Date; updated_at: Date;
}
interface ProjectRow { id: string; name: string; description: string | null; goal: string | null; lifecycle_state: string }
interface OutputMetaRow { title: string; kind: string; session_id: string }
interface OutputVersionRow { version: number; content: string | null; author: string; created_at: Date }

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value ? value : null;
};

const UUID_OR_TEXT = /^[A-Za-z0-9_.:-]{1,200}$/;

function validate(args: ReadArgs): { offset: number | null; maxChars: number } {
  if (typeof args.kind !== 'string' || !args.kind) throw new KnowledgeValidationError('invalid_kind', 'kind is required.');
  if (typeof args.id !== 'string' || !UUID_OR_TEXT.test(args.id)) throw new KnowledgeValidationError('invalid_id', 'id is missing or malformed.');
  const maxChars = args.maxChars ?? DEFAULT_PAGE_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_PAGE_CHARS) {
    throw new KnowledgeValidationError('invalid_max_chars', `maxChars must be an integer between 1 and ${MAX_PAGE_CHARS}.`);
  }
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > MAX_OFFSET)) {
    throw new KnowledgeValidationError('invalid_offset', 'offset must be a non-negative integer.');
  }
  if (args.cursor !== undefined && args.offset !== undefined) {
    throw new KnowledgeValidationError('cursor_and_offset', 'Provide either cursor or offset, not both.');
  }
  if (args.outputVersion !== undefined && (!Number.isSafeInteger(args.outputVersion) || args.outputVersion < 1)) {
    throw new KnowledgeValidationError('invalid_version', 'outputVersion must be a positive integer.');
  }
  return { offset: args.offset ?? null, maxChars };
}

async function aliasesFor(db: Pool, refId: string, extra: string[] = []): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`SELECT id::text AS id FROM nodes WHERE ref_id::text = $1`, [refId]);
  return [...new Set([refId, ...extra, ...rows.map(r => r.id)])];
}

/** Resolve any alias (note id, mirror content-item id, graph node id) to one canonical record. */
export async function resolveCanonical(db: Pool, kind: ReadableKnowledgeKind, id: string): Promise<Canonical | null> {
  switch (kind) {
    case 'note': return resolveNote(db, id);
    case 'task': {
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM tasks WHERE id = $1`, [id]);
      return rows[0] ? { kind, id, aliases: await aliasesFor(db, id) } : null;
    }
    case 'project': {
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM projects WHERE id = $1`, [id]);
      return rows[0] ? { kind, id, aliases: [id] } : null;
    }
    case 'output': {
      const { rows } = await db.query<{ id: string }>(`SELECT id::text AS id FROM chat_outputs WHERE id::text = $1`, [id]);
      return rows[0] ? { kind, id, aliases: [id] } : null;
    }
    case 'content-item': {
      const { rows } = await db.query<{ id: string; source: string; source_id: string | null }>(
        `SELECT id::text AS id, source, source_id FROM content_items WHERE id::text = $1`, [id]);
      const row = rows[0];
      if (!row) return null;
      if (row.source === 'note') return row.source_id ? resolveNote(db, row.source_id) : null;
      return { kind, id: row.id, aliases: await aliasesFor(db, row.id) };
    }
    case 'graph-node': {
      const { rows } = await db.query<{ ref_id: string; ref_type: string }>(
        `SELECT ref_id::text AS ref_id, ref_type FROM nodes WHERE id::text = $1`, [id]);
      const node = rows[0];
      if (!node) return null;
      if (node.ref_type === 'note') return resolveNote(db, node.ref_id);
      if (node.ref_type === 'task') return resolveCanonical(db, 'task', node.ref_id);
      return resolveCanonical(db, 'content-item', node.ref_id);
    }
  }
}

async function resolveNote(db: Pool, noteId: string): Promise<Canonical | null> {
  const { rows } = await db.query<{ id: string }>(`SELECT id::text AS id FROM notes WHERE id::text = $1`, [noteId]);
  if (!rows[0]) return null;
  const mirrors = await db.query<{ id: string }>(`SELECT id::text AS id FROM content_items WHERE source = 'note' AND source_id = $1`, [noteId]);
  return { kind: 'note', id: noteId, aliases: await aliasesFor(db, noteId, mirrors.rows.map(r => r.id)) };
}

function stateFromMetadata(metadata: unknown, text: string): KnowledgeExtractionState {
  const m = (typeof metadata === 'object' && metadata !== null ? metadata : {}) as Record<string, unknown>;
  const declared = m.extractionState;
  if (declared === 'failed' || declared === 'partial' || declared === 'metadata-only' || declared === 'complete') return declared;
  if (m.truncated === true) return 'partial';
  return text.trim() ? 'complete' : 'metadata-only';
}

async function load(db: Pool, c: Canonical, args: ReadArgs, sessionId: string): Promise<Loaded | null> {
  const issues: KnowledgeIssue[] = [];
  switch (c.kind) {
    case 'note': {
      const { rows } = await db.query<NoteRow>(`SELECT content, project_id, created_at, updated_at, status FROM notes WHERE id::text = $1`, [c.id]);
      const row = rows[0];
      if (!row) return null;
      const raw = String(row.content);
      const parsed = parseNoteContent(raw);
      const text = parsed.blocks.length === 0 ? '' : sanitizeText(await renderNoteAsText(db, raw));
      return {
        title: sanitizeText(parsed.title ?? 'Untitled note'), text, projectId: row.project_id ?? null,
        fields: { status: String(row.status ?? 'active'), contentType: parsed.contentType ?? null },
        origin: 'human', createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
        locator: { internalPath: `/think?noteId=${c.id}` }, extractionState: text.trim() ? 'complete' : 'metadata-only', issues,
      };
    }
    case 'content-item': {
      const { rows } = await db.query<ItemRow>(
        `SELECT title, summary, body, url, source, project_context, metadata, published_at, updated_at FROM content_items WHERE id::text = $1`, [c.id]);
      const row = rows[0];
      if (!row) return null;
      const body = typeof row.body === 'string' && row.body.trim() ? row.body : '';
      const text = sanitizeText(body);
      const state = stateFromMetadata(row.metadata, text);
      const m = row.metadata ?? {};
      if (m.hasTranscript === false || m.contentKind === 'video-description') {
        issues.push({ code: 'no_transcript', message: 'Only the video description is stored; no transcript is available, so totalChars covers the description only.', retryable: false });
      }
      if (state === 'partial') issues.push({ code: 'extraction_partial', message: 'Stored text is a partial extraction; totalChars is the stored length, not the original document length.', retryable: false });
      if (state === 'metadata-only') issues.push({ code: 'metadata_only', message: 'No body text is stored; only metadata is available.', retryable: false });
      if (state === 'failed') issues.push({ code: 'extraction_failed', message: 'Text extraction failed for this record.', retryable: true });
      const summary = typeof row.summary === 'string' ? sanitizeText(row.summary) : '';
      const url = sanitizeUrl(row.url);
      return {
        title: sanitizeText(String(row.title ?? 'Untitled')), text: text || summary,
        projectId: row.project_context && row.project_context !== 'personal' ? String(row.project_context) : null,
        fields: { source: String(row.source ?? ''), ...projectMetadata(row.metadata) },
        origin: 'imported', createdAt: iso(row.published_at), updatedAt: iso(row.updated_at),
        locator: { internalPath: `/library?contentItemId=${c.id}`, ...(url ? { externalUrl: url } : {}) },
        extractionState: state, issues,
      };
    }
    case 'task': {
      const { rows } = await db.query<TaskRow>(`SELECT title, body, status, priority, project_id, due_date, created_at, updated_at FROM tasks WHERE id = $1`, [c.id]);
      const row = rows[0];
      if (!row) return null;
      return {
        title: sanitizeText(String(row.title)), text: sanitizeText(String(row.body ?? '')), projectId: row.project_id ?? null,
        fields: { status: String(row.status), priority: String(row.priority), dueDate: iso(row.due_date) },
        origin: 'human', createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
        locator: { internalPath: `/plan?taskId=${encodeURIComponent(c.id)}` }, extractionState: 'complete', issues,
      };
    }
    case 'project': {
      const { rows } = await db.query<ProjectRow>(`SELECT id, name, description, goal, lifecycle_state FROM projects WHERE id = $1`, [c.id]);
      const row = rows[0];
      if (!row) return null;
      const text = sanitizeText([row.goal ? `Goal: ${row.goal}` : '', row.description ? `Description: ${row.description}` : ''].filter(Boolean).join('\n\n'));
      return {
        title: sanitizeText(String(row.name)), text, projectId: String(row.id), fields: { lifecycleState: String(row.lifecycle_state) },
        origin: 'human', createdAt: null, updatedAt: null,
        locator: { internalPath: `/projects?projectId=${encodeURIComponent(c.id)}` }, extractionState: text ? 'complete' : 'metadata-only', issues,
      };
    }
    case 'output': {
      const meta = await db.query<OutputMetaRow>(`SELECT title, kind, session_id::text AS session_id FROM chat_outputs WHERE id::text = $1`, [c.id]);
      const out = meta.rows[0];
      if (!out || out.session_id !== sessionId) return null;
      const version = args.outputVersion;
      const v = await db.query<OutputVersionRow>(
        version === undefined
          ? `SELECT version, content, author, created_at FROM chat_output_versions WHERE output_id::text = $1 ORDER BY version DESC LIMIT 1`
          : `SELECT version, content, author, created_at FROM chat_output_versions WHERE output_id::text = $1 AND version = $2`,
        version === undefined ? [c.id] : [c.id, version]);
      const row = v.rows[0];
      if (!row) return null;
      return {
        title: sanitizeText(String(out.title)), text: sanitizeText(String(row.content ?? '')), projectId: null,
        fields: { version: Number(row.version), author: String(row.author), kind: String(out.kind) },
        origin: row.author === 'athena' ? 'ai-generated' : 'human', createdAt: iso(row.created_at), updatedAt: iso(row.created_at),
        locator: { internalPath: `/chat?session=${out.session_id}` }, extractionState: 'complete', issues, versionSalt: `v${row.version}`,
      };
    }
    default: return null;
  }
}

function manifestKinds(): Set<string> {
  return new Set(KNOWLEDGE_FAMILIES.map(f => f.kind));
}

/** Read one canonical record, paged, with exclusion/scope checks revalidated on every call. */
export async function readKnowledgeRecord(db: Pool, args: ReadArgs, ctx: ReadContext): Promise<KnowledgeAccess> {
  const { offset, maxChars } = validate(args);
  const isReadable = (READABLE_KINDS as readonly string[]).includes(args.kind);
  if (!isReadable) {
    if (manifestKinds().has(args.kind)) {
      return { status: 'unavailable', code: 'unsupported_family', retryable: false, message: `No reader exists yet for "${args.kind}" records.` };
    }
    throw new KnowledgeValidationError('invalid_kind', `Unknown kind "${args.kind}".`);
  }
  const scope = ctx.strictProjectId ? `project:${ctx.strictProjectId}` : 'any';

  const loadExcluded = async (): Promise<Set<string> | null> => {
    try { return await ctx.loadExcluded(); } catch { return null; }
  };
  const failClosed = (): KnowledgeAccess => ({
    status: 'unavailable', code: 'exclusions_unavailable', retryable: true,
    message: 'Source exclusions could not be verified, so nothing was read. Try again shortly.',
  });

  const excludedBefore = await loadExcluded();
  if (!excludedBefore) return failClosed();

  const canonical = await resolveCanonical(db, args.kind as ReadableKnowledgeKind, args.id);
  if (!canonical) return { status: 'not_found' };
  if (isExcluded(canonical.aliases, excludedBefore)) return { status: 'excluded' };

  const loaded = await load(db, canonical, args, ctx.sessionId);
  if (!loaded) return { status: 'not_found' };
  if (ctx.strictProjectId && loaded.projectId !== ctx.strictProjectId) return { status: 'not_found' };

  const refKey = `${canonical.kind}:${canonical.id}`;
  const version = versionOf(`${loaded.versionSalt ?? ''}\u0000${loaded.title}\u0000${loaded.text}`);
  const text = loaded.text;
  const issues = [...loaded.issues];
  let start = 0;
  if (args.cursor !== undefined) {
    const payload = decodeCursor(args.cursor, { ref: refKey, scope, sessionId: ctx.sessionId });
    if (payload.version !== version) {
      issues.push({ code: 'version_changed', message: 'The record changed since the cursor was issued. Restart from the returned cursor; pages are never spliced across versions.', retryable: true });
      return finish(loaded, canonical, version, '', 0, 0, text.length, encodeCursor({ ref: refKey, version, offset: 0, scope, sessionId: ctx.sessionId }), issues, true);
    }
    start = payload.offset;
  } else if (offset !== null) {
    start = offset;
  }
  if (start > text.length) throw new KnowledgeValidationError('offset_beyond_end', `offset exceeds the record length (${text.length}).`);
  start = snapOffset(text, start);
  const end = pageEnd(text, start, maxChars);
  const nextCursor = end < text.length ? encodeCursor({ ref: refKey, version, offset: end, scope, sessionId: ctx.sessionId }) : null;

  const excludedAfter = await loadExcluded();
  if (!excludedAfter) return failClosed();
  if (isExcluded(canonical.aliases, excludedAfter)) return { status: 'excluded' };

  return finish(loaded, canonical, version, text.slice(start, end), start, end, text.length, nextCursor, issues, false);
}

function finish(
  l: Loaded, c: Canonical, version: string, content: string, start: number, end: number, total: number,
  nextCursor: string | null, issues: KnowledgeIssue[], versionChanged: boolean,
): KnowledgeAccess {
  const record: KnowledgeRecord = {
    ref: { kind: c.kind, id: c.id }, title: l.title, projectId: l.projectId, fields: l.fields, origin: l.origin, version,
    createdAt: l.createdAt, updatedAt: l.updatedAt, locator: l.locator, extractionState: l.extractionState,
    content, startOffset: start, endOffset: end, totalChars: total, nextCursor, untrusted: true,
  };
  const complete = !versionChanged && start === 0 && nextCursor === null;
  const coverage = { totalChars: total, returnedChars: end - start, complete };
  const partial = versionChanged || nextCursor !== null || l.extractionState !== 'complete' || issues.length > 0;
  return { status: partial ? 'partial' : 'ok', record, coverage, issues };
}
