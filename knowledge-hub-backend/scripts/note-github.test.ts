import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { getDb } from '../src/db/db.js';
import { notesRouter } from '../src/routes/notes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { GitHubClient } from '../src/integrations/github/githubClient.js';
import { noteMarkdown, githubMarkdownBlocks } from '../src/services/noteMarkdown.js';
import { validatePublicationPath, publishNote, startPublication, publicationRow, checkPublication, syncNotePublications } from '../src/services/noteGitHubService.js';
import type { GitHubPublication } from '../src/services/noteGitHubService.js';
import { writeNote, listNoteVersions, getNoteVersion } from '../src/services/noteVersionService.js';
import { reconcileContentStore } from '../src/services/githubDocumentIdentity.js';
import { getContentItemsByIds, getRagItems, upsertContentItem } from '../src/db/queries.js';
import { syncContentStore } from '../src/integrations/github/contentStoreSync.js';
import { env } from '../src/config/env.js';

const content = (text: string): string => JSON.stringify({ title: 'Linked note', contentType: 'note',
  contentJson: JSON.stringify([
    { type: 'heading', props: { level: 1 }, content: 'Linked note' },
    { type: 'paragraph', content: [{ type: 'text', text, styles: { bold: true } }] },
    { type: 'bulletListItem', content: 'A list item' },
    { type: 'codeBlock', props: { language: 'typescript' }, content: 'const value = 42;' },
  ]) });

