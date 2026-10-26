import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/model-contract';
process.env.AZURE_OPENAI_ENDPOINT = 'https://main.fixture.invalid';
process.env.AZURE_OPENAI_API_KEY = 'fixture-main';
process.env.AZURE_OPENAI_ENDPOINT_STANDARD = 'https://standard.fixture.invalid';
process.env.AZURE_OPENAI_API_KEY_STANDARD = 'fixture-standard';
process.env.AZURE_OPENAI_ENDPOINT_GPT54 = 'https://bulk.fixture.invalid';
process.env.AZURE_OPENAI_API_KEY_GPT54 = 'fixture-bulk';
process.env.AZURE_OPENAI_DEPLOYMENT_SCREEN_READ = 'gpt-5.4';
const { FoundryClient } = await import('../src/ai/foundryClient.js');
const { getDb } = await import('../src/db/db.js');

test('standard routing is separate; plain-text writer responses must be complete', async t => {
  t.mock.method(getDb(), 'query', async () => ({ rows: [] }));
  let finishReason = 'length';
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    urls.push(url);
    const headers = options.headers as Record<string, string>;
    assert.equal(headers['api-key'], url.startsWith('https://standard.') ? 'fixture-standard' : 'fixture-bulk');
    return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: 'A complete sentence.' } }] }));
  });
  const client = new FoundryClient('weekly-contract-test');
  for (const invoke of [
    () => client.chat('standard', [{ role: 'user', content: 'Fixture' }]),
    () => client.chatBulk([{ role: 'user', content: 'Fixture' }]),
  ]) {
    finishReason = 'length';
    await assert.rejects(invoke, /limit|truncat/i);
    finishReason = 'content_filter';
    await assert.rejects(invoke, /incomplete or refused/);
    finishReason = 'stop';
    assert.equal(await invoke(), 'A complete sentence.');
  }
  assert.ok(urls.slice(0, 3).every(url => url.startsWith('https://standard.fixture.invalid/')));
  assert.ok(urls.slice(3).every(url => url.startsWith('https://bulk.fixture.invalid/openai/deployments/gpt-5.4/')));
});
