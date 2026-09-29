/**
 * ai/athenaMemory.ts — Athena's learned memory.
 *
 *  - instruction: a standing instruction ("blog posts always include X"),
 *    scoped to everywhere / a persona / a project / a kind of output.
 *  - example:     a reply the user liked (👍), used as a style/structure
 *    reference for the same persona.
 *  - profile:     the user profile, moved here from config/static-context.md
 *    so it can be edited in the app.
 *
 * Active instructions are injected into the system prompt on every turn whose
 * scope matches (not searched for, so they can't be missed). Suggestions (from
 * 👎 feedback or the weekly review) stay inactive until approved.
 */

import type { Pool } from 'pg';

export type MemoryKind = 'instruction' | 'example' | 'profile';
export type MemoryScopeType = 'global' | 'persona' | 'project' | 'output';
export type MemoryStatus = 'active' | 'paused' | 'suggested' | 'dismissed';
export type MemoryOrigin = 'chat' | 'feedback' | 'weekly' | 'manual' | 'profile-import';

export interface AthenaMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  scopeType: MemoryScopeType;
  scopeValue: string | null;
  status: MemoryStatus;
  origin: MemoryOrigin;
  sourceSessionId: string | null;
  sourceExcerpt: string | null;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  scope_type: MemoryScopeType;
  scope_value: string | null;
  status: MemoryStatus;
  origin: MemoryOrigin;
  source_session_id: string | null;
  source_excerpt: string | null;
  last_applied_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id::text, kind, content, scope_type, scope_value, status, origin, source_session_id::text,
  source_excerpt, last_applied_at, created_at, updated_at`;

function toMemory(r: MemoryRow): AthenaMemory {
  return {
    id: r.id,
    kind: r.kind,
    content: r.content,
    scopeType: r.scope_type,
    scopeValue: r.scope_value,
    status: r.status,
    origin: r.origin,
    sourceSessionId: r.source_session_id,
    sourceExcerpt: r.source_excerpt,
    lastAppliedAt: r.last_applied_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Prompt budget: instructions are short; examples are trimmed hard.
const MAX_INSTRUCTIONS_IN_PROMPT = 60;
const EXAMPLES_PER_PERSONA = 2;
const EXAMPLE_CHARS = 2_500;

export interface NewMemory {
  kind?: MemoryKind;
  content: string;
  scopeType?: MemoryScopeType;
  scopeValue?: string | null;
  status?: MemoryStatus;
  origin?: MemoryOrigin;
  sourceSessionId?: string | null;
  sourceExcerpt?: string | null;
}

export async function createMemory(db: Pool, m: NewMemory): Promise<AthenaMemory> {
  const scopeType = m.scopeType ?? 'global';
  const { rows } = await db.query<MemoryRow>(
    `INSERT INTO athena_memories (kind, content, scope_type, scope_value, status, origin, source_session_id, source_excerpt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [
      m.kind ?? 'instruction',
      m.content.trim(),
      scopeType,
      scopeType === 'global' ? null : (m.scopeValue?.trim() || null),
      m.status ?? 'active',
      m.origin ?? 'chat',
      m.sourceSessionId ?? null,
      m.sourceExcerpt?.slice(0, 1_000) ?? null,
    ],
  );
  return toMemory(rows[0]!);
}

export async function listMemories(db: Pool): Promise<AthenaMemory[]> {
  const { rows } = await db.query<MemoryRow>(
    `SELECT ${COLUMNS} FROM athena_memories WHERE status <> 'dismissed' ORDER BY kind, scope_type, scope_value NULLS FIRST, created_at DESC`,
  );
  return rows.map(toMemory);
}

export async function updateMemory(
  db: Pool,
  id: string,
  patch: Partial<Pick<AthenaMemory, 'content' | 'scopeType' | 'scopeValue' | 'status'>>,
): Promise<AthenaMemory | null> {
  const { rows } = await db.query<MemoryRow>(
    `UPDATE athena_memories SET
        content     = COALESCE($2, content),
        scope_type  = COALESCE($3, scope_type),
        scope_value = CASE WHEN COALESCE($3, scope_type) = 'global' THEN NULL WHEN $5 THEN $4 ELSE scope_value END,
        status      = COALESCE($6, status),
        updated_at  = NOW()
      WHERE id::text = $1
      RETURNING ${COLUMNS}`,
    [id, patch.content ?? null, patch.scopeType ?? null, patch.scopeValue ?? null, 'scopeValue' in patch, patch.status ?? null],
  );
  return rows[0] ? toMemory(rows[0]) : null;
}

