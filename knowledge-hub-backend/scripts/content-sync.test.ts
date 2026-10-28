import 'dotenv/config';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Pool } from 'pg';
import { normalizeGitHubRepository, projectGitHubRepositories } from '../src/integrations/github/projectContext.js';
import { decodeProjectDocument, syncProjectDocs } from '../src/integrations/github/projectDocsSync.js';
import { sourceFailure } from '../src/sync/sourceDiagnostics.js';
import { GitHubClient } from '../src/integrations/github/githubClient.js';
import { fetchFromCallingAllPapers } from '../src/services/cfpSyncService.js';

test('project repository mappings accept canonical GitHub URLs without letting URLs enter API paths', () => {
  for (const value of ['owner/repo', 'https://github.com/owner/repo', 'https://github.com/owner/repo.git/']) {
    assert.equal(normalizeGitHubRepository(value), 'owner/repo');
  }
  assert.deepEqual(projectGitHubRepositories(['https://github.com/owner/repo', 'owner/repo', '']), ['owner/repo']);
  for (const value of ['https://example.com/owner/repo', 'https://github.com/owner/repo/tree/main', 'owner/..']) {
    assert.throws(() => normalizeGitHubRepository(value));
  }
  assert.throws(() => projectGitHubRepositories([123]));
});

test('project document sync uses the real default branch and exposes incomplete tree coverage', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async (sql: string) => ({
    rows: sql.includes('SELECT id, name, github_repos')
      ? [{ id: 'project', name: 'Project', github_repos: ['https://github.com/owner/repo'] }] : [],
  }));
  const paths: string[] = [];
  const request = mock.method(GitHubClient.prototype, 'get', async (path: string) => {
    paths.push(path);
    if (path === '/repos/owner/repo') return { default_branch: 'release/current' };
    if (path === '/repos/owner/repo/git/ref/heads/release%2Fcurrent') return { object: { sha: 'head' } };
    if (path === '/repos/owner/repo/git/trees/head') return { tree: [], truncated: true };
    throw new Error(`Unexpected path: ${path}`);
  });
  try {
    const result = await syncProjectDocs(db);
    assert.equal(result.indexed, 0);
    assert.equal(result.errors, 1);
    assert.equal(result.failures[0]?.code, 'incomplete-tree');
    assert.deepEqual(paths, ['/repos/owner/repo', '/repos/owner/repo/git/ref/heads/release%2Fcurrent', '/repos/owner/repo/git/trees/head']);
  } finally {
    request.mock.restore(); query.mock.restore(); await db.end();
  }
});

test('project repository failures remain errors instead of silently trying master', async () => {
  const db = new Pool();
  const query = mock.method(db, 'query', async (sql: string) => ({
    rows: sql.includes('SELECT id, name, github_repos')
      ? [{ id: 'project', name: 'Project', github_repos: ['owner/missing'] }] : [],
  }));
  const request = mock.method(GitHubClient.prototype, 'get', async () => { throw new Error('404 Not Found'); });
  try {
    const result = await syncProjectDocs(db);
    assert.equal(result.indexed, 0);
    assert.equal(result.errors, 1);
    assert.equal(result.failures[0]?.code, 'not-found-or-inaccessible');
    assert.equal(request.mock.callCount(), 1);
  } finally {
    request.mock.restore(); query.mock.restore(); await db.end();
  }
});

test('project documents decode UTF-8 and BOM-tagged UTF-16 without stripping content', () => {
  const text = '# Deployment\nCaf\u00e9 and \u03a9';
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.from(le).swap16();
  for (const bytes of [Buffer.from(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), le, be]) {
    assert.equal(decodeProjectDocument(bytes), text);
  }
  assert.throws(() => decodeProjectDocument(Buffer.from([0xff, 0xfe, 0x41])), /decode/);
  assert.throws(() => decodeProjectDocument(Buffer.from([0xc3, 0x28])), /decode/);
  assert.throws(() => decodeProjectDocument(Buffer.from('a\0b')), /NUL/);
});

test('source diagnostics classify access failures without retaining provider bodies or secrets', () => {
  for (const [message, code] of [
    ['401 Developer API key has expired: SECRET', 'expired-credential'],
    ['403 Forbidden: SECRET', 'access-denied'], ['404 Not Found: SECRET', 'not-found-or-inaccessible'],
  ]) {
    const result = sourceFailure('source', new Error(message));
    assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('CallingAllPapers v1 reads the uri field and rejects an unexpected response shape', async () => {
  const request = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(input, 'https://api.callingallpapers.com/v1/cfp');
    return Response.json({ cfps: [{
      name: 'Cloud conference', uri: 'https://example.com/submit', eventUri: 'https://example.com',
      dateCfpEnd: '2099-12-01T00:00:00Z', location: 'Online', tags: ['Azure'],
    }] });
  });
  try {
    const entries = await fetchFromCallingAllPapers();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.cfpUri, 'https://example.com/submit');
    assert.equal(entries[0]?.isVirtual, true);
    request.mock.mockImplementation(async () => Response.json({ unexpected: [] }));
    await assert.rejects(fetchFromCallingAllPapers(), /invalid CFP list/);
  } finally {
    request.mock.restore();
  }
});
