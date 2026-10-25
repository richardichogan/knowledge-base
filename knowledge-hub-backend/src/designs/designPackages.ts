import { randomUUID, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { GitHubClient } from '../integrations/github/githubClient.js';
import { writableRepository, validatePublicationPath } from '../services/noteGitHubService.js';
import { ConflictError, NotFoundError, ValidationError } from '../types/errors.js';
import { getDesign, requiredText } from './designStore.js';
import { assertCurrent, digest, latestArtifact, lockSources, selectedAssets, sourceSnapshot } from './designArtifacts.js';

export interface PackageManifest {
  id: string; version: 1; designId: string; parentNoteId: string; title: string; createdAt: string;
  ready: boolean; missingInputs: string[]; openDecisions: string[]; pendingFeedback: number;
  sources: Array<{ id: string; revision: number; role: string; path: string }>;
  artifact: { id: string; revision: number; sources: Array<{ id: string; revision: number }> } | null;
  files: Array<{ path: string; role: string; sha256: string }>;
}
export interface DesignPackage { id: string; files: Record<string, string>; manifest: PackageManifest }
const filenames: Record<string, string> = { design: 'design.md', use_case: 'use-case.md', spec: 'specification.md', architecture: 'architecture.md', diagram: 'diagram.json' };
const JSON_INDENT = 2;
const MAX_SVG_LENGTH = 6_000_000;
const ATTRIBUTE_PREFIX_LENGTH = 2;
const MAX_FOLDER_LENGTH = 160;
const pretty = (value: unknown): string => `${JSON.stringify(value, null, JSON_INDENT)}\n`;
const gitBlobSha = (content: string): string => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
function conflict(message: string): never { throw new ConflictError(message, 'DESIGN_PUBLICATION_CONFLICT'); }

export function validateDiagramSvg(svg: unknown): string {
  if (typeof svg !== 'string' || !svg.startsWith('<svg') || svg.length > MAX_SVG_LENGTH || /<!DOCTYPE|<!ENTITY/i.test(svg) || XMLValidator.validate(svg) !== true) throw new ValidationError('The diagram SVG export is invalid or too large.');
  const allowedTags = new Set(['svg', 'g', 'title', 'desc', 'defs', 'rect', 'path', 'line', 'circle', 'ellipse', 'polygon', 'polyline', 'text', 'tspan', 'image', 'marker', 'mask', 'pattern']);
  const allowedAttrs = new Set(['xmlns', 'xmlns:xlink', 'version', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'id', 'd', 'points', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'transform', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'preserveAspectRatio', 'href', 'xlink:href', 'mask', 'maskUnits', 'marker-start', 'marker-end', 'markerWidth', 'markerHeight', 'markerUnits', 'orient', 'refX', 'refY', 'patternUnits']);
  const parsed: unknown = new XMLParser({ ignoreAttributes: false }).parse(svg);
  const check = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(check); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '#text') continue;
      if (key.startsWith('@_')) {
        const attr = key.slice(ATTRIBUTE_PREFIX_LENGTH), text = String(child);
        if (!allowedAttrs.has(attr) && !/^data-[a-z-]+$/.test(attr)) throw new ValidationError(`Unsupported SVG attribute: ${attr}.`);
        if ((attr === 'href' || attr === 'xlink:href') && !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(text)) throw new ValidationError('SVG images must be embedded raster assets, not external URLs.');
        if (/url\s*\(/i.test(text) && !/^url\(#[a-zA-Z0-9_-]+\)$/.test(text)) throw new ValidationError('External SVG resources are not allowed.');
        if (attr === 'xmlns' && text !== 'http://www.w3.org/2000/svg') throw new ValidationError('Invalid SVG namespace.');
      } else {
        if (!allowedTags.has(key)) throw new ValidationError(`Unsupported SVG element: ${key}.`);
        check(child);
      }
    }
  };
  check(parsed);
  return svg;
}

export async function createPackage(db: Pool, id: string, input: Record<string, unknown>): Promise<DesignPackage> {
  const design = await getDesign(db, id);
  selectedAssets(design);
  const sources = await sourceSnapshot(db, design);
  const artifact = await latestArtifact(db, design.id);
  if (artifact) await assertCurrent(db, design, artifact);
  const diagram = sources.find(source => source.role === 'diagram');
  const files: Record<string, string> = {};
  for (const source of sources) files[filenames[source.role]!] = source.role === 'diagram' ? pretty(source.document) : source.markdown;
  if (diagram) {
    if (input['diagramId'] !== diagram.id || input['diagramRevision'] !== diagram.revision) conflict('The diagram changed before export. Export its current revision.');
    files['diagram.svg'] = validateDiagramSvg(input['diagramSvg']);
  }
  if (artifact) files['visual-design.html'] = artifact.html;
  const pendingFeedback = Number((await db.query<{ count: string }>("SELECT count(*) FROM design_feedback WHERE design_id=$1 AND status IN ('queued','proposed')", [design.id])).rows[0]!.count);
  const missingInputs = ['use_case', 'spec', 'architecture', 'diagram'].filter(role => !sources.some(source => source.role === role));
  if (!artifact) missingInputs.push('visual-design');
  const manifest: PackageManifest = {
    id: randomUUID(), version: 1, designId: design.id, parentNoteId: design.parentNoteId, title: design.title, createdAt: new Date().toISOString(),
    ready: !missingInputs.length && !pendingFeedback && !artifact?.blueprint.openDecisions.length,
    missingInputs, openDecisions: artifact?.blueprint.openDecisions ?? [], pendingFeedback,
    sources: sources.map(source => ({ id: source.id, role: source.role, revision: source.revision, path: filenames[source.role]! })),
    artifact: artifact ? { id: artifact.id, revision: artifact.revision, sources: artifact.sources.map(source => ({ id: source.id, revision: source.revision })) } : null,
    files: [],
  };
  files['README.md'] = `# Design package: ${design.title.replace(/[\r\n]/g, ' ')}

Package ${manifest.id}. ${manifest.ready ? 'All supplied inputs are current.' : 'INCOMPLETE / DECISIONS OPEN — clarify before implementation.'}

## Copilot reading order and authority

1. Read manifest.json for exact original IDs, selected revisions, hashes, missing inputs and open decisions.
2. Read design.md and the supplied use-case.md, specification.md and architecture.md. These Markdown files are the authoritative agreed requirements.
3. Explore visual-design.html locally for visual and interaction intent. It is a sandboxed review artifact, NOT production code and NOT a competing requirements source.
4. Read diagram.json and diagram.svg for architecture and flow context.

If requirements, visual intent or diagrams conflict, flag the conflict and ask before deciding. Do not implement missing inputs or resolve open decisions by guessing.
Pending or discarded feedback is NOT an accepted requirement. Only accepted Markdown changes belong in the authoritative files.

## Missing inputs

${missingInputs.length ? missingInputs.map(role => `- ${role}`).join('\n') : 'None.'}

## Open decisions

${manifest.openDecisions.length ? manifest.openDecisions.map(item => `- ${item}`).join('\n') : 'None recorded.'}

${pendingFeedback} feedback item(s) remain unaccepted. Their text is intentionally excluded from requirements.
`;
  manifest.files = Object.entries(files).map(([path, content]) => ({ path, role: path === 'visual-design.html' ? 'visual-intent' : path.startsWith('diagram.') ? 'diagram-context' : path === 'README.md' ? 'copilot-instructions' : 'authoritative-markdown', sha256: digest(content) }));
  files['manifest.json'] = pretty(manifest);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = (await client.query<{ revision: number }>('SELECT revision FROM designs WHERE id=$1 FOR UPDATE', [design.id])).rows[0];
    if (locked?.revision !== design.revision) conflict('Design version selection changed before packaging.');
    await lockSources(client, sources);
    const latest = (await client.query<{ id: string }>('SELECT id FROM design_artifacts WHERE design_id=$1 ORDER BY revision DESC LIMIT 1', [design.id])).rows[0];
    if ((latest?.id ?? null) !== (artifact?.id ?? null)) conflict('The visual artifact changed before packaging.');
    await client.query('INSERT INTO design_packages(id,design_id,files,manifest) VALUES($1,$2,$3,$4)', [manifest.id, design.id, JSON.stringify(files), JSON.stringify(manifest)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return { id: manifest.id, files, manifest };
}

export async function getPackage(db: Pool, id: string, packageId: string): Promise<DesignPackage> {
  const design = await getDesign(db, id);
  const result = await db.query<DesignPackage>('SELECT id,files,manifest FROM design_packages WHERE id::text=$1 AND design_id=$2', [packageId, design.id]);
  if (!result.rows[0]) throw new NotFoundError('Design package');
  return result.rows[0];
}
export async function packageArchive(snapshot: DesignPackage): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(snapshot.files)) zip.file(`design/${path}`, content, { date: new Date(snapshot.manifest.createdAt) });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
interface Publication { id: string; package_id: string; repo: string; branch: string; folder: string; base_sha: string; status: string; commit_sha: string | null }
interface Commit { sha: string; tree: { sha: string } }
interface Tree { sha: string; truncated: boolean; tree: Array<{ path: string; sha: string; type: string; mode: string }> }
const packagePaths = new Set([...Object.values(filenames), 'README.md', 'manifest.json', 'visual-design.html', 'diagram.svg']);
async function ownedDestination(gh: GitHubClient, repo: string, folder: string, baseSha: string, snapshot: DesignPackage): Promise<string[]> {
  const tree = await gh.get<Tree>(`/repos/${repo}/git/trees/${baseSha}`, { recursive: '1' });
  if (tree.truncated) throw new ValidationError('Repository tree is too large to safely check the package destination.');
  const destination = tree.tree.filter(entry => entry.path === folder || entry.path.startsWith(`${folder}/`));
  if (!destination.some(entry => entry.type !== 'tree')) return [];
  const remote = await gh.getOptional<{ content: string; encoding: string }>(`/repos/${repo}/contents/${folder.split('/').map(encodeURIComponent).join('/')}/manifest.json`, { ref: baseSha });
  if (!remote || remote.encoding !== 'base64') conflict('The destination contains files not owned by this Design package. Choose an empty folder.');
  let previous: unknown;
  try { previous = JSON.parse(Buffer.from(remote.content, 'base64').toString('utf8')); } catch { conflict('Destination manifest is invalid. Choose a different folder.'); }
  if (!previous || typeof previous !== 'object' || !('designId' in previous) || previous.designId !== snapshot.manifest.designId
    || !('files' in previous) || !Array.isArray(previous.files)) conflict('This folder is not owned by this Design.');
  const paths = ['manifest.json'];
  for (const file of previous.files as unknown[]) {
    if (!file || typeof file !== 'object' || !('path' in file) || typeof file.path !== 'string' || !packagePaths.has(file.path)
      || !('sha256' in file) || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) conflict('Destination manifest contains unsupported paths or hashes.');
    const content = await gh.getOptional<{ content: string; encoding: string }>(`/repos/${repo}/contents/${folder.split('/').map(encodeURIComponent).join('/')}/${file.path}`, { ref: baseSha });
    if (!content || content.encoding !== 'base64' || digest(Buffer.from(content.content, 'base64').toString('utf8')) !== file.sha256) conflict(`The destination file ${file.path} was modified outside Athena. Nothing was overwritten.`);
    paths.push(file.path);
  }
  for (const path of Object.keys(snapshot.files)) {
    if (!paths.includes(path) && destination.some(entry => entry.path === `${folder}/${path}`)) conflict(`Unrelated destination file ${path} would be overwritten. Choose another folder.`);
  }
  return [...new Set(paths)];
}
function folderPath(value: unknown): string {
  const folder = requiredText(value, 'Package folder', MAX_FOLDER_LENGTH);
  validatePublicationPath(`${folder}/README.md`);
  return folder;
}
export async function preparePublication(db: Pool, id: string, packageId: string, input: Record<string, unknown>, gh = new GitHubClient()): Promise<Publication> {
  const snapshot = await getPackage(db, id, packageId);
  const repo = await writableRepository(input['repo'], gh);
  const folder = folderPath(input['folder']);
  const ref = await gh.get<{ object: { sha: string } }>(`/repos/${repo.full_name}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  await ownedDestination(gh, repo.full_name, folder, ref.object.sha, snapshot);
  return (await db.query<Publication>(`INSERT INTO design_publications(package_id,repo,branch,folder,base_sha) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [packageId, repo.full_name, repo.default_branch, folder, ref.object.sha])).rows[0]!;
}
async function verifyFiles(gh: GitHubClient, publication: Publication, snapshot: DesignPackage, commitSha: string): Promise<void> {
  const tree = await gh.get<Tree>(`/repos/${publication.repo}/git/trees/${commitSha}`, { recursive: '1' });
  if (tree.truncated) throw new ValidationError('Published tree could not be fully verified.');
  for (const [path, content] of Object.entries(snapshot.files)) {
    const entry = tree.tree.find(item => item.path === `${publication.folder}/${path}`);
    if (!entry || entry.type !== 'blob' || entry.sha !== gitBlobSha(content)) throw new ValidationError(`Published package verification failed for ${path}. Publication is not confirmed.`);
  }
}
export async function publishPackage(db: Pool, id: string, packageId: string, publicationId: string, confirmed: unknown, gh = new GitHubClient()): Promise<{ commitUrl: string }> {
  if (confirmed !== true) throw new ValidationError('Confirm the exact repository, folder and package before publishing.');
  const snapshot = await getPackage(db, id, packageId);
  const row = (await db.query<Publication>('SELECT * FROM design_publications WHERE id::text=$1 AND package_id=$2', [publicationId, packageId])).rows[0];
  if (!row) throw new NotFoundError('Publication confirmation');
  await writableRepository(row.repo, gh);
  const refPath = `/repos/${row.repo}/git/ref/heads/${encodeURIComponent(row.branch)}`;
  const ref = await gh.get<{ object: { sha: string } }>(refPath);
  if (row.commit_sha && (row.status === 'published' || ref.object.sha === row.commit_sha)) {
    await verifyFiles(gh, row, snapshot, row.commit_sha);
    await db.query("UPDATE design_publications SET status='published' WHERE id=$1", [row.id]);
    return { commitUrl: `https://github.com/${row.repo}/commit/${row.commit_sha}` };
  }
  if (ref.object.sha !== row.base_sha) conflict('The repository changed after confirmation. Prepare publication again against the current destination.');
  const claimed = await db.query("UPDATE design_publications SET status='publishing' WHERE id=$1 AND status IN ('prepared','failed') RETURNING id", [row.id]);
  if (!claimed.rows.length) conflict('Publication is already in progress. Refresh its status before retrying.');
  try {
    const previousFiles = await ownedDestination(gh, row.repo, row.folder, row.base_sha, snapshot);
    const base = await gh.get<Commit>(`/repos/${row.repo}/git/commits/${row.base_sha}`);
    const tree = await gh.post<{ sha: string }>(`/repos/${row.repo}/git/trees`, {
      base_tree: base.tree.sha,
      tree: [...Object.entries(snapshot.files).map(([path, content]) => ({ path: `${row.folder}/${path}`, mode: '100644', type: 'blob', content })),
        ...previousFiles.filter(path => !(path in snapshot.files)).map(path => ({ path: `${row.folder}/${path}`, mode: '100644', type: 'blob', sha: null }))],
    });
    const commit = await gh.post<{ sha: string }>(`/repos/${row.repo}/git/commits`, {
      message: `Publish Design package ${snapshot.id}`, tree: tree.sha, parents: [row.base_sha],
    });
    await verifyFiles(gh, row, snapshot, commit.sha);
    await db.query('UPDATE design_publications SET commit_sha=$2 WHERE id=$1', [row.id, commit.sha]);
    await gh.patch(`/repos/${row.repo}/git/refs/heads/${encodeURIComponent(row.branch)}`, { sha: commit.sha, force: false });
    const updated = await gh.get<{ object: { sha: string } }>(refPath);
    if (updated.object.sha !== commit.sha) conflict('The branch moved before publication could be confirmed. Inspect the returned commit before retrying.');
    await verifyFiles(gh, row, snapshot, commit.sha);
    await db.query("UPDATE design_publications SET status='published' WHERE id=$1", [row.id]);
    return { commitUrl: `https://github.com/${row.repo}/commit/${commit.sha}` };
  } catch (error) {
    await db.query("UPDATE design_publications SET status='failed' WHERE id=$1", [row.id]);
    throw error;
  }
}
