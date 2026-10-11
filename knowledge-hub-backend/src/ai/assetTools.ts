/**
 * ai/assetTools.ts — Athena's tools for creating and changing app assets beyond notes, tasks and Sparks:
 * Discover sources and article states, Sparks, projects, Think notes by id, diagrams and mind maps.
 *
 * Each tool writes through the same services/SQL as the corresponding UI route, so Athena's changes
 * look exactly like the user's own. Nothing here deletes data: removal is limited to disabling a
 * feed, shelving/archiving an article, archiving a project, or removing shapes from a diagram
 * (which keeps its revision history).
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { LlmToolDefinition } from './foundryClient.js';
import { textToBlocks } from './markdownToNoteBlocks.js';
import type { DiagramDocument, DiagramEdge, DiagramNode, DiagramKind } from '../types/diagram.js';
import { env } from '../config/env.js';

export const ASSET_WRITE_TOOLS = [
  'add_discover_source', 'update_discover_source', 'set_discover_item_state', 'update_spark',
  'create_project', 'update_project', 'update_note', 'create_diagram', 'update_diagram', 'create_mind_map',
  'create_weekly_microsoft_digest',
] as const;
type AssetToolName = typeof ASSET_WRITE_TOOLS[number];

export function isAssetTool(name: string): name is AssetToolName {
  return (ASSET_WRITE_TOOLS as readonly string[]).includes(name);
}

const DISCOVER_STATES = ['to-review', 'saved', 'blog', 'archived', 'published', 'shelved'] as const;
const PROJECT_CATEGORIES = ['work', 'personal', 'side-hustle'] as const;
const PROJECT_PRIORITIES = ['low', 'medium', 'high'] as const;
const PROJECT_IMPORTANCE = ['critical', 'high', 'normal', 'low'] as const;
const PROJECT_LIFECYCLE = ['active', 'paused', 'completed', 'archived'] as const;
const NODE_KINDS = ['process', 'decision', 'terminator', 'document'] as const;
const MAX_DIAGRAM_NODES = 80;
const MAX_MAP_IDEAS = 60;

/** Diagram colour names → saved (light-theme) fill and border, as the editor's swatches use. */
export const DIAGRAM_COLOURS: Record<string, { fill: string; stroke: string }> = {
  grey: { fill: '#ffffff', stroke: '#161616' },
  blue: { fill: '#edf5ff', stroke: '#0f62fe' },
  green: { fill: '#defbe6', stroke: '#198038' },
  yellow: { fill: '#fcf4d6', stroke: '#b28600' },
  red: { fill: '#fff1f1', stroke: '#da1e28' },
  purple: { fill: '#f6f2ff', stroke: '#8a3ffc' },
};
const COLOUR_NAMES = Object.keys(DIAGRAM_COLOURS);
const NODE_SIZE: Record<typeof NODE_KINDS[number], { width: number; height: number }> = {
  process: { width: 160, height: 64 },
  decision: { width: 140, height: 90 },
  terminator: { width: 160, height: 52 },
  document: { width: 160, height: 80 },
};
const LAYOUT = { left: 80, top: 80, columnGap: 240, rowGap: 130 };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : undefined;

const diagramNodeSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Short handle used by connectors in this call (defaults to the label).' },
    label: { type: 'string' },
    description: { type: 'string', description: 'Longer explanation; shown when a footnote marker is added.' },
    kind: { type: 'string', enum: [...NODE_KINDS] },
    colour: { type: 'string', enum: COLOUR_NAMES, description: 'Border/fill colour. Use colours consistently by meaning and name them in the legend.' },
    footnote: { type: 'boolean', description: 'Add a numbered footnote marker showing the description.' },
  },
  required: ['label'],
};
const diagramEdgeSchema = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'Key, label or id of the source shape.' },
    to: { type: 'string', description: 'Key, label or id of the target shape.' },
    label: { type: 'string' },
    dashed: { type: 'boolean' },
  },
  required: ['from', 'to'],
};
const legendSchema = {
  type: 'array',
  description: 'Key explaining what each colour means.',
  items: { type: 'object', properties: { colour: { type: 'string', enum: COLOUR_NAMES }, label: { type: 'string' } }, required: ['colour', 'label'] },
};

