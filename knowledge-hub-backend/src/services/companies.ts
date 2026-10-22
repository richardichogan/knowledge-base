import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { NotFoundError, ValidationError } from '../types/errors.js';

export interface CompanyInput { name: string; description: string; website: string; projectIds: string[] }
export interface Company extends CompanyInput { id: string }
export interface ProjectRole { projectId: string; role: string; companyId: string | null }
export interface PersonRelationships { companyId: string | null; assignments: ProjectRole[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROJECTS = 100;
const NAME_LIMIT = 200;
const DESCRIPTION_LIMIT = 10000;
const WEBSITE_LIMIT = 2000;
const ROLE_LIMIT = 1000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('A record is required');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max) throw new ValidationError(`${label} must be text of at most ${max} characters`);
  return value.trim();
}
function companyId(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError('Choose a valid company');
  return value.toLowerCase();
}
export function validateCompany(value: unknown): CompanyInput {
  const input = object(value);
  const name = text(input['name'], NAME_LIMIT, 'Company name');
  if (!name) throw new ValidationError('Company name is required');
  const description = text(input['description'] ?? '', DESCRIPTION_LIMIT, 'Description');
  const website = text(input['website'] ?? '', WEBSITE_LIMIT, 'Website');
  if (website) {
    let url: URL;
    try { url = new URL(website); } catch { throw new ValidationError('Website must be an http or https URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new ValidationError('Website must be an http or https URL');
  }
  const projects = input['projectIds'] ?? [];
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS) throw new ValidationError('Choose up to 100 projects');
  const projectIds = [...new Set(projects.map(id => text(id, NAME_LIMIT, 'Project ID')))];
  if (projectIds.some(id => !id)) throw new ValidationError('Project IDs cannot be empty');
  return { name, description, website, projectIds };
}
export function validatePersonRelationships(value: unknown): PersonRelationships {
  const input = object(value);
  const company = companyId(input['companyId']);
  const assignments = input['assignments'];
  if (!Array.isArray(assignments) || assignments.length > MAX_PROJECTS) throw new ValidationError('Choose up to 100 project roles');
  const roles = assignments.map(value => {
    const row = object(value);
    const projectId = text(row['projectId'], NAME_LIMIT, 'Project ID');
    if (!projectId) throw new ValidationError('Choose a project for each role');
    return { projectId, role: text(row['role'] ?? '', ROLE_LIMIT, 'Project role'), companyId: companyId(row['companyId'] ?? null) };
  });
  if (new Set(roles.map(role => role.projectId)).size !== roles.length) throw new ValidationError('Each project can have only one role per person');
  return { companyId: company, assignments: roles };
}

const COMPANY_SELECT = `SELECT c.id::text,c.name,c.description,c.website,
  COALESCE((SELECT json_agg(link.project_id ORDER BY link.project_id) FROM (
    SELECT cp.project_id FROM company_projects cp WHERE cp.company_id=c.id
    UNION SELECT r.project_id FROM person_project_roles r WHERE r.company_id=c.id
  ) link),'[]'::json) AS "projectIds"
  FROM companies c`;

export async function listCompanies(db: Pool, query = ''): Promise<Company[]> {
  const escaped = query.replace(/[\\%_]/g, '\\$&');
  return (await db.query<Company>(`${COMPANY_SELECT} WHERE $1='' OR c.name ILIKE $2 ORDER BY lower(c.name),c.id`, [query, `%${escaped}%`])).rows;
}
export async function getCompany(db: Pool, id: string): Promise<Company> {
  const row = (await db.query<Company>(`${COMPANY_SELECT} WHERE c.id::text=$1`, [id])).rows[0];
  if (!row) throw new NotFoundError('Company');
  return row;
}
export async function saveCompany(db: Pool, value: unknown, id?: string): Promise<Company> {
  const input = validateCompany(value);
  const key = id ?? randomUUID();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Match the people import lock to keep identity creation and contact import consistent.
    await client.query('SELECT pg_advisory_xact_lock(741903, 85)');
    const duplicate = await client.query('SELECT id FROM companies WHERE lower(trim(name))=lower($1) AND id::text<>$2', [input.name, key]);
    if (duplicate.rows.length) throw new ValidationError('A company with this name already exists. Select the existing company.');
    if (id) {
      const updated = await client.query('UPDATE companies SET name=$2,description=$3,website=$4,updated_at=now() WHERE id::text=$1 RETURNING id', [id, input.name, input.description, input.website]);
      if (!updated.rows.length) throw new NotFoundError('Company');
    } else await client.query('INSERT INTO companies(id,name,description,website) VALUES($1,$2,$3,$4)', [key, input.name, input.description, input.website]);
    const projects = await client.query('SELECT id FROM projects WHERE id=ANY($1::text[])', [input.projectIds]);
    if (projects.rows.length !== input.projectIds.length) throw new ValidationError('One or more selected projects no longer exist');
    await client.query('DELETE FROM company_projects WHERE company_id=$1', [key]);
    for (const projectId of input.projectIds) await client.query('INSERT INTO company_projects(company_id,project_id) VALUES($1,$2)', [key, projectId]);
    await client.query('COMMIT');
    return { id: key, ...input };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function getPersonRelationships(db: Pool, id: string): Promise<PersonRelationships> {
  const person = (await db.query<{ companyId: string | null }>('SELECT company_id::text AS "companyId" FROM people WHERE id::text=$1', [id])).rows[0];
  if (!person) throw new NotFoundError('Person');
  const roles = await db.query<ProjectRole>('SELECT project_id AS "projectId",role,company_id::text AS "companyId" FROM person_project_roles WHERE person_id::text=$1 ORDER BY project_id', [id]);
  return { companyId: person.companyId, assignments: roles.rows };
}
export async function savePersonRelationships(db: Pool, id: string, value: unknown): Promise<PersonRelationships> {
  const input = validatePersonRelationships(value);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741903, 85)');
    const person = await client.query('SELECT id FROM people WHERE id::text=$1 FOR UPDATE', [id]);
    if (!person.rows.length) throw new NotFoundError('Person');
    const companyIds = [...new Set([input.companyId, ...input.assignments.map(row => row.companyId)].filter((key): key is string => key !== null))];
    const companies = await client.query('SELECT id FROM companies WHERE id::text=ANY($1::text[])', [companyIds]);
    if (companies.rows.length !== companyIds.length) throw new ValidationError('One or more selected companies no longer exist');
    const projectIds = input.assignments.map(row => row.projectId);
    const projects = await client.query('SELECT id FROM projects WHERE id=ANY($1::text[])', [projectIds]);
    if (projects.rows.length !== projectIds.length) throw new ValidationError('One or more selected projects no longer exist');
    await client.query('UPDATE people SET company_id=$2,updated_at=now() WHERE id::text=$1', [id, input.companyId]);
    await client.query('DELETE FROM person_project_roles WHERE person_id::text=$1', [id]);
    for (const role of input.assignments) {
      await client.query('INSERT INTO person_project_roles(person_id,project_id,company_id,role) VALUES($1,$2,$3,$4)', [id, role.projectId, role.companyId, role.role]);
    }
    await client.query('COMMIT');
    return input;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function companyPeople(db: Pool, id: string): Promise<Array<{ id: string; name: string; projectId: string | null; role: string }>> {
  await getCompany(db, id);
  return (await db.query<{ id: string; name: string; projectId: string | null; role: string }>(`
    SELECT p.id::text,p.name,r.project_id AS "projectId",COALESCE(r.role,p.role) AS role
    FROM people p LEFT JOIN person_project_roles r ON r.person_id=p.id AND r.company_id::text=$1
    WHERE p.company_id::text=$1 OR r.company_id::text=$1 ORDER BY lower(p.name),r.project_id`, [id])).rows;
}
