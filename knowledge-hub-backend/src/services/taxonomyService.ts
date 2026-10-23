/**
 * services/taxonomyService.ts
 * Auto-tagging with the concept taxonomy.
 *
 * Where tags come from, by area of the app (see TAGGING_POLICY):
 *   Discover   discovered articles → AI tags, may propose a new tag; email → existing tags only
 *   Think      notes               → AI tags, may propose a new tag
 *   Plan       tasks               → AI tags from the existing taxonomy only
 *   My Work    activity            → the project's tag; AI tags only on items worth reading
 *                                    (pull requests, issues, releases, posts, meetings)
 *   Projects   GitHub design and instructional docs (PRDs, specs, ADRs, READMEs, guides,
 *              agent/skill instructions) → existing tags plus the project tag
 *   Library, other Projects items  → nothing new is applied
 *
 * Every content item's outcome is recorded in content_items.tagging_status (tagged, no_fit,
 * failed, skipped) so the tagging sweep can tag never-attempted items and retry failures.
 *
 * Exported:
 *   tagContent()        — tags one item per its policy, queues a proposed new tag as evidence
 *   loadConceptTags()   — the flat concept tag list
 *   tagKey()            — normalised form of a tag name, for matching near-duplicates
 *   policyFor()         — the policy for a content type (and, for GitHub docs, its URL)
 *   isDesignDoc()       — is a GitHub doc URL a design or instructional document?
 *   TAGGABLE_SOURCES    — content types whose policy can apply tags
 */
import type { Pool } from 'pg';
import { FoundryClient } from '../ai/foundryClient.js';

export interface ConceptTag { id: string; name: string; parentName: string }

export interface TaggingResult {
  appliedTagIds: string[];
  suggestedNewTags: string[];
}

export interface TaggingPolicy {
  /** 'ai' = the model chooses tags; 'project' = only the item's project tag; 'none' = nothing. */
  mode: 'ai' | 'project' | 'none';
  /** May the model propose a tag that is not in the taxonomy yet? */
  mayPropose: boolean;
  /** Also apply the item's project tag. */
  projectTag: boolean;
}

const NONE: TaggingPolicy = { mode: 'none', mayPropose: false, projectTag: false };
const AI_EXISTING: TaggingPolicy = { mode: 'ai', mayPropose: false, projectTag: true };

const POLICY_BY_TYPE: Record<string, TaggingPolicy> = {
  // Discover
  'discovered-article': { mode: 'ai', mayPropose: true, projectTag: false },
  'discover_item': { mode: 'ai', mayPropose: true, projectTag: false },
  email: { mode: 'ai', mayPropose: false, projectTag: false },
  // Think and Plan: tagged by id through autoTagging.ts (notes carry their own project field)
  note: { mode: 'ai', mayPropose: true, projectTag: false },
  task: { mode: 'ai', mayPropose: false, projectTag: false },
  // My Work: calendar, to-dos and the user's own published content
  'cms-blog': AI_EXISTING, 'cms-newsletter': AI_EXISTING, 'cms-podcast-show-notes': AI_EXISTING, 'cms-session-summary': AI_EXISTING,
  'graph-calendar': AI_EXISTING, 'graph-todo': AI_EXISTING,
  // Library and Projects (GitHub and GitLab items belong to Projects): never tagged
  'github-pr': NONE, 'github-issue': NONE, 'github-release': NONE, 'github-commit': NONE, 'github-action': NONE, 'github-deployment': NONE, 'github-pr-review': NONE,
  'gitlab-mr': NONE, 'gitlab-issue': NONE, 'gitlab-release': NONE, 'gitlab-commit': NONE, 'gitlab-deployment': NONE, 'gitlab-pipeline': NONE,
  'github-doc': NONE, 'github-content-store': NONE, 'onedrive-document': NONE, 'user-upload': NONE, 'ica-document': NONE, image: NONE,
};