export function getAssetToolDefinitions(): LlmToolDefinition[] {
  const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): LlmToolDefinition => ({
    type: 'function', function: { name, description, parameters: { type: 'object', properties, required } },
  });
  return [
    fn('add_discover_source',
      'Subscribes Discover to an RSS/Atom feed. The feed is read first, so a bad address fails here; only report it as added when this returns success. Check get_discover_sources first to avoid duplicates.',
      {
        title: { type: 'string', description: 'Display name, e.g. "Azure Updates".' },
        feedUrl: { type: 'string', description: 'The feed URL (not an article or home page URL).' },
        groupName: { type: 'string', description: 'Vendor group, e.g. Microsoft, GitHub, Google, AWS, OpenAI, IBM, Other.' },
      }, ['title', 'feedUrl']),
    fn('update_discover_source',
      'Renames, regroups, disables or re-enables an existing Discover feed (from get_discover_sources). Disabling keeps its articles.',
      {
        sourceId: { type: 'string', description: 'Source id, or its exact title.' },
        title: { type: 'string' }, groupName: { type: 'string' },
        active: { type: 'boolean', description: 'false disables the feed, true re-enables it.' },
      }, ['sourceId']),
    fn('set_discover_item_state',
      'Moves a Discover article between To Review, Saved, Blog, Shelved, Archived and Published (e.g. restore a shelved article).',
      {
        itemId: { type: 'string', description: 'Discover item id, or the article URL.' },
        state: { type: 'string', enum: [...DISCOVER_STATES] },
      }, ['itemId', 'state']),
    fn('update_spark', 'Edits an existing Spark\'s text and/or tags.',
      { sparkId: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, ['sparkId']),
    fn('create_project', 'Creates a new project. Only when the user asks for a project; check the project catalogue first so you don\'t duplicate one.',
      {
        name: { type: 'string' }, id: { type: 'string', description: 'Optional short kebab-case id.' },
        description: { type: 'string' }, goal: { type: 'string' },
        category: { type: 'string', enum: [...PROJECT_CATEGORIES] }, priority: { type: 'string', enum: [...PROJECT_PRIORITIES] },
        importance: { type: 'string', enum: [...PROJECT_IMPORTANCE] }, tags: { type: 'array', items: { type: 'string' } },
      }, ['name']),
    fn('update_project', 'Updates a project\'s name, description, goal, category, priority, importance, state (active/paused/completed/archived) or tags. Tags given replace the existing tags.',
      {
        projectId: { type: 'string', description: 'Project id or exact name.' },
        name: { type: 'string' }, description: { type: 'string' }, goal: { type: 'string' },
        category: { type: 'string', enum: [...PROJECT_CATEGORIES] }, priority: { type: 'string', enum: [...PROJECT_PRIORITIES] },
        importance: { type: 'string', enum: [...PROJECT_IMPORTANCE] }, lifecycleState: { type: 'string', enum: [...PROJECT_LIFECYCLE] },
        tags: { type: 'array', items: { type: 'string' } },
      }, ['projectId']),
    fn('update_note',
      'Changes a saved Think note by id, even when it is not open: append content, replace the whole body (a checkpoint of the previous version is kept in its history), rename it, or move it to another project. For the note open beside the chat use propose_note_edit instead.',
      {
        noteId: { type: 'string' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'How to apply content. Defaults to append.' },
        content: { type: 'string', description: 'Markdown: blank lines separate paragraphs; #, ##, ### make headings; - bullets.' },
        title: { type: 'string' },
        projectId: { type: 'string' },
      }, ['noteId']),
    fn('create_diagram',
      'Creates a new diagram (Think → Diagrams) from shapes and connectors, laid out automatically left to right. Use for architectures, flows and processes. Colour shapes by meaning and add a legend for the colours.',
      {
        title: { type: 'string' }, description: { type: 'string' },
        projectId: { type: 'string', description: 'Project to file it under.' },
        nodes: { type: 'array', items: diagramNodeSchema },
        edges: { type: 'array', items: diagramEdgeSchema },
        legend: legendSchema,
      }, ['title', 'nodes']),
    fn('update_diagram',
      'Changes a saved diagram (find it with search_diagrams/read_diagram): add shapes and connectors, relabel/recolour/describe shapes, remove shapes, set the legend or rename it. Earlier versions stay in its history.',
      {
        diagramId: { type: 'string' }, title: { type: 'string' },
        addNodes: { type: 'array', items: diagramNodeSchema },
        addEdges: { type: 'array', items: diagramEdgeSchema },
        updateNodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              node: { type: 'string', description: 'Id or current label.' }, label: { type: 'string' }, description: { type: 'string' },
              colour: { type: 'string', enum: COLOUR_NAMES }, footnote: { type: 'boolean' },
            },
            required: ['node'],
          },
        },
        removeNodes: { type: 'array', items: { type: 'string' }, description: 'Ids or labels; their connectors go too.' },
        legend: legendSchema,
      }, ['diagramId']),
    fn('create_mind_map',
      'Creates a new mind map (Think → Canvases) with a central idea and branches. Each idea can hang off the centre or off an earlier idea.',
      {
        title: { type: 'string' }, projectId: { type: 'string' },
        centre: { type: 'string', description: 'Central idea; defaults to the title.' },
        ideas: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, body: { type: 'string' }, parent: { type: 'string', description: 'Label of an earlier idea; omit for the centre.' } },
            required: ['label'],
          },
        },
      }, ['title', 'ideas']),
    fn('create_weekly_microsoft_digest',
      'Builds (or rebuilds) this week\'s Microsoft round-up from every Microsoft and GitHub Discover update in the last 7 days: ' +
        'a blog draft saved to Think and a Slack summary (posted to Slack when connected), pinned as a "Weekly Microsoft updates" chat. ' +
        'Runs automatically on Monday mornings; call it when asked for the weekly Microsoft summary, digest or round-up.',
      {}, []),
  ];
}

