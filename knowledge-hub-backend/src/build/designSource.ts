import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { BuildSpec } from './buildStore.js';
import type { DesignPackage } from '../designs/designPackages.js';
import { ValidationError } from '../types/errors.js';

export async function designBuildSource(db: Pool, spec: BuildSpec, access: {
  strictProjectId?: string | null; excludedIds?: ReadonlySet<string>;
} = {}): Promise<string | null> {
  const origin = (await db.query<{ payload: { packageId: string; publicationId: string; commit: string } }>(
    `SELECT payload FROM build_events WHERE spec_id=$1 AND kind='created' AND payload ? 'packageId' ORDER BY id LIMIT 1`, [spec.id])).rows[0];
  if (!origin) return null;
  const source = (await db.query<{ files: DesignPackage['files']; manifest: DesignPackage['manifest']; repo: string; commit_sha: string; status: string }>(
    `SELECT d.files,d.manifest,p.repo,p.commit_sha,p.status FROM design_packages d
     JOIN design_publications p ON p.package_id=d.id WHERE d.id::text=$1 AND p.id::text=$2`,
    [origin.payload.packageId, origin.payload.publicationId])).rows[0];
  if (!source || source.status !== 'published' || source.commit_sha !== origin.payload.commit || source.repo !== spec.repo) {
    throw new ValidationError('The Build’s immutable Design source is unavailable or no longer matches its repository. Restore the original binding or create a new confirmed package handoff.');
  }
  const ids = [...source.manifest.sources.map(item => item.id), source.manifest.parentNoteId];
  if (ids.some(id => access.excludedIds?.has(id))) throw new ValidationError('A published Design source is excluded from this conversation.');
  if (access.strictProjectId) {
    const outside = await db.query(`SELECT id FROM notes WHERE id=ANY($1::uuid[]) AND project_id IS DISTINCT FROM $2
      UNION ALL SELECT id FROM canvases WHERE id=ANY($1::uuid[]) AND project IS DISTINCT FROM $2`, [ids, access.strictProjectId]);
    if (outside.rows.length) throw new ValidationError('A published Design source is outside the enforced workstream scope.');
  }
  for (const file of source.manifest.files) {
    const content = source.files[file.path];
    if (content === undefined || createHash('sha256').update(content).digest('hex') !== file.sha256) {
      throw new ValidationError(`The immutable Design package failed its file hash check: ${file.path}. No source was substituted.`);
    }
  }
  return JSON.stringify({ packageId: origin.payload.packageId, repo: source.repo, commit: source.commit_sha,
    manifest: source.manifest, files: source.files });
}
