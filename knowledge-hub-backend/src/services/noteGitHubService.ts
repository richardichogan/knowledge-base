import type { Pool } from 'pg';
import { env } from '../config/env.js';
import { GitHubClient } from '../integrations/github/githubClient.js';
import { ConfigurationError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../types/errors.js';
import { noteMarkdown } from './noteMarkdown.js';
import { parseWriting, writingFingerprint } from './noteVersionService.js';
import { removePublishedNoteCopies } from './githubDocumentIdentity.js';

export interface GitHubPublication {
  noteId: string;
  repo: string;
  branch: string;
  path: string;
  url: string;
  commitUrl: string | null;
  status: 'pending' | 'synced' | 'conflict' | 'error';
  error: string | null;
}
export interface PublicationRow {
  note_id: string; repo: string; branch: string; path: string;
  blob_sha: string | null; commit_url: string | null; synced_fingerprint: string | null;
  synced_revision: number | null; status: GitHubPublication['status']; error: string | null;
}
interface StoredNote { id: string; content: string; revision: number }
export interface RemoteNote { sha: string; content: string; encoding: string; type: string }
interface GitHubWrite { content: { sha: string }; commit: { html_url: string } }
type QueryDb = Pick<Pool, 'query'>;
const MAX_FILE_PATH_LENGTH = 240;
const MAX_COMMIT_MESSAGE_LENGTH = 500;
const REPOSITORY_PAGE_SIZE = 100;
const PUBLISH_SETTLE_MS = 30_000;

export function publicationView(row: PublicationRow): GitHubPublication {
  return {
    noteId: row.note_id, repo: row.repo, branch: row.branch, path: row.path,
    url: `https://github.com/${row.repo}/blob/${encodeURIComponent(row.branch)}/${row.path.split('/').map(encodeURIComponent).join('/')}`,
    commitUrl: row.commit_url, status: row.status, error: row.error,
  };
}
export function validatePublicationPath(path: unknown): string {
  if (typeof path !== 'string' || path.length > MAX_FILE_PATH_LENGTH || !path.endsWith('.md') || !validFolderPath(path)) {
    throw new ValidationError('Choose a relative .md path. Hidden folders, traversal and special characters are not allowed.');
  }
  return path;
}
function validFolderPath(path: string): boolean {
  return path.split('/').every(segment => segment !== '' && !segment.startsWith('.')
    && !/[\\<>:"|?*%\p{Cc}]/u.test(segment) && segment === segment.trim());
}
export interface WritableRepository { name: string; defaultBranch: string; private: boolean }
interface GitHubRepository { full_name: string; default_branch: string; private: boolean; size?: number; permissions?: { push?: boolean } }
function validateRepo(repo: unknown): string {
  if (typeof repo !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    throw new ValidationError('Choose a repository in owner/repository format.');
  }
  return repo;
}
export async function writableRepository(repo: unknown, gh = new GitHubClient()): Promise<GitHubRepository> {
  const name = validateRepo(repo);
  if (!env.GITHUB_ACCESS_TOKEN) throw new ConfigurationError('GITHUB_ACCESS_TOKEN');
  const repository = await gh.getOptional<GitHubRepository>(`/repos/${name}`);
  if (repository === null) throw new ForbiddenError('This repository is unavailable to the configured GitHub account. Choose a writable repository from the list.');
  if (repository.permissions?.push !== true) throw new ForbiddenError('The configured GitHub account cannot write to this repository.');
  return repository;
}
async function projectRepositories(db: QueryDb): Promise<string[]> {
  const { rows } = await db.query<{ repo: string }>(
    `SELECT DISTINCT lower(btrim(repo)) AS repo
     FROM projects CROSS JOIN LATERAL unnest(github_repos) AS repo
     WHERE btrim(repo) ~ '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$'
     ORDER BY repo`);
  return rows.map(row => row.repo);
}
async function requireProjectRepository(db: QueryDb, repo: unknown): Promise<string> {
  const name = validateRepo(repo);
  if (!(await projectRepositories(db)).includes(name.toLowerCase())) {
    throw new ForbiddenError('Choose a GitHub repository configured in Projects.');
  }
  return name;
}
export async function listWritableRepositories(db: QueryDb, page: number, gh = new GitHubClient()): Promise<{ items: WritableRepository[]; hasMore: boolean }> {
  if (!env.GITHUB_ACCESS_TOKEN) throw new ConfigurationError('GITHUB_ACCESS_TOKEN');
  const configured = await projectRepositories(db);
  const start = (page - 1) * REPOSITORY_PAGE_SIZE;
  const rows = await Promise.all(configured.slice(start, start + REPOSITORY_PAGE_SIZE)
    .map(async repo => ({ repo, metadata: await gh.getOptional<GitHubRepository>(`/repos/${repo}`) })));
  return { items: rows.flatMap(({ repo, metadata }) => metadata?.permissions?.push === true ? [{
    name: repo, defaultBranch: metadata.default_branch, private: metadata.private,
  }] : []), hasMore: start + REPOSITORY_PAGE_SIZE < configured.length };
}
export async function listRepositoryFolders(db: QueryDb, repo: unknown, folder: unknown, gh = new GitHubClient()): Promise<{ folders: string[]; branch: string }> {
  if (typeof folder !== 'string' || (folder !== '' && !validFolderPath(folder))) throw new ValidationError('Choose a relative folder path.');
  const repository = await writableRepository(await requireProjectRepository(db, repo), gh);
  const path = folder.split('/').map(encodeURIComponent).join('/');
  const entries = await gh.getOptional<Array<{ type: string; path: string }>>(`/repos/${repository.full_name}/contents/${path}`, { ref: repository.default_branch });
  if (entries === null && folder === '' && repository.size === 0) return { folders: [], branch: repository.default_branch };
  if (!Array.isArray(entries)) throw new ValidationError('This path is not a folder.');
  return { folders: entries.filter(entry => entry.type === 'dir' && validFolderPath(entry.path)).map(entry => entry.path), branch: repository.default_branch };
}
function contentsPath(row: PublicationRow): string {
  return `/repos/${row.repo}/contents/${row.path.split('/').map(encodeURIComponent).join('/')}`;
}
export async function publicationRow(db: QueryDb, id: string): Promise<PublicationRow | null> {
  const result = await db.query<PublicationRow>('SELECT * FROM note_github_publications WHERE note_id = $1', [id]);
  return result.rows[0] ?? null;
}
export async function remoteNote(gh: GitHubClient, row: PublicationRow): Promise<RemoteNote | null> {
  const remote = await gh.getOptional<RemoteNote>(contentsPath(row), { ref: row.branch });
  if (remote !== null && (remote.type !== 'file' || remote.encoding !== 'base64' || typeof remote.content !== 'string')) {
    throw new ValidationError('The GitHub path does not contain a readable Markdown file.');
  }
  return remote;
}
async function activeNote(db: QueryDb, id: string): Promise<StoredNote> {
  const result = await db.query<StoredNote>("SELECT id, content, revision FROM notes WHERE id = $1 AND status = 'active'", [id]);
  if (!result.rows[0]) throw new NotFoundError('Note');
  return result.rows[0];
}

/** SHA comparison, not timestamps: never overwrite a file edited outside Think. */
export function remoteHasChanged(row: PublicationRow, remote: RemoteNote | null): boolean {
  return (remote?.sha ?? null) !== row.blob_sha;
}
export async function checkPublication(db: Pool, id: string, gh = new GitHubClient()): Promise<GitHubPublication | null> {
  await activeNote(db, id);
  const row = await publicationRow(db, id);
  if (!row) return null;
  const remote = await remoteNote(gh, row);
  if (remoteHasChanged(row, remote)) {
    const error = remote === null
      ? 'The published file was deleted on GitHub. Choose which version to keep.'
      : 'This file changed on GitHub. Automatic publishing is paused. Choose which version to keep.';
    await db.query(
      `UPDATE note_github_publications SET status = 'conflict', error = $2, updated_at = NOW()
       WHERE note_id = $1 AND blob_sha IS NOT DISTINCT FROM $3`, [id, error, row.blob_sha]);
  }
  const current = await publicationRow(db, id);
  return current ? publicationView(current) : null;
}

export async function publishNote(
  db: Pool, id: string,
  options: { commitMessage?: string; expectedRemoteSha?: string | null } = {},
  gh = new GitHubClient(),
): Promise<GitHubPublication> {
  const client = await db.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`note-publish:${id}`]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw new ConflictError('This note is already publishing. Try again shortly.', 'GITHUB_PUBLISH_BUSY');
    const row = await publicationRow(client, id);
    if (!row) throw new NotFoundError('GitHub publication');
    const note = await activeNote(client, id);
    const remote = await remoteNote(gh, row);
    const resolving = 'expectedRemoteSha' in options;
    if (resolving ? (remote?.sha ?? null) !== options.expectedRemoteSha : remoteHasChanged(row, remote)) {
      throw new ConflictError(
        'The GitHub file changed. Automatic publishing is paused; review it and choose which version to keep.',
        'GITHUB_NOTE_CONFLICT');
    }
    const fingerprint = writingFingerprint(parseWriting(note.content));
    const markdown = await noteMarkdown(note.content, id);
    const matches = remote !== null && Buffer.from(remote.content.replace(/\s/g, ''), 'base64').toString('utf8') === markdown;
    let sha = remote?.sha ?? null;
    let commitUrl = row.commit_url;
    if (!matches) {
      const result = await gh.put<GitHubWrite>(contentsPath(row), {
        message: options.commitMessage ?? `Update Think note: ${parseWriting(note.content).title}`,
        content: Buffer.from(markdown).toString('base64'), branch: row.branch,
        ...(remote !== null && { sha: remote.sha }),
      });
      sha = result.content.sha;
      commitUrl = result.commit.html_url;
    }
    await client.query(
      `UPDATE note_github_publications SET blob_sha = $2, commit_url = $3,
       synced_fingerprint = $4, synced_revision = $5, error = NULL,
       status = CASE WHEN (SELECT revision FROM notes WHERE id = $1) = $5 THEN 'synced' ELSE 'pending' END,
       updated_at = NOW() WHERE note_id = $1`,
      [id, sha, commitUrl, fingerprint, note.revision]);
    const current = await publicationRow(client, id);
    if (!current) throw new NotFoundError('GitHub publication');
    if (current.status === 'pending') scheduleGitHubPublish(db, id);
    return publicationView(current);
  } catch (err) {
    if (locked) {
      const conflict = err instanceof ConflictError;
      await client.query(
        `UPDATE note_github_publications SET status = $2, error = $3, updated_at = NOW() WHERE note_id = $1`,
        [id, conflict ? 'conflict' : 'error', err instanceof Error ? err.message : String(err)]);
    }
    throw err;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`note-publish:${id}`]);
    } finally { client.release(); }
  }
}

