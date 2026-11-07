/**
 * goals/goalReview.ts — keeps the goals honest. Monthly, Athena reviews each measure's progress and the workstreams
 * that serve no goal, and proposes target/deadline changes and project links. Nothing changes until Richard accepts
 * each one. Richard (or Athena on his word) can also set a target or link a workstream or task directly.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getFoundryClient } from '../ai/foundryClient.js';
import { NotFoundError, ValidationError } from '../types/errors.js';
import { diffTaskForActivity, comparableTaskRow, recordTaskEdit, type TaskActivityActor } from '../work/taskEditActivity.js';
import { decideProposal, recordProposal } from './proposals.js';
import {
  EMPTY_GOAL_CONFIG, GOALS, GOAL_CONFIG_KEY, applyGoalConfig, goalConfig, goalsStatus, mutateState,
  type GoalAdjustment, type GoalConfig, type GoalId, type ProjectGoal,
} from './goals.js';

const MAX_TOKENS = 3_000;
const TIMEOUT_MS = 120_000;
const MAX_ADJUSTMENTS = 200;
const MAX_TARGET = 1000;
const UNLINKED_TASKS = 50;
const GOAL_IDS: readonly ProjectGoal[] = [...GOALS.map(g => g.id), 'none'];

export interface GoalLinks {
  projects: Array<{ id: string; name: string; goalId: ProjectGoal | null; openTasks: number }>;
  unlinkedTasks: Array<{ id: string; title: string; projectId: string | null; projectName: string | null }>;
}

const projectGoal = (v: unknown): ProjectGoal => {
  if (typeof v !== 'string' || !GOAL_IDS.includes(v as ProjectGoal)) throw new ValidationError(`Choose a goal: ${GOAL_IDS.join(', ')}.`);
  return v as ProjectGoal;
};

/** Which goal each workstream serves (null = not yet decided) and open tasks that sit outside every goal. */
export async function goalLinks(db: Pool): Promise<GoalLinks> {
  const config = await goalConfig(db);
  const goals = applyGoalConfig(config);
  const owner = new Map(goals.flatMap(g => g.projects.map(p => [p, g.id] as const)));
  const projects = (await db.query<{ id: string; name: string; open: number }>(
    `SELECT p.id, p.name, COUNT(t.id) FILTER (WHERE NOT t.archived AND t.status <> 'completed')::int AS open
       FROM projects p LEFT JOIN tasks t ON t.project_id = p.id GROUP BY p.id, p.name ORDER BY p.name`)).rows;
  const linked = projects.map(p => ({ id: p.id, name: p.name, goalId: owner.get(p.id) ?? (config.projectGoals[p.id] === 'none' ? 'none' as const : null), openTasks: p.open }));
  const outside = linked.filter(p => p.goalId === null).map(p => p.id);
  const unlinkedTasks = (await db.query<{ id: string; title: string; project_id: string | null; name: string | null }>(
    `SELECT t.id::text, t.title, t.project_id, p.name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
      WHERE NOT t.archived AND t.status <> 'completed' AND (t.project_id IS NULL OR t.project_id = ANY($1))
      ORDER BY t.updated_at DESC LIMIT $2`, [outside, UNLINKED_TASKS])).rows
    .map(r => ({ id: r.id, title: r.title, projectId: r.project_id, projectName: r.name }));
  return { projects: linked, unlinkedTasks };
}

/** Links a workstream to a goal, or marks it as not goal work. Its tasks follow. */
export async function linkProject(db: Pool, projectId: unknown, goalId: unknown): Promise<GoalLinks> {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new ValidationError('Choose the workstream.');
  const target = projectGoal(goalId);
  const exists = await db.query('SELECT 1 FROM projects WHERE id=$1', [projectId]);
  if (!exists.rowCount) throw new NotFoundError('Workstream');
  await mutateState<GoalConfig, void>(db, GOAL_CONFIG_KEY, { ...EMPTY_GOAL_CONFIG }, c => {
    c.projectGoals = { ...(c.projectGoals ?? {}), [projectId]: target };
  });
  return goalLinks(db);
}

