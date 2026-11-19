import type { Pool } from 'pg';
import { getDesign, type DesignDetail } from './designStore.js';
import { GitHubClient } from '../integrations/github/githubClient.js';
import { ConflictError, ValidationError } from '../types/errors.js';

const PHASE_IDS = ['initiation', 'workforce', 'offline', 'release', 'foundry', 'channels', 'operations', 'acceptance'];
const STATES = ['blocked', 'passed', 'failed', 'stale', 'unknown'] as const;
const MAX_REPORT_BYTES = 1_000_000;
export interface AcceptanceReport {
  version: 1; binding: string | null; scenario: string | null; evidenceBasis: string; canPublish: boolean;
  candidate?: { commit: string; environment: string; configurationFingerprint: string; backendRevision: string;
    frontendArtifact: string; workforceMemberIds: string[]; agents: Array<{ catalogueId: string; deploymentId: string; definitionFingerprint: string }> };
  phases: Array<{ id: string; title: string; state: typeof STATES[number];
    criteria: Array<{ id: string; phase: string; title: string; kinds: string[]; state: typeof STATES[number]; reasons: string[]; sources: string[] }> }>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => { throw new ValidationError('Expected an IMAGINE version-1 PhaseAcceptanceReport, or a BuildStatus export containing acceptance.report. No acceptance was inferred.'); };
const text = (value: unknown): string => typeof value === 'string' && value.trim() && value.length <= 20_000 ? value : invalid();
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text) : invalid();
const state = (value: unknown): typeof STATES[number] => STATES.find(item => item === value) ?? invalid();
const nullable = (value: unknown): string | null => value === null ? null : text(value);

export function parseAcceptanceReport(input: unknown): AcceptanceReport {
  const value = record(input) && record(input['acceptance']) ? input['acceptance']['report'] : input;
  if (!record(value) || value['version'] !== 1 || typeof value['canPublish'] !== 'boolean'
    || !Array.isArray(value['phases']) || value['phases'].length !== PHASE_IDS.length) return invalid();
  const phases = value['phases'].map((phase, index) => {
    if (!record(phase) || phase['id'] !== PHASE_IDS[index] || !Array.isArray(phase['criteria'])) return invalid();
    const phaseId = text(phase['id']);
    const criteria = phase['criteria'].map(criterion => {
      if (!record(criterion) || criterion['phase'] !== phaseId) return invalid();
      return { id: text(criterion['id']), phase: phaseId, title: text(criterion['title']),
        kinds: strings(criterion['kinds']), state: state(criterion['state']), reasons: strings(criterion['reasons']), sources: strings(criterion['sources']) };
    });
    if (new Set(criteria.map(item => item.id)).size !== criteria.length) return invalid();
    return { id: phaseId, title: text(phase['title']), state: state(phase['state']), criteria };
  });
  let candidate: AcceptanceReport['candidate'];
  if (value['candidate'] !== undefined) {
    const item = value['candidate'];
    if (!record(item) || !/^[a-f0-9]{40}$/.test(String(item['commit'])) || !Array.isArray(item['agents'])) return invalid();
    candidate = { commit: text(item['commit']), environment: text(item['environment']),
      configurationFingerprint: text(item['configurationFingerprint']), backendRevision: text(item['backendRevision']),
      frontendArtifact: text(item['frontendArtifact']), workforceMemberIds: strings(item['workforceMemberIds']),
      agents: item['agents'].map(agent => {
        if (!record(agent)) return invalid();
        return { catalogueId: text(agent['catalogueId']), deploymentId: text(agent['deploymentId']), definitionFingerprint: text(agent['definitionFingerprint']) };
      }) };
    if (!candidate.workforceMemberIds.length || !candidate.agents.length) return invalid();
  }
  return { version: 1, binding: nullable(value['binding']), scenario: nullable(value['scenario']),
    evidenceBasis: text(value['evidenceBasis']), canPublish: value['canPublish'], phases, ...(candidate ? { candidate } : {}) };
}

export function acceptanceLocation(value: unknown): { repo: string; ref: string; path: string; url: string } {
  if (typeof value !== 'string' || value.length > 2048) throw new ValidationError('Supply the GitHub JSON report file URL.');
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError('Supply a valid GitHub report file URL.'); }
  const segments = url.pathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { throw new ValidationError('The report URL contains invalid encoding.'); }
  });
  const [owner, name, kind, ref, ...path] = segments;
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
    || !owner || !name || !/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(name)
    || kind !== 'blob' || !ref || !path.length || path.some(part => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))
    || !path.join('/').endsWith('.json')) throw new ValidationError('Use an HTTPS github.com/owner/repo/blob/ref/path.json URL. Encode slashes in a branch name.');
  return { repo: `${owner}/${name}`, ref, path: path.join('/'), url: url.href };
}

