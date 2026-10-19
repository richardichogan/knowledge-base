import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { NotFoundError, ValidationError } from '../types/errors.js';

export interface PersonInput {
  name: string; emails: string[]; organisation: string; role: string; notes: string; threads: string;
  source: string; sourcePeriod: string; contactGroup: string; emailCount: number | null;
}
export interface Person extends PersonInput { id: string; createdAt: string; updatedAt: string }
const FIELDS = ['name', 'organisation', 'role', 'notes', 'threads', 'source', 'sourcePeriod', 'contactGroup'] as const;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const LIMITS = { name: 200, shortText: 1000, longText: 10000, emails: 20, emailLength: 254, import: 500 };

export function validatePerson(value: unknown): PersonInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('A person record is required');
  const input = value as Record<string, unknown>;
  const text = Object.fromEntries(FIELDS.map(field => {
    const raw = input[field] ?? '';
    const max = ['notes', 'threads'].includes(field) ? LIMITS.longText : field === 'name' ? LIMITS.name : LIMITS.shortText;
    if (typeof raw !== 'string' || raw.length > max) throw new ValidationError(`${field} must be text of at most ${max} characters`);
    return [field, raw.trim()];
  })) as Pick<PersonInput, typeof FIELDS[number]>;
  if (!text.name) throw new ValidationError('Name is required');
  const emails = input['emails'] ?? [];
  if (!Array.isArray(emails) || emails.length > LIMITS.emails ||
    emails.some(email => typeof email !== 'string' || email.length > LIMITS.emailLength || !EMAIL.test(email.trim()))) {
    throw new ValidationError('Provide up to 20 valid email addresses');
  }
  const count = input['emailCount'] ?? null;
  if (count !== null && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) {
    throw new ValidationError('Email count must be a non-negative whole number or empty');
  }
  return { ...text, emails: [...new Set((emails as string[]).map(email => email.trim().toLowerCase()))], emailCount: count };
}

export function personFromRow(row: Record<string, unknown>): Person {
  return {
    id: String(row['id']), name: String(row['name']), emails: row['emails'] as string[],
    organisation: String(row['organisation']), role: String(row['role']), notes: String(row['notes']),
    threads: String(row['threads']), source: String(row['source']), sourcePeriod: String(row['source_period']),
    contactGroup: String(row['contact_group']), emailCount: row['email_count'] as number | null,
    createdAt: new Date(String(row['created_at'])).toISOString(), updatedAt: new Date(String(row['updated_at'])).toISOString(),
  };
}

export async function listPeople(db: Pool, query: string): Promise<Person[]> {
  const literal = query.replace(/[\\%_]/g, '\\$&');
  const { rows } = await db.query(`SELECT * FROM people
    WHERE $1 = '' OR concat_ws(' ',name,organisation,role,array_to_string(emails,' '),threads,notes) ILIKE $2
    ORDER BY lower(name),id`, [query, `%${literal}%`]);
  return rows.map(personFromRow);
}

export async function getPerson(db: Pool, id: string): Promise<Person> {
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM people WHERE id::text=$1', [id]);
  if (!rows[0]) throw new NotFoundError('Person');
  return personFromRow(rows[0]);
}

async function writePerson(client: PoolClient, input: PersonInput, id: string): Promise<Person> {
  const { rows: conflicts } = await client.query('SELECT id FROM people WHERE emails && $1::text[] AND id<>$2', [input.emails, id]);
  if (conflicts.length) throw new ValidationError('An email address already belongs to another person. Edit that contact instead.');
  const { rows } = await client.query<Record<string, unknown>>(`INSERT INTO people
    (id,name,emails,organisation,role,notes,threads,source,source_period,contact_group,email_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,emails=EXCLUDED.emails,organisation=EXCLUDED.organisation,
      role=EXCLUDED.role,notes=EXCLUDED.notes,threads=EXCLUDED.threads,source=EXCLUDED.source,
      source_period=EXCLUDED.source_period,contact_group=EXCLUDED.contact_group,email_count=EXCLUDED.email_count,updated_at=NOW()
    RETURNING *`, [id, input.name, input.emails, input.organisation, input.role, input.notes, input.threads,
    input.source, input.sourcePeriod, input.contactGroup, input.emailCount]);
  return personFromRow(rows[0]!);
}

async function transaction<T>(db: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialise contact writes so concurrent imports cannot claim the same email.
    await client.query('SELECT pg_advisory_xact_lock(741903, 85)');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function savePerson(db: Pool, value: unknown, id?: string): Promise<Person> {
  const input = validatePerson(value);
  return transaction(db, async client => {
    if (id) {
      const { rows } = await client.query('SELECT id FROM people WHERE id::text=$1', [id]);
      if (!rows.length) throw new NotFoundError('Person');
    }
    return writePerson(client, input, id ?? randomUUID());
  });
}

/** Reimporting the same report updates its snapshot, never adds the counts again. */
export async function importPeople(db: Pool, values: unknown): Promise<{ created: number; updated: number }> {
  if (!Array.isArray(values) || !values.length || values.length > LIMITS.import) throw new ValidationError('Import between 1 and 500 people');
  const contacts = values.map(validatePerson);
  return transaction(db, async client => {
    let created = 0;
    let updated = 0;
    for (const contact of contacts) {
      const { rows } = await client.query<Record<string, unknown>>(`SELECT * FROM people
        WHERE emails && $1::text[] OR (lower(name)=lower($2) AND organisation=$3)`, [contact.emails, contact.name, contact.organisation]);
      if (rows.length > 1) throw new ValidationError(`Multiple existing contacts match ${contact.name}; resolve these contacts before importing.`);
      const existing = rows[0] ? personFromRow(rows[0]) : null;
      const input = existing ? {
        ...contact, emails: [...new Set([...existing.emails, ...contact.emails])],
        role: existing.role || contact.role, notes: existing.notes || contact.notes,
      } : contact;
      await writePerson(client, input, existing?.id ?? randomUUID());
      if (existing) updated++; else created++;
    }
    return { created, updated };
  });
}
