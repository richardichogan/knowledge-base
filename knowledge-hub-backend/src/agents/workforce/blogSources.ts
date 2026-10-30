import type { PoolClient } from 'pg';
import type { ScopedBlogResearch } from './blogTeam.js';
import type { BlogDomainCapabilities } from './blogDomain.js';
import { contentSignature, record, type AssignmentBrief, type AssignmentScope, type SourceVersion } from './contracts.js';
import { ConflictError, ValidationError } from '../../types/errors.js';
import { USER_PROFESSIONAL_PROFILE } from '../../ai/userProfile.js';
import { queryTerms } from '../../services/knowledge/search.js';

const MAX_SOURCE_CHARS = 60_000;
const VOICE_CHARS = 2_500;
const AUTHOR_CHARS = 3_500;
const MAX_THEME_SPARKS = 100;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SOURCE_TYPES = ['discover', 'spark-theme', 'blog-context', 'blog-voice', 'blog-author-post', 'earlier-post',
  'author-memory', 'author-message', 'configured-profile', 'chat-scope', 'blog-checkpoint'] as const;
const CONFIGURED_PROFILE_ID = 'professional';
const MAX_AUTHOR_MEMORIES = 12;
const MAX_VOICE_POSTS = 3;
const MAX_AUTHOR_POSTS = 3;
const MAX_EARLIER_POSTS = 5;
const MAX_AUTHOR_CHATS = 2;
const MAX_AUTHOR_MESSAGES = 6;
const MIN_VOICE_CHARS = 200;
type SourceType = typeof SOURCE_TYPES[number];
export interface BlogSourceSelection { type: SourceType; id: string }
interface LoadedSource { selection: BlogSourceSelection; version: string; data: Record<string, unknown> }

