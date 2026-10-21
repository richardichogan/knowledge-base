import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { encryptConnectionValue, decryptConnectionValue } from './connectionCredentials.js';
import { IntegrationError, ValidationError } from '../types/errors.js';

export const MURAL_REDIRECT = 'https://athena.themicrosoftcloudblog.com/integrations/mural/callback';
export const MURAL_CLIENT_ID = 'a10cd14e-6000-4e86-8c23-ce3388057959';
const API = 'https://app.mural.co/api/public/v1';
const CONFIG = 'integration:mural:config';
const AUTH = 'integration:mural:auth';
const PENDING = 'integration:mural:pending:';
const TIMEOUT = 30_000;
const MAX_URL_LENGTH = 2048;
const MAX_SECRET_LENGTH = 8192;
const STATE_BYTES = 32;
const VERIFIER_BYTES = 48;
const MS_PER_SECOND = 1000;
const REFRESH_LEAD_MS = 60_000;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const RATE_LIMITED = 429;
const PNG_HEADER_BYTES = 33;
const MAX_UPLOAD_BYTES = 20_971_520;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_TYPE_START = 12;
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const MAX_PNG_SIDE = 16384;
const MAX_PNG_PIXELS = 64_000_000;
const MAX_TITLE_LENGTH = 300;
const MAX_BOARD_LIST_REQUESTS = 200;
const BAD_REQUEST = 400;
interface Config { clientId: string; secret: string; boardUrl: string }
interface Tokens { accessToken: string; refreshToken: string; expiresAt: number }
interface Pending { userId: string; verifier: string; fingerprint: string }
type Store = Pick<Pool, 'query'>;
export interface MuralStatus { clientId: string; configured: boolean; connected: boolean; boardUrl: string; redirectUrl: string }
export interface MuralBoardOption { id: string; title: string; url: string; workspace: string; archived: boolean }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new IntegrationError('mural', 'Unexpected response format.');
  return value as Record<string, unknown>;
}

export function muralBoard(input: unknown): { id: string; url: string } {
  if (typeof input !== 'string' || input.length > MAX_URL_LENGTH) throw new ValidationError('Enter the URL of an individual Mural board.');
  let url: URL;
  try { url = new URL(input); } catch { throw new ValidationError('Enter a valid Mural board URL.'); }
  const match = /^\/t\/(?<workspace>[a-z0-9_-]+)\/m\/(?<owner>[a-z0-9_-]+)\/(?<board>\d+)(?:\/[a-f0-9]+)?\/?$/i.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'app.mural.co' || url.port !== '' || url.username || url.password || !match) {
    throw new ValidationError('Use an individual https://app.mural.co/t/.../m/... board URL, not the workspace list or a visitor link.');
  }
  // Drop query strings and the final share token. OAuth, not visitor access, grants permission.
  const parts = match.groups ?? {};
  return { id: `${parts['owner']}.${parts['board']}`, url: `https://app.mural.co/t/${parts['workspace']}/m/${parts['owner']}/${parts['board']}` };
}

async function read<T>(db: Store, key: string): Promise<T | null> {
  const result = await db.query<{ last_cursor: string }>('SELECT last_cursor FROM sync_state WHERE source = $1', [key]);
  const row = result.rows[0];
  return row ? JSON.parse(decryptConnectionValue(key, row.last_cursor)) as T : null;
}

async function write(db: Store, key: string, value: unknown): Promise<void> {
  await db.query(`INSERT INTO sync_state (source, last_cursor, item_count, updated_at)
    VALUES ($1, $2, 0, NOW()) ON CONFLICT (source)
    DO UPDATE SET last_cursor = EXCLUDED.last_cursor, updated_at = NOW()`,
  [key, encryptConnectionValue(key, JSON.stringify(value))]);
}

function fingerprint(config: Config): string {
  return createHash('sha256').update(`${config.clientId}:${config.secret}`).digest('hex');
}

async function configured(db: Store): Promise<Config> {
  const config = await read<Config>(db, CONFIG);
  if (!config) throw new ValidationError('Set up Mural in Sources / Integrations first.');
  return config;
}

export async function muralStatus(db: Store): Promise<MuralStatus> {
  const config = await read<Config>(db, CONFIG);
  const tokens = await read<Tokens>(db, AUTH);
  return { clientId: config?.clientId ?? MURAL_CLIENT_ID, configured: Boolean(config),
    connected: Boolean(tokens), boardUrl: config?.boardUrl ?? 'https://app.mural.co/t/athena5676/m/athena5676/1792510867260', redirectUrl: MURAL_REDIRECT };
}