/** Links one task by moving it into the goal's home workstream, recorded in the task's activity like any edit. */
export async function linkTask(db: Pool, taskId: unknown, goalId: unknown, actor: TaskActivityActor): Promise<GoalLinks> {
  if (typeof taskId !== 'string' || !taskId.trim()) throw new ValidationError('Choose the task.');
  const target = projectGoal(goalId);
  if (target === 'none') throw new ValidationError('Link the task to a goal, or mark its workstream as not goal work.');
  const home = GOALS.find(g => g.id === target)!.homeProject;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const before = (await client.query<Record<string, unknown>>('SELECT * FROM tasks WHERE id::text=$1 FOR UPDATE', [taskId])).rows[0];
    if (!before) throw new NotFoundError('Task');
    const after = (await client.query<Record<string, unknown>>('UPDATE tasks SET project_id=$2, updated_at=NOW() WHERE id::text=$1 RETURNING *', [taskId, home])).rows[0]!;
    await recordTaskEdit(client, taskId, actor, await diffTaskForActivity(client, comparableTaskRow(before), comparableTaskRow(after)));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const config = await goalConfig(db);
  if (!applyGoalConfig(config).some(g => g.id === target && g.projects.includes(home))) await linkProject(db, home, target);
  return goalLinks(db);
}

function measureOf(id: unknown) {
  const m = GOALS.flatMap(g => g.measures).find(x => x.id === id);
  if (!m) throw new NotFoundError('Goal measure');
  return m;
}

/** Sets a measure's target (count/automatic) or deadline (milestone) directly. */
export async function setMeasure(db: Pool, measureId: unknown, value: unknown): Promise<GoalConfig> {
  const m = measureOf(measureId);
  const override = m.kind === 'milestone' ? { deadline: deadlineValue(value) } : { target: targetValue(value) };
  return mutateState<GoalConfig, GoalConfig>(db, GOAL_CONFIG_KEY, { ...EMPTY_GOAL_CONFIG }, c => {
    c.measures = { ...(c.measures ?? {}), [m.id]: override };
    return c;
  });
}
function targetValue(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_TARGET) throw new ValidationError('Use a whole-number target from 0 to 1000.');
  return n;
}
function deadlineValue(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new ValidationError('Use a deadline as YYYY-MM-DD.');
  return v;
}

const PROMPT = [
  'You are Athena reviewing Richard\'s four working goals at the start of a month. Propose only changes he would clearly want.',
  'Target/deadline changes: only when a measure has been consistently far above or below target, or a milestone deadline is unrealistic. Give the evidence in one sentence. At most one per measure; usually none.',
  'Links: for each unlinked workstream, say which goal it serves (imagine, practice, voice, attention) or "none" when it is not goal work (side projects, personal apps, archived ideas). Only use a goal when its purpose clearly matches.',
  'UK English. Never invent measures or workstreams.',
].join('\n');

interface RawAdjustment { kind: string; measureId: string; projectId: string; goalId: string; to: string; reason: string }

