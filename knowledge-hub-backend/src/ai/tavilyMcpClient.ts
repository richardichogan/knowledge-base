/**
 * Client for Tavily's hosted MCP server — gives Athena real internet search
 * (`tavily-search`) and page extraction (`tavily-extract`), unlike
 * `fetch_web_page` which can only read a URL it's already been given.
 *
 * Endpoint: https://mcp.tavily.com/mcp/ (remote, streamable HTTP), API key
 * passed as a `tavilyApiKey` query param per Tavily's own docs — not a
 * header, unlike most bearer-token APIs. As with the Learn MCP client, the
 * tool list is not hardcoded: we call `listTools()` at runtime (cached
 * briefly) so whatever Tavily currently advertises is exposed to the model
 * as-is.
 *
 * The optional second Tavily account is tried only after the primary fails.
 * Brave is an optional final search backup, not an extraction backup.
 * Isolated from the rest of chatTools.ts for the same reason: a Tavily
 * outage should never take down the rest of Athena's tools.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { LlmToolDefinition } from './foundryClient.js';
import { TAVILY_MCP_URL, TAVILY_MCP_TOOL_CACHE_MS, TAVILY_MCP_TIMEOUT_MS } from '../config/constants.js';
import { env } from '../config/env.js';
import { rethrowAssignmentControl, withAssignmentResearch } from '../agents/workforce/modelBudget.js';
import { searchBrave } from './braveSearch.js';

interface AccountConnection {
  key: string | undefined;
  client: Client | null;
  connecting: Promise<Client> | null;
}

const primary: AccountConnection = { key: undefined, client: null, connecting: null };
const secondary: AccountConnection = { key: undefined, client: null, connecting: null };

let cachedTools: LlmToolDefinition[] = [];
let cachedToolNames: Set<string> = new Set();
let cacheExpiresAt = 0;
const SEARCH_NAME = /^tavily[-_]search$/;
const BACKUP_TOOL: LlmToolDefinition = {
  type: 'function',
  function: {
    name: 'tavily_search',
    description: 'Search the public web. Send public search terms only, never private context.',
    parameters: { type: 'object', required: ['query'], additionalProperties: false, properties: {
      query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 20 },
      include_domains: { type: 'array', items: { type: 'string' } },
      exclude_domains: { type: 'array', items: { type: 'string' } },
      start_date: { type: 'string' }, end_date: { type: 'string' }, time_range: { type: 'string' },
    } },
  },
};

function withBackupTool(tools: LlmToolDefinition[]): LlmToolDefinition[] {
  return env.BRAVE_SEARCH_API_KEY && !tools.some(tool => SEARCH_NAME.test(tool.function.name))
    ? [...tools, BACKUP_TOOL] : tools;
}

export function isPublicWebSearchEnabled(): boolean {
  return Boolean(env.BRAVE_SEARCH_API_KEY) || isTavilyEnabled();
}

function resetConnection(account: AccountConnection): void {
  const previous = account.client;
  account.client = null;
  account.connecting = null;
  cacheExpiresAt = 0;
  if (previous !== null) {
    void previous.close().catch(() => { console.warn('[Tavily] Could not close a previous connection.'); });
  }
}

function configuredAccounts(): AccountConnection[] {
  const keys = [env.TAVILY_API_KEY, env.TAVILY_BACKUP_API_KEY];
  for (const [index, account] of [primary, secondary].entries()) {
    if (account.key !== keys[index]) {
      resetConnection(account);
      account.key = keys[index];
    }
  }
  return [primary, secondary].filter((account, index) =>
    Boolean(account.key) && (index === 0 || account.key !== primary.key));
}

/** True when either Tavily account is configured for this environment. */
export function isTavilyEnabled(): boolean {
  return configuredAccounts().length > 0;
}

