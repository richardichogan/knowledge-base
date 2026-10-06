/**
 * build/decompose.ts
 * Turns a spec into dependency-ordered tasks sized for one cloud coding-agent
 * PR each. Ported from sdlc-orchestrator's PLAN → ISSUES → REVIEW → REWRITE
 * pipeline, trimmed to a single review round and extended with a per-task
 * agent suggestion (Copilot vs Claude).
 */
import { getFoundryClient } from '../ai/foundryClient.js';
import { AiError, ValidationError } from '../types/errors.js';
import { BUILD_AGENTS, type BuildAgent } from './githubAgents.js';

export const MAX_BUILD_TASKS = 20;
const MAX_TASK_TITLE_CHARS = 250;
const DECOMPOSE_MAX_TOKENS = 12_000;
const REVIEW_MAX_TOKENS = 2_000;
export const TASK_SIZES = ['S', 'M', 'L'] as const;
export type TaskSize = typeof TASK_SIZES[number];

export interface TaskDraft {
  key: string;
  title: string;
  body: string;
  agent: BuildAgent;
  agentReason: string;
  size: TaskSize;
  dependsOn: string[];
}

export interface Decomposition {
  planNotes: string;
  tasks: TaskDraft[];
  reviewNotes: string[];
}

const TASKS_SYSTEM_PROMPT = `You are a principal engineer decomposing a spec into work for GitHub cloud coding agents.
Each task becomes ONE GitHub issue that ONE agent implements in ONE pull request, starting from the latest base branch.

Rules:
- 2 to ${MAX_BUILD_TASKS} tasks. Prefer fewer, cohesive tasks over many tiny ones; never one giant task.
- Each task must be independently implementable, reviewable and testable once its dependencies are merged.
- Order tasks so foundations (schema, types, shared modules) come first. Declare dependencies explicitly by key.
- Two tasks that would edit the same files heavily must depend on one another, not run in parallel.
- Do not invent external integrations, infrastructure or scope that the spec does not ask for.
- Do not include deployment to production. Do not include tasks that need human-only access (secrets, portals).
- Every task must state how to validate it (exact commands, tests, behaviours).

Agent choice per task ("copilot" or "claude"):
- "copilot": well-scoped, conventional changes — CRUD, wiring, tests, docs, UI following existing patterns.
- "claude": tasks needing deeper reasoning — tricky algorithms, cross-cutting refactors, ambiguous design, concurrency.
- Give a one-line reason.

Each task body must be markdown with exactly these sections:
## Why
## Scope
## Implementation Steps
## Acceptance Criteria
## Validation
## Out of Scope

Return JSON only:
{"plan_notes": "2-5 sentences on approach and sequencing",
 "tasks": [{"key": "T1", "title": "imperative, max 72 chars", "body": "markdown", "agent": "copilot|claude",
            "agent_reason": "...", "size": "S|M|L", "depends_on": ["T0"]}]}`;

const REVIEW_SYSTEM_PROMPT = `You are a strict quality gate for task decompositions handed to AI coding agents.
Fail the set if any task is vague, lacks concrete implementation steps or validation, is too large for one PR,
invents scope not in the spec, or has missing / wrong dependencies (including parallel tasks that would clash on the same files).
Return JSON only: {"pass": boolean, "issues": ["concrete, actionable problem"]}`;

const REWRITE_SYSTEM_PROMPT = `Rewrite the task decomposition to fix every reviewer issue. Keep what was already good.
Return JSON only in exactly the same shape as before: {"plan_notes": "...", "tasks": [...]}.`;

function parseJson<T>(text: string): T | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return null;
  try { return JSON.parse(match[0]) as T; } catch { return null; }
}

interface RawTask { key?: unknown; title?: unknown; body?: unknown; agent?: unknown; agent_reason?: unknown; size?: unknown; depends_on?: unknown }
interface RawDecomposition { plan_notes?: unknown; tasks?: unknown }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Normalises raw model output into drafts (lenient on cosmetics, strict on structure — see validateTaskGraph). */
export function normaliseDrafts(raw: unknown): TaskDraft[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawTask[]).map((t, i): TaskDraft => {
    const agent = BUILD_AGENTS.find((a) => a === str(t.agent).toLowerCase()) ?? 'copilot';
    const size = TASK_SIZES.find((s) => s === str(t.size).toUpperCase()) ?? 'M';
    return {
      key: str(t.key) !== '' ? str(t.key) : `T${i + 1}`,
      title: str(t.title).slice(0, MAX_TASK_TITLE_CHARS),
      body: str(t.body),
      agent,
      agentReason: str(t.agent_reason),
      size,
      dependsOn: Array.isArray(t.depends_on) ? (t.depends_on as unknown[]).map(str).filter((d) => d !== '') : [],
    };
  });
}

