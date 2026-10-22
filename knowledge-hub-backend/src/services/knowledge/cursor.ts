import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { KnowledgeValidationError } from '../../types/knowledge.js';

const MAX_CURSOR_CHARS = 2_000;

export interface CursorPayload {
  /** Canonical ref key, e.g. "note:<id>". */
  ref: string;
  version: string;
  offset: number;
  scope: string;
  sessionId: string;
}

function key(): Buffer {
  return createHash('sha256').update(`knowledge-cursor:${env.JWT_SECRET}`).digest();
}

function sign(body: string): string {
  return createHmac('sha256', key()).update(body).digest('base64url');
}

export function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

function invalid(): KnowledgeValidationError {
  return new KnowledgeValidationError('invalid_cursor', 'Cursor is invalid or was issued for a different record, scope or session.');
}

/** Verifies signature and binds the cursor to ref, scope and session before anything is disclosed. */
export function decodeCursor(cursor: string, expected: { ref: string; scope: string; sessionId: string }): CursorPayload {
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_CHARS) throw invalid();
  const [body, sig, extra] = cursor.split('.');
  if (!body || !sig || extra !== undefined) throw invalid();
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw invalid(); }
  const p = parsed as Partial<CursorPayload> | null;
  if (!p || typeof p.ref !== 'string' || typeof p.version !== 'string' || typeof p.scope !== 'string'
    || typeof p.sessionId !== 'string' || typeof p.offset !== 'number' || !Number.isSafeInteger(p.offset) || p.offset < 0) throw invalid();
  if (p.ref !== expected.ref || p.scope !== expected.scope || p.sessionId !== expected.sessionId) throw invalid();
  return p as CursorPayload;
}
