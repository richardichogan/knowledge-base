import { env } from '../../config/env.js';
import { IntegrationError } from '../../types/errors.js';
import { EXTERNAL_FETCH_TIMEOUT_MS } from '../../config/constants.js';

/**
 * Thin wrapper around the GitLab REST API v4.
 * All API calls use the personal access token held server-side.
 * Never exposes the token to the mobile app.
 */
export class GitLabClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  public constructor() {
    this.baseUrl = `${env.GITLAB_BASE_URL}/api/v4`;
    this.headers = {
      'PRIVATE-TOKEN': env.GITLAB_ACCESS_TOKEN ?? '',
      'Content-Type': 'application/json',
    };
  }

  /**
   * Makes a GET request to the GitLab API.
   * @throws IntegrationError on non-2xx response.
   */
  public async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), { headers: this.headers, signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS) });

    if (!response.ok) {
      throw new IntegrationError(
        'gitlab',
        `GET ${path} failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Paginates through all pages of a GitLab list endpoint.
   * GitLab uses X-Next-Page header for pagination.
   */
  public async *paginate<T>(
    path: string,
    params: Record<string, string> = {},
  ): AsyncGenerator<T[]> {
    let page = '1';
    const perPage = '100';

    while (true) {
      const url = new URL(`${this.baseUrl}${path}`);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set('page', page);
      url.searchParams.set('per_page', perPage);

      const response = await fetch(url.toString(), { headers: this.headers, signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS) });

      if (!response.ok) {
        throw new IntegrationError(
          'gitlab',
          `GET ${path} (page ${page}) failed: ${response.status} ${response.statusText}`,
        );
      }

      const items = await response.json() as T[];
      if (items.length === 0) break;
      yield items;

      const nextPage = response.headers.get('X-Next-Page');
      if (!nextPage) break;
      page = nextPage;
    }
  }
}