export async function startPublication(
  db: Pool, id: string, repoInput: unknown, path: unknown, message: unknown, expectedRevision: unknown, gh = new GitHubClient(),
): Promise<GitHubPublication> {
  const filePath = validatePublicationPath(path);
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    throw new ValidationError('Commit message must contain 1-500 characters.');
  }
  if (!env.GITHUB_ACCESS_TOKEN) throw new ConfigurationError('GITHUB_ACCESS_TOKEN');
  const repo = validateRepo(repoInput);
  const note = await activeNote(db, id);
  if (!Number.isInteger(expectedRevision) || note.revision !== expectedRevision) {
    throw new ConflictError('Save and reload this note before publishing.', 'NOTE_REVISION_CONFLICT');
  }
  const existing = await publicationRow(db, id);
  if (existing && (existing.path !== filePath || existing.repo.toLowerCase() !== repo.toLowerCase())) {
    throw new ValidationError('A published note keeps its original repository and GitHub path.');
  }
  if (!existing) await requireProjectRepository(db, repo);
  const repository = await writableRepository(repo, gh);
  await db.query(
    `INSERT INTO note_github_publications (note_id, repo, branch, path)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [id, repository.full_name, repository.default_branch, filePath]);
  const reserved = await publicationRow(db, id);
  if (!reserved || reserved.path !== filePath || reserved.repo.toLowerCase() !== repository.full_name.toLowerCase()) {
    throw new ConflictError('Another note is already linked to this GitHub path.', 'GITHUB_PATH_CONFLICT');
  }
  await removePublishedNoteCopies(db, reserved.repo);
  return publishNote(db, id, { commitMessage: message.trim() }, gh);
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleGitHubPublish(db: Pool, id: string): void {
  const timer = pending.get(id);
  if (timer) clearTimeout(timer);
  const next = setTimeout(() => {
    pending.delete(id);
    void publicationRow(db, id).then(row => {
      if (row?.status === 'pending') return publishNote(db, id);
      return undefined;
    }).catch((err: unknown) => { console.error(`[note-github] ${id}:`, err); });
  }, PUBLISH_SETTLE_MS);
  next.unref();
  pending.set(id, next);
}

/** Durable pending rows survive restarts; errors are retried by the normal sync job. */
export async function syncNotePublications(db: Pool): Promise<{ indexed: number; errors: number }> {
  const rows = await db.query<{ note_id: string }>(
    `SELECT p.note_id FROM note_github_publications p JOIN notes n ON n.id = p.note_id
     WHERE n.status = 'active'`);
  let indexed = 0;
  let errors = 0;
  for (const row of rows.rows) {
    try {
      const checked = await checkPublication(db, row.note_id);
      if (checked) await removePublishedNoteCopies(db, checked.repo);
      if (checked?.status === 'pending' || checked?.status === 'error') {
        await publishNote(db, row.note_id);
        indexed++;
      }
    }
    catch (err) { errors++; console.error(`[note-github] ${row.note_id}:`, err); }
  }
  return { indexed, errors };
}
