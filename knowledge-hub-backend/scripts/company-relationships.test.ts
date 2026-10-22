import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { validateCompany, validatePersonRelationships, savePersonRelationships, saveCompany } from '../src/services/companies.js';
import { validateDiagramDocument } from '../src/services/diagramValidation.js';
import { emptyDiagram } from '../src/types/diagram.js';
import { linkHref } from '../src/services/noteLinks.js';

const companyId = '00000000-0000-4000-8000-000000000001';
const personId = '00000000-0000-4000-8000-000000000002';

test('company validation rejects unsafe websites, empty names and invalid project links', () => {
  assert.deepEqual(validateCompany({ name: ' BCG ', projectIds: ['reckitt', 'reckitt'] }),
    { name: 'BCG', description: '', website: '', projectIds: ['reckitt'] });
  for (const input of [null, [], { name: '' }, { name: 'BCG', website: 'javascript:alert(1)' },
    { name: 'BCG', website: 'not a URL' }, { name: 'BCG', projectIds: [42] }]) assert.throws(() => validateCompany(input));
  assert.equal(linkHref('company', companyId), `/companies?companyId=${companyId}`);
});

test('programme representation is explicit and separate from employer and general role', () => {
  const input = { companyId, assignments: [{ projectId: 'reckitt', companyId, role: 'BCG representative' }] };
  assert.deepEqual(validatePersonRelationships(input), input);
  assert.deepEqual(validatePersonRelationships({ companyId: null, assignments: [] }), { companyId: null, assignments: [] });
  for (const input of [{ companyId: 'invalid', assignments: [] }, { companyId, assignments: [{}] },
    { companyId, assignments: [{ projectId: 'reckitt' }, { projectId: 'reckitt' }] }]) assert.throws(() => validatePersonRelationships(input));
});

test('relationship updates validate references, commit atomically and roll back on failure without a database', async () => {
  const db = new Pool();
  const queries: string[] = [];
  let companyExists = true;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: sql.startsWith('SELECT id FROM people') ? [{ id: personId }]
        : sql.startsWith('SELECT id FROM companies') ? companyExists ? [{ id: companyId }] : []
          : sql.startsWith('SELECT id FROM projects') ? [{ id: 'reckitt' }] : [] };
    }, release: () => {},
  };
  const connect = mock.method(db, 'connect', async () => client);
  try {
    const input = { companyId, assignments: [{ projectId: 'reckitt', companyId, role: 'Representative' }] };
    assert.deepEqual(await savePersonRelationships(db, personId, input), input);
    assert.ok(queries.some(sql => sql.startsWith('UPDATE people')));
    assert.ok(queries.some(sql => sql.startsWith('INSERT INTO person_project_roles')));
    assert.equal(queries.at(-1), 'COMMIT');
    queries.length = 0; companyExists = false;
    await assert.rejects(savePersonRelationships(db, personId, input), /companies no longer exist/);
    assert.equal(queries.at(-1), 'ROLLBACK');
    assert.ok(!queries.some(sql => sql.startsWith('UPDATE people')));
  } finally { connect.mock.restore(); await db.end(); }
});

test('duplicate company creation fails explicitly rather than returning a success-shaped duplicate', async () => {
  const db = new Pool();
  const queries: string[] = [];
  const connect = mock.method(db, 'connect', async () => ({
    query: async (sql: string) => { queries.push(sql); return { rows: sql.startsWith('SELECT id FROM companies') ? [{ id: companyId }] : [] }; },
    release: () => {},
  }));
  try {
    await assert.rejects(saveCompany(db, { name: 'BCG' }), /already exists/);
    assert.equal(queries.at(-1), 'ROLLBACK');
    assert.ok(!queries.some(sql => sql.startsWith('INSERT INTO companies')));
  } finally { connect.mock.restore(); await db.end(); }
});

test('grid spacing is validated and survives backend document round trips', () => {
  for (const gridSize of [5, 10, 20, 40]) {
    const document = { ...emptyDiagram(), gridSize };
    assert.deepEqual(validateDiagramDocument(document, new Set()), document);
  }
  for (const gridSize of [0, 13, 80, '10', null]) {
    assert.throws(() => validateDiagramDocument({ ...emptyDiagram(), gridSize }, new Set()));
  }
});

test('migration retains people data and indexes company mentions with the existing note-link trigger', async () => {
  const sql = await readFile(new URL('../src/db/migrations/093_company_people_relationships.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS company_id/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS person_project_roles/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION rebuild_note_links/);
  assert.match(sql, /'person', 'company'/);
  assert.doesNotMatch(sql, /UPDATE people|DELETE FROM people|INSERT INTO people|UPDATE notes/);
});