test('Markdown export and import preserve rich writing; paths reject traversal and hidden folders', async () => {
  const markdown = await noteMarkdown(content('Full prose'), '11111111-1111-4111-8111-111111111111');
  assert.match(markdown, /athena_note_id:/);
  assert.match(markdown, /# Linked note/);
  assert.match(markdown, /\*\*Full prose\*\*/);
  assert.match(markdown, /[-*] A list item/);
  assert.match(markdown, /```typescript\nconst value = 42;/);
  assert.ok(JSON.stringify(await githubMarkdownBlocks(markdown)).includes('Full prose'));
  const unsafe = JSON.stringify(await githubMarkdownBlocks('[Unsafe](javascript:alert(1))\n\n<script>alert(1)</script>'));
  assert.ok(!unsafe.includes('"href":"javascript:'), 'GitHub imports use the existing safe Markdown parser');
  assert.ok(unsafe.includes('<script>'), 'Raw HTML stays inert source text');
  assert.equal(validatePublicationPath('docs/Project notes/my-note.md'), 'docs/Project notes/my-note.md');
  assert.equal(validatePublicationPath('README.md'), 'README.md');
  assert.equal(validatePublicationPath('docs/Caf\u00e9 notes/test (v2).md'), 'docs/Caf\u00e9 notes/test (v2).md');
  for (const path of ['../note.md', 'docs/../note.md', '.github/workflows/note.md', '/note.md', 'docs//note.md', 'file.ts', 'a\\b.md', 'file%2f.md']) {
    assert.throws(() => validatePublicationPath(path));
  }
  const exports = await Promise.all(Array.from({ length: 4 }, (_, i) => noteMarkdown(content(`Concurrent ${i}`), String(i))));
  exports.forEach((body, i) => assert.ok(body.includes(`Concurrent ${i}`)));
});

test('real GitHub HTTP contract, note saves, conflicts, revision safety and single indexed identity', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE notes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      tags TEXT[] NOT NULL DEFAULT '{}', linked_items UUID[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active', project_id UUID);
    CREATE TABLE content_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source TEXT, source_id TEXT,
      title TEXT, summary TEXT, body TEXT, published_at TIMESTAMPTZ, indexed_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(), url TEXT, project_context TEXT, metadata JSONB, tags TEXT[], search_vector TSVECTOR,
      UNIQUE(source, source_id));
    CREATE TABLE nodes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ref_id TEXT, ref_type TEXT);
    CREATE TABLE sync_state (source TEXT PRIMARY KEY, last_sync_at TIMESTAMPTZ, item_count INTEGER, last_error TEXT, last_cursor TEXT, updated_at TIMESTAMPTZ DEFAULT now());
  `);
  for (const name of ['060_note_history.sql', '061_note_github_publications.sql']) {
    const sql = await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
  }
  let lockAvailable = true;
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: lockAvailable }], rowCount: 1 };
    if (sql.includes('pg_advisory_unlock')) return { rows: [], rowCount: 1 };
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client } as unknown as Pool;
  const queryMock = mock.method(getDb(), 'query', query);
  const connectMock = mock.method(getDb(), 'connect', async () => client);
  const create = async () => String((await db.query('INSERT INTO notes (content) VALUES ($1) RETURNING id', [content('Original')])).rows[0]!.id);
  const id = await create();
  const other = await create();
  const repo = 'owner/destination';
  const path = 'docs/Project notes/linked.md';
  const key = `${repo}/${path}`;
  const files = new Map<string, { sha: string; content: string }>();
  const sha = (body: string) => createHash('sha1').update(body).digest('hex');
  let puts = 0;
  let failRead = false;
  let failWrite = false;
  let editedDuringWrite = false;
  let failVectorDeletion = false;
  const vectorDeletes: string[] = [];
  const searchEndpoint = env.FOUNDRY_IQ_SEARCH_ENDPOINT;
  const searchKey = env.FOUNDRY_IQ_SEARCH_ADMIN_KEY;
  const originalFetch = globalThis.fetch;
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'search.invalid') {
      if (failVectorDeletion) return new Response('Unavailable', { status: 503 });
      const body = JSON.parse(String(init?.body)) as { value: Array<{ id: string; '@search.action': string }> };
      body.value.forEach(item => { assert.equal(item['@search.action'], 'delete'); vectorDeletes.push(item.id); });
      return new Response(JSON.stringify({ value: body.value.map(item => ({ key: item.id, status: true, statusCode: 200 })) }));
    }
    if (url.hostname !== 'api.github.com') return originalFetch(input, init);
    if (failRead && init?.method !== 'PUT') return new Response('Rate limit', { status: 403 });
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/user/repos') return reply([
      { full_name: repo, default_branch: 'develop', private: true, permissions: { push: true } },
      { full_name: 'owner/read-only', default_branch: 'main', private: false, permissions: { push: false } },
    ]);
    if (url.pathname === `/repos/${repo}` || url.pathname === `/repos/${env.GITHUB_CONTENT_STORE_REPO}`) {
      return reply({ full_name: url.pathname.slice(7), default_branch: 'develop', private: true, permissions: { push: true } });
    }
    if (url.pathname.includes('/git/ref/heads/')) return reply({ object: { sha: 'tree-head' } });
    if (url.pathname.includes('/git/trees/')) return reply({ truncated: false, tree: [{ type: 'blob', path: 'plain.md', sha: 'plain-blob' }] });
    if (url.pathname.includes('/git/blobs/')) return reply({ content: Buffer.from('# Plain document\n\nReadable prose').toString('base64'), encoding: 'base64' });
    if (url.pathname.endsWith('/contents/') && init?.method !== 'PUT') {
      return reply([{ type: 'dir', path: 'docs' }, { type: 'dir', path: '.github' }]);
    }
    const match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
    if (!match) throw new Error(`Unexpected GitHub request: ${url.pathname}`);
    const fileKey = `${match[1]}/${decodeURIComponent(match[2]!)}`;
    if (init?.method === 'PUT') {
      if (failWrite) return reply({ message: 'Permission denied' }, 403);
      const body = JSON.parse(String(init.body));
      assert.equal(body.branch, 'develop');
      const current = files.get(fileKey);
      assert.equal(body.sha ?? null, current?.sha ?? null, 'PUT requires the last read SHA');
      const writing = Buffer.from(body.content, 'base64').toString('utf8');
      const next = { sha: sha(writing), content: writing };
      files.set(fileKey, next);
      puts++;
      if (editedDuringWrite) {
        editedDuringWrite = false;
        const note = (await db.query('SELECT revision FROM notes WHERE id = $1', [id])).rows[0]!;
        await writeNote(pool, id, { content: content('Edited during upload'), expectedRevision: Number(note.revision) });
      }
      return reply({ content: { sha: next.sha }, commit: { html_url: `https://github.com/${repo}/commit/${puts}` } });
    }
    assert.equal(url.searchParams.get('ref'), 'develop', 'Read the selected repository default branch');
    const file = files.get(fileKey);
    return file ? reply({ type: 'file', sha: file.sha, encoding: 'base64', content: Buffer.from(file.content).toString('base64') }) : reply({ message: 'Not Found' }, 404);
  });
  const app = express();
  app.use(express.json());
  app.use('/api/notes', notesRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => { server.once('listening', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/notes`;
  const request = async <T = unknown>(suffix: string, body?: unknown) => {
    const response = await fetch(`${base}${suffix}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { success: boolean; data: T; error?: { message: string } } };
  };
  try {
    const repos = await request<{ items: Array<{ name: string }> }>('/github/repositories');
    assert.equal(repos.status, 200);
    assert.deepEqual(repos.body.data.items.map((row: { name: string }) => row.name), [repo]);
    const folders = await request<{ folders: string[] }>(`/github/folders?repo=${encodeURIComponent(repo)}&folder=`);
    assert.deepEqual(folders.body.data.folders, ['docs']);
    const first = await request<GitHubPublication>(`/${id}/github`, { repo, filePath: path, commitMessage: 'Publish linked note', expectedRevision: 0 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.status, 'synced');
    assert.equal(first.body.data.repo, repo);
    assert.match(files.get(key)!.content, /\*\*Original\*\*/);
    assert.equal((await publicationRow(pool, id))!.synced_revision, 0);
    assert.equal((await request(`/${other}/github`, { repo, filePath: path, commitMessage: 'Collision', expectedRevision: 0 })).status, 409);
    await assert.rejects(startPublication(pool, id, repo, 'other.md', 'Move', 0), /original repository/);
    let saved = await writeNote(pool, id, { content: content('New writing'), expectedRevision: 0 });
    assert.equal((await publicationRow(pool, id))!.status, 'pending');
    await publishNote(pool, id);
    assert.match(files.get(key)!.content, /\*\*New writing\*\*/);
    const beforeNoop = puts;
    await publishNote(pool, id);
    assert.equal(puts, beforeNoop, 'No duplicate commit for identical Markdown');
    files.set(key, { sha: 'external-edit', content: '# GitHub writing\n\n**External rich prose**' });
    assert.equal((await checkPublication(pool, id))!.status, 'conflict');
    saved = await writeNote(pool, id, { content: content('Local conflict draft'), expectedRevision: saved.revision });
    assert.equal((await publicationRow(pool, id))!.status, 'conflict', 'Local saves cannot clear an external conflict');
    await assert.rejects(publishNote(pool, id), /GitHub file changed/);
    assert.equal(puts, beforeNoop);
    const reviewed = await request<{ sha: string }>(`/${id}/github/remote`);
    assert.equal(reviewed.body.data.sha, 'external-edit');
    const adopted = await request<GitHubPublication>(`/${id}/github/resolve`, { choice: 'github', remoteSha: 'external-edit', expectedRevision: saved.revision });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    assert.equal(adopted.body.data.status, 'synced');
    const imported = (await db.query('SELECT content, revision FROM notes WHERE id = $1', [id])).rows[0]!;
    assert.ok(String(imported.content).includes('External rich prose'));
    const checkpoints = await listNoteVersions(pool, id);
    const beforeImport = checkpoints.find(row => row.reason === 'before_github')!;
    assert.ok((await getNoteVersion(pool, id, beforeImport.id)).writing.contentJson.includes('Local conflict draft'));
    const resolveStale = await request(`/${id}/github/resolve`, { choice: 'think', remoteSha: 'external-edit', expectedRevision: 0 });
    assert.equal(resolveStale.status, 409);
    files.delete(key);
    assert.equal((await checkPublication(pool, id))!.status, 'conflict');
    const restoreFile = await request(`/${id}/github/resolve`, { choice: 'think', remoteSha: null, expectedRevision: imported.revision });
    assert.equal(restoreFile.status, 200);
    failWrite = true;
    saved = await writeNote(pool, id, { content: content('Retry writing'), expectedRevision: Number(imported.revision) });
    await assert.rejects(publishNote(pool, id), /403/);
    assert.equal((await publicationRow(pool, id))!.status, 'error');
    assert.ok((await db.query('SELECT content FROM notes WHERE id = $1', [id])).rows[0]!.content.includes('Retry writing'));
    failWrite = false;
    await syncNotePublications(pool);
    assert.equal((await publicationRow(pool, id))!.status, 'synced', 'Durable retry publishes saved writing');
    editedDuringWrite = true;
    saved = await writeNote(pool, id, { content: content('Concurrent upload'), expectedRevision: saved.revision });
    await publishNote(pool, id);
    assert.equal((await publicationRow(pool, id))!.status, 'pending', 'A later edit cannot be marked published by an older upload');
    await publishNote(pool, id);
    assert.match(files.get(key)!.content, /Edited during upload/);
    lockAvailable = false;
    await assert.rejects(publishNote(pool, id), /already publishing/);
    assert.equal((await publicationRow(pool, id))!.status, 'synced');
    lockAvailable = true;
    failRead = true;
    await assert.rejects(new GitHubClient().getOptional(`/repos/${repo}/contents/${path}`), /403/);
    failRead = false;

    // Imported document copies and old hash-keyed versions disappear everywhere.
    const insert = async (source: string, sourceId: string, itemPath: string) => String((await db.query(
      `INSERT INTO content_items (source, source_id, metadata, title, body, published_at, tags)
       VALUES ($1, $2, $3, 'Document', 'Readable prose', NOW(), '{}') RETURNING id`,
      [source, sourceId, JSON.stringify({ repo, path: itemPath })])).rows[0]!.id);
    const shadow = await insert('github-doc', 'shadow', path);
    const oldest = await insert('github-content-store', 'old-hash', 'plain.md');
    const duplicate = await insert('github-content-store', 'new-hash', 'plain.md');
    const deleted = await insert('github-content-store', 'deleted-hash', 'deleted.md');
    await db.query("UPDATE content_items SET search_vector = to_tsvector('english', 'DuplicateSentinel') WHERE id = $1", [shadow]);
    assert.deepEqual(await getContentItemsByIds(pool, [shadow]), [], 'A stale vector result cannot reintroduce a published copy');
    assert.deepEqual(await getRagItems(pool, 'DuplicateSentinel', 5), [], 'FTS cannot duplicate a linked note even before cleanup');
    await db.query("INSERT INTO nodes (ref_id, ref_type) VALUES ($1, 'document')", [shadow]);
    env.FOUNDRY_IQ_SEARCH_ENDPOINT = 'https://search.invalid';
    env.FOUNDRY_IQ_SEARCH_ADMIN_KEY = 'test-only';
    failVectorDeletion = true;
    await assert.rejects(reconcileContentStore(pool, repo, new Set([path, 'plain.md']), new Set([path])), /503/);
    assert.equal((await db.query('SELECT id FROM content_items')).rows.length, 4, 'Keep IDs until vector deletion succeeds, so cleanup can retry');
    failVectorDeletion = false;
    await reconcileContentStore(pool, repo, new Set([path, 'plain.md']), new Set([path]));
    assert.ok([shadow, duplicate, deleted].every(id => vectorDeletes.includes(id)), 'Remove stale copies from vector search too');
    env.FOUNDRY_IQ_SEARCH_ENDPOINT = searchEndpoint;
    env.FOUNDRY_IQ_SEARCH_ADMIN_KEY = searchKey;
    const remaining = await db.query<{ id: string; source_id: string }>('SELECT id, source_id FROM content_items');
    assert.deepEqual(remaining.rows, [{ id: oldest, source_id: `${repo}::plain.md` }]);
    assert.equal((await db.query('SELECT * FROM nodes')).rows.length, 0);
    for (const removed of [shadow, duplicate, deleted]) assert.ok(!remaining.rows.some(row => row.id === removed));
    const suppressed = await upsertContentItem(pool, {
      source: 'github-doc', sourceId: `${repo}::${path}`, title: 'Must not duplicate', body: 'same writing', summary: '',
      publishedAt: new Date().toISOString(), projectContext: 'personal', metadata: { repo, path }, tags: [],
    });
    assert.equal(suppressed.id, '', 'Even a direct document upsert skips a linked note');
    const sync = await syncContentStore(pool);
    assert.equal(sync.errors, 0);
    const firstIds = (await db.query("SELECT id FROM content_items WHERE metadata->>'repo' = $1", [env.GITHUB_CONTENT_STORE_REPO])).rows;
    await db.query("UPDATE sync_state SET last_cursor = 'previous' WHERE source = 'github-content-store'");
    await syncContentStore(pool);
    const secondIds = (await db.query("SELECT id FROM content_items WHERE metadata->>'repo' = $1", [env.GITHUB_CONTENT_STORE_REPO])).rows;
    assert.deepEqual(secondIds, firstIds, 'Content-store updates preserve one stable ID');
  } finally {
    env.FOUNDRY_IQ_SEARCH_ENDPOINT = searchEndpoint;
    env.FOUNDRY_IQ_SEARCH_ADMIN_KEY = searchKey;
    await new Promise<void>((resolve, reject) => { server.close(err => { if (err) reject(err); else resolve(); }); });
    queryMock.mock.restore();
    connectMock.mock.restore();
    fetchMock.mock.restore();
    await db.close();
  }
});
