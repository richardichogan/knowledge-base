/**
 * integrations/discovery/projectFit.ts — how much a discovered article matters to
 * Richard's live projects (IMAGINE first), as distinct from its editorial score.
 *
 * The editorial scorer judges whether an article is worth writing about. That misses
 * an article that is directly useful to a project he is delivering — e.g. an Azure
 * post on agent-first platforms is "familiar thought leadership" editorially, but core
 * reading for IMAGINE. This pass rates each article against the focus projects and
 * stores a ranking boost, which lifts it in Discover/Today, keeps it out of automatic
 * shelving, and restores it from Shelved if it was put away too early.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { FoundryClient } from '../../ai/foundryClient.js';

export type ProjectFitLevel = 1 | 2;

export interface FocusProject {
  id: string;
  name: string;
  importance: 'high' | 'normal';
  /** Goal/description plus the titles of its recent notes, so the model knows what the project is actually doing. */
  brief: string;
}

export interface ProjectFit {
  projectId: string;
  name: string;
  fit: ProjectFitLevel;
  why: string;
}

/** Discover rank multiplier = 1 + boost. A "directly useful to IMAGINE" article ranks as if it scored half again. */
export const PROJECT_BOOST = {
  highDirect: 0.5,
  highRelated: 0.2,
  normalDirect: 0.25,
  normalRelated: 0.08,
} as const;
/** At or above this boost an article is protected from shelving and restored if already shelved. */
export const PROJECT_PROTECT_BOOST = PROJECT_BOOST.highDirect;
/** Articles this recent are assessed (and, when they matter to a focus project, restored from Shelved). */
export const PROJECT_FIT_LOOKBACK_DAYS = 45;
const ARTICLES_PER_CALL = 10;
const ARTICLES_PER_PASS = 60;
const CALL_CONCURRENCY = 3;
const NOTE_TITLES_PER_PROJECT = 10;
const BRIEF_CHARS = 900;
const ARTICLE_BODY_CHARS = 500;
const WHY_CHARS = 200;
const PROJECT_FIT_MAX_TOKENS = 3_000;

/** Active projects whose work Discover should serve: high importance, or high-priority work projects. */
export async function loadFocusProjects(db: Pool): Promise<FocusProject[]> {
  const { rows } = await db.query<{ id: string; name: string; importance: string | null; goal: string | null; description: string | null; tags: string[] | null; notes: string[] | null }>(
    `SELECT p.id, p.name, p.importance, p.goal, p.description, p.tags,
            (SELECT array_agg(t.title) FROM (
               SELECT ci.title FROM content_items ci
                WHERE ci.source = 'note' AND ci.project_context = p.id AND ci.published_at > now() - interval '90 days'
                ORDER BY ci.published_at DESC LIMIT $1) t) AS notes
       FROM projects p
      WHERE COALESCE(p.lifecycle_state, 'active') = 'active'
        AND (p.importance IN ('critical', 'high') OR (p.priority IN ('high', 'urgent') AND COALESCE(p.category, 'work') = 'work'))
      ORDER BY (p.importance IN ('critical', 'high')) DESC, p.name`,
    [NOTE_TITLES_PER_PROJECT],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    importance: r.importance === 'high' || r.importance === 'critical' ? 'high' : 'normal',
    brief: [
      r.goal ?? '', r.description ?? '',
      (r.tags ?? []).length > 0 ? `Tags: ${(r.tags ?? []).join(', ')}` : '',
      (r.notes ?? []).length > 0 ? `Recent notes: ${(r.notes ?? []).join('; ')}` : '',
    ].filter((s) => s.trim() !== '').join(' ').slice(0, BRIEF_CHARS),
  }));
}

/** Changes whenever the focus projects (or what they are about) change, so articles are re-assessed. */
export function focusProjectsKey(projects: FocusProject[]): string {
  return createHash('sha1').update(JSON.stringify(projects.map((p) => [p.id, p.importance, p.brief]))).digest('hex').slice(0, 12);
}

export function projectBoost(fits: ProjectFit[], projects: FocusProject[]): number {
  let best = 0;
  for (const f of fits) {
    const high = projects.find((p) => p.id === f.projectId)?.importance === 'high';
    const boost = high
      ? (f.fit === 2 ? PROJECT_BOOST.highDirect : PROJECT_BOOST.highRelated)
      : (f.fit === 2 ? PROJECT_BOOST.normalDirect : PROJECT_BOOST.normalRelated);
    best = Math.max(best, boost);
  }
  return best;
}

export function buildProjectFitPrompt(projects: FocusProject[]): string {
  return [
    'You decide which of Richard Hogan\'s live projects each article is useful to. Richard is Global Chief Architect in IBM\'s Microsoft Practice.',
    'This is NOT an editorial judgement about whether he should write about it — only whether reading it helps a project\'s actual work.',
    '',
    'Projects:',
    ...projects.map((p) => `- id "${p.id}" — ${p.name}${p.importance === 'high' ? ' (HIGH importance)' : ''}: ${p.brief || '(no description)'}`),
    '',
    'For each article, list only the projects it genuinely serves:',
    '- fit 2 = directly relevant: the platform, pattern, risk, capability or market move bears on what the project is designing, building, governing or selling now.',
    '- fit 1 = useful background for the project.',
    'Omit a project when the link is only a shared buzzword. Most articles serve no project; an empty list is normal.',
    '',
    'Reply with ONLY JSON, no fences: {"results":[{"key":"<article key>","projects":[{"id":"<project id>","fit":1|2,"why":"<one short clause>"}]}]}',
  ].join('\n');
}