export async function deleteMemory(db: Pool, id: string): Promise<void> {
  await db.query(`DELETE FROM athena_memories WHERE id::text = $1`, [id]);
}

/** Memories created in a session since a point in time (to confirm "Remembered: …" in the UI). */
export async function memoriesCreatedSince(db: Pool, sessionId: string, since: Date): Promise<AthenaMemory[]> {
  const { rows } = await db.query<MemoryRow>(
    `SELECT ${COLUMNS} FROM athena_memories WHERE source_session_id::text = $1 AND created_at >= $2 ORDER BY created_at`,
    [sessionId, since.toISOString()],
  );
  return rows.map(toMemory);
}

// ── Profile (was config/static-context.md) ────────────────────────────────────

/**
 * The user profile text. On first use, imports the legacy blob file into the
 * memory table so it becomes editable in the app; afterwards the table wins.
 */
export async function getProfileText(db: Pool, loadLegacyBlob: () => Promise<string>): Promise<string> {
  const { rows } = await db.query<{ content: string; status: MemoryStatus }>(
    `SELECT content, status FROM athena_memories WHERE kind = 'profile' ORDER BY created_at LIMIT 1`,
  );
  const existing = rows[0];
  if (existing !== undefined) return existing.status === 'active' ? existing.content : '';
  const legacy = await loadLegacyBlob();
  if (legacy.trim() === '') return '';
  await db.query(
    `INSERT INTO athena_memories (kind, content, scope_type, status, origin)
     SELECT 'profile', $1, 'global', 'active', 'profile-import'
     WHERE NOT EXISTS (SELECT 1 FROM athena_memories WHERE kind = 'profile')`,
    [legacy],
  );
  return legacy;
}

// ── Prompt injection ──────────────────────────────────────────────────────────

/**
 * Standing instructions + approved examples that apply to this turn,
 * formatted for the system prompt. Output-scoped instructions are always
 * included, labelled with their output type, so they apply whenever Athena
 * produces that kind of thing.
 */
export async function buildStandingInstructionsBlock(
  db: Pool,
  opts: { persona?: string | undefined; projectId?: string | null | undefined },
): Promise<string> {
  const persona = opts.persona ?? 'general';
  const projectId = opts.projectId ?? '';
  const { rows } = await db.query<MemoryRow>(
    `SELECT ${COLUMNS} FROM athena_memories
      WHERE status = 'active' AND kind = 'instruction'
        AND (scope_type IN ('global', 'output')
             OR (scope_type = 'persona' AND scope_value = $1)
             OR (scope_type = 'project' AND scope_value = $2))
      ORDER BY created_at DESC
      LIMIT $3`,
    [persona, projectId, MAX_INSTRUCTIONS_IN_PROMPT],
  );
  const examples = await db.query<MemoryRow>(
    `SELECT ${COLUMNS} FROM athena_memories
      WHERE status = 'active' AND kind = 'example' AND scope_type = 'persona' AND scope_value = $1
      ORDER BY created_at DESC LIMIT $2`,
    [persona, EXAMPLES_PER_PERSONA],
  );
  if (rows.length === 0 && examples.rows.length === 0) return '';

  const label = (m: MemoryRow): string => {
    if (m.scope_type === 'output') return ` (when producing: ${m.scope_value ?? 'that output'})`;
    if (m.scope_type === 'persona') return ` (${m.scope_value ?? ''} persona)`;
    if (m.scope_type === 'project') return ` (project: ${m.scope_value ?? ''})`;
    return '';
  };

  const parts: string[] = [];
  if (rows.length > 0) {
    parts.push(
      '## Standing instructions from Richard (learned from earlier feedback — always follow)',
      'Newest first. If two conflict, follow the newer one and briefly mention the conflict.',
      ...rows.map((m) => `- ${m.content}${label(m)}`),
    );
  }
  if (examples.rows.length > 0) {
    parts.push(
      '',
      '## Replies Richard liked for this persona (match their structure and tone, not their content)',
      ...examples.rows.map((m, i) => `### Example ${(i + 1).toString()}\n${m.content.slice(0, EXAMPLE_CHARS)}`),
    );
  }

  const ids = [...rows, ...examples.rows].map((m) => m.id);
  void db.query(`UPDATE athena_memories SET last_applied_at = NOW() WHERE id::text = ANY($1::text[])`, [ids]).catch(() => undefined);
  return parts.join('\n');
}
