import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { EvalAdapter, EvalAnswer } from './knowledge-eval.js';
import type { EvalQuestion } from './fixtures/knowledge/evalPack.js';
import { CORPUS, EDGES, type CorpusRecord } from './fixtures/knowledge/corpus.js';
import { FIXTURE_PROJECTS } from './fixtures/knowledge/constants.js';
import { migrateIsolated } from './knowledge-pg-migrate.js';

/**
 * Live evaluation adapter (spec 12.2). Runs each question through the real handleConversationTurn with the real
 * configured Azure OpenAI route against the SYNTHETIC corpus seeded into the app's real tables on an ISOLATED
 * loopback PostgreSQL. Refuses anything else. Credentials come only from process env (never read from .env,
 * never logged). Env: KNOWLEDGE_EVAL_LIVE=approved, KNOWLEDGE_EVAL_DATABASE_URL (loopback), AZURE_OPENAI_* for the model,
 * optional KNOWLEDGE_ORCHESTRATION, KNOWLEDGE_EVAL_TRACE (JSONL path).
 */
const url = process.env.KNOWLEDGE_EVAL_DATABASE_URL;
if (process.env.KNOWLEDGE_EVAL_LIVE !== 'approved') throw new Error('KNOWLEDGE_EVAL_LIVE=approved required');
if (!url) throw new Error('KNOWLEDGE_EVAL_DATABASE_URL (isolated loopback PostgreSQL) is required');
const host = new URL(url).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error(`Refusing non-loopback database host ${host}`);
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'development';

const dbName = new URL(url).pathname.slice(1);
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName])).rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
await admin.end();
await migrateIsolated(url);

const { handleConversationTurn } = await import('../src/ai/conversationService.js');
const { emptyContextUsed } = await import('../src/ai/contextUsage.js');
const { env } = await import('../src/config/env.js');
const pool = new pg.Pool({ connectionString: url, max: 4 });

const projectAlias = new Map<string, string>();
for (const r of CORPUS) if (r.kind === 'project' && r.projectId) projectAlias.set(r.projectId, r.alias);
const watchlistIds = new Map<string, string>();
const watchlistAlias = new Map<string, string>();
const aliasById = new Map(CORPUS.map((r) => [r.id, r.alias] as const));

const noteJson = (title: string, text: string): string => JSON.stringify({
  title, contentType: 'note',
  contentJson: JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }], children: [] }]),
});