async function locked<T>(db: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mural-token-refresh'))");
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function saveMuralConfig(pool: Pool, input: unknown): Promise<MuralStatus> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Enter Mural connection settings.');
  const body = record(input);
  const { clientId, secret, boardUrl } = body;
  if (Object.keys(body).some(k => !['clientId', 'secret', 'boardUrl'].includes(k))
    || typeof clientId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(clientId)
    || typeof secret !== 'string' || secret.length > MAX_SECRET_LENGTH || /[\r\n\0]/.test(secret)) {
    throw new ValidationError('Enter a valid client ID and client secret (no line breaks).');
  }
  const board = muralBoard(boardUrl);
  return locked(pool, async db => {
    const previous = await read<Config>(db, CONFIG);
    const value = secret.trim() || (previous?.clientId === clientId ? previous.secret : '');
    if (!value) throw new ValidationError('Enter the Mural client secret.');
    const config = { clientId, secret: value, boardUrl: board.url };
    if (!previous || fingerprint(previous) !== fingerprint(config)) {
      await db.query('DELETE FROM sync_state WHERE source = $1 OR source LIKE $2', [AUTH, `${PENDING}%`]);
    }
    await write(db, CONFIG, config);
    return muralStatus(db);
  });
}

export async function startMuralAuth(pool: Pool, userId: string): Promise<string> {
  return locked(pool, async db => {
    const config = await configured(db);
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const verifier = randomBytes(VERIFIER_BYTES).toString('base64url');
    await db.query("DELETE FROM sync_state WHERE source LIKE $1 AND updated_at < NOW() - INTERVAL '10 minutes'", [`${PENDING}%`]);
    await write(db, `${PENDING}${state}`, { userId, verifier, fingerprint: fingerprint(config) } satisfies Pending);
    const url = new URL(`${API}/authorization/oauth2/`);
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: MURAL_REDIRECT, response_type: 'code',
      scope: 'murals:read murals:write workspaces:read', state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return url.href;
  });
}

export async function request(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) }); }
  catch { throw new IntegrationError('mural', 'Could not reach Mural. The request may have timed out; check the destination before retrying an export.'); }
}