export interface FitArticle { id: string; title: string; body: string | null; url: string | null }

/** Parses the model's answer; ignores unknown keys/projects and malformed entries. */
export function parseProjectFitResponse(raw: string, keys: Map<string, string>, projects: FocusProject[]): Map<string, ProjectFit[]> {
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const parsed = JSON.parse(cleaned) as { results?: Array<{ key?: unknown; projects?: unknown }> };
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out = new Map<string, ProjectFit[]>();
  for (const r of parsed.results ?? []) {
    const articleId = typeof r.key === 'string' ? keys.get(r.key) : undefined;
    if (articleId === undefined) continue;
    const fits: ProjectFit[] = [];
    for (const f of Array.isArray(r.projects) ? r.projects as Array<Record<string, unknown>> : []) {
      const project = typeof f['id'] === 'string' ? byId.get(f['id']) : undefined;
      const fit = Number(f['fit']);
      if (project === undefined || (fit !== 1 && fit !== 2) || fits.some((x) => x.projectId === project.id)) continue;
      fits.push({ projectId: project.id, name: project.name, fit, why: typeof f['why'] === 'string' ? f['why'].slice(0, WHY_CHARS) : '' });
    }
    out.set(articleId, fits.sort((a, b) => b.fit - a.fit));
  }
  return out;
}

/** Rates a handful of articles against the focus projects in one call. */
export async function assessProjectFit(client: FoundryClient, projects: FocusProject[], articles: FitArticle[]): Promise<Map<string, ProjectFit[]>> {
  if (projects.length === 0 || articles.length === 0) return new Map();
  const keys = new Map(articles.map((a, i) => [`a${(i + 1).toString()}`, a.id]));
  const prompt = articles.map((a, i) =>
    `key: a${(i + 1).toString()}\nTitle: ${a.title}\nURL: ${a.url ?? ''}\nSummary: ${(a.body ?? '').slice(0, ARTICLE_BODY_CHARS) || '(none)'}`).join('\n\n');
  const raw = await client.chatBulk([{ role: 'system', content: buildProjectFitPrompt(projects) }, { role: 'user', content: prompt }], PROJECT_FIT_MAX_TOKENS);
  return parseProjectFitResponse(raw, keys, projects);
}

/**
 * Assesses recent scored articles not yet rated against the current focus projects. Articles that are directly
 * useful to a high-importance project and were shelved automatically go back to To Review. Returns how many
 * articles were assessed (0 when there is nothing left to do).
 */
export async function runProjectFitPass(db: Pool): Promise<number> {
  const projects = await loadFocusProjects(db);
  if (projects.length === 0) return 0;
  const key = focusProjectsKey(projects);
  const { rows } = await db.query<FitArticle>(
    `SELECT id, title, body, url FROM content_items
      WHERE source = 'discovered-article' AND relevance_explanation IS NOT NULL
        AND published_at > now() - $1 * interval '1 day'
        AND COALESCE(metadata->>'projectFitKey', '') <> $2
        AND COALESCE((metadata->>'projectFitAttempts')::int, 0) < 3
      ORDER BY published_at DESC LIMIT $3`,
    [PROJECT_FIT_LOOKBACK_DAYS, key, ARTICLES_PER_PASS],
  );
  if (rows.length === 0) return 0;

  const client = new FoundryClient('article-project-fit');
  const chunks: FitArticle[][] = [];
  for (let i = 0; i < rows.length; i += ARTICLES_PER_CALL) chunks.push(rows.slice(i, i + ARTICLES_PER_CALL));
  let assessed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const chunk = chunks[next++]!;
      let results: Map<string, ProjectFit[]>;
      try {
        results = await assessProjectFit(client, projects, chunk);
      } catch (err) {
        console.warn('[ProjectFit] assessment failed:', err instanceof Error ? err.message : String(err));
        await db.query(
          `UPDATE content_items SET metadata = metadata || jsonb_build_object('projectFitAttempts', COALESCE((metadata->>'projectFitAttempts')::int, 0) + 1) WHERE id = ANY($1)`,
          [chunk.map((a) => a.id)],
        ).catch(() => undefined);
        continue;
      }
      for (const article of chunk) {
        const fits = results.get(article.id) ?? [];
        await saveProjectFit(db, article.id, fits, projectBoost(fits, projects), key);
        assessed++;
      }
    }
  };
  await Promise.all(Array.from({ length: CALL_CONCURRENCY }, worker));
  return assessed;
}

/** Stores the assessment and restores an automatically shelved article that matters to a focus project. */
export async function saveProjectFit(db: Pool, articleId: string, fits: ProjectFit[], boost: number, key: string): Promise<void> {
  await db.query(
    `UPDATE content_items
        SET metadata = metadata || jsonb_build_object('projectFit', $2::jsonb, 'projectBoost', $3::numeric, 'projectFitKey', $4::text)
            || (CASE WHEN $3::numeric >= $5::numeric AND workflow_state = 'shelved' AND metadata->>'shelvedReason' IN ('stale', 'low')
                     THEN jsonb_build_object('restoredAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'restoredReason', 'project')
                     ELSE '{}'::jsonb END),
            workflow_state = CASE WHEN $3::numeric >= $5::numeric AND workflow_state = 'shelved' AND metadata->>'shelvedReason' IN ('stale', 'low')
                                  THEN 'to-review' ELSE workflow_state END
      WHERE id = $1`,
    [articleId, JSON.stringify(fits), boost, key, PROJECT_PROTECT_BOOST],
  );
}