async function seed(): Promise<void> {
  watchlistIds.clear(); watchlistAlias.clear();
  await pool.query(`TRUNCATE content_items, notes, tasks, nodes, athena_memories, ai_chat_sessions, canvases, discover_watchlists CASCADE; DELETE FROM projects`);
  const goalOf = new Map(CORPUS.filter((r) => r.kind === 'project').map((r) => [r.projectId, r] as const));
  for (const p of FIXTURE_PROJECTS) {
    const rec = goalOf.get(p.id);
    await pool.query(`INSERT INTO projects (id, name, goal, description, target_end_date) VALUES ($1,$2,$3,$4,$5)`,
      [p.id, p.name, p.goal, rec?.text ?? '', rec?.meta?.['targetDate'] ?? p.targetDate]);
  }
  for (const r of CORPUS) await insert(r);
  const nodeId = new Map<string, string>();
  const node = async (r: CorpusRecord): Promise<string> => {
    const have = nodeId.get(r.alias); if (have) return have;
    const id = randomUUID();
    await pool.query(`INSERT INTO nodes (id, ref_id, ref_type, title) VALUES ($1,$2,$3,$4)`,
      [id, r.kind === 'project' ? r.projectId : r.id, r.kind === 'note' ? 'note' : r.kind === 'task' ? 'task' : r.kind === 'project' ? 'project' : 'content-item', r.title]);
    nodeId.set(r.alias, id); return id;
  };
  const byAlias = new Map(CORPUS.map((r) => [r.alias, r] as const));
  for (const e of EDGES) {
    const a = byAlias.get(e.from), b = byAlias.get(e.to);
    if (!a || !b || a.deleted || b.deleted) continue;
    await pool.query(`INSERT INTO edges (source_node_id, target_node_id, edge_type, confidence) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [await node(a), await node(b), e.type, e.confidence ?? 1]);
  }
}

async function insert(r: CorpusRecord): Promise<void> {
  if (r.deleted) return;
  const created = r.createdAt, updated = r.updatedAt;
  if (r.kind === 'project') return;
  if (r.kind === 'task') {
    const status = r.state === 'completed' || r.state === 'archived' ? 'completed' : r.state === 'blocked' ? 'waiting' : 'backlog';
    const due = typeof r.meta?.['due'] === 'string' ? String(r.meta['due']).slice(0, 10) : null;
    await pool.query(`INSERT INTO tasks (id, title, body, status, priority, project_id, due_date, archived, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.id, r.title, r.text, status, r.meta?.['priority'] ?? 'normal', r.projectId, due, r.state === 'archived', created, updated]);
    return;
  }
  if (r.kind === 'chat') {
    // Real past-chat reader tables: ai_chat_sessions + ai_chat_messages (user/assistant turns parsed from the corpus text).
    await pool.query(`INSERT INTO ai_chat_sessions (id, title, project_id, updated_at) VALUES ($1,$2,$3,$4)`, [r.id, r.title, r.projectId ?? null, updated]);
    const turns = [...r.text.matchAll(/(User|Assistant): (.*?)(?= (?:User|Assistant): |$)/gs)];
    let n = 0;
    for (const m of turns) {
      await pool.query(`INSERT INTO ai_chat_messages (session_id, role, content, persona, created_at) VALUES ($1,$2,$3,'general',$4::timestamptz + ($5 || ' seconds')::interval)`, [r.id, m[1]!.toLowerCase(), m[2]!.trim(), created, String(n++)]);
    }
    return;
  }
  if (r.kind === 'canvas') {
    // Real diagram reader tables: canvases (diagram type) + canvas_diagrams (document nodes/edges).
    await pool.query(`INSERT INTO canvases (id, title, description, project, canvas_type, created_at, updated_at) VALUES ($1,$2,$3,$4,'diagram',$5,$6)`, [r.id, r.title, '', r.projectId ?? null, created, updated]);
    const nodes = [{ id: randomUUID(), kind: 'rectangle', label: r.text, description: '', x: 0, y: 0, width: 240, height: 80, stroke: '#1d4ed8', fill: '#ffffff', parentId: null, assetId: null }];
    await pool.query(`INSERT INTO canvas_diagrams (canvas_id, revision, document, updated_at) VALUES ($1, 1, $2::jsonb, $3)`, [r.id, JSON.stringify({ version: 1, nodes, edges: [] }), updated]);
    return;
  }
  if (r.kind === 'watchlist') {
    // Real watchlist tables: one watchlist per title, runs keyed by corpus id (Adjuster agent watch has two runs).
    let wid = watchlistIds.get(r.title);
    const version = Number(r.meta?.['baselineVersion'] ?? 1);
    if (!wid) {
      wid = randomUUID(); watchlistIds.set(r.title, wid); watchlistAlias.set(wid, r.alias);
      const config = { name: r.title, description: '', question: r.title, searchContext: '', entities: [{ name: r.title, relationship: 'competitor' }], criteria: ['changes'], projectIds: [r.projectId], sourceIds: [], baseline: { text: 'synthetic baseline', links: [] }, cadence: 'weekly', paused: true };
      await pool.query(`INSERT INTO discover_watchlists (id, config, baseline_version) VALUES ($1,$2::jsonb,$3)`, [wid, JSON.stringify(config), version]);
      for (let v = 1; v <= version; v++) await pool.query(`INSERT INTO discover_watchlist_baselines (watchlist_id, version, baseline) VALUES ($1,$2,'{"text":"synthetic baseline","links":[]}'::jsonb)`, [wid, v]);
    }
    const cov = (r.meta?.['coverage'] ?? {}) as { from?: string; to?: string };
    const status = r.state === 'failed' ? 'failed' : (r.meta?.['findings'] as unknown[] | undefined)?.length === 0 ? 'no_meaningful_change' : 'changes';
    await pool.query(`INSERT INTO discover_watchlist_runs (id, watchlist_id, baseline_version, config, started_at, completed_at, window_start, status, summary, coverage, evidence) VALUES ($1,$2,$3,'{}'::jsonb,$4,$4,$4,$5,$6,$7::jsonb,'[]'::jsonb)`, [r.id, wid, Math.min(version, 2), created, status, r.text, JSON.stringify(cov)]);
    return;
  }
  if (r.kind === 'memory') {
    await pool.query(`INSERT INTO athena_memories (kind, content, scope_type, scope_value, status, origin) VALUES ('instruction',$1,'project',$2,$3,'manual')`,
      [r.text, r.projectId, r.state === 'active' ? 'active' : 'dismissed']);
    return;
  }
  const source = r.source ?? r.kind;
  const metadata: Record<string, unknown> = { ...(r.meta ?? {}), ...(r.path ? { path: r.path } : {}), ...(r.excludedField ? { [r.excludedField.name]: r.excludedField.value } : {}) };
  if (r.kind === 'note') {
    await pool.query(`INSERT INTO notes (id, content, created_at, updated_at) VALUES ($1,$2,$3,$4)`, [r.id, noteJson(r.title, r.text), created, updated]);
  }
  await pool.query(
    `INSERT INTO content_items (id, source, source_id, title, body, published_at, project_context, metadata, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [r.id, source, r.kind === 'note' ? r.id : (r.path ?? r.alias), r.title, r.text, created, r.projectId ?? 'personal', JSON.stringify(metadata), updated]);
}

const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function toAlias(id: string): string {
  const direct = aliasById.get(id) ?? projectAlias.get(id) ?? watchlistAlias.get(id);
  if (direct) return direct;
  const m = uuidRe.exec(id)?.[0].toLowerCase();
  return (m && aliasById.get(m)) || id;
}

const trace = process.env.KNOWLEDGE_EVAL_TRACE;

export const adapter: EvalAdapter = {
  describe: () => ({
    deployment: process.env.KNOWLEDGE_EVAL_DEPLOYMENT_LABEL ?? env.AZURE_OPENAI_DEPLOYMENT_GPT4O,
    params: {
      slot: 'standard', persona: 'general', apiVersion: env.AZURE_OPENAI_API_VERSION, endpointHost: new URL(env.AZURE_OPENAI_ENDPOINT ?? 'http://unset').hostname,
      knowledgeOrchestration: process.env.KNOWLEDGE_ORCHESTRATION ?? 'off', database: 'isolated loopback PostgreSQL 16, synthetic corpus',
    },
  }),
  async run(question: EvalQuestion): Promise<EvalAnswer> {
    await seed();
    const sessionId = randomUUID();
    await pool.query('INSERT INTO ai_chat_sessions (id) VALUES ($1)', [sessionId]);
    const used = emptyContextUsed();
    const tools: string[] = [];
    let answer = '', error: string | undefined;
    const t0 = Date.now();
    for (let attempt = 0; attempt < 2 && !answer; attempt++) {
      try {
        tools.length = 0;
        answer = await handleConversationTurn(pool as never, [], question.question, 'standard', 'general', sessionId, undefined,
          (name: string) => { tools.push(name); }, {}, { contextUsed: used, signal: AbortSignal.timeout(300_000) });
        error = undefined;
      } catch (e) { error = e instanceof Error ? e.message : String(e); }
    }
    await new Promise((r) => setTimeout(r, 1500));
    const u = await pool.query<{ calls: string; input: string; output: string; deployments: string[] }>(
      `SELECT count(*) AS calls, coalesce(sum(prompt_tokens),0) AS input, coalesce(sum(completion_tokens),0) AS output, array_agg(DISTINCT deployment) AS deployments
         FROM ai_usage_log WHERE session_id = $1`, [sessionId]);
        const ev = used.evidence?.entries ?? [];
    const sources = [...used.auto, ...used.found, ...ev.map((e) => ({ id: e.ref.id }))];
    const retrieved = [...new Set(sources.map((s) => toAlias(s.id)))];
    const cited = ev.filter((e) => e.state === 'cited').map((e) => toAlias(e.ref.id));
    const mentioned = [...answer.matchAll(new RegExp(uuidRe.source, 'gi'))].map((m) => toAlias(m[0]));
    const citations = [...new Set([...cited, ...mentioned])];
    const usage = { inputTokens: Number(u.rows[0]!.input), outputTokens: Number(u.rows[0]!.output), calls: Number(u.rows[0]!.calls), semanticQueries: 0, embeddings: 0 };
    if (trace) {
      appendFileSync(trace, `${JSON.stringify({ id: question.id, ms: Date.now() - t0, error, tools, retrieved, citations, usage, deployments: u.rows[0]!.deployments, warnings: used.warnings, answer })}\n`);
    }
    return { retrieved, answer: error && !answer ? `ERROR: ${error}` : answer, citations, usage };
  },
};

