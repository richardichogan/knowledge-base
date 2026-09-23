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
 * Optional integration: if TAVILY_API_KEY is unset, `getTavilyMcpTools()`
 * returns `[]` without attempting a connection, so local dev / a missing
 * key never breaks chat — Athena simply has no web_search tool that turn.
 * Isolated from the rest of chatTools.ts for the same reason: a Tavily
 * outage should never take down the rest of Athena's tools.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { LlmToolDefinition } from './foundryClient.js';
import { TAVILY_MCP_URL, TAVILY_MCP_TOOL_CACHE_MS, TAVILY_MCP_TIMEOUT_MS } from '../config/constants.js';
import { env } from '../config/env.js';

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

let cachedTools: LlmToolDefinition[] = [];
let cachedToolNames: Set<string> = new Set();
let cacheExpiresAt = 0;

/** True when Tavily is configured for this environment. */
export function isTavilyEnabled(): boolean {
  return Boolean(env.TAVILY_API_KEY);
}

async function getClient(): Promise<Client> {
  if (client !== null) return client;
  if (connecting !== null) return connecting;

  connecting = (async (): Promise<Client> => {
    const c = new Client({ name: 'knowledge-hub-athena', version: '1.0.0' });
    const url = new URL(TAVILY_MCP_URL);
    url.searchParams.set('tavilyApiKey', env.TAVILY_API_KEY!);
    const transport = new StreamableHTTPClientTransport(url);
    // Same SDK typing gap as learnMcpClient.ts — cast at this single call site.
    await c.connect(transport as unknown as Transport, { timeout: TAVILY_MCP_TIMEOUT_MS });
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } catch (err) {
    client = null;
    throw err;
  } finally {
    connecting = null;
  }
}

/** Drops the cached connection/tool list so the next call reconnects from scratch. */
function resetConnection(): void {
  client = null;
  connecting = null;
  cacheExpiresAt = 0;
}

/**
 * Returns Tavily's currently advertised MCP tools, as OpenAI-style
 * function-calling definitions ready to merge into Athena's tool list.
 * Cached for TAVILY_MCP_TOOL_CACHE_MS; returns `[]` (never throws) if
 * TAVILY_API_KEY is unset or the server is unreachable, so a missing key or
 * a Tavily outage never breaks chat.
 */
export async function getTavilyMcpTools(): Promise<LlmToolDefinition[]> {
  if (!isTavilyEnabled()) return [];
  if (Date.now() < cacheExpiresAt) return cachedTools;

  try {
    const c = await getClient();
    const { tools } = await c.listTools(undefined, { timeout: TAVILY_MCP_TIMEOUT_MS });
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
    return cachedTools;
  } catch (err) {
    console.error('[tavilyMcpClient] Failed to list tools — Tavily tools unavailable this turn:', err);
    resetConnection();
    return [];
  }
}

/** True if `name` was in the last successfully fetched Tavily MCP tool list. */
export function isTavilyMcpTool(name: string): boolean {
  return cachedToolNames.has(name);
}

/**
 * Invokes a Tavily MCP tool by name and flattens its result content into a
 * single string (concatenating any text blocks) — good enough for feeding
 * back into the chat completion as a tool message.
 */
export async function callTavilyMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const c = await getClient();
    const result = await c.callTool({ name, arguments: args }, undefined, { timeout: TAVILY_MCP_TIMEOUT_MS });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n');
    return { result: text !== '' ? text : result.content };
  } catch (err) {
    resetConnection();
    return { error: err instanceof Error ? err.message : 'Tavily MCP request failed' };
  }
}
