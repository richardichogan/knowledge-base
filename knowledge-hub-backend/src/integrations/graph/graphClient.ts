import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { getDb } from '../../db/db.js';
import { getSyncState, upsertSyncState } from '../../db/queries.js';
import { EXTERNAL_FETCH_TIMEOUT_MS } from '../../config/constants.js';
import { IntegrationError, UnauthorisedError } from '../../types/errors.js';
import { MS_PER_SECOND } from '../../config/constants.js';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

// ── Refresh token storage ─────────────────────────────────────────────────────
// Microsoft returns a new refresh token on every refresh; the old one expires
// after 90 days. It's kept in the database (AES-256-GCM, key = SHA-256 of the
// client secret) so each new one is saved and the sign-in never lapses.
// GRAPH_REFRESH_TOKEN in the environment is only the initial fallback.

const TOKEN_STATE_KEY = 'graph-auth';

function tokenKey(): Buffer {
  return createHash('sha256').update(env.GRAPH_CLIENT_SECRET ?? '').digest();
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decrypt(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

async function loadRefreshToken(): Promise<string | undefined> {
  try {
    const state = await getSyncState(getDb(), TOKEN_STATE_KEY);
    if (state?.lastCursor != null && state.lastCursor !== '') return decrypt(state.lastCursor);
  } catch {
    // Unreadable (secret changed) — fall back to the environment value.
  }
  return env.GRAPH_REFRESH_TOKEN;
}

/** Saves a refresh token (from sign-in or a refresh) so the next refresh uses it. */
export async function saveGraphRefreshToken(refreshToken: string): Promise<void> {
  await upsertSyncState(getDb(), TOKEN_STATE_KEY, { lastSyncAt: new Date(), lastCursor: encrypt(refreshToken), lastError: null });
}

/**
 * Microsoft Graph API client.
 * Uses OAuth2 refresh token flow — all tokens held server-side.
 * The mobile app never sees Graph tokens.
 */
export class GraphClient {
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  /**
   * Returns a valid access token, refreshing if necessary.
   */
  public async getAccessToken(): Promise<string> {
    const nowMs = Date.now();
    const bufferMs = 60_000; // refresh 60s before expiry

    if (this.accessToken && nowMs < this.tokenExpiresAt - bufferMs) {
      return this.accessToken;
    }

    const refreshToken = await loadRefreshToken();
    if (!refreshToken) {
      throw new UnauthorisedError(
        'Microsoft Graph refresh token not configured. Complete the OAuth2 flow first.',
      );
    }

    const tokenUrl = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      client_id: env.GRAPH_CLIENT_ID ?? '',
      client_secret: env.GRAPH_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'Calendars.Read Tasks.ReadWrite Mail.Read offline_access',
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new UnauthorisedError(`Graph token refresh failed: ${response.status} — ${text}`);
    }

    const token = await response.json() as TokenResponse;
    if (token.refresh_token !== undefined && token.refresh_token !== refreshToken) {
      await saveGraphRefreshToken(token.refresh_token);
    }
    this.accessToken = token.access_token;
    this.tokenExpiresAt = nowMs + token.expires_in * MS_PER_SECOND;

    return this.accessToken;
  }

  /** Makes a GET request to the Microsoft Graph API. */
  public async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new IntegrationError(
        'graph',
        `GET ${path} failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /** Makes a POST request to the Microsoft Graph API. */
  public async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new IntegrationError(
        'graph',
        `POST ${path} failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /** Makes a PATCH request to the Microsoft Graph API. */
  public async patch<T>(path: string, body: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new IntegrationError(
        'graph',
        `PATCH ${path} failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /** Paginates through a Graph list endpoint using @odata.nextLink. */
  public async *paginate<T>(
    path: string,
    params: Record<string, string> = {},
  ): AsyncGenerator<T[]> {
    let nextUrl: string | null = null;
    const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    nextUrl = url.toString();

    while (nextUrl) {
      const token = await this.getAccessToken();
      const response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new IntegrationError(
          'graph',
          `Paginate ${path} failed: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json() as { value: T[]; '@odata.nextLink'?: string };
      yield data.value;
      nextUrl = data['@odata.nextLink'] ?? null;
    }
  }
}

/** Singleton instance — one client per process. */
let graphClientInstance: GraphClient | undefined;

export function getGraphClient(): GraphClient {
  if (!graphClientInstance) {
    graphClientInstance = new GraphClient();
  }
  return graphClientInstance;
}