function changed(message: string): never {
  throw new ConflictError(`${message} Saved work has been retained; a fresh authorised action is required.`, 'ASSIGNMENT_SOURCE_CHANGED');
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} is invalid.`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function selection(value: { type: string; id: string }): BlogSourceSelection {
  const type = SOURCE_TYPES.find(type => type === value.type);
  if (!type || (type === 'configured-profile' ? value.id !== CONFIGURED_PROFILE_ID
    : type === 'author-message' ? !/^[1-9][0-9]{0,18}$/.test(value.id) : !UUID.test(value.id))) throw new ValidationError('The manual blog source type or ID is not supported.');
  return { type, id: value.id };
}

async function aliases(client: PoolClient, ids: string[]): Promise<string[]> {
  const result = await client.query<{ id: string }>('SELECT id::text FROM nodes WHERE ref_id=ANY($1::text[])', [ids]);
  return [...ids, ...result.rows.map(row => row.id)];
}

function checkExcluded(ids: string[], scope: AssignmentScope): void {
  if (ids.some(id => scope.excludedSourceIds.includes(id))) changed('A controlling source is excluded.');
}

export function blogCheckpointSourceData(input: Record<string, unknown>): Record<string, unknown> {
  const checkpoint = record(input['blogCheckpoint'], 'Controlling blog checkpoint');
  if (contentSignature(checkpoint) !== input['workforceBlogProjectionSignature']) changed('The controlling blog checkpoint changed outside accepted team work.');
  const pendingRecheck = input['workforceCanonicalBlog'] === true && typeof input['workforceRecheckSourceJobId'] === 'string';
  return {
    checkpoint,
    output: record(input['workforceBlogOutput'] ?? (pendingRecheck ? {} : undefined), 'Controlling blog output revisions'),
    ...(pendingRecheck ? { recheckSourceJobId: input['workforceRecheckSourceJobId'],
      recheckPost: record(input['workforceRecheckPost'], 'Commissioned recheck candidate') } : {}),
  };
}

async function readSource(client: PoolClient, selected: BlogSourceSelection, brief: AssignmentBrief): Promise<LoadedSource> {
  checkExcluded([selected.id, `${selected.type}:${selected.id}`], brief.scope);
  checkExcluded(await aliases(client, [selected.id]), brief.scope);
  let data: Record<string, unknown>;
  if (['discover', 'blog-context', 'blog-voice', 'blog-author-post', 'earlier-post'].includes(selected.type)) {
    const result = await client.query<{ data: unknown }>('SELECT to_jsonb(c) AS data FROM content_items c WHERE id=$1 FOR SHARE', [selected.id]);
    if (!result.rows[0]) changed('A controlling article was removed.');
    data = record(result.rows[0].data, 'Source article');
    const source = data['source'];
    if (selected.type === 'discover' ? source !== 'email' && source !== 'discovered-article' : source !== 'cms-blog') changed('The article no longer belongs to the commissioned source collection.');
    if (brief.scope.projectId !== null && data['project_context'] !== brief.scope.projectId) changed('The article is outside the commissioned project.');
    checkExcluded(await aliases(client, [selected.id, text(data['source_id'], 'Article source ID')]), brief.scope);
  } else if (selected.type === 'spark-theme') {
    const result = await client.query<{ data: unknown }>('SELECT to_jsonb(c) AS data FROM spark_clusters c WHERE id=$1 FOR UPDATE', [selected.id]);
    if (!result.rows[0]) changed('The controlling Spark theme was removed.');
    const header = record(result.rows[0].data, 'Spark theme');
    if (header['dismissed'] === true || header['status'] === 'dismissed') changed('The controlling Spark theme was dismissed.');
    const members = await client.query<{ data: unknown }>('SELECT to_jsonb(s) AS data FROM sparks s WHERE cluster_id=$1 ORDER BY id FOR SHARE', [selected.id]);
    if (!members.rows.length || members.rows.length > MAX_THEME_SPARKS) throw new ValidationError('The commissioned theme must contain between one and 100 explicitly bounded Sparks.');
    const sparks: Record<string, unknown>[] = [];
    for (const member of members.rows) {
      const spark = record(member.data, 'Spark');
      const sourceId = nullableText(spark['source_id'], 'Spark source ID');
      const ids = sourceId ? [text(spark['id'], 'Spark ID'), sourceId] : [text(spark['id'], 'Spark ID')];
      checkExcluded(await aliases(client, ids), brief.scope);
      if (sourceId) {
        const titles = await client.query<{ title: string }>('SELECT title FROM nodes WHERE ref_id=$1 AND ref_type=$2 ORDER BY id FOR SHARE', [sourceId, spark['source_type']]);
        if (titles.rows.length > 1) throw new ValidationError('The Spark source title is ambiguous.');
        spark['workforceSourceTitle'] = titles.rows[0]?.title ?? null;
      } else spark['workforceSourceTitle'] = null;
      if (brief.scope.projectId !== null) {
        if (!sourceId) changed('A Spark has no verifiable project association.');
        const articles = await client.query<{ project_id: string | null }>('SELECT project_context AS project_id FROM content_items WHERE id::text=$1 FOR SHARE', [sourceId]);
        const notes = await client.query<{ project_id: string | null }>('SELECT project_id FROM notes WHERE id::text=$1 FOR SHARE', [sourceId]);
        const projects = [...articles.rows, ...notes.rows];
        if (!projects.length || projects.some(row => row.project_id !== brief.scope.projectId)) changed('A Spark is outside the commissioned project.');
        spark['workforceSourceProjects'] = projects;
      }
      sparks.push(spark);
    }
    data = { header, sparks };
  } else if (selected.type === 'author-memory') {
    const result = await client.query<{ data: unknown }>('SELECT to_jsonb(m) AS data FROM athena_memories m WHERE id=$1 FOR SHARE', [selected.id]);
    if (!result.rows[0]) changed('An approved author-context memory was removed.');
    data = record(result.rows[0].data, 'Author memory');
    if (typeof data['source_session_id'] === 'string') checkExcluded(await aliases(client, [data['source_session_id'], `chat-scope:${data['source_session_id']}`]), brief.scope);
    const applies = data['scope_type'] === 'global'
      || (data['scope_type'] === 'project' && data['scope_value'] === brief.scope.projectId)
      || (data['scope_type'] === 'persona' && data['scope_value'] === 'blog_post')
      || (data['scope_type'] === 'output' && ['blog', 'blog_post', 'article'].includes(String(data['scope_value'])));
    if (data['status'] !== 'active' || (data['kind'] !== 'profile' && data['kind'] !== 'instruction') || !applies) changed('The author-context memory is no longer active or applicable.');
  } else if (selected.type === 'configured-profile') {
    await client.query('LOCK TABLE athena_memories IN SHARE MODE');
    const profiles = await client.query("SELECT id FROM athena_memories WHERE kind='profile' LIMIT 1 FOR SHARE");
    if (profiles.rowCount) changed('Configured background cannot replace an existing, paused or dismissed author profile.');
    data = { content: USER_PROFESSIONAL_PROFILE };
  } else if (selected.type === 'author-message') {
    const result = await client.query<{ data: unknown; project_id: string | null }>(
      `SELECT to_jsonb(m) AS data,s.project_id FROM ai_chat_messages m JOIN ai_chat_sessions s ON s.id=m.session_id
        WHERE m.id::text=$1 AND m.role='user' FOR SHARE OF m,s`, [selected.id],
    );
    if (!result.rows[0]) changed('A commissioned user-authored message was removed.');
    if (brief.scope.projectId !== null && result.rows[0].project_id !== brief.scope.projectId) changed('The commissioned author message is outside the project.');
    data = record(result.rows[0].data, 'Author message');
    const conversationId = text(data['session_id'], 'Author conversation ID');
    checkExcluded(await aliases(client, [conversationId, `chat-scope:${conversationId}`]), brief.scope);
  } else if (selected.type === 'blog-checkpoint') {
    const owners = await client.query<{ id: string; owner_id: string }>(
      `SELECT a.id,a.owner_id FROM agent_assignments a JOIN agent_jobs j ON j.assignment_id=a.id
        WHERE j.id=$1 FOR SHARE OF a`, [selected.id],
    );
    if (owners.rows[0]?.owner_id !== brief.ownerId) changed('The controlling blog checkpoint is unavailable for this owner.');
    const result = await client.query<{ input: Record<string, unknown>; owner_id: string; subject_id: string }>(
      `SELECT j.input,a.owner_id,j.subject_id FROM agent_jobs j JOIN agent_assignments a ON a.id=j.assignment_id
        WHERE j.id=$1 AND j.specialist='blog-writer' AND a.id=$2 FOR SHARE OF j`, [selected.id, owners.rows[0].id],
    );
    const saved = result.rows[0];
    if (!saved || saved.owner_id !== brief.ownerId || saved.subject_id !== brief.subjectId) changed('The controlling blog checkpoint is unavailable for this owner or subject.');
    data = blogCheckpointSourceData(saved.input);
  } else {
    if (brief.origin.kind !== 'chat' || selected.id !== brief.origin.conversationId) throw new ValidationError('A conversation scope must belong to the commission origin.');
    const result = await client.query<{ data: unknown }>(
      "SELECT jsonb_build_object('projectId',project_id,'excludedSources',COALESCE(excluded_sources,'[]'::jsonb)) AS data FROM ai_chat_sessions WHERE id=$1 FOR SHARE", [selected.id],
    );
    if (!result.rows[0]) changed('The commissioning conversation was removed.');
    data = record(result.rows[0].data, 'Conversation scope');
  }
  return { selection: selected, version: contentSignature(data), data };
}

async function loadSources(client: PoolClient, brief: AssignmentBrief, compare: boolean): Promise<LoadedSource[]> {
  if (brief.workflow !== 'manual-blog' || brief.policyProfile !== 'manual-blog' || brief.scope.readOnly) throw new ValidationError('The source adapter requires a mutating manual blog commission.');
  if (brief.origin.kind === 'schedule') throw new ValidationError('Scheduled work requires its own approved policy, not the manual blog pilot.');
  const originConversation = brief.origin.kind === 'chat' ? brief.origin.conversationId : null;
  if (originConversation !== null && !brief.scope.sources.some(source => source.type === 'chat-scope' && source.id === originConversation)) {
    throw new ValidationError('The exact originating conversation scope is required.');
  }
  const sources: LoadedSource[] = [];
  for (const source of [...brief.scope.sources].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))) {
    const loaded = await readSource(client, selection(source), brief);
    if (compare && loaded.version !== source.version) changed('A controlling source or conversation scope changed.');
    sources.push(loaded);
  }
  const origin = sources.find(source => source.selection.type === 'chat-scope');
  if (origin) {
    if (!Array.isArray(origin.data['excludedSources'])) throw new ValidationError('The conversation exclusions could not be verified.');
    const values: unknown[] = origin.data['excludedSources'];
    const ids = values.map(value => text(record(value, 'Excluded source')['id'], 'Excluded source ID'));
    if (ids.some(id => !brief.scope.excludedSourceIds.includes(id))) changed('The conversation has a newer source exclusion.');
  }
  const primary = sources.filter(source => source.selection.type === 'discover' || source.selection.type === 'spark-theme');
  if (brief.subjectType !== 'blog-source' || primary.length !== 1 || brief.subjectId !== `${primary[0]!.selection.type}:${primary[0]!.selection.id}`) throw new ValidationError('Exactly one primary source must match the commissioned subject.');
  return sources;
}

/** Snapshot exact selections inside the same trusted commissioning transaction; this does not broaden retrieval. */
export async function captureManualBlogSources(client: PoolClient, brief: AssignmentBrief): Promise<{ sources: SourceVersion[]; title: string }> {
  const loaded = await loadSources(client, brief, false);
  const primary = loaded.find(source => source.selection.type === 'discover' || source.selection.type === 'spark-theme')!;
  const title = primary.selection.type === 'discover' ? text(primary.data['title'], 'Article title')
    : text(record(primary.data['header'], 'Theme header')['theme'], 'Theme title');
  return { sources: loaded.map(source => ({ ...source.selection, version: source.version })), title };
}

/** Trusted selection only: no model/embedding calls and no private text returned to a role before version-bound loading. */
export async function selectManualBlogContext(
  client: PoolClient, brief: AssignmentBrief, title: string, length: 'short' | 'long',
): Promise<BlogSourceSelection[]> {
  const terms = queryTerms(title).join(' | ');
  const bindings = [brief.scope.projectId, brief.scope.excludedSourceIds, terms];
  // Identifiers below are fixed server-owned expressions; values always remain query parameters.
  const visible = (ids: string[]): string => `NOT (ARRAY[${ids.join(',')}] && $2::text[])
    AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.ref_id=ANY(ARRAY[${ids.join(',')}]) AND n.id::text=ANY($2::text[]))`;
  const memories = await client.query<{ id: string }>(
    `SELECT m.id::text FROM athena_memories m WHERE m.status='active' AND m.kind IN ('profile','instruction')
      AND (m.scope_type='global' OR (m.scope_type='project' AND m.scope_value=$1)
        OR (m.scope_type='persona' AND m.scope_value='blog_post')
        OR (m.scope_type='output' AND m.scope_value IN ('blog','blog_post','article')))
      AND ${visible(['m.id::text', "'author-memory:'||m.id::text", 'm.source_session_id::text', "'chat-scope:'||m.source_session_id::text"])}
      ORDER BY (m.kind='profile') DESC,m.created_at DESC,m.id LIMIT $3`,
    [bindings[0], bindings[1], MAX_AUTHOR_MEMORIES],
  );
  const selected: BlogSourceSelection[] = memories.rows.map(row => ({ type: 'author-memory', id: row.id }));
  const profiles = await client.query("SELECT id FROM athena_memories WHERE kind='profile' LIMIT 1");
  if (!profiles.rowCount && !brief.scope.excludedSourceIds.includes(CONFIGURED_PROFILE_ID)
    && !brief.scope.excludedSourceIds.includes(`configured-profile:${CONFIGURED_PROFILE_ID}`)) {
    selected.push({ type: 'configured-profile', id: CONFIGURED_PROFILE_ID });
  }
  const eligiblePost = `c.source='cms-blog' AND ($1::text IS NULL OR c.project_context=$1)
    AND ${visible(['c.id::text', 'c.source_id', "'blog-context:'||c.id::text", "'blog-voice:'||c.id::text",
    "'blog-author-post:'||c.id::text", "'earlier-post:'||c.id::text"])}`;
  const voices = await client.query<{ id: string }>(
    `SELECT c.id::text FROM content_items c WHERE ${eligiblePost} AND length(trim(c.body))>$3
      ORDER BY c.published_at DESC NULLS LAST,c.id LIMIT $4`, [bindings[0], bindings[1], MIN_VOICE_CHARS, MAX_VOICE_POSTS],
  );
  selected.push(...voices.rows.map(row => ({ type: 'blog-voice' as const, id: row.id })));
  if (terms) {
    const related = await client.query<{ id: string }>(
      `SELECT c.id::text FROM content_items c WHERE ${eligiblePost} AND c.url IS NOT NULL AND length(trim(c.body))>0
        AND to_tsvector('english',c.title||' '||COALESCE(c.summary,'')||' '||COALESCE(c.body,'')) @@ to_tsquery('english',$3)
        ORDER BY ts_rank(to_tsvector('english',c.title||' '||COALESCE(c.summary,'')||' '||COALESCE(c.body,'')),to_tsquery('english',$3)) DESC,c.id LIMIT $4`,
      [...bindings, length === 'short' ? MAX_EARLIER_POSTS : MAX_AUTHOR_POSTS],
    );
    selected.push(...related.rows.slice(0, MAX_AUTHOR_POSTS).map(row => ({ type: 'blog-author-post' as const, id: row.id })));
    if (length === 'short') selected.push(...related.rows.map(row => ({ type: 'earlier-post' as const, id: row.id })));
    const messages = await client.query<{ id: string }>(
      `WITH eligible AS (
        SELECT m.id,m.session_id,m.created_at,ts_rank(to_tsvector('english',m.content),to_tsquery('english',$3)) AS rank
        FROM ai_chat_messages m JOIN ai_chat_sessions s ON s.id=m.session_id
        WHERE m.role='user' AND ($1::text IS NULL OR s.project_id::text=$1)
          AND ${visible(['m.id::text', "'author-message:'||m.id::text", 's.id::text', "'chat-scope:'||s.id::text"])}
          AND to_tsvector('english',m.content) @@ to_tsquery('english',$3)
      ), conversations AS (
        SELECT session_id,MAX(rank) AS rank FROM eligible GROUP BY session_id ORDER BY rank DESC,session_id LIMIT $4
      ), ranked AS (
        SELECT e.id,e.session_id,ROW_NUMBER() OVER(PARTITION BY e.session_id ORDER BY e.rank DESC,e.created_at DESC,e.id DESC) AS n
          FROM eligible e JOIN conversations c ON c.session_id=e.session_id
      ) SELECT id::text FROM ranked WHERE n<=$5 ORDER BY session_id,n`,
      [...bindings, MAX_AUTHOR_CHATS, MAX_AUTHOR_MESSAGES],
    );
    selected.push(...messages.rows.map(row => ({ type: 'author-message' as const, id: row.id })));
  }
  return selected;
}

export function manualBlogSourceCapabilities(): BlogDomainCapabilities {
  return {
    checkCurrent: async (client, assignment): Promise<void> => { await loadSources(client, assignment.brief, true); },
    loadResearch: async (client, assignment): Promise<ScopedBlogResearch> => {
      const sources = await loadSources(client, assignment.brief, true);
      const job = await client.query<{ input: Record<string, unknown> }>("SELECT input FROM agent_jobs WHERE assignment_id=$1 AND step_key='research'", [assignment.id]);
      const length = job.rows[0]?.input['length'];
      if (length !== 'short' && length !== 'long') throw new ValidationError('The commissioned blog format is required.');
      if (!assignment.brief.instruction.startsWith(`[manual-blog:${length}] `)) changed('The commissioned blog format changed.');
      const primary = sources.find(source => source.selection.type === 'discover' || source.selection.type === 'spark-theme')!;
      let source: ScopedBlogResearch['source'];
      if (primary.selection.type === 'discover') {
        const data = primary.data;
        const metadata = record(data['metadata'], 'Article metadata');
        const body = text(data['body'], 'Article body');
        const collection = data['source'];
        if (collection !== 'email' && collection !== 'discovered-article') throw new ValidationError('The commissioned article collection is invalid.');
        if (!body.trim() || body.length > MAX_SOURCE_CHARS) throw new ValidationError('The commissioned article must contain a bounded, non-empty body.');
        source = { kind: 'discover', article: {
          title: text(data['title'], 'Article title'), body, source: collection,
          url: nullableText(data['url'], 'Article URL'), publishedAt: metadata['originalPublishedAt'] === undefined ? null : nullableText(metadata['originalPublishedAt'], 'Publication date'),
          publicationDateKnown: metadata['publicationDateKnown'] === true,
        } };
      } else {
        const header = record(primary.data['header'], 'Theme header');
        const sparks = primary.data['sparks'];
        if (!Array.isArray(sparks)) throw new ValidationError('The commissioned Sparks are unavailable.');
        const values: unknown[] = sparks;
        source = { kind: 'spark-theme', theme: text(header['theme'], 'Theme title'), ideas: values.map(value => ({
          body: text(record(value, 'Spark')['body'], 'Spark body'),
          sourceTitle: nullableText(record(value, 'Spark')['workforceSourceTitle'], 'Spark source title'),
        })) };
      }
      const posts = sources.filter(source => ['blog-context', 'blog-voice', 'blog-author-post', 'earlier-post'].includes(source.selection.type));
      return {
        source, length, instruction: assignment.brief.instruction.replace(/^\[manual-blog:(?:short|long)\] /, ''),
        earlierPosts: posts.filter(source => ['blog-context', 'earlier-post'].includes(source.selection.type) && typeof source.data['url'] === 'string').map(source => ({ title: text(source.data['title'], 'Post title'), url: text(source.data['url'], 'Post URL') })),
        voiceSamples: posts.filter(source => ['blog-context', 'blog-voice'].includes(source.selection.type)).map(source => ({ title: text(source.data['title'], 'Sample title'), sample: text(source.data['body'], 'Sample text').slice(0, VOICE_CHARS) })),
        authorRecords: sources.filter(source => ['author-memory', 'author-message', 'configured-profile', 'blog-context', 'blog-author-post'].includes(source.selection.type)).map(source => ({
          id: `${source.selection.type}:${source.selection.id}`, ref: `${source.selection.type}:${source.selection.id}`,
          kind: source.selection.type === 'author-message' ? 'user-message' : ['blog-context', 'blog-author-post'].includes(source.selection.type) ? 'published-post' : source.selection.type === 'configured-profile' || source.data['kind'] === 'profile' ? 'profile' : 'preference',
          text: text(['blog-context', 'blog-author-post'].includes(source.selection.type) ? source.data['body'] : source.data['content'], 'Author context').slice(0, AUTHOR_CHARS),
        })),
      };
    },
  };
}
