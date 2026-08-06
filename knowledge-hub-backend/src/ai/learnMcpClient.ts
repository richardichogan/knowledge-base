/**
 * Client for the public Microsoft Learn MCP server — grounds Athena in
 * up-to-date official Microsoft documentation (Learn articles, code samples)
 * without us having to crawl/index that content ourselves.
 *
 * Endpoint: https://learn.microsoft.com/api/mcp (remote, streamable HTTP,
 * no authentication required). Per Microsoft's own guidance, the tool list
 * is not part of a stable public contract and may change over time, so we
 * call `listTools()` at runtime (cached briefly) instead of hardcoding tool
 * names/schemas — whatever the server currently advertises (as of writing:
 * `microsoft_docs_search`, `microsoft_docs_fetch`, `microsoft_code_sample_search`)
 * is exposed to the model as-is.
 *
 * This is deliberately isolated from the rest of chatTools.ts: if the Learn
 * MCP server is unreachable (network policy, outage, etc.) Athena should
 * keep working with its local tools — connection/list failures here are
 * caught and simply result in zero Learn tools being offered that turn.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { LlmToolDefinition } from './foundryClient.js';
import { MS_LEARN_MCP_URL, MS_LEARN_MCP_TOOL_CACHE_MS, MS_LEARN_MCP_TIMEOUT_MS } from '../config/constants.js';

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

let cachedTools: LlmToolDefinition[] = [];
let cachedToolNames: Set<string> = new Set();
let cacheExpiresAt = 0;

async function getClient(): Promise<Client> {
  if (client !== null) return client;
  if (connecting !== null) return connecting;

  connecting = (async (): Promise<Client> => {
    const c = new Client({ name: 'knowledge-hub-athena', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(MS_LEARN_MCP_URL));
    // The SDK's own StreamableHTTPClientTransport class doesn't quite satisfy its
    // Transport interface under `exactOptionalPropertyTypes` (a gap in the SDK's
    // published types, not a real runtime issue) — cast at this single call site.
    await c.connect(transport as unknown as Transport, { timeout: MS_LEARN_MCP_TIMEOUT_MS });
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } catch (err) {
    // Connection failed — clear state so the next call retries from scratch
    // rather than being stuck reusing a dead in-flight promise.
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
 * Returns the Learn MCP server's currently advertised tools, as OpenAI-style
 * function-calling definitions ready to merge into Athena's tool list.
 * Cached for MS_LEARN_MCP_TOOL_CACHE_MS; returns `[]` (never throws) if the
 * server is unreachable so a Learn MCP outage never breaks chat.
 */
export async function getLearnMcpTools(): Promise<LlmToolDefinition[]> {
  if (Date.now() < cacheExpiresAt) return cachedTools;

  try {
    const c = await getClient();
    const { tools } = await c.listTools(undefined, { timeout: MS_LEARN_MCP_TIMEOUT_MS });
    cachedTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description ?? `Microsoft Learn MCP tool: ${tool.name}`,
        parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      },
    }));
    cachedToolNames = new Set(tools.map((t) => t.name));
    cacheExpiresAt = Date.now() + MS_LEARN_MCP_TOOL_CACHE_MS;
    return cachedTools;
  } catch (err) {
    console.error('[learnMcpClient] Failed to list tools — Learn MCP tools unavailable this turn:', err);
    resetConnection();
    return [];
  }
}

/** True if `name` was in the last successfully fetched Learn MCP tool list. */
export function isLearnMcpTool(name: string): boolean {
  return cachedToolNames.has(name);
}

/**
 * Invokes a Learn MCP tool by name and flattens its result content into a
 * single string (concatenating any text blocks) — good enough for feeding
 * back into the chat completion as a tool message.
 */
export async function callLearnMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const c = await getClient();
    const result = await c.callTool({ name, arguments: args }, undefined, { timeout: MS_LEARN_MCP_TIMEOUT_MS });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n');
    return { result: text !== '' ? text : result.content };
  } catch (err) {
    resetConnection();
    return { error: err instanceof Error ? err.message : 'Microsoft Learn MCP request failed' };
  }
}
