import { env } from '../../config/env.js';
import { IntegrationError } from '../../types/errors.js';
import { EXTERNAL_FETCH_TIMEOUT_MS } from '../../config/constants.js';

/**
 * Thin wrapper around the GitHub REST API v3.
 * Uses personal access token held server-side.
 */
export class GitHubClient {
  private readonly baseUrl = 'https://api.github.com';
  private readonly headers: Record<string, string>;

  public constructor() {
    this.headers = {
      Authorization: `Bearer ${env.GITHUB_ACCESS_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /** Makes a GET request to the GitHub API. */
  public async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), { headers: this.headers, signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS) });

    if (!response.ok) {
      throw new IntegrationError(
        'github',
        `GET ${path} failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /** Makes a POST request to the GitHub API (for creating issues). */
  public async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new IntegrationError(
        'github',
        `POST ${path} failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Paginates through all pages of a GitHub list endpoint.
   * GitHub uses Link header with rel="next" for pagination.
   */
  public async *paginate<T>(
    path: string,
    params: Record<string, string> = {},
  ): AsyncGenerator<T[]> {
    const perPage = '100';
    let page = '1';

    while (true) {
      const url = new URL(`${this.baseUrl}${path}`);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set('per_page', perPage);
      url.searchParams.set('page', page);

      const response = await fetch(url.toString(), { headers: this.headers, signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS) });

      if (!response.ok) {
        throw new IntegrationError(
          'github',
          `GET ${path} (page ${page}) failed: ${response.status} ${response.statusText}`,
        );
      }

      const items = await response.json() as T[];
      if (items.length === 0) break;
      yield items;

      const linkHeader = response.headers.get('Link') ?? '';
      if (!linkHeader.includes('rel="next"')) break;
      page = String(parseInt(page, 10) + 1);
    }
  }
}
