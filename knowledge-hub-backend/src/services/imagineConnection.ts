import type { Pool } from 'pg';
import { EXTERNAL_FETCH_TIMEOUT_MS } from '../config/constants.js';
import { ForbiddenError, IntegrationError, ValidationError } from '../types/errors.js';
import { decryptConnectionValue, encryptConnectionValue } from './connectionCredentials.js';

const API_ORIGIN = 'https://black-meadow-047776203.7.azurestaticapps.net';
const LOGIN = '/api/v1/auth/login';
const ME = '/api/v1/auth/me';
const OID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const SID = /^participant\.sid=[A-Za-z0-9._%+-]{1,2048}$/;
const roles = ['participant', 'approver', 'demo-admin'] as const;
type Role = typeof roles[number];
export interface ImagineParticipant { userId: string; userName: string; roles: Role[] }
type Method = 'GET' | 'POST' | 'PUT';
export interface ImagineTransport {
  request(method: Method, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

function ownerKey(ownerId: string): string {
  if (typeof ownerId !== 'string' || !OID.test(ownerId)) throw new ForbiddenError('Sign in to Athena with your Microsoft account.');
  return `imagine:participant:${ownerId.toLowerCase()}`;
}

// Forward only the Origin of this browser request, never invent the upstream app's Origin.
// Imagine independently checks its own exact allowlist on every mutation, including login.
function mutationOrigin(origin: string | undefined): string {
  const allowed = (process.env['CORS_ORIGIN'] ?? '').split(',').map(o => o.trim()).filter(Boolean);
  if (origin === undefined || !allowed.includes(origin) ||
      !(origin === 'http://localhost:5173' || /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin)) || origin === API_ORIGIN) {
    throw new ForbiddenError('Use an allowed Athena browser origin to connect to Imagine.');
  }
  return origin;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => new IntegrationError('Imagine', 'The Imagine API did not return a usable response.');

async function send(method: Method, path: string, origin: string | undefined, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['Origin'] = mutationOrigin(origin);
  if (cookie !== undefined) {
    if (!SID.test(cookie)) throw unavailable();
    headers['Cookie'] = cookie;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`${API_ORIGIN}${path}`, { method, headers, redirect: 'error',
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
      ...(body !== undefined && { body: JSON.stringify(body) }) });
  } catch { throw unavailable(); }
}

async function json(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  try { return await response.json(); } catch { throw unavailable(); }
}

async function checkIdentity(response: Response, ownerId: string): Promise<ImagineParticipant> {
  const payload = await json(response);
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload['error']) ? payload['error']['code'] : null;
    if (response.status === 403 && error === 'UNTRUSTED_ORIGIN') {
      throw new ForbiddenError('Imagine does not trust this Athena browser origin. Its exact origin must be allowed by Imagine.');
    }
    if (response.status === 403) throw new ForbiddenError('Imagine denied participant access for this account.');
    if (response.status === 401) throw new ValidationError('Imagine sign-in expired or was rejected. Reconnect to Imagine.');
    throw new IntegrationError('Imagine', `Participant sign-in check failed (HTTP ${response.status}).`);
  }
  const data = isRecord(payload) && payload['success'] === true ? payload['data'] : undefined;
  if (!isRecord(data) || typeof data['userId'] !== 'string' || typeof data['userName'] !== 'string' ||
      !Array.isArray(data['roles']) || !data['roles'].includes('participant') ||
      !data['roles'].every((r: unknown): r is Role => roles.some(known => r === known))) throw unavailable();
  if (data['userId'].toLowerCase() !== ownerId.toLowerCase()) {
    throw new ForbiddenError('The Imagine participant is not the signed-in Athena owner.');
  }
  return { userId: data['userId'], userName: data['userName'], roles: data['roles'] };
}

/** Call only with the authenticated route owner and the real browser Origin, never body-supplied values. */
export async function connectImagine(db: Pool, ownerId: string, idToken: unknown, browserOrigin: string | undefined): Promise<ImagineParticipant> {
  const key = ownerKey(ownerId);
  if (typeof idToken !== 'string' || idToken.length > 32768 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(idToken)) {
    throw new ValidationError('A Microsoft ID token is required.');
  }
  const login = await send('POST', LOGIN, browserOrigin, undefined, { idToken });
  await checkIdentity(login, ownerId);
  // This is the Set-Cookie on our own server-side login response, not a browser cookie.
  const issued = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).filter((v): v is string => !!v && SID.test(v));
  if (issued.length !== 1) throw unavailable();
  const sid = issued[0]!;
  const participant = await checkIdentity(await send('GET', ME, undefined, sid), ownerId);
  const encrypted = encryptConnectionValue(key, sid);
  await db.query(`INSERT INTO sync_state (source, last_cursor, item_count, updated_at) VALUES ($1,$2,0,NOW())
    ON CONFLICT (source) DO UPDATE SET last_cursor=EXCLUDED.last_cursor, updated_at=NOW()`, [key, encrypted]);
  return participant;
}

function allowed(method: Method, path: string): boolean {
  if (typeof path !== 'string' || /[^/A-Za-z0-9_-]/.test(path)) return false;
  switch (method) {
    case 'GET': return /^\/api\/v1\/(?:verticals|workforces(?:\/[A-Za-z0-9_-]{1,128})?|agents(?:\/[A-Za-z0-9_-]{1,128}(?:\/evals(?:\/results)?)?)?)$/.test(path);
    case 'POST': return /^\/api\/v1\/agents(?:\/[A-Za-z0-9_-]{1,128}\/evals)?$/.test(path);
    case 'PUT': return /^\/api\/v1\/workforces\/[A-Za-z0-9_-]{1,128}$/.test(path);
    default: return false;
  }
}

const currentSessionPredicate = `source=$1 AND NULLIF(last_cursor, '') IS NOT NULL AND updated_at > NOW() - INTERVAL '24 hours'`;

/** Local stored-session indicator only: does not contact Imagine or verify current enrollment. */
export async function hasImagineConnection(db: Pool, ownerId: string): Promise<boolean> {
  if (typeof ownerId !== 'string' || !OID.test(ownerId)) return false;
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM sync_state WHERE ${currentSessionPredicate}) AS present`, [ownerKey(ownerId)]);
  return rows[0]?.present === true;
}

/** Reuse for one authenticated turn only. Without that turn's real Origin, only reads are available. */
export async function openImagineConnection(db: Pool, ownerId: string, browserOrigin: string | undefined):
Promise<{ participant: ImagineParticipant; transport: ImagineTransport }> {
  const key = ownerKey(ownerId);
  const { rows } = await db.query<{ last_cursor: string }>(
    `SELECT last_cursor FROM sync_state WHERE ${currentSessionPredicate}`, [key]);
  if (!rows[0]) throw new ValidationError('Connect your Microsoft account to Imagine first.');
  const sid = decryptConnectionValue(key, rows[0].last_cursor);
  const participant = await checkIdentity(await send('GET', ME, undefined, sid), ownerId);
  const transport: ImagineTransport = {
    async request(method, path, body) {
      if (!allowed(method, path) || (method === 'GET' && body !== undefined)) throw new ForbiddenError('Unsupported Imagine operation.');
      if (method !== 'GET' && !participant.roles.includes('demo-admin')) throw new ForbiddenError('Imagine blueprint authoring requires demo-admin access.');
      const response = await send(method, path, browserOrigin, sid, body);
      return { status: response.status, body: await json(response) };
    },
  };
  return { participant, transport };
}