/**
 * Throws ValidationError unless the drafts form a usable graph: 1..MAX tasks,
 * unique keys, non-empty titles, known dependencies, no self-dependency, no cycles.
 * Returns the drafts in a stable topological order.
 */
export function validateTaskGraph(drafts: TaskDraft[]): TaskDraft[] {
  if (drafts.length === 0) throw new ValidationError('Decomposition produced no tasks', { tasks: 'empty' });
  if (drafts.length > MAX_BUILD_TASKS) throw new ValidationError(`At most ${MAX_BUILD_TASKS} tasks`, { tasks: 'too_many' });
  const keys = new Set<string>();
  for (const d of drafts) {
    if (d.title === '') throw new ValidationError(`Task ${d.key} has no title`, { [`tasks.${d.key}.title`]: 'required' });
    if (keys.has(d.key)) throw new ValidationError(`Duplicate task key ${d.key}`, { [`tasks.${d.key}.key`]: 'duplicate' });
    keys.add(d.key);
  }
  for (const d of drafts) {
    for (const dep of d.dependsOn) {
      if (dep === d.key) throw new ValidationError(`Task ${d.key} depends on itself`, { [`tasks.${d.key}.dependsOn`]: 'self' });
      if (!keys.has(dep)) throw new ValidationError(`Task ${d.key} depends on unknown task ${dep}`, { [`tasks.${d.key}.dependsOn`]: 'unknown' });
    }
  }
  // Kahn's algorithm, preserving the original order among ready tasks.
  const remaining = new Map(drafts.map((d) => [d.key, new Set(d.dependsOn)]));
  const ordered: TaskDraft[] = [];
  while (ordered.length < drafts.length) {
    const ready = drafts.find((d) => remaining.has(d.key) && remaining.get(d.key)?.size === 0);
    if (ready === undefined) {
      throw new ValidationError('Task dependencies contain a cycle', { tasks: 'cycle' });
    }
    ordered.push(ready);
    remaining.delete(ready.key);
    for (const deps of remaining.values()) deps.delete(ready.key);
  }
  return ordered;
}

function asDecomposition(text: string): { planNotes: string; tasks: TaskDraft[] } | null {
  const parsed = parseJson<RawDecomposition>(text);
  if (parsed === null) return null;
  return { planNotes: str(parsed.plan_notes), tasks: normaliseDrafts(parsed.tasks) };
}

/** Runs the LLM pipeline: draft → review → (rewrite once if the review fails) → validate. */
export async function decomposeSpec(input: { title: string; specMarkdown: string; repo: string; context?: string | undefined }): Promise<Decomposition> {
  const client = getFoundryClient('build-decompose');
  const userBlock = [
    `Repository: ${input.repo}`,
    `Spec title: ${input.title}`,
    input.context !== undefined && input.context !== '' ? `Context:\n${input.context}` : '',
    `Spec:\n${input.specMarkdown}`,
  ].filter((s) => s !== '').join('\n\n');

  const draftText = await client.chat('reasoning', [
    { role: 'system', content: TASKS_SYSTEM_PROMPT },
    { role: 'user', content: userBlock },
  ], DECOMPOSE_MAX_TOKENS);
  let current = asDecomposition(draftText);
  if (current === null || current.tasks.length === 0) throw new AiError('Decomposition did not return valid JSON tasks');

  const reviewText = await client.chat('reasoning', [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: `${userBlock}\n\nCandidate decomposition:\n${JSON.stringify(current)}` },
  ], REVIEW_MAX_TOKENS).catch(() => '');
  const review = parseJson<{ pass?: unknown; issues?: unknown }>(reviewText);
  const reviewNotes = Array.isArray(review?.issues) ? (review.issues as unknown[]).map(str).filter((s) => s !== '') : [];

  if (review?.pass === false && reviewNotes.length > 0) {
    const rewriteText = await client.chat('reasoning', [
      { role: 'system', content: `${TASKS_SYSTEM_PROMPT}\n\n${REWRITE_SYSTEM_PROMPT}` },
      { role: 'user', content: `${userBlock}\n\nPrevious decomposition:\n${JSON.stringify(current)}\n\nReviewer issues:\n- ${reviewNotes.join('\n- ')}` },
    ], DECOMPOSE_MAX_TOKENS).catch(() => '');
    const rewritten = asDecomposition(rewriteText);
    if (rewritten !== null && rewritten.tasks.length > 0) current = rewritten;
  }

  return { planNotes: current.planNotes, tasks: validateTaskGraph(current.tasks), reviewNotes };
}