const DESIGN_DOC_FOLDER = /\/(docs?|specs?|designs?|architecture|decisions|adrs?|rfcs?|requirements|prds?|guides?|[a-z-]+-guide|runbooks?|playbooks?|skills|references|contracts|diagrams|\.agents|\.github\/(agents|skills|instructions|prompts))\//i;
const DESIGN_DOC_FILE = /\/[^/]*(readme|agents|prd|spec|design|architecture|requirement|instructions|guide|runbook|playbook|skill|\.agent|\.prompt|adr|rfc|overview|setup|how-?to|usage|manual|onboarding|quick[-_ ]?start|troubleshooting|features|roadmap|best[-_ ]practices|conventions|standards|contributing|reference|strategy|plan|process)[^/]*\.mdx?$/i;
const NOT_DESIGN_DOC = /(changelog|session[-_ ]?notes|\/sessions\/|\/status\/|status[-_ ]report|\.copilot-tracking|\/license|code[-_]of[-_]conduct|migration[-_]index|\/data\/|\/posts\/|\/blogs\/)/i;

/** A GitHub doc that explains how something should be designed, built or used (PRDs, specs, ADRs, guides). */
export function isDesignDoc(url: string | null | undefined): boolean {
  if (url === null || url === undefined || url === '') return false;
  const path = url.split('?')[0] ?? url;
  if (NOT_DESIGN_DOC.test(path)) return false;
  return DESIGN_DOC_FOLDER.test(path) || DESIGN_DOC_FILE.test(path);
}

export function policyFor(contentType: string, url?: string | null): TaggingPolicy {
  if (contentType === 'github-doc' && isDesignDoc(url)) return AI_EXISTING;
  return POLICY_BY_TYPE[contentType] ?? NONE;
}

/** Content types whose policy can apply a tag (github-doc only for design docs, checked per URL). */
export const TAGGABLE_SOURCES: readonly string[] = [
  ...Object.entries(POLICY_BY_TYPE).filter(([type, p]) => p.mode !== 'none' && type !== 'note' && type !== 'task').map(([type]) => type),
  'github-doc',
];

// ── Limiting concurrent model calls ──────────────────────────────────────────

/** Sync sweeps insert many items at once; unbounded parallel tagging calls get rate-limited. */
const MAX_CONCURRENT_TAGGING = 3;
let activeTagging = 0;
const taggingQueue: Array<() => void> = [];

async function withTaggingSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeTagging >= MAX_CONCURRENT_TAGGING) await new Promise<void>((resolve) => { taggingQueue.push(resolve); });
  else activeTagging++;
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter, so a new caller cannot slip in between.
    const next = taggingQueue.shift();
    if (next !== undefined) next();
    else activeTagging--;
  }
}

// ── Matching names ───────────────────────────────────────────────────────────

const GENERIC_WORDS = new Set(['management', 'service', 'services', 'platform', 'system', 'systems', 'solution', 'solutions', 'process', 'processes']);

/** "AI Risks" / "AI Risk Management" / "ai-risk" → "ai risk": for spotting near-duplicates. */
export function tagKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w !== '' && !GENERIC_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

/** Words that mean "this is an event, a status or a kind of file", never a durable subject. */
const NOT_A_SUBJECT = /\b(success|succeeded|failure|failed|error|errors|pending|waiting|cancelled|canceled|in progress|queued|skipped|run|runs|workflow|pipeline|build|builds|commit|commits|merge|merged|pull request|pull requests|lint|linting|cron|job|jobs|deploy|deployed|deployment|deployments|release notes?|update|updates|readme|issue|issues|ticket|log|logs|meeting|call|email|document|file|folder|draft|todo|task|tasks)\b/i;

