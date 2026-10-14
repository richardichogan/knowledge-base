import type { Pool } from 'pg';
import { ValidationError, NotFoundError } from '../types/errors.js';

export type RegisterKind = 'question' | 'risk' | 'issue';
export type RegisterStatus = 'open' | 'resolved';

export interface RegisterItem {
  id: string;
  projectId: string;
  kind: RegisterKind;
  title: string;
  detail: string;
  status: RegisterStatus;
  resolution: string;
  owner: string;
  dueDate: string | null;
  taskId: string | null;
  sourceType: 'manual' | 'chat_decision';
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type Section<T> = { available: true; data: T; truncated: boolean; total: number } | { available: false; error: string };

export interface CockpitLink { label: string; href: string; at: string | null; meta?: string; sourceId?: string }

export interface ProjectCockpit {
  projectId: string;
  generatedAt: string;
  outcome: Section<{ goal: string; expectedOutputs: string[]; lifecycleState: string; targetEndDate: string | null }>;
  commitments: Section<CockpitLink[]>;
  blockers: Section<CockpitLink[]>;
  register: Section<{ open: number; resolved: number; openByKind: Record<RegisterKind, number> }>;
  decisions: Section<CockpitLink[]>;
  notes: Section<CockpitLink[]>;
  outputs: Section<CockpitLink[]>;
}

const KINDS: RegisterKind[] = ['question', 'risk', 'issue'];
const SECTION_LIMIT = 6;
const SNIPPET_LENGTH = 120;
const MAX_TITLE = 300;
const MAX_TEXT = 4000;
const MAX_OWNER = 200;
export const REGISTER_PAGE_SIZE = 50;
const REGISTER_MAX_PAGE_SIZE = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_LENGTH = 10;

const DATE_COLUMN = `to_char(due_date, 'YYYY-MM-DD')`;
const REGISTER_COLUMNS = `id, project_id, kind, title, detail, status, resolution, owner, ${DATE_COLUMN} AS due_date,
  task_id, source_type, source_id, created_at, updated_at, resolved_at`;

function iso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toItem(row: Record<string, unknown>): RegisterItem {
  return {
    id: String(row['id']), projectId: String(row['project_id']), kind: row['kind'] as RegisterKind,
    title: String(row['title']), detail: String(row['detail']), status: row['status'] as RegisterStatus,
    resolution: String(row['resolution']), owner: String(row['owner']),
    dueDate: row['due_date'] == null ? null : String(row['due_date']),
    taskId: row['task_id'] == null ? null : String(row['task_id']),
    sourceType: row['source_type'] as RegisterItem['sourceType'],
    sourceId: row['source_id'] == null ? null : String(row['source_id']),
    createdAt: iso(row['created_at']) ?? '', updatedAt: iso(row['updated_at']) ?? '', resolvedAt: iso(row['resolved_at']),
  };
}

async function section<T>(load: () => Promise<{ data: T; total: number }>, limit = SECTION_LIMIT): Promise<Section<T>> {
  try {
    const { data, total } = await load();
    return { available: true, data, total, truncated: total > limit };
  } catch {
    return { available: false, error: 'This section could not be loaded.' };
  }
}

const snippet = (value: unknown): string => {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH)}…` : flat;
};

export async function assertProject(db: Pool, projectId: string): Promise<Record<string, unknown>> {
  const r = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) throw new NotFoundError('Project');
  return row;
}

export async function getProjectCockpit(db: Pool, projectId: string, now = new Date()): Promise<ProjectCockpit> {
  const project = await assertProject(db, projectId);
  const count = async (sql: string): Promise<number> => Number(((await db.query(sql, [projectId])).rows[0] as { n: number }).n);
  const taskSection = (extra: string): Promise<Section<CockpitLink[]>> => section(async () => {
    const list = await db.query(`SELECT id, title, status, ${DATE_COLUMN} AS due_date, updated_at FROM tasks
      WHERE project_id = $1 AND ${extra} ORDER BY due_date ASC NULLS LAST, updated_at DESC LIMIT ${SECTION_LIMIT}`, [projectId]);
    return {
      total: await count(`SELECT COUNT(*)::int AS n FROM tasks WHERE project_id = $1 AND ${extra}`),
      data: list.rows.map((r: Record<string, unknown>) => ({
        label: String(r['title']), href: `/plan?taskId=${encodeURIComponent(String(r['id']))}`, at: iso(r['updated_at']),
        meta: r['due_date'] == null ? String(r['status']) : `${String(r['status'])} · due ${String(r['due_date'])}`,
      })),
    };
  });

  const [outcome, commitments, blockers, register, decisions, notes, outputs] = await Promise.all([
    section(() => Promise.resolve({
      total: 1,
      data: {
        goal: String(project['goal'] ?? ''), lifecycleState: String(project['lifecycle_state'] ?? 'active'),
        expectedOutputs: Array.isArray(project['expected_outputs']) ? project['expected_outputs'] as string[] : [],
        targetEndDate: project['target_end_date'] == null ? null : (iso(project['target_end_date']) ?? '').slice(0, DATE_LENGTH),
      },
    })),
    taskSection(`status NOT IN ('completed', 'waiting', 'inbox')`),
    taskSection(`status = 'waiting'`),
    section(async () => {
      const r = await db.query(`SELECT kind, status, COUNT(*)::int AS n FROM project_register_items WHERE project_id = $1 GROUP BY kind, status`, [projectId]);
      const openByKind: Record<RegisterKind, number> = { question: 0, risk: 0, issue: 0 };
      let open = 0; let resolved = 0;
      for (const row of r.rows as { kind: RegisterKind; status: RegisterStatus; n: number }[]) {
        if (row.status === 'open') { open += row.n; openByKind[row.kind] += row.n; } else resolved += row.n;
      }
      return { total: open + resolved, data: { open, resolved, openByKind } };
    }),
    section(async () => {
      const list = await db.query(`SELECT d.id, d.text, d.status, d.updated_at, s.id AS session_id FROM chat_decisions d
        JOIN ai_chat_sessions s ON s.id = d.session_id WHERE s.project_id = $1 ORDER BY d.updated_at DESC LIMIT ${SECTION_LIMIT}`, [projectId]);
      return {
        total: await count(`SELECT COUNT(*)::int AS n FROM chat_decisions d JOIN ai_chat_sessions s ON s.id = d.session_id WHERE s.project_id = $1`),
        data: list.rows.map((r: Record<string, unknown>) => ({
          label: snippet(r['text']), href: `/chat?session=${encodeURIComponent(String(r['session_id']))}`, at: iso(r['updated_at']),
          meta: String(r['status']), sourceId: String(r['id']),
        })),
      };
    }),
    section(async () => {
      const list = await db.query(`SELECT id, content, updated_at FROM notes WHERE project_id = $1 AND status = 'active'
        ORDER BY updated_at DESC LIMIT ${SECTION_LIMIT}`, [projectId]);
      return {
        total: await count(`SELECT COUNT(*)::int AS n FROM notes WHERE project_id = $1 AND status = 'active'`),
        data: list.rows.map((r: Record<string, unknown>) => ({
          label: snippet(r['content']) || 'Untitled note', href: `/think?noteId=${encodeURIComponent(String(r['id']))}`, at: iso(r['updated_at']),
        })),
      };
    }),
    section(async () => {
      const list = await db.query(`SELECT o.id, o.title, o.kind, o.updated_at, o.session_id,
          (SELECT MAX(version) FROM chat_output_versions v WHERE v.output_id = o.id) AS latest_version
        FROM chat_outputs o JOIN ai_chat_sessions s ON s.id = o.session_id WHERE s.project_id = $1
        ORDER BY o.updated_at DESC LIMIT ${SECTION_LIMIT}`, [projectId]);
      return {
        total: await count(`SELECT COUNT(*)::int AS n FROM chat_outputs o JOIN ai_chat_sessions s ON s.id = o.session_id WHERE s.project_id = $1`),
        data: list.rows.map((r: Record<string, unknown>) => ({
          label: String(r['title']), href: `/chat?session=${encodeURIComponent(String(r['session_id']))}`, at: iso(r['updated_at']),
          meta: `${String(r['kind'])} · v${String(r['latest_version'] ?? 1)}`,
        })),
      };
    }),
  ]);
  return { projectId, generatedAt: now.toISOString(), outcome, commitments, blockers, register, decisions, notes, outputs };
}

// ── Register ────────────────────────────────────────────────────────────────

export interface RegisterInput {
  kind?: unknown; title?: unknown; detail?: unknown; status?: unknown; resolution?: unknown;
  owner?: unknown; dueDate?: unknown; taskId?: unknown;
}

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new ValidationError(`${field} is required`, { [field]: 'required' });
    return undefined;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`, { [field]: 'invalid' });
  const trimmed = value.trim();
  if (required && trimmed === '') throw new ValidationError(`${field} is required`, { [field]: 'required' });
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`, { [field]: 'too long' });
  return trimmed;
}

function dueDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, DATE_LENGTH) !== value) {
    throw new ValidationError('dueDate must be a valid YYYY-MM-DD date', { dueDate: 'invalid' });
  }
  return value;
}

async function checkTask(db: Pool, projectId: string, taskId: unknown): Promise<string | null | undefined> {
  if (taskId === undefined) return undefined;
  if (taskId === null || taskId === '') return null;
  if (typeof taskId !== 'string') throw new ValidationError('taskId must be text', { taskId: 'invalid' });
  const r = await db.query('SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [taskId, projectId]);
  if (r.rowCount === 0) throw new ValidationError('Linked task must belong to this project', { taskId: 'not in project' });
  return taskId;
}

function kindOf(value: unknown, required: boolean): RegisterKind | undefined {
  if (value === undefined && !required) return undefined;
  if (!KINDS.includes(value as RegisterKind)) throw new ValidationError('kind must be question, risk or issue', { kind: 'invalid' });
  return value as RegisterKind;
}

export async function listRegister(
  db: Pool, projectId: string, opts: { status?: string | undefined; kind?: string | undefined; limit?: number | undefined; offset?: number | undefined },
): Promise<{ items: RegisterItem[]; total: number; limit: number; offset: number }> {
  await assertProject(db, projectId);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? REGISTER_PAGE_SIZE) || REGISTER_PAGE_SIZE, 1), REGISTER_MAX_PAGE_SIZE);
  const offset = Math.max(Math.trunc(opts.offset ?? 0) || 0, 0);
  const params: unknown[] = [projectId];
  let where = 'project_id = $1';
  if (opts.status === 'open' || opts.status === 'resolved') { params.push(opts.status); where += ` AND status = $${params.length}`; }
  if (opts.kind !== undefined && opts.kind !== '') { params.push(kindOf(opts.kind, true)); where += ` AND kind = $${params.length}`; }
  const [list, total] = await Promise.all([
    db.query(`SELECT ${REGISTER_COLUMNS} FROM project_register_items WHERE ${where}
      ORDER BY (status = 'open') DESC, due_date ASC NULLS LAST, created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    db.query(`SELECT COUNT(*)::int AS n FROM project_register_items WHERE ${where}`, params),
  ]);
  return { items: list.rows.map(toItem), total: Number((total.rows[0] as { n: number }).n), limit, offset };
}