async function getClient(account: AccountConnection): Promise<Client> {
  if (account.client !== null) return account.client;
  if (account.connecting !== null) return account.connecting;
  const key = account.key;
  if (!key) throw new Error('Tavily account is not configured');

  const pending = (async (): Promise<Client> => {
    const c = new Client({ name: 'knowledge-hub-athena', version: '1.0.0' });
    const url = new URL(TAVILY_MCP_URL);
    url.searchParams.set('tavilyApiKey', key);
    const transport = new StreamableHTTPClientTransport(url);
    // Same SDK typing gap as learnMcpClient.ts — cast at this single call site.
    await withAssignmentResearch(signal => c.connect(transport as unknown as Transport, {
      timeout: TAVILY_MCP_TIMEOUT_MS, ...(signal ? { signal } : {}),
    }));
    if (account.key !== key) {
      await c.close();
      throw new Error('Tavily credential changed while connecting');
    }
    account.client = c;
    return c;
  })();
  account.connecting = pending;

  try {
    return await pending;
  } finally {
    if (account.connecting === pending) account.connecting = null;
  }
}

/**
 * Returns Tavily's currently advertised MCP tools, as OpenAI-style
 * function-calling definitions ready to merge into Athena's tool list.
 * Cached for TAVILY_MCP_TOOL_CACHE_MS. Worker cancellation and assignment
 * control failures propagate rather than masquerade as unavailable evidence.
 */
export async function getTavilyMcpTools(): Promise<LlmToolDefinition[]> {
  if (!isTavilyEnabled()) return withBackupTool([]);
  if (Date.now() < cacheExpiresAt) return withBackupTool(cachedTools);

  for (const account of configuredAccounts()) {
    try {
      const c = await getClient(account);
      const { tools } = await withAssignmentResearch(signal => c.listTools(undefined, {
        timeout: TAVILY_MCP_TIMEOUT_MS, ...(signal ? { signal } : {}),
      }));
      cachedTools = tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description ?? `Tavily MCP tool: ${tool.name}`,
          parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      }));
      cachedToolNames = new Set(tools.map((t) => t.name));
      cacheExpiresAt = Date.now() + TAVILY_MCP_TOOL_CACHE_MS;
      return withBackupTool(cachedTools);
    } catch (err) {
      rethrowAssignmentControl(err);
      console.warn('[Tavily] Could not list tools for an account; trying the next configured account.');
      resetConnection(account);
    }
  }
  return withBackupTool([]);
}

/** True if `name` was in the last successfully fetched Tavily MCP tool list. */
export function isTavilyMcpTool(name: string): boolean {
  return cachedToolNames.has(name) || (Boolean(env.BRAVE_SEARCH_API_KEY) && SEARCH_NAME.test(name));
}

export function tavilySearchFailure(text: string): { failed: boolean; canFallBack: boolean } {
  try {
    const body = JSON.parse(text) as { error?: unknown; status?: unknown; detail?: unknown } | null;
    if (body && body.error) {
      const status = Number(body.status);
      return { failed: true, canFallBack: [401, 402, 403, 408, 429, 432].includes(status) || status >= 500
        || /usage limit|quota|rate limit/i.test(JSON.stringify(body.detail ?? body.error)) };
    }
  } catch { /* Tavily also returns plain-text or formatted search results. */ }
  return { failed: false, canFallBack: false };
}

/**
 * Invokes a Tavily MCP tool by name and flattens its result content into a
 * single string (concatenating any text blocks) — good enough for feeding
 * back into the chat completion as a tool message.
 */
export async function callTavilyMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const search = SEARCH_NAME.test(name);
  const backup = search && Boolean(env.BRAVE_SEARCH_API_KEY);
  for (const account of configuredAccounts()) {
    try {
      const c = await getClient(account);
      const result = await withAssignmentResearch(signal => c.callTool({ name, arguments: args }, undefined, {
        timeout: TAVILY_MCP_TIMEOUT_MS, ...(signal ? { signal } : {}),
      }));
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n\n');
      const failure = tavilySearchFailure(text);
      if (failure.canFallBack || (result.isError && !failure.failed)) {
        console.info('[Tavily] Account request failed; trying the next configured backup.');
        continue;
      }
      if (result.isError || failure.failed) return { error: 'Tavily could not complete the request.', result: text };
      return { result: text !== '' ? text : result.content };
    } catch (err) {
      rethrowAssignmentControl(err);
      resetConnection(account);
      console.warn('[Tavily] Account connection failed; trying the next configured backup.');
    }
  }
  if (backup) {
    console.info('[Search] Tavily accounts unavailable; using Brave.');
    return searchBrave(args);
  }
  return { error: 'The configured Tavily accounts could not complete the request.' };
}