async function exchange(config: Config, params: Record<string, string>): Promise<Tokens> {
  const response = await request(`${API}/authorization/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: config.clientId, client_secret: config.secret }),
  });
  if (!response.ok) throw new IntegrationError('mural', `Authorisation failed (HTTP ${response.status}). Check the client credentials and registered redirect URL, then reconnect.`);
  const body = record(await response.json());
  if (typeof body.access_token !== 'string' || !body.access_token
    || typeof body.refresh_token !== 'string' || !body.refresh_token
    || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new IntegrationError('mural', 'Invalid token response. Reconnect to Mural.');
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * MS_PER_SECOND };
}

export async function finishMuralAuth(pool: Pool, userId: string, input: unknown): Promise<void> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Invalid Mural callback. Connect again.');
  const body = record(input);
  if (typeof body.state !== 'string' || !/^[\w-]{43}$/.test(body.state)
    || typeof body.code !== 'string' || !body.code || body.code.length > MAX_SECRET_LENGTH) throw new ValidationError('Invalid Mural callback. Connect again.');
  const code = body.code;
  const key = `${PENDING}${body.state}`;
  const outcome = await locked(pool, async db => {
    // Claim once, binding the callback to the signed-in Athena user and a short expiry.
    const result = await db.query<{ last_cursor: string }>(
      `DELETE FROM sync_state WHERE source = $1 AND updated_at > NOW() - INTERVAL '10 minutes' RETURNING last_cursor`, [key]);
    const row = result.rows[0];
    if (!row) return new ValidationError('Mural sign-in expired or has already been used. Connect again.');
    const pending = JSON.parse(decryptConnectionValue(key, row.last_cursor)) as Pending;
    const config = await configured(db);
    if (pending.userId !== userId || pending.fingerprint !== fingerprint(config)) return new ValidationError('Mural sign-in does not match this session or configuration. Connect again.');
    try {
      const tokens = await exchange(config, { grant_type: 'authorization_code', code, redirect_uri: MURAL_REDIRECT, code_verifier: pending.verifier });
      await write(db, AUTH, tokens);
      return null;
    } catch (error) {
      // Commit the consumed state even on provider failure; it must never be replayed.
      if (error instanceof IntegrationError) return error;
      throw error;
    }
  });
  if (outcome) throw outcome;
}

export async function disconnectMural(db: Pool): Promise<void> {
  await locked(db, async client => {
    await client.query('DELETE FROM sync_state WHERE source = $1 OR source LIKE $2', [AUTH, `${PENDING}%`]);
  });
}

export async function withToken<T>(db: Pool, operation: (token: string) => Promise<T>): Promise<T> {
  // Serialise rotating refresh tokens across replicas without holding a connection during export.
  const tokens = await locked(db, async connection => {
    const result = await connection.query<{ last_cursor: string }>('SELECT last_cursor FROM sync_state WHERE source = $1 FOR UPDATE', [AUTH]);
    const row = result.rows[0];
    if (!row) throw new ValidationError('Connect to Mural in Sources / Integrations first.');
    let tokens = JSON.parse(decryptConnectionValue(AUTH, row.last_cursor)) as Tokens;
    if (tokens.expiresAt < Date.now() + REFRESH_LEAD_MS) {
      tokens = await exchange(await configured(connection), { grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
      await connection.query('UPDATE sync_state SET last_cursor = $2, updated_at = NOW() WHERE source = $1',
        [AUTH, encryptConnectionValue(AUTH, JSON.stringify(tokens))]);
    }
    return tokens;
  });
  return operation(tokens.accessToken);
}

export async function apiJson(token: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await request(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === BAD_REQUEST) throw new IntegrationError('mural',
    `Mural rejected the ${path.includes('/widgets/') ? path.split('/widgets/')[1] : 'API'} payload (HTTP 400). The request contains invalid or unsupported fields; this is not a board-name change.`);
  if (!response.ok) throw new IntegrationError('mural',
    `Mural returned HTTP ${response.status}. ${response.status === UNAUTHORIZED ? 'Reconnect to Mural.' : response.status === FORBIDDEN ? 'Check mural write permission, OAuth scopes and workspace data-residency policy.' : response.status === RATE_LIMITED ? 'Rate limit reached; wait before retrying.' : 'Check board access and try again.'}`);
  return record(await response.json());
}

export async function listMuralBoards(db: Pool): Promise<MuralBoardOption[]> {
  return withToken(db, async token => {
    let requests = 0;
    const pages = async (path: string): Promise<Record<string, unknown>[]> => {
      const items: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      let next = '';
      do {
        if (++requests > MAX_BOARD_LIST_REQUESTS) throw new IntegrationError('mural', 'Board listing exceeded the pagination limit. Use a board URL instead.');
        const query = new URLSearchParams({ limit: '100', ...(next ? { next } : {}) });
        const response = await request(`${API}${path}?${query.toString()}`, {
          method: 'GET', headers: { Authorization: `Bearer ${token}` },
        });
        if (response.status === FORBIDDEN) {
          throw new IntegrationError('mural', 'Board listing needs workspaces:read and murals:read. Enable these scopes in your Mural app, then reconnect in Sources / Integrations. You can still enter a board URL.');
        }
        if (response.status === UNAUTHORIZED) throw new IntegrationError('mural', 'Mural sign-in expired or was revoked. Reconnect in Sources / Integrations.');
        if (!response.ok) throw new IntegrationError('mural', `Could not list Mural boards (HTTP ${response.status}). ${response.status === RATE_LIMITED ? 'Wait before refreshing.' : 'Check workspace access and try again.'}`);
        const page = record(await response.json());
        if (!Array.isArray(page.value) || (page.next !== undefined && page.next !== null && typeof page.next !== 'string')) {
          throw new IntegrationError('mural', 'Mural returned an invalid board list. Try refreshing.');
        }
        items.push(...page.value.map(record));
        next = typeof page.next === 'string' ? page.next : '';
        if (next && seen.has(next)) throw new IntegrationError('mural', 'Mural repeated a pagination token. Refresh the board list.');
        if (next) seen.add(next);
      } while (next);
      return items;
    };
    const boards = new Map<string, MuralBoardOption>();
    for (const workspace of await pages('/workspaces')) {
      if (typeof workspace.id !== 'string' || !/^[a-z0-9_-]+$/i.test(workspace.id) || typeof workspace.name !== 'string') {
        throw new IntegrationError('mural', 'Mural returned an invalid workspace.');
      }
      for (const board of await pages(`/workspaces/${encodeURIComponent(workspace.id)}/murals`)) {
        if (typeof board.id !== 'string' || !/^[a-z0-9_-]+\.\d+$/i.test(board.id)
          || typeof board.title !== 'string' || !['active', 'archived'].includes(String(board.status))) {
          throw new IntegrationError('mural', 'Mural returned an invalid board.');
        }
        const [owner, id] = board.id.split('.');
        boards.set(board.id, {
          id: board.id, title: board.title, workspace: workspace.name, archived: board.status === 'archived',
          url: muralBoard(`https://app.mural.co/t/${workspace.id}/m/${owner}/${id}`).url,
        });
      }
    }
    return [...boards.values()].sort((a, b) => a.workspace.localeCompare(b.workspace) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  });
}

