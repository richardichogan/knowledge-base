import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/blog-contract';
process.env.AZURE_OPENAI_ENDPOINT_GPT54 = 'https://reasoning.fixture.invalid';
process.env.AZURE_OPENAI_API_KEY_GPT54 = 'fixture-key';
const { FoundryClient } = await import('../src/ai/foundryClient.js');
const { getDb } = await import('../src/db/db.js');

test('Astra Responses receives a strict schema and rejects incomplete or refused output', async t => {
  t.mock.method(getDb(), 'query', async () => ({ rows: [] }));
  const schema = { name: 'draft', schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' } } } };
  let status = 'completed';
  let refusal = false;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    assert.equal(body.model, 'gpt-6-astra');
    assert.deepEqual(body.text.format, { type: 'json_schema', ...schema, strict: true });
    return new Response(JSON.stringify({
      status, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      output: [{ type: 'message', content: [refusal ? { type: 'refusal', refusal: 'No' } : { type: 'output_text', text: '{"title":"Complete"}' }] }],
    }));
  });
  const client = new FoundryClient('blog-astra-contract');
  const invoke = () => client.chat('reasoning', [{ role: 'user', content: 'Draft' }], 1000, undefined, undefined, schema, { deployment: 'gpt-6-astra', api: 'responses' });
  assert.equal(await invoke(), '{"title":"Complete"}');
  status = 'incomplete';
  await assert.rejects(invoke, /limit|truncat/i);
  status = 'completed';
  refusal = true;
  await assert.rejects(invoke, /refused/);
});
