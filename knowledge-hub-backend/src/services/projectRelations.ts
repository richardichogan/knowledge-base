import type { Pool, PoolClient } from 'pg';
import { NotFoundError, ValidationError } from '../types/errors.js';

export type OfferingRelation = 'sells' | 'related';
export interface CompanyRef { id: string; name: string }
export interface OfferingLink { offeringId: string; offeringName: string; relation: OfferingRelation }
export interface LinkedProject { id: string; name: string; projectType: string; relation: OfferingRelation }
export interface ProjectRelations {
  client: CompanyRef | null;
  partners: CompanyRef[];
  offeringLink: OfferingLink | null;
  linkedProjects: LinkedProject[];
}
/** `undefined` leaves a relation unchanged; `null`/`[]` clears it. */
export interface ProjectRelationsInput {
  clientCompanyId?: string | null;
  partnerCompanyIds?: string[];
  offeringLink?: { offeringId: string; relation: OfferingRelation } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELATIONS: OfferingRelation[] = ['sells', 'related'];
const MAX_PARTNERS = 50;

/** SQL select columns that add relation data to a `projects` row. */
export const PROJECT_RELATION_COLUMNS = `
  (SELECT json_build_object('id', c.id::text, 'name', c.name) FROM company_projects cp JOIN companies c ON c.id = cp.company_id
    WHERE cp.project_id = projects.id AND cp.role = 'client' LIMIT 1) AS client_company,
  COALESCE((SELECT json_agg(json_build_object('id', c.id::text, 'name', c.name) ORDER BY lower(c.name))
    FROM company_projects cp JOIN companies c ON c.id = cp.company_id
    WHERE cp.project_id = projects.id AND cp.role = 'partner'), '[]'::json) AS partner_companies,
  (SELECT json_build_object('offeringId', o.id, 'offeringName', o.name, 'relation', l.relation)
    FROM project_offering_links l JOIN projects o ON o.id = l.offering_id WHERE l.project_id = projects.id) AS offering_link,
  COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'projectType', p.project_type, 'relation', l.relation) ORDER BY lower(p.name))
    FROM project_offering_links l JOIN projects p ON p.id = l.project_id WHERE l.offering_id = projects.id), '[]'::json) AS linked_projects`;

export function rowToRelations(row: Record<string, unknown>): ProjectRelations {
  return {
    client: (row['client_company'] as CompanyRef | null | undefined) ?? null,
    partners: Array.isArray(row['partner_companies']) ? row['partner_companies'] as CompanyRef[] : [],
    offeringLink: (row['offering_link'] as OfferingLink | null | undefined) ?? null,
    linkedProjects: Array.isArray(row['linked_projects']) ? row['linked_projects'] as LinkedProject[] : [],
  };
}

function companyId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError(`${label} must be a valid company`);
  return value.toLowerCase();
}

/** Validates the relation fields of a project create/update request body. */
export function parseProjectRelations(input: Record<string, unknown>): ProjectRelationsInput {
  const result: ProjectRelationsInput = {};
  if (input['clientCompanyId'] !== undefined) {
    result.clientCompanyId = input['clientCompanyId'] === null || input['clientCompanyId'] === '' ? null : companyId(input['clientCompanyId'], 'Client');
  }
  if (input['partnerCompanyIds'] !== undefined) {
    const raw = input['partnerCompanyIds'];
    if (!Array.isArray(raw) || raw.length > MAX_PARTNERS) throw new ValidationError(`Choose up to ${MAX_PARTNERS} partners`);
    result.partnerCompanyIds = [...new Set(raw.map(id => companyId(id, 'Partner')))];
  }
  if (input['offeringLink'] !== undefined) {
    const raw = input['offeringLink'];
    if (raw === null) result.offeringLink = null;
    else {
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Offering link must include an offering and relation');
      const link = raw as Record<string, unknown>;
      const offeringId = typeof link['offeringId'] === 'string' ? link['offeringId'].trim() : '';
      const relation = link['relation'] as OfferingRelation;
      if (!offeringId) throw new ValidationError('Choose an offering');
      if (!RELATIONS.includes(relation)) throw new ValidationError('Offering relation must be "sells" or "related"');
      result.offeringLink = { offeringId, relation };
    }
  }
  return result;
}

export function hasRelationChanges(input: ProjectRelationsInput): boolean {
  return input.clientCompanyId !== undefined || input.partnerCompanyIds !== undefined || input.offeringLink !== undefined;
}