/** Monthly review: proposes target/deadline changes and workstream links, each for Richard to accept or dismiss. */
export async function runGoalReview(db: Pool, trigger: 'job' | 'manual' | 'athena' = 'manual'): Promise<{ proposed: number; skipped?: boolean }> {
  const config = await goalConfig(db);
  // The job runs every Monday; only the first run in a calendar month reviews.
  if (trigger === 'job' && config.lastReview?.slice(0, 7) === new Date().toISOString().slice(0, 7)) return { proposed: 0, skipped: true };
  const status = await goalsStatus(db);
  const links = await goalLinks(db);
  const goals = applyGoalConfig(config);
  const pending = new Set(config.adjustments.filter(a => a.status === 'proposed').map(a => a.measureId ?? a.projectId));
  const facts = {
    today: new Date().toISOString().slice(0, 10),
    goals: goals.map(g => ({ id: g.id, name: g.name, why: g.why, projects: g.projects,
      measures: g.measures.map(m => ({ id: m.id, kind: m.kind, label: m.label, ...(m.kind === 'milestone' ? { deadline: m.deadline } : { target: m.target }),
        status: status.find(s => s.id === g.id)?.measures.find(x => x.id === m.id)?.summary ?? '' })) })),
    unlinkedWorkstreams: links.projects.filter(p => p.goalId === null && !pending.has(p.id)).map(p => ({ id: p.id, name: p.name, openTasks: p.openTasks })),
  };
  const raw = await getFoundryClient('goal-review').chat('standard',
    [{ role: 'system', content: PROMPT }, { role: 'user', content: JSON.stringify(facts) }], MAX_TOKENS, TIMEOUT_MS, undefined, {
      name: 'goal_review', schema: { type: 'object', additionalProperties: false, required: ['adjustments'], properties: { adjustments: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['kind', 'measureId', 'projectId', 'goalId', 'to', 'reason'],
        properties: { kind: { type: 'string', enum: ['target', 'deadline', 'link'] }, measureId: { type: 'string' }, projectId: { type: 'string' },
          goalId: { type: 'string', enum: [...GOAL_IDS, ''] }, to: { type: 'string' }, reason: { type: 'string' } } } } } },
    });
  const parsed = JSON.parse(raw) as { adjustments?: RawAdjustment[] };
  const at = new Date().toISOString();
  const fresh: GoalAdjustment[] = [];
  const allMeasures = goals.flatMap(g => g.measures);
  for (const r of parsed.adjustments ?? []) {
    const reason = typeof r.reason === 'string' ? r.reason.trim().slice(0, 400) : '';
    if (!reason) continue;
    if (r.kind === 'link') {
      const p = links.projects.find(x => x.id === r.projectId && x.goalId === null);
      if (!p || pending.has(p.id) || !GOAL_IDS.includes(r.goalId as ProjectGoal)) continue;
      const to = r.goalId === 'none' ? 'Not goal work' : GOALS.find(g => g.id === r.goalId)!.name;
      fresh.push({ id: randomUUID(), kind: 'link', projectId: p.id, goalId: r.goalId as ProjectGoal, from: p.name, to, reason, at, status: 'proposed', decidedAt: null });
      pending.add(p.id);
    } else {
      const m = allMeasures.find(x => x.id === r.measureId);
      if (!m || pending.has(m.id)) continue;
      try {
        if (r.kind === 'deadline' && m.kind === 'milestone') {
          const to = deadlineValue(r.to);
          if (to !== m.deadline) fresh.push({ id: randomUUID(), kind: 'deadline', measureId: m.id, from: m.deadline, to, reason, at, status: 'proposed', decidedAt: null });
        } else if (r.kind === 'target' && m.kind !== 'milestone') {
          const to = targetValue(r.to);
          if (to !== m.target) fresh.push({ id: randomUUID(), kind: 'target', measureId: m.id, from: String(m.target), to: String(to), reason, at, status: 'proposed', decidedAt: null });
        }
      } catch { continue; }
      pending.add(m.id);
    }
  }
  await mutateState<GoalConfig, void>(db, GOAL_CONFIG_KEY, { ...EMPTY_GOAL_CONFIG }, c => {
    c.adjustments = [...fresh, ...(c.adjustments ?? [])].slice(0, MAX_ADJUSTMENTS);
    c.lastReview = at;
  });
  for (const a of fresh) await recordProposal(db, 'goal-adjustment', `adjust:${a.id}`, adjustmentTitle(a, allMeasures)).catch(() => { /* reporting only */ });
  return { proposed: fresh.length };
}

function adjustmentTitle(a: GoalAdjustment, measures: Array<{ id: string; label: string }>): string {
  if (a.kind === 'link') return `Link ${a.from} → ${a.to}`;
  return `${measures.find(m => m.id === a.measureId)?.label ?? a.measureId}: ${a.from} → ${a.to}`;
}

/** Accepting applies the change; dismissing leaves everything as it is. */
export async function decideAdjustment(db: Pool, id: unknown, accept: boolean): Promise<GoalConfig> {
  if (typeof id !== 'string' || !id) throw new ValidationError('Choose the adjustment.');
  const result = await mutateState<GoalConfig, GoalConfig>(db, GOAL_CONFIG_KEY, { ...EMPTY_GOAL_CONFIG }, c => {
    const a = (c.adjustments ?? []).find(x => x.id === id);
    if (!a) throw new NotFoundError('Goal adjustment');
    if (a.status !== 'proposed') throw new ValidationError('That adjustment has already been decided.');
    a.status = accept ? 'accepted' : 'dismissed';
    a.decidedAt = new Date().toISOString();
    if (accept && a.kind === 'link' && a.projectId && a.goalId) c.projectGoals = { ...(c.projectGoals ?? {}), [a.projectId]: a.goalId };
    if (accept && a.kind === 'target' && a.measureId) c.measures = { ...(c.measures ?? {}), [a.measureId]: { target: Number(a.to) } };
    if (accept && a.kind === 'deadline' && a.measureId) c.measures = { ...(c.measures ?? {}), [a.measureId]: { deadline: a.to } };
    return c;
  });
  await decideProposal(db, `adjust:${id}`, accept ? 'accepted' : 'dismissed').catch(() => { /* reporting only */ });
  return result;
}

export async function goalSettings(db: Pool) {
  const [config, links] = await Promise.all([goalConfig(db), goalLinks(db)]);
  const measures = GOALS.flatMap(g => g.measures.map(m => ({ goalId: g.id as GoalId, id: m.id, label: m.label, kind: m.kind })));
  return { adjustments: config.adjustments.filter(a => a.status === 'proposed'), measures, overrides: config.measures, lastReview: config.lastReview, links };
}
