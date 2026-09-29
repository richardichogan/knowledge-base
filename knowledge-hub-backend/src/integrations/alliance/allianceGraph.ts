/**
 * integrations/alliance/allianceGraph.ts — Microsoft Graph access to the IBM
 * Alliance tenant, as the signed-in user (delegated Files.Read(.All)).
 *
 * Separate from integrations/graph (themicrosoftcloudblog tenant: calendar,
 * mail, To Do). The refresh token is stored in the database — encrypted with
 * a key derived from the app's client secret — rather than written to .env,
 * so it survives container restarts and is rotated automatically on refresh.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../../config/env.js';
import { getSyncState, upsertSyncState } from '../../db/queries.js';

export const ALLIANCE_SCOPES = ['offline_access', 'openid', 'profile', 'User.Read', 'Files.Read.All'].join(' ');

const TOKEN_STATE_KEY = 'alliance-graph-auth';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_REFRESH_BUFFER_MS = 60_000;

interface StoredAuth {
  refreshToken: string;
  upn: string;
  connectedAt: string;
}

let cachedAccess: { token: string; expiresAt: number } | null = null;

/** True when the Alliance app registration settings are present. */
export function isAllianceConfigured(): boolean {
  return Boolean(env.ALLIANCE_GRAPH_CLIENT_ID && env.ALLIANCE_GRAPH_TENANT_ID && env.ALLIANCE_GRAPH_CLIENT_SECRET);
}

function authority(): string {
  return `https://login.microsoftonline.com/${env.ALLIANCE_GRAPH_TENANT_ID ?? 'common'}/oauth2/v2.0`;
}

// ── Token storage (AES-256-GCM; key = SHA-256 of the client secret) ──────────

function key(): Buffer {
  return createHash('sha256').update(env.ALLIANCE_GRAPH_CLIENT_SECRET ?? '').digest();
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decrypt(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

async function loadAuth(db: Pool): Promise<StoredAuth | null> {
  const state = await getSyncState(db, TOKEN_STATE_KEY);
  if (state?.lastCursor == null || state.lastCursor === '') return null;
  try {
    return JSON.parse(decrypt(state.lastCursor)) as StoredAuth;
  } catch {
    // Secret rotated (key changed) or corrupt — treat as disconnected.
    return null;
  }
}

async function saveAuth(db: Pool, auth: StoredAuth): Promise<void> {
  await upsertSyncState(db, TOKEN_STATE_KEY, { lastSyncAt: new Date(), lastCursor: encrypt(JSON.stringify(auth)), lastError: null });
}

/** Clears the stored sign-in (e.g. after the refresh token is rejected). */
export async function clearAllianceAuth(db: Pool, reason: string): Promise<void> {
  cachedAccess = null;
  await db.query(`UPDATE sync_state SET last_cursor = NULL, last_error = $2, updated_at = NOW() WHERE source = $1`, [TOKEN_STATE_KEY, reason]);
}

// ── Sign-in (authorization code flow) ─────────────────────────────────────────

/** Microsoft sign-in URL for the Alliance tenant. */
export function buildAllianceLoginUrl(state: string): string {
  const url = new URL(`${authority()}/authorize`);
  url.searchParams.set('client_id', env.ALLIANCE_GRAPH_CLIENT_ID ?? '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.ALLIANCE_GRAPH_REDIRECT_URI);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', ALLIANCE_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${authority()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.ALLIANCE_GRAPH_CLIENT_ID ?? '',
      client_secret: env.ALLIANCE_GRAPH_CLIENT_SECRET ?? '',
      scope: ALLIANCE_SCOPES,
      ...params,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Alliance token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

/**
 * Completes sign-in: exchanges the code, checks the account (if an allowed
 * UPN is configured), and stores the refresh token. Returns the account UPN.
 */
export async function completeAllianceSignIn(db: Pool, code: string): Promise<string> {
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: env.ALLIANCE_GRAPH_REDIRECT_URI });
  if (!tokens.refresh_token) throw new Error('No refresh token returned — offline_access was not granted.');

  const meRes = await fetch(`${GRAPH_BASE}/me?$select=userPrincipalName,mail`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!meRes.ok) throw new Error(`Could not read the signed-in account: ${meRes.status}`);
  const me = (await meRes.json()) as { userPrincipalName?: string; mail?: string };
  const upn = me.userPrincipalName ?? me.mail ?? 'unknown';

  const allowed = env.ALLIANCE_ALLOWED_UPN?.trim().toLowerCase();
  if (allowed && upn.toLowerCase() !== allowed) {
    throw new Error(`Signed in as ${upn}, but only ${env.ALLIANCE_ALLOWED_UPN ?? ''} may connect OneDrive.`);
  }

  await saveAuth(db, { refreshToken: tokens.refresh_token, upn, connectedAt: new Date().toISOString() });
  cachedAccess = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  return upn;
}

/** Valid access token for the Alliance tenant, refreshing (and rotating the refresh token) as needed. */
export async function getAllianceAccessToken(db: Pool): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) return cachedAccess.token;
  const auth = await loadAuth(db);
  if (auth === null) throw new Error('OneDrive (Alliance) is not connected.');
  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // invalid_grant = token revoked/expired (password change, CA policy, 90 days idle): needs a fresh sign-in.
    if (message.includes('invalid_grant')) await clearAllianceAuth(db, 'Sign-in expired — reconnect OneDrive.');
    throw err;
  }
  if (tokens.refresh_token && tokens.refresh_token !== auth.refreshToken) {
    await saveAuth(db, { ...auth, refreshToken: tokens.refresh_token });
  }
  cachedAccess = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  return tokens.access_token;
}

/** GET a Graph resource (path relative to /v1.0, or an absolute @odata.nextLink). */
export async function allianceGraphGet<T>(db: Pool, pathOrUrl: string): Promise<T> {
  const token = await getAllianceAccessToken(db);
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph GET ${pathOrUrl} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Downloads a drive item's file content. */
export async function allianceDownload(db: Pool, itemId: string): Promise<Buffer> {
  const token = await getAllianceAccessToken(db);
  const res = await fetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Download of ${itemId} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface AllianceStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
  connectedAt: string | null;
  lastError: string | null;
}

/** Connection status for the UI health indicator. */
export async function getAllianceStatus(db: Pool): Promise<AllianceStatus> {
  if (!isAllianceConfigured()) {
    return { configured: false, connected: false, account: null, connectedAt: null, lastError: null };
  }
  const auth = await loadAuth(db);
  const row = await db.query<{ last_error: string | null }>(`SELECT last_error FROM sync_state WHERE source = $1`, [TOKEN_STATE_KEY]);
  return {
    configured: true,
    connected: auth !== null,
    account: auth?.upn ?? null,
    connectedAt: auth?.connectedAt ?? null,
    lastError: row.rows[0]?.last_error ?? null,
  };
}