export async function inviteMuralRecipients(db: Pool, boardUrl: string, recipients: string[], permission: 'view' | 'edit'): Promise<number> {
  const board = muralBoard(boardUrl);
  return withToken(db, async token => {
    const response = await apiJson(token, `/murals/${encodeURIComponent(board.id)}/users/invite`, {
      invitations: recipients.map(email => ({ email, editPermission: permission })), sendEmail: true,
    });
    if (!Array.isArray(response.value) || response.value.length !== recipients.length) {
      throw new IntegrationError('mural', 'Mural did not confirm every invitation. Check the board sharing settings before retrying.');
    }
    const expected = new Set(recipients);
    for (const value of response.value) {
      const invitation = record(value);
      const email = typeof invitation.email === 'string' ? invitation.email.toLowerCase() : '';
      if (!expected.delete(email) || invitation.rejected === true
        || (invitation.rejected !== false && typeof invitation.refCode !== 'string' && typeof invitation.username !== 'string')) {
        throw new IntegrationError('mural', 'Mural rejected or did not confirm an invitation. Some invitations may already have been sent. Check board permissions and workspace guest policy before retrying.');
      }
    }
    return recipients.length;
  });
}

export function pngDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < PNG_HEADER_BYTES || data.length > MAX_UPLOAD_BYTES
    || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || data.toString('ascii', PNG_TYPE_START, PNG_WIDTH_OFFSET) !== 'IHDR') throw new ValidationError('Export must be a PNG image, no larger than 20 MiB.');
  const width = data.readUInt32BE(PNG_WIDTH_OFFSET), height = data.readUInt32BE(PNG_HEIGHT_OFFSET);
  if (!width || !height || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE || width * height > MAX_PNG_PIXELS) throw new ValidationError('PNG dimensions exceed the diagram export limits.');
  return { width, height };
}

export function muralUploadUrl(value: unknown): string {
  if (typeof value !== 'string') throw new IntegrationError('mural', 'Missing asset upload URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.blob\.core\.windows\.net$/i.test(url.hostname) || url.port || url.username || url.password) {
    throw new IntegrationError('mural', 'Unsupported asset storage URL. No diagram was uploaded.');
  }
  return url.href;
}

export async function exportMuralImage(db: Pool, input: Buffer, boardInput: unknown, titleInput: unknown): Promise<{ boardUrl: string }> {
  const board = muralBoard(boardInput);
  const dimensions = pngDimensions(input);
  if (typeof titleInput !== 'string' || titleInput.length > MAX_TITLE_LENGTH) throw new ValidationError('Diagram title is too long.');
  return withToken(db, async token => {
    // Check permission before creating an asset; never overwrite existing widgets.
    await apiJson(token, `/murals/${encodeURIComponent(board.id)}`);
    const asset = record((await apiJson(token, `/murals/${encodeURIComponent(board.id)}/assets`, { fileExtension: 'png' })).value);
    const uploadUrl = muralUploadUrl(asset.url);
    if (typeof asset.name !== 'string' || !asset.name) throw new IntegrationError('mural', 'Missing asset name.');
    const response = await request(uploadUrl, { method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'image/png' }, body: new Uint8Array(input) });
    if (!response.ok) throw new IntegrationError('mural', `Image upload failed (HTTP ${response.status}). No image widget was created.`);
    try {
      await apiJson(token, `/murals/${encodeURIComponent(board.id)}/widgets/image`, {
        name: asset.name, ...dimensions, x: 100, y: 100,
        caption: titleInput || 'Athena diagram', description: 'One-way image export from Athena. Edit the source diagram in Athena.',
        showCaption: true, border: false,
      });
    } catch (error) {
      throw new IntegrationError('mural', `${error instanceof Error ? error.message : 'Widget creation failed.'} The image asset was uploaded; check the board before retrying to avoid duplicates.`);
    }
    return { boardUrl: board.url };
  });
}