export async function executeAssetTool(db: Pool, name: AssetToolName, args: Record<string, unknown>, openNoteId?: string): Promise<unknown> {
  try {
    switch (name) {
      case 'add_discover_source': return await addDiscoverSource(db, args);
      case 'update_discover_source': return await updateDiscoverSource(db, args);
      case 'set_discover_item_state': return await setDiscoverItemState(db, args);
      case 'update_spark': return await updateSpark(db, args);
      case 'create_project': return await createProject(db, args);
      case 'update_project': return await updateProject(db, args);
      case 'update_note': return await updateNote(db, args, openNoteId);
      case 'create_diagram': return await createDiagram(db, args);
      case 'update_diagram': return await updateDiagram(args);
      case 'create_mind_map': return await createMindMap(db, args);
      case 'create_weekly_microsoft_digest': {
        const { generateWeeklyMicrosoftDigest } = await import('./weeklyMicrosoftDigest.js');
        const d = await generateWeeklyMicrosoftDigest(db);
        return {
          success: true,
          week: d.week,
          updates: d.articleCount,
          blogDraftUrl: d.noteUrl,
          slackPosted: d.slackPosted,
          ...(d.slackPosted ? {} : { slackNote: env.SLACK_WEBHOOK_URL === undefined ? 'Slack is not connected (SLACK_WEBHOOK_URL unset); the summary is in the pinned chat.' : 'Slack post failed; the summary is in the pinned chat.' }),
          chatUrl: `${env.FRONTEND_BASE_URL}/chat?session=${d.sessionId}`,
          slackText: d.slackText,
        };
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Discover ─────────────────────────────────────────────────────────────────

async function addDiscoverSource(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const title = str(args['title']);
  const feedUrl = str(args['feedUrl']);
  if (title === undefined || feedUrl === undefined || !/^https?:\/\//i.test(feedUrl)) return { error: 'A title and an http(s) feed URL are needed.' };
  const { readFeed } = await import('../integrations/discovery/feedReader.js');
  let items: number;
  try {
    items = (await readFeed(feedUrl)).length;
  } catch (err) {
    return { error: `Not added — that address didn't work as a feed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { rows } = await db.query<{ id: string; existed: boolean }>(
    `INSERT INTO discovery_sources (title, feed_url, group_name) VALUES ($1, $2, $3)
     ON CONFLICT (feed_url) DO UPDATE SET title = EXCLUDED.title, group_name = EXCLUDED.group_name, is_active = true
     RETURNING id::text, (xmax <> 0) AS existed`,
    [title, feedUrl, str(args['groupName']) ?? 'Other'],
  );
  return {
    success: true, sourceId: rows[0]?.id, title, feedUrl, itemsInFeed: items,
    note: rows[0]?.existed === true ? 'It was already configured; it is now enabled with this name.' : 'Added. Its articles appear in Discover after the next check (about every 30 minutes).',
  };
}

async function updateDiscoverSource(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const ref = str(args['sourceId']);
  if (ref === undefined) return { error: 'sourceId is required.' };
  const active = typeof args['active'] === 'boolean' ? args['active'] : null;
  const { rows } = await db.query<{ id: string; title: string; group_name: string; is_active: boolean }>(
    `UPDATE discovery_sources
        SET is_active = COALESCE($2, is_active), title = COALESCE($3, title), group_name = COALESCE($4, group_name),
            last_error = CASE WHEN $2 = true THEN NULL ELSE last_error END
      WHERE id::text = $1 OR (lower(title) = lower($1) AND NOT EXISTS (SELECT 1 FROM discovery_sources WHERE id::text = $1))
      RETURNING id::text, title, group_name, is_active`,
    [ref, active, str(args['title']) ?? null, str(args['groupName']) ?? null],
  );
  if (rows.length === 0) return { error: 'No Discover source with that id or title. Use get_discover_sources.' };
  if (rows.length > 1) return { error: 'More than one source has that title; use its id.' };
  return { success: true, source: { id: rows[0]!.id, title: rows[0]!.title, group: rows[0]!.group_name, active: rows[0]!.is_active } };
}

async function setDiscoverItemState(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const ref = str(args['itemId']);
  const state = oneOf(args['state'], DISCOVER_STATES);
  if (ref === undefined || state === undefined) return { error: 'itemId and a valid state are needed.' };
  const stamp = state === 'to-review'
    ? `, metadata = metadata || jsonb_build_object('restoredAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`
    : state === 'shelved' ? `, metadata = metadata || jsonb_build_object('shelvedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))` : '';
  const { rows } = await db.query<{ id: string; title: string }>(
    `UPDATE content_items SET workflow_state = $1${stamp}
      WHERE source = 'discovered-article' AND (id::text = $2 OR rtrim(url, '/') = rtrim($2, '/'))
      RETURNING id::text, title`,
    [state, ref],
  );
  if (rows.length === 0) return { error: 'No Discover article with that id or URL.' };
  return { success: true, updated: rows.map((r) => ({ id: r.id, title: r.title, state })) };
}

// ── Sparks ───────────────────────────────────────────────────────────────────

async function updateSpark(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const id = str(args['sparkId']);
  const body = str(args['body']);
  const tags = Array.isArray(args['tags']) ? (args['tags'] as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()) : null;
  if (id === undefined || (body === undefined && tags === null)) return { error: 'sparkId and a new body or tags are needed.' };
  const { rows } = await db.query<{ id: string; body: string; tags: string[] }>(
    `UPDATE sparks SET body = COALESCE($2, body), tags = COALESCE($3, tags) WHERE id::text = $1 RETURNING id::text, body, tags`,
    [id, body ?? null, tags],
  );
  if (rows.length === 0) return { error: 'Spark not found.' };
  return { success: true, spark: rows[0] };
}

// ── Projects ─────────────────────────────────────────────────────────────────

async function resolveProjectId(db: Pool, ref: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM projects WHERE id = $1 OR lower(name) = lower($1) ORDER BY (id = $1) DESC LIMIT 1`, [ref]);
  return rows[0]?.id ?? null;
}

function cleanTags(v: unknown): string[] | null {
  return Array.isArray(v) ? [...new Set((v as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()))] : null;
}

async function createProject(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const name = str(args['name']);
  if (name === undefined) return { error: 'name is required.' };
  if (await resolveProjectId(db, name) !== null) return { error: `A project called "${name}" already exists; use update_project.` };
  const slug = (str(args['id']) ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const id = slug !== '' && await resolveProjectId(db, slug) === null ? slug : randomUUID();
  const tags = cleanTags(args['tags']) ?? [];
  await db.query(
    `INSERT INTO projects (id, name, colour, category, priority, project_type, description, goal, role, ownership, lifecycle_state, importance, expected_outputs, gitlab_paths, github_repos, links, tags)
     VALUES ($1, $2, 'gray', $3, $4, 'standard', $5, $6, '', '', 'active', $7, '{}', '{}', '{}', '[]', $8)`,
    [id, name, oneOf(args['category'], PROJECT_CATEGORIES) ?? 'work', oneOf(args['priority'], PROJECT_PRIORITIES) ?? 'medium',
      str(args['description']) ?? '', str(args['goal']) ?? '', oneOf(args['importance'], PROJECT_IMPORTANCE) ?? 'normal', tags],
  );
  return { success: true, project: { id, name }, url: `${env.FRONTEND_BASE_URL}/projects` };
}

async function updateProject(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const ref = str(args['projectId']);
  const id = ref === undefined ? null : await resolveProjectId(db, ref);
  if (id === null) return { error: 'Project not found. Use the id from the project catalogue.' };
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown): void => { if (v !== undefined && v !== null) { vals.push(v); sets.push(`${col} = $${vals.length.toString()}`); } };
  set('name', str(args['name']));
  set('description', typeof args['description'] === 'string' ? args['description'].trim() : undefined);
  set('goal', typeof args['goal'] === 'string' ? args['goal'].trim() : undefined);
  set('category', oneOf(args['category'], PROJECT_CATEGORIES));
  set('priority', oneOf(args['priority'], PROJECT_PRIORITIES));
  set('importance', oneOf(args['importance'], PROJECT_IMPORTANCE));
  set('lifecycle_state', oneOf(args['lifecycleState'], PROJECT_LIFECYCLE));
  set('tags', cleanTags(args['tags']));
  if (sets.length === 0) return { error: 'Nothing to change.' };
  vals.push(id);
  const { rows } = await db.query<{ id: string; name: string }>(
    `UPDATE projects SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length.toString()} RETURNING id, name`, vals);
  return { success: true, project: rows[0], changed: sets.map((s) => s.split(' = ')[0]) };
}

// ── Notes ────────────────────────────────────────────────────────────────────

async function updateNote(db: Pool, args: Record<string, unknown>, openNoteId?: string): Promise<unknown> {
  const id = str(args['noteId']);
  if (id === undefined) return { error: 'noteId is required.' };
  if (id === openNoteId) return { error: 'That note is open beside the chat: use propose_note_edit so the user can review the change.' };
  const content = typeof args['content'] === 'string' && args['content'].trim() !== '' ? args['content'] : undefined;
  const title = str(args['title']);
  const projectRef = str(args['projectId']);
  if (content === undefined && title === undefined && projectRef === undefined) return { error: 'Give content, a title or a projectId to change.' };
  const projectId = projectRef === undefined ? undefined : await resolveProjectId(db, projectRef);
  if (projectId === null) return { error: 'Project not found.' };

  const { writeNote } = await import('../services/noteVersionService.js');
  const { scheduleNoteIndexing } = await import('../routes/notes.js');
  const { rows } = await db.query<{ content: string; revision: number }>(`SELECT content, revision FROM notes WHERE id::text = $1 AND status = 'active'`, [id]);
  const row = rows[0];
  if (row === undefined) return { error: 'Note not found or archived.' };
  let wrapper: Record<string, unknown> = {};
  try { wrapper = JSON.parse(row.content) as Record<string, unknown>; } catch { wrapper = {}; }

  const mode = args['mode'] === 'replace' ? 'replace' : 'append';
  let note;
  if (content !== undefined && mode === 'append' && title === undefined && projectId === undefined) {
    note = await writeNote(db, id, { appendBlocks: textToBlocks(content) });
  } else {
    // Keep the current text in the note's history before Athena rewrites it.
    const protectedNote = mode === 'replace' && content !== undefined
      ? await writeNote(db, id, { content: row.content, expectedRevision: row.revision, protect: true })
      : { revision: row.revision };
    let blocks: unknown[] = [];
    try { blocks = JSON.parse(typeof wrapper['contentJson'] === 'string' ? wrapper['contentJson'] : '[]') as unknown[]; } catch { blocks = []; }
    if (content !== undefined) blocks = mode === 'replace' ? textToBlocks(content) : [...blocks, ...textToBlocks(content)];
    const next = { ...wrapper, ...(title !== undefined ? { title } : {}), contentJson: JSON.stringify(blocks) };
    note = await writeNote(db, id, {
      content: JSON.stringify(next), expectedRevision: protectedNote.revision,
      ...(projectId !== undefined ? { projectId } : {}),
    });
  }
  scheduleNoteIndexing(db, note);
  return { success: true, note: { id, title: title ?? wrapper['title'], url: `${env.FRONTEND_BASE_URL}/think?noteId=${id}` }, mode: content === undefined ? 'metadata' : mode };
}

// ── Diagrams ─────────────────────────────────────────────────────────────────

interface NodeSpec { key: string; label: string; description?: string; kind: typeof NODE_KINDS[number]; colour: string; footnote: boolean }
interface EdgeSpec { from: string; to: string; label: string; dashed: boolean }

function nodeSpecs(v: unknown): NodeSpec[] {
  return (Array.isArray(v) ? v as Array<Record<string, unknown>> : []).flatMap((n) => {
    const label = str(n['label']);
    if (label === undefined) return [];
    const description = str(n['description']);
    return [{
      key: str(n['key']) ?? label, label, ...(description !== undefined ? { description } : {}),
      kind: oneOf(n['kind'], NODE_KINDS) ?? 'process', colour: oneOf(n['colour'], COLOUR_NAMES) ?? 'grey', footnote: n['footnote'] === true,
    }];
  });
}

function edgeSpecs(v: unknown): EdgeSpec[] {
  return (Array.isArray(v) ? v as Array<Record<string, unknown>> : []).flatMap((e) => {
    const from = str(e['from']);
    const to = str(e['to']);
    return from === undefined || to === undefined ? [] : [{ from, to, label: str(e['label']) ?? '', dashed: e['dashed'] === true }];
  });
}

function makeNode(spec: NodeSpec, x: number, y: number): DiagramNode {
  const size = NODE_SIZE[spec.kind];
  const colour = DIAGRAM_COLOURS[spec.colour] ?? DIAGRAM_COLOURS['grey']!;
  return {
    id: randomUUID(), kind: spec.kind as DiagramKind, label: spec.label, ...(spec.description !== undefined ? { description: spec.description } : {}),
    x, y, width: size.width, height: size.height, parentId: null, fill: colour.fill, stroke: colour.stroke,
    textColor: '#161616', fontSize: 16, assetId: null,
  };
}

function makeEdge(sourceId: string, targetId: string, spec: EdgeSpec): DiagramEdge {
  return {
    id: randomUUID(), sourceId, targetId, sourcePort: 'right', targetPort: 'left', route: 'orthogonal', waypoints: [],
    label: spec.label, stroke: '#525252', dashed: spec.dashed, arrows: 'end',
  };
}

/** Columns by longest path from the starting shapes (cycles tolerated), rows in input order. */
export function layoutColumns(keys: string[], edges: Array<{ from: string; to: string }>): Map<string, number> {
  const column = new Map(keys.map((k) => [k, 0]));
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const from = column.get(e.from);
      const to = column.get(e.to);
      if (from !== undefined && to !== undefined && to < from + 1 && from + 1 < keys.length) { column.set(e.to, from + 1); changed = true; }
    }
    if (!changed) break;
  }
  return column;
}

/** Finds a shape by id, or by label (case-insensitive) when unambiguous. */
function findNode(doc: DiagramDocument, ref: string, extra: Map<string, string> = new Map()): DiagramNode | string {
  const byKey = extra.get(ref) ?? extra.get(ref.toLowerCase());
  if (byKey !== undefined) return doc.nodes.find((n) => n.id === byKey) ?? `Shape "${ref}" not found.`;
  const byId = doc.nodes.find((n) => n.id === ref);
  if (byId !== undefined) return byId;
  const byLabel = doc.nodes.filter((n) => n.label.trim().toLowerCase() === ref.trim().toLowerCase());
  if (byLabel.length === 1) return byLabel[0]!;
  return byLabel.length > 1 ? `More than one shape is labelled "${ref}"; use its id.` : `Shape "${ref}" not found.`;
}

function legendFrom(v: unknown, existing: DiagramDocument['legend']): DiagramDocument['legend'] {
  if (!Array.isArray(v)) return existing;
  const entries = (v as Array<Record<string, unknown>>).flatMap((e) => {
    const colour = oneOf(e['colour'], COLOUR_NAMES);
    const label = str(e['label']);
    return colour === undefined || label === undefined ? [] : [{ colour: DIAGRAM_COLOURS[colour]!.stroke, label }];
  });
  return { visible: entries.length > 0, position: existing?.position ?? 'top-right', entries };
}

/** Adds shapes (placed to the right of anything already there) and connectors to a document. */
export function addToDiagram(doc: DiagramDocument, nodes: NodeSpec[], edges: EdgeSpec[]): { doc: DiagramDocument; problems: string[] } {
  const problems: string[] = [];
  const startX = doc.nodes.length === 0 ? LAYOUT.left : Math.max(...doc.nodes.map((n) => n.x + n.width)) + LAYOUT.columnGap - NODE_SIZE.process.width;
  const newKeys = nodes.map((n) => n.key.toLowerCase());
  const columns = layoutColumns(newKeys, edges.map((e) => ({ from: e.from.toLowerCase(), to: e.to.toLowerCase() })));
  const rows = new Map<number, number>();
  const keyToId = new Map<string, string>();
  const added: DiagramNode[] = [];
  for (const spec of nodes) {
    const col = columns.get(spec.key.toLowerCase()) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const node = makeNode(spec, startX + col * LAYOUT.columnGap, LAYOUT.top + row * LAYOUT.rowGap);
    keyToId.set(spec.key.toLowerCase(), node.id);
    added.push(node);
  }
  const next: DiagramDocument = { ...doc, nodes: [...doc.nodes, ...added], edges: [...doc.edges], footnotes: [...(doc.footnotes ?? [])] };
  nodes.forEach((spec, i) => {
    if (spec.footnote) next.footnotes!.push({ id: randomUUID(), targetId: added[i]!.id, source: 'description' });
  });
  for (const e of edges) {
    const from = findNode(next, e.from, keyToId);
    const to = findNode(next, e.to, keyToId);
    if (typeof from === 'string' || typeof to === 'string') { problems.push(typeof from === 'string' ? from : to as string); continue; }
    next.edges.push(makeEdge(from.id, to.id, e));
  }
  if (next.footnotes!.length === 0) delete next.footnotes;
  return { doc: next, problems };
}

async function createDiagram(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const title = str(args['title']);
  const nodes = nodeSpecs(args['nodes']);
  if (title === undefined || nodes.length === 0) return { error: 'A title and at least one shape are needed.' };
  if (nodes.length > MAX_DIAGRAM_NODES) return { error: `At most ${MAX_DIAGRAM_NODES.toString()} shapes per call.` };
  const projectRef = str(args['projectId']);
  const project = projectRef === undefined ? null : await resolveProjectId(db, projectRef);
  const { createCanvas, updateCanvas } = await import('../services/canvasService.js');
  const { getDiagram, saveDiagram } = await import('../services/diagramService.js');
  const { emptyDiagram } = await import('../types/diagram.js');
  const { doc, problems } = addToDiagram(emptyDiagram(), nodes, edgeSpecs(args['edges']));
  const legend = legendFrom(args['legend'], undefined);
  const canvas = await createCanvas({ title, canvasType: 'diagram', ...(project !== null ? { project } : {}) });
  const description = str(args['description']);
  if (description !== undefined) await updateCanvas(canvas.id, { description });
  const current = await getDiagram(canvas.id);
  await saveDiagram(canvas.id, { revision: current.revision, document: { ...doc, ...(legend !== undefined ? { legend } : {}) } });
  return {
    success: true, diagram: { id: canvas.id, title, shapes: doc.nodes.length, connectors: doc.edges.length },
    url: `${env.FRONTEND_BASE_URL}/think?mapId=${canvas.id}`,
    ...(problems.length > 0 ? { skippedConnectors: problems } : {}),
  };
}

async function updateDiagram(args: Record<string, unknown>): Promise<unknown> {
  const id = str(args['diagramId']);
  if (id === undefined) return { error: 'diagramId is required.' };
  const { getDiagram, saveDiagram, getCanvasType } = await import('../services/diagramService.js');
  if (await getCanvasType(id) !== 'diagram') return { error: 'Diagram not found.' };
  const { updateCanvas } = await import('../services/canvasService.js');
  const current = await getDiagram(id);
  let doc: DiagramDocument = structuredClone(current.document);
  const problems: string[] = [];

  for (const ref of Array.isArray(args['removeNodes']) ? args['removeNodes'] as unknown[] : []) {
    if (typeof ref !== 'string') continue;
    const node = findNode(doc, ref);
    if (typeof node === 'string') { problems.push(node); continue; }
    const gone = new Set([node.id, ...doc.edges.filter((e) => e.sourceId === node.id || e.targetId === node.id).map((e) => e.id)]);
    doc = {
      ...doc,
      nodes: doc.nodes.filter((n) => n.id !== node.id).map((n) => (n.parentId === node.id ? { ...n, parentId: null } : n)),
      edges: doc.edges.filter((e) => !gone.has(e.id)),
      ...(doc.footnotes !== undefined ? { footnotes: doc.footnotes.filter((f) => !gone.has(f.targetId)) } : {}),
    };
  }
  for (const u of Array.isArray(args['updateNodes']) ? args['updateNodes'] as Array<Record<string, unknown>> : []) {
    const ref = str(u['node']);
    const node = ref === undefined ? 'Each update needs a node.' : findNode(doc, ref);
    if (typeof node === 'string') { problems.push(node); continue; }
    const label = str(u['label']);
    const description = str(u['description']);
    const colour = oneOf(u['colour'], COLOUR_NAMES);
    if (label !== undefined) node.label = label;
    if (description !== undefined) node.description = description;
    if (colour !== undefined) { node.fill = DIAGRAM_COLOURS[colour]!.fill; node.stroke = DIAGRAM_COLOURS[colour]!.stroke; }
    if (u['footnote'] === true && !(doc.footnotes ?? []).some((f) => f.targetId === node.id)) {
      doc.footnotes = [...(doc.footnotes ?? []), { id: randomUUID(), targetId: node.id, source: 'description' }];
    }
  }
  const added = addToDiagram(doc, nodeSpecs(args['addNodes']), edgeSpecs(args['addEdges']));
  doc = added.doc;
  problems.push(...added.problems);
  const legend = legendFrom(args['legend'], doc.legend);
  if (legend !== undefined) doc.legend = legend;
  if (doc.nodes.length > MAX_DIAGRAM_NODES * 4) return { error: 'That would make the diagram too large.' };

  const saved = await saveDiagram(id, { revision: current.revision, document: doc });
  const title = str(args['title']);
  if (title !== undefined) await updateCanvas(id, { title });
  return {
    success: true, diagram: { id, shapes: saved.document.nodes.length, connectors: saved.document.edges.length, revision: saved.revision },
    url: `${env.FRONTEND_BASE_URL}/think?mapId=${id}`,
    note: 'Saved. If the diagram is open in the editor, tell the user to reopen it to see the changes.',
    ...(problems.length > 0 ? { problems } : {}),
  };
}

// ── Mind maps ────────────────────────────────────────────────────────────────

async function createMindMap(db: Pool, args: Record<string, unknown>): Promise<unknown> {
  const title = str(args['title']);
  const ideas = (Array.isArray(args['ideas']) ? args['ideas'] as Array<Record<string, unknown>> : [])
    .flatMap((i) => { const label = str(i['label']); return label === undefined ? [] : [{ label, body: str(i['body']), parent: str(i['parent']) }]; });
  if (title === undefined || ideas.length === 0) return { error: 'A title and at least one idea are needed.' };
  if (ideas.length > MAX_MAP_IDEAS) return { error: `At most ${MAX_MAP_IDEAS.toString()} ideas per map.` };
  const projectRef = str(args['projectId']);
  const project = projectRef === undefined ? null : await resolveProjectId(db, projectRef);
  const { createCanvas, applyOps } = await import('../services/canvasService.js');
  const canvas = await createCanvas({ title, rootLabel: str(args['centre']) ?? title, ...(project !== null ? { project } : {}) });
  const rootId = canvas.nodes[0]?.id;
  if (rootId === undefined) return { error: 'Could not create the map.' };
  const ids = new Map<string, string>();
  const ops = ideas.map((idea) => {
    const id = randomUUID();
    const parent = idea.parent !== undefined ? ids.get(idea.parent.toLowerCase()) ?? rootId : rootId;
    ids.set(idea.label.toLowerCase(), id);
    return {
      op: 'add' as const, id, label: idea.label, ...(idea.body !== undefined ? { body: idea.body } : {}),
      connectTo: { nodeId: parent, edgeId: randomUUID() },
    };
  });
  await applyOps(canvas.id, ops);
  return { success: true, map: { id: canvas.id, title, ideas: ideas.length }, url: `${env.FRONTEND_BASE_URL}/think?mapId=${canvas.id}` };
}