async function imagineDesign(db: Pool, id: string): Promise<DesignDetail> {
  const design = await getDesign(db, id);
  if (!design.imagineDemo) throw new ValidationError('This workflow is available for Imagine demo Designs.');
  return design;
}
async function configuredRepository(db: Pool, design: DesignDetail, repo: string): Promise<void> {
  const row = design.projectId ? (await db.query<{ github_repos: string[] }>('SELECT github_repos FROM projects WHERE id=$1', [design.projectId])).rows[0] : undefined;
  if (!row?.github_repos?.some(item => item.toLowerCase() === repo.toLowerCase())) {
    throw new ValidationError('Choose a report in one of this Design workstream’s configured GitHub repositories.');
  }
}
export async function readDesignAcceptance(db: Pool, id: string, gh = new GitHubClient()) {
  const design = await imagineDesign(db, id);
  const source = design.selections.reference;
  if (!source) return { source: null, report: null };
  if (!design.assets.some(asset => asset.sourceType === 'link' && asset.role === 'reference' && asset.sourceId === source)) {
    throw new ValidationError('The saved acceptance report reference is unavailable. Select its current GitHub file.');
  }
  const location = acceptanceLocation(source);
  await configuredRepository(db, design, location.repo);
  const commit = await gh.get<{ sha: string }>(`/repos/${location.repo}/commits/${encodeURIComponent(location.ref)}`);
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new ValidationError('GitHub did not return an immutable report revision.');
  const file = await gh.get<{ type: string; encoding: string; content: string; size: number; sha: string }>(
    `/repos/${location.repo}/contents/${location.path.split('/').map(encodeURIComponent).join('/')}`, { ref: commit.sha });
  if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || !/^[a-f0-9]{40}$/.test(file.sha)
    || file.size > MAX_REPORT_BYTES || file.content.length > MAX_REPORT_BYTES * 2) throw new ValidationError('The report must be a readable JSON file no larger than 1 MB.');
  const decoded = Buffer.from(file.content, 'base64');
  if (decoded.length > MAX_REPORT_BYTES) throw new ValidationError('The report exceeds the 1 MB read limit.');
  let raw: unknown;
  try { raw = JSON.parse(decoded.toString('utf8')); } catch { throw new ValidationError('The saved GitHub report is not valid JSON.'); }
  const report = parseAcceptanceReport(raw);
  return { source: { url: location.url, repo: location.repo, path: location.path, commit: commit.sha, blob: file.sha,
    immutableUrl: `https://github.com/${location.repo}/blob/${commit.sha}/${location.path.split('/').map(encodeURIComponent).join('/')}`,
    readAt: new Date().toISOString() }, report };
}
export async function setDesignAcceptanceSource(db: Pool, id: string, input: Record<string, unknown>): Promise<DesignDetail> {
  const design = await imagineDesign(db, id);
  const location = acceptanceLocation(input['url']);
  await configuredRepository(db, design, location.repo);
  if (input['expectedRevision'] !== design.revision) throw new ConflictError('The Design changed. Reload before saving its report reference.', 'DESIGN_CONFLICT');
  if (design.assets.length >= 200 && !design.assets.some(asset => asset.sourceType === 'link' && asset.sourceId === location.url)) {
    throw new ValidationError('This Design already has 200 linked assets.');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(`UPDATE designs SET selections=jsonb_set(selections,'{reference}',to_jsonb($2::text)),
      revision=revision+1,updated_at=NOW() WHERE id=$1 AND revision=$3 RETURNING id`, [design.id, location.url, design.revision]);
    if (!updated.rows.length) throw new ConflictError('The Design changed. No report reference saved.', 'DESIGN_CONFLICT');
    await client.query(`INSERT INTO design_assets(design_id,source_type,source_id,role,excluded) VALUES($1,'link',$2,'reference',false)
      ON CONFLICT(design_id,source_type,source_id) DO UPDATE SET role='reference',excluded=false`, [design.id, location.url]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return getDesign(db, design.id);
}
export async function listDesignBuilds(db: Pool, id: string) {
  const design = await imagineDesign(db, id);
  const specs = design.assets.filter(asset => asset.role === 'spec' && asset.sourceType === 'note').map(asset => asset.sourceId);
  return (await db.query<{ id: string; title: string; status: string; repo: string; updatedAt: string }>(`
    SELECT id,title,status,repo,updated_at AS "updatedAt" FROM build_specs
    WHERE note_id=ANY($1::uuid[]) ORDER BY updated_at DESC,id DESC LIMIT 20`, [specs])).rows;
}
