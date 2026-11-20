import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchBrave } from '../src/ai/braveSearch.js';
import { tavilySearchFailure } from '../src/ai/tavilyMcpClient.js';

test('Tavily plan exhaustion is retryable on Brave but an empty result or invalid request is not', () => {
  assert.deepEqual(tavilySearchFailure('{"error":"Search failed","status":432}'), { failed: true, canFallBack: true });
  assert.deepEqual(tavilySearchFailure('{"error":"Invalid request","status":400}'), { failed: true, canFallBack: false });
  assert.deepEqual(tavilySearchFailure('{"results":[]}'), { failed: false, canFallBack: false });
});

test('Brave receives only public search fields and drops hits outside the source allowlist', async t => {
  const previous = process.env.BRAVE_SEARCH_API_KEY;
  process.env.BRAVE_SEARCH_API_KEY = 'test-key-not-a-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = previous;
  });
  const fetchSearch: typeof fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('q'), 'Work IQ (site:microsoft.com)');
    assert.equal(url.searchParams.get('freshness'), '2026-11-13to2026-11-20');
    assert.equal(url.searchParams.has('objective'), false);
    return Response.json({ web: { results: [
      { url: 'https://learn.microsoft.com/example', title: 'Official', description: 'Excerpt' },
      { url: 'https://notmicrosoft.com/example', title: 'Unrelated', description: 'Excerpt' },
    ] } });
  };
  assert.deepEqual(await searchBrave({
    query: 'Work IQ', include_domains: ['microsoft.com'], start_date: '2026-11-13',
    end_date: '2026-11-20', objective: 'This is not sent',
  }, fetchSearch), { result: JSON.stringify({ provider: 'brave', results: [
    { url: 'https://learn.microsoft.com/example', title: 'Official', content: 'Excerpt' },
  ] }) });
});