export async function createRegisterItem(db: Pool, projectId: string, input: RegisterInput): Promise<RegisterItem> {
  await assertProject(db, projectId);
  const kind = kindOf(input.kind, true) as RegisterKind;
  const title = text(input.title, 'title', MAX_TITLE, true) as string;
  const task = await checkTask(db, projectId, input.taskId);
  const r = await db.query(
    `INSERT INTO project_register_items (project_id, kind, title, detail, owner, due_date, task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${REGISTER_COLUMNS}`,
    [projectId, kind, title, text(input.detail, 'detail', MAX_TEXT) ?? '', text(input.owner, 'owner', MAX_OWNER) ?? '',
      dueDate(input.dueDate) ?? null, task ?? null],
  );
  return toItem(r.rows[0] as Record<string, unknown>);
}

export async function updateRegisterItem(db: Pool, projectId: string, itemId: string, input: RegisterInput): Promise<RegisterItem> {
  const sets: string[] = [];
  const params: unknown[] = [itemId, projectId];
  const add = (column: string, value: unknown): void => { params.push(value); sets.push(`${column} = $${params.length}`); };
  const kind = kindOf(input.kind, false); if (kind !== undefined) add('kind', kind);
  const title = text(input.title, 'title', MAX_TITLE);
  if (title !== undefined) { if (title === '') throw new ValidationError('title is required', { title: 'required' }); add('title', title); }
  const detail = text(input.detail, 'detail', MAX_TEXT); if (detail !== undefined) add('detail', detail);
  const resolution = text(input.resolution, 'resolution', MAX_TEXT); if (resolution !== undefined) add('resolution', resolution);
  const owner = text(input.owner, 'owner', MAX_OWNER); if (owner !== undefined) add('owner', owner);
  const due = dueDate(input.dueDate); if (due !== undefined) add('due_date', due);
  const task = await checkTask(db, projectId, input.taskId); if (task !== undefined) add('task_id', task);
  if (input.status !== undefined) {
    if (input.status !== 'open' && input.status !== 'resolved') throw new ValidationError('status must be open or resolved', { status: 'invalid' });
    add('status', input.status);
    sets.push(input.status === 'resolved' ? 'resolved_at = COALESCE(resolved_at, NOW())' : 'resolved_at = NULL');
  }
  if (sets.length === 0) throw new ValidationError('No changes supplied', { body: 'empty' });
  const r = await db.query(
    `UPDATE project_register_items SET ${sets.join(', ')}, updated_at = NOW() WHERE id::text = $1 AND project_id = $2 RETURNING ${REGISTER_COLUMNS}`, params);
  if (r.rows.length === 0) throw new NotFoundError('Register item');
  return toItem(r.rows[0] as Record<string, unknown>);
}

