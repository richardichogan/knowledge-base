import { env } from '../../config/env.js';
import { IntegrationError, UnauthorisedError } from '../../types/errors.js';
import { MS_PER_SECOND } from '../../config/constants.js';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
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

    if (!env.GRAPH_REFRESH_TOKEN) {
      throw new UnauthorisedError(
        'Microsoft Graph refresh token not configured. Complete the OAuth2 flow first.',
      );
    }

    const tokenUrl = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      client_id: env.GRAPH_CLIENT_ID ?? '',
      client_secret: env.GRAPH_CLIENT_SECRET ?? '',
      refresh_token: env.GRAPH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
      scope: 'Calendars.Read Tasks.ReadWrite Mail.Read offline_access',
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new UnauthorisedError(`Graph token refresh failed: ${response.status} — ${text}`);
    }

    const token = await response.json() as TokenResponse;
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
