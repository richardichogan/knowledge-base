import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTavilyMcpTool } from '../src/ai/tavilyMcpClient.js';

test('Tavily uses the second account for quota failures, not empty results or invalid requests', async t => {
  const keys = ['TAVILY_API_KEY', 'TAVILY_BACKUP_API_KEY', 'BRAVE_SEARCH_API_KEY'] as const;
  const previous = keys.map(key => process.env[key]);
  process.env.TAVILY_API_KEY = 'test-primary';
  process.env.TAVILY_BACKUP_API_KEY = 'test-secondary';
  delete process.env.BRAVE_SEARCH_API_KEY;
  t.after(() => {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });
  let calls = 0;
  let first = { error: 'Search failed', status: 432 };
  let empty = false;
  t.mock.method(Client.prototype, 'connect', async () => {});
  t.mock.method(Client.prototype, 'close', async () => {});
  t.mock.method(Client.prototype, 'callTool', async () => {
    calls++;
    return { content: [{ type: 'text', text: JSON.stringify(
      empty ? { results: [] } : calls === 1 ? first : { results: [{ title: 'Found', url: 'https://example.com' }] },
    ) }] };
  });
  const response = await callTavilyMcpTool('tavily_search', { query: 'Public topic' });
  assert.equal(calls, 2);
  assert.match(JSON.stringify(response), /Found/);
  calls = 0;
  empty = true;
  await callTavilyMcpTool('tavily_search', { query: 'No matches' });
  assert.equal(calls, 1);
  calls = 0;
  empty = false;
  first = { error: 'Invalid query', status: 400 };
  const invalid = await callTavilyMcpTool('tavily_search', { query: '' });
  assert.equal(calls, 1);
  assert.ok(invalid && typeof invalid === 'object' && 'error' in invalid);
});