/** Saves client, partners and offering link atomically, keeping each rule consistent. */
export async function saveProjectRelations(db: Pool, projectId: string, input: ProjectRelationsInput): Promise<void> {
  if (!hasRelationChanges(input)) return;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await applyRelations(client, projectId, input);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function applyRelations(client: PoolClient, projectId: string, input: ProjectRelationsInput): Promise<void> {
  const project = (await client.query<{ project_type: string }>('SELECT project_type FROM projects WHERE id = $1 FOR UPDATE', [projectId])).rows[0];
  if (!project) throw new NotFoundError(`Workstream '${projectId}' not found`);
  const current = (await client.query<{ company_id: string; role: string }>(
    'SELECT company_id::text, role FROM company_projects WHERE project_id = $1', [projectId])).rows;
  const clientId = input.clientCompanyId !== undefined ? input.clientCompanyId : current.find(r => r.role === 'client')?.company_id ?? null;
  const partnerIds = input.partnerCompanyIds ?? current.filter(r => r.role === 'partner').map(r => r.company_id);
  if (clientId !== null && partnerIds.includes(clientId)) throw new ValidationError('The client cannot also be a partner');
  const companyIds = [...new Set([...(clientId ? [clientId] : []), ...partnerIds])];
  const found = await client.query('SELECT id FROM companies WHERE id::text = ANY($1::text[])', [companyIds]);
  if (found.rows.length !== companyIds.length) throw new ValidationError('One or more selected companies no longer exist');

  if (input.clientCompanyId !== undefined || input.partnerCompanyIds !== undefined) {
    await client.query('DELETE FROM company_projects WHERE project_id = $1 AND NOT (company_id::text = ANY($2::text[]))', [projectId, companyIds]);
    await client.query("UPDATE company_projects SET role = 'partner' WHERE project_id = $1 AND role = 'client'", [projectId]);
    for (const id of partnerIds) {
      await client.query(`INSERT INTO company_projects (company_id, project_id, role) VALUES ($1, $2, 'partner')
        ON CONFLICT (company_id, project_id) DO UPDATE SET role = 'partner'`, [id, projectId]);
    }
    if (clientId) {
      await client.query(`INSERT INTO company_projects (company_id, project_id, role) VALUES ($1, $2, 'client')
        ON CONFLICT (company_id, project_id) DO UPDATE SET role = 'client'`, [clientId, projectId]);
    }
  }

  if (input.offeringLink !== undefined) {
    if (input.offeringLink === null) await client.query('DELETE FROM project_offering_links WHERE project_id = $1', [projectId]);
    else {
      if (project.project_type === 'offering') throw new ValidationError('An offering cannot be linked to another offering');
      if (input.offeringLink.offeringId === projectId) throw new ValidationError('A workstream cannot be linked to itself');
      const offering = (await client.query<{ project_type: string }>('SELECT project_type FROM projects WHERE id = $1', [input.offeringLink.offeringId])).rows[0];
      if (!offering) throw new ValidationError('The selected offering no longer exists');
      if (offering.project_type !== 'offering') throw new ValidationError('The selected record is not an offering');
      await client.query(`INSERT INTO project_offering_links (project_id, offering_id, relation) VALUES ($1, $2, $3)
        ON CONFLICT (project_id) DO UPDATE SET offering_id = EXCLUDED.offering_id, relation = EXCLUDED.relation`,
      [projectId, input.offeringLink.offeringId, input.offeringLink.relation]);
    }
  } else if (project.project_type === 'offering') {
    await client.query('DELETE FROM project_offering_links WHERE project_id = $1', [projectId]);
  }
}

/** Removes offering links that a project type change has made invalid. */
export async function reconcileOfferingLinks(db: Pool, projectId: string): Promise<void> {
  await db.query(`DELETE FROM project_offering_links WHERE project_id = $1
    AND EXISTS (SELECT 1 FROM projects WHERE id = $1 AND project_type = 'offering')`, [projectId]);
  await db.query(`DELETE FROM project_offering_links WHERE offering_id = $1
    AND EXISTS (SELECT 1 FROM projects WHERE id = $1 AND project_type <> 'offering')`, [projectId]);
}

/** Resolves company names or IDs (case-insensitive exact name match) for Athena tools. */
export async function resolveCompanyRefs(db: Pool, refs: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const row = (await db.query<{ id: string }>(
      'SELECT id::text FROM companies WHERE id::text = lower($1) OR lower(trim(name)) = lower($1) LIMIT 1', [ref])).rows[0];
    if (!row) throw new ValidationError(`Company "${ref}" was not found. Use an existing company name or create the company first.`);
    ids.push(row.id);
  }
  return ids;
}