/** Is a model-proposed new tag fit to enter the review queue at all? */
export function isCredibleNewTag(name: string): boolean {
  const n = name.trim();
  if (n.length < 3 || n.length > 40) return false;
  const words = n.split(/\s+/);
  if (words.length > 4) return false;
  if (/[#:()\d]/.test(n)) return false;
  if (NOT_A_SUBJECT.test(n)) return false;
  return true;
}

// ── Taxonomy lookups (cached briefly) ────────────────────────────────────────

let conceptTagCache: ConceptTag[] | null = null;
let allTagCache: { at: number; byKey: Map<string, { id: string; name: string; isConcept: boolean }> } | null = null;
let rejectedCache: { at: number; keys: Set<string> } | null = null;
const CACHE_MS = 5 * 60_000;

export async function loadConceptTags(db: Pool): Promise<ConceptTag[]> {
  if (conceptTagCache) return conceptTagCache;
  const rows = await db.query<{ id: string; name: string; parent_name: string | null }>(
    `SELECT c.id, c.name, p.name AS parent_name FROM tags c LEFT JOIN tags p ON p.id = c.parent_id
      WHERE c.parent_id IS NOT NULL ORDER BY p.name, c.name`,
  );
  conceptTagCache = rows.rows.map((r) => ({ id: r.id, name: r.name, parentName: r.parent_name ?? 'General' }));
  return conceptTagCache;
}

export function invalidateConceptTagCache(): void {
  conceptTagCache = null;
  allTagCache = null;
  rejectedCache = null;
}

async function allTagsByKey(db: Pool): Promise<Map<string, { id: string; name: string; isConcept: boolean }>> {
  if (allTagCache !== null && Date.now() - allTagCache.at < CACHE_MS) return allTagCache.byKey;
  const rows = await db.query<{ id: string; name: string; parent_id: string | null }>(`SELECT id, name, parent_id FROM tags`);
  const byKey = new Map<string, { id: string; name: string; isConcept: boolean }>();
  for (const r of rows.rows) byKey.set(tagKey(r.name), { id: r.id, name: r.name, isConcept: r.parent_id !== null });
  allTagCache = { at: Date.now(), byKey };
  return byKey;
}

async function rejectedKeys(db: Pool): Promise<Set<string>> {
  if (rejectedCache !== null && Date.now() - rejectedCache.at < CACHE_MS) return rejectedCache.keys;
  const rows = await db.query<{ suggested_name: string }>(`SELECT suggested_name FROM pending_tag_suggestions WHERE status = 'rejected'`);
  const keys = new Set(rows.rows.map((r) => tagKey(r.suggested_name)));
  rejectedCache = { at: Date.now(), keys };
  return keys;
}

// ── The model call ───────────────────────────────────────────────────────────

function systemPrompt(mayPropose: boolean): string {
  return `You tag items in Richard's personal knowledge hub using his existing concept taxonomy.

Choose 0 to 5 existing tags that the item is substantively ABOUT: the main subject, not something merely mentioned in passing. Most items deserve 2 to 4. If nothing fits well, choose none. Use tag names exactly as listed.
${mayPropose ? `
Only if the item has a clear central subject that NO existing tag covers, and it is a durable subject that will recur across many items (a topic, technology, method or theme), you may propose ONE new tag in "new_tag". Do NOT propose: an event, a status, a kind of file or activity (build, deployment, pull request, meeting, update), a one-off phrase, a product version, or a variant of an existing tag (singular/plural, "Management", "Deployment"). Use 1 to 3 words in Title Case. Proposing nothing is the normal case.
` : `
Do not invent tags: use only the listed ones.
`}
Return ONLY JSON: {"tags": ["Tag Name"]${mayPropose ? ', "new_tag": "Name or null"' : ''}}`;
}

/** Marks a tag removed from an item by the user, so the same auto tag is not applied again. */
export async function rememberRejection(db: Pick<Pool, 'query'>, kind: string, contentId: string, tagIds: string[]): Promise<void> {
  for (const tagId of tagIds) {
    await db.query(`INSERT INTO tag_rejections (content_kind, content_id, tag_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [kind, contentId, tagId]);
  }
}

// ── Project tag (My Work) ────────────────────────────────────────────────────

const projectTagCache = new Map<string, string | null>();

async function projectTagId(db: Pool, projectContext: string | null | undefined): Promise<string | null> {
  if (projectContext === null || projectContext === undefined || projectContext === '') return null;
  if (projectTagCache.has(projectContext)) return projectTagCache.get(projectContext) ?? null;
  const r = await db.query<{ id: string }>(
    `SELECT id FROM tags WHERE project_id = $1`,
    [projectContext],
  ).catch(() => ({ rows: [] as Array<{ id: string }> }));
  const id = r.rows[0]?.id ?? null;
  projectTagCache.set(projectContext, id);
  return id;
}

// ── Tagging one item ─────────────────────────────────────────────────────────

export interface TagOptions {
  /** The item's project, for the project tag (My Work items). */
  projectContext?: string | null | undefined;
  /** The item's URL: decides whether a GitHub doc is a design document. */
  url?: string | null | undefined;
  /** How much of the text to show the model. */
  maxChars?: number;
}

export type TaggingOutcome = 'tagged' | 'no_fit' | 'failed' | 'skipped';

export const TAG_TEXT_CHARS = 3_000;

/** The text shown to the model. GitHub docs use the body (their summary is a 200-character stub) and path. */
export function taggingText(item: { source: string; title: string; summary?: string | null; body?: string | null; url?: string | null }): string {
  const preferBody = item.source === 'github-doc';
  const first = preferBody ? item.body : item.summary;
  const second = preferBody ? item.summary : item.body;
  const text = first !== null && first !== undefined && first.trim() !== '' ? first : (second ?? '');
  const path = preferBody && item.url !== null && item.url !== undefined ? `\nPath: ${item.url.replace(/^https:\/\/github\.com\//, '')}` : '';
  return `${item.title}${path}\n\n${text}`.slice(0, TAG_TEXT_CHARS);
}

/** Notes and tasks have their own tables; every other type is a content_items row. */
function isContentItem(contentType: string): boolean {
  return contentType !== 'note' && contentType !== 'task';
}

async function recordOutcome(db: Pool, contentId: string, contentType: string, outcome: TaggingOutcome): Promise<void> {
  if (!isContentItem(contentType)) return;
  await db.query(
    `UPDATE content_items SET tagging_status = $2, tagging_attempts = tagging_attempts + 1, tagging_attempted_at = now()
      WHERE id::text = $1`,
    [contentId, outcome],
  ).catch((err: unknown) => {
    console.error(`[TaxonomyService] could not record tagging outcome for ${contentType}:${contentId}`, err instanceof Error ? err.message : err);
  });
}

/**
 * Tags one item per the policy for its content type. Failures are logged and never re-thrown —
 * callers must not roll back their own inserts because tagging failed.
 */
export async function tagContent(
  db: Pool,
  text: string,
  contentId: string,
  contentType: string,
  exampleTitle: string,
  options: TagOptions = {},
): Promise<TaggingResult> {
  const empty: TaggingResult = { appliedTagIds: [], suggestedNewTags: [] };
  const policy = policyFor(contentType, options.url);
  if (policy.mode === 'none') {
    await recordOutcome(db, contentId, contentType, 'skipped');
    return empty;
  }
  try {
    const result = await withTaggingSlot(() => tagWithPolicy(db, policy, text, contentId, contentType, exampleTitle, options));
    await recordOutcome(db, contentId, contentType, result.outcome);
    return { appliedTagIds: result.appliedTagIds, suggestedNewTags: result.suggestedNewTags };
  } catch (err) {
    console.error(`[TaxonomyService] tagging failed for ${contentType}:${contentId}`, err);
    await recordOutcome(db, contentId, contentType, 'failed');
    return empty;
  }
}

const MIN_TAGGABLE_TEXT_CHARS = 20;

async function tagWithPolicy(
  db: Pool,
  policy: TaggingPolicy,
  text: string,
  contentId: string,
  contentType: string,
  exampleTitle: string,
  options: TagOptions,
): Promise<TaggingResult & { outcome: TaggingOutcome }> {
  const applied: string[] = [];
  const outcome = (fallback: TaggingOutcome): TaggingOutcome => (applied.length > 0 ? 'tagged' : fallback);
  if (policy.projectTag) {
    const projectTag = await projectTagId(db, options.projectContext);
    if (projectTag !== null && await applyTag(db, contentId, contentType, projectTag)) applied.push(projectTag);
  }
  if (policy.mode !== 'ai') return { appliedTagIds: applied, suggestedNewTags: [], outcome: outcome('no_fit') };

  const conceptTags = await loadConceptTags(db);
  if (conceptTags.length === 0 || text.trim().length < MIN_TAGGABLE_TEXT_CHARS) return { appliedTagIds: applied, suggestedNewTags: [], outcome: outcome('skipped') };

  const client = new FoundryClient('auto-tagging');
  const raw = await client.chatBulk([
    { role: 'system', content: systemPrompt(policy.mayPropose) },
    { role: 'user', content: `Item:\n${text.slice(0, options.maxChars ?? 3_000)}\n\nExisting concept tags, by group:\n${buildTaxonomyListing(conceptTags)}` },
  ], 800);
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)) as { tags?: string[]; new_tag?: string | null };

  for (const tagName of (parsed.tags ?? []).slice(0, 5)) {
    const match = conceptTags.find((t) => t.name.toLowerCase() === String(tagName).toLowerCase());
    if (match === undefined) continue;
    if (await applyTag(db, contentId, contentType, match.id)) applied.push(match.id);
  }

  const suggested: string[] = [];
  const proposal = policy.mayPropose && typeof parsed.new_tag === 'string' ? parsed.new_tag.trim() : '';
  if (proposal !== '' && proposal.toLowerCase() !== 'null' && isCredibleNewTag(proposal)) {
    const key = tagKey(proposal);
    const existing = (await allTagsByKey(db)).get(key);
    if (existing !== undefined) {
      // The "new" tag already exists under another spelling: just apply it.
      if (existing.isConcept && await applyTag(db, contentId, contentType, existing.id)) applied.push(existing.id);
    } else if (!(await rejectedKeys(db)).has(key)) {
      await recordSuggestion(db, proposal, exampleTitle, `${contentType}:${contentId}`);
      suggested.push(proposal);
    }
  }
  return { appliedTagIds: applied, suggestedNewTags: suggested, outcome: await finalOutcome(db, contentId, contentType, applied) };
}

/** Tagged if anything was applied now or the item already carried a tag (a re-run); otherwise nothing fitted. */
async function finalOutcome(db: Pool, contentId: string, contentType: string, applied: string[]): Promise<TaggingOutcome> {
  if (applied.length > 0) return 'tagged';
  if (!isContentItem(contentType)) return 'no_fit';
  const existing = await db.query(`SELECT 1 FROM discover_item_tags WHERE discover_item_id::text = $1 LIMIT 1`, [contentId]);
  return (existing.rowCount ?? 0) > 0 ? 'tagged' : 'no_fit';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTaxonomyListing(tags: ConceptTag[]): string {
  const groups: Record<string, string[]> = {};
  for (const t of tags) (groups[t.parentName] ??= []).push(t.name);
  return Object.entries(groups).map(([parent, children]) => `${parent}: ${children.join(', ')}`).join('\n');
}

const TABLE_FOR_TYPE: Record<string, { table: string; idCol: string }> = {
  note: { table: 'note_tags', idCol: 'note_id' },
  task: { table: 'task_tags', idCol: 'task_id' },
};

/** Applies an auto tag unless the user already removed that tag from this item. Returns true if newly applied. */
async function applyTag(db: Pool, contentId: string, contentType: string, tagId: string): Promise<boolean> {
  const rejected = await db.query(`SELECT 1 FROM tag_rejections WHERE content_id = $1 AND tag_id = $2`, [contentId, tagId]);
  if ((rejected.rowCount ?? 0) > 0) return false;
  // Every other content type shares discover_item_tags (the column name is historical).
  const mapping = TABLE_FOR_TYPE[contentType] ?? { table: 'discover_item_tags', idCol: 'discover_item_id' };
  const result = await db.query(
    `INSERT INTO ${mapping.table} (${mapping.idCol}, tag_id, source) VALUES ($1, $2, 'auto') ON CONFLICT DO NOTHING`,
    [contentId, tagId],
  );
  return (result.rowCount ?? 0) > 0;
}

const MAX_EVIDENCE_KEYS = 60;

/** Records a proposed new tag. Evidence is the number of DISTINCT items proposing it, not repeat runs. */
async function recordSuggestion(db: Pool, name: string, exampleTitle: string, itemKey: string): Promise<void> {
  await db.query(
    `INSERT INTO pending_tag_suggestions (suggested_name, suggested_count, evidence, item_keys, example_content)
     VALUES ($1, 1, 1, ARRAY[$3::text], ARRAY[$2::text])
     ON CONFLICT (suggested_name) DO UPDATE SET
       item_keys = CASE WHEN $3 = ANY(pending_tag_suggestions.item_keys) OR cardinality(pending_tag_suggestions.item_keys) >= ${MAX_EVIDENCE_KEYS}
                        THEN pending_tag_suggestions.item_keys ELSE array_append(pending_tag_suggestions.item_keys, $3::text) END,
       evidence = CASE WHEN $3 = ANY(pending_tag_suggestions.item_keys) THEN pending_tag_suggestions.evidence ELSE pending_tag_suggestions.evidence + 1 END,
       suggested_count = CASE WHEN $3 = ANY(pending_tag_suggestions.item_keys) THEN pending_tag_suggestions.suggested_count ELSE pending_tag_suggestions.suggested_count + 1 END,
       example_content = CASE
         WHEN array_length(pending_tag_suggestions.example_content, 1) < 5 AND NOT ($2::text = ANY(pending_tag_suggestions.example_content))
         THEN array_append(pending_tag_suggestions.example_content, $2::text)
         ELSE pending_tag_suggestions.example_content END,
       updated_at = now()
     WHERE pending_tag_suggestions.status = 'pending'`,
    [name.trim(), exampleTitle.slice(0, 200), itemKey],
  );
}