export async function deleteRegisterItem(db: Pool, projectId: string, itemId: string): Promise<void> {
  const r = await db.query('DELETE FROM project_register_items WHERE id::text = $1 AND project_id = $2', [itemId, projectId]);
  if (r.rowCount === 0) throw new NotFoundError('Register item');
}

/** Promote a chat decision into the register. Idempotent per (project, decision); never touches the decision. */
export async function promoteDecision(
  db: Pool, projectId: string, decisionId: unknown, kindInput: unknown,
): Promise<{ item: RegisterItem; created: boolean }> {
  await assertProject(db, projectId);
  if (typeof decisionId !== 'string' || decisionId === '') throw new ValidationError('decisionId is required', { decisionId: 'required' });
  const kind = kindOf(kindInput ?? 'question', true) as RegisterKind;
  const d = await db.query(
    `SELECT d.id, d.text FROM chat_decisions d JOIN ai_chat_sessions s ON s.id = d.session_id WHERE d.id::text = $1 AND s.project_id = $2`,
    [decisionId, projectId]);
  const decision = d.rows[0] as { id: string; text: string } | undefined;
  if (decision === undefined) throw new NotFoundError('Decision in this project');
  const ins = await db.query(
    `INSERT INTO project_register_items (project_id, kind, title, source_type, source_id)
     VALUES ($1,$2,$3,'chat_decision',$4) ON CONFLICT DO NOTHING RETURNING ${REGISTER_COLUMNS}`,
    [projectId, kind, decision.text.slice(0, MAX_TITLE), String(decision.id)]);
  if (ins.rows.length > 0) return { item: toItem(ins.rows[0] as Record<string, unknown>), created: true };
  const existing = await db.query(
    `SELECT ${REGISTER_COLUMNS} FROM project_register_items WHERE project_id = $1 AND source_type = 'chat_decision' AND source_id = $2`,
    [projectId, String(decision.id)]);
  return { item: toItem(existing.rows[0] as Record<string, unknown>), created: false };
}
