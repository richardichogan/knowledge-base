import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';

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

  await t.test('long bulk requests honour explicit HTTP deadlines and retain structured-output checks', async t => {
    t.mock.method(getDb(), 'query', async () => ({ rows: [] }));
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    t.after(async () => { setGlobalDispatcher(previous); await agent.close(); });
    const dispatch = agent.dispatch.bind(agent);
    let calls = 0;
    t.mock.method(agent, 'dispatch', (options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers) => {
      calls++;
      assert.equal(options.headersTimeout, 540_000);
      assert.equal(options.bodyTimeout, 540_000);
      return dispatch(options, handler);
    });
    const pool = agent.get('https://bulk.fixture.invalid');
    const client = new FoundryClient('blueprint-timeout-test');
    const schema = { name: 'blueprint', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } };
    const invoke = () => client.chatBulk([{ role: 'user', content: 'Full specification' }], 64_000, 540_000, 'medium', schema);
    const intercept = () => pool.intercept({ path: /\/openai\/deployments\/gpt-5\.4\/chat\/completions\?api-version=/, method: 'POST',
      headers: { 'api-key': 'fixture-bulk' }, body: body => {
        const parsed = JSON.parse(body);
        assert.equal(parsed.max_completion_tokens, 64_000);
        assert.equal(parsed.reasoning_effort, 'medium');
        assert.deepEqual(parsed.messages, [{ role: 'user', content: 'Full specification' }]);
        assert.deepEqual(parsed.response_format.json_schema, { ...schema, strict: true });
        return true;
      } });
    for (const finish of ['stop', 'length', 'content_filter']) {
      intercept().reply(200, { choices: [{ finish_reason: finish, message: { content: '{"title":"Complete"}' } }] });
      if (finish === 'stop') assert.equal(await invoke(), '{"title":"Complete"}');
      else await assert.rejects(invoke, finish === 'length' ? /limit|truncat/i : /incomplete or refused/);
    }
    intercept().reply(503, 'Service temporarily unavailable');
    await assert.rejects(invoke, /503 Service Unavailable/);
    intercept().replyWithError(Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }));
    await assert.rejects(invoke, /Bulk request failed:.*UND_ERR_SOCKET/);
    intercept().replyWithError(Object.assign(new Error('headers timed out'), { code: 'UND_ERR_HEADERS_TIMEOUT' }));
    await assert.rejects(invoke, /Bulk request timed out after 540000ms.*UND_ERR_HEADERS_TIMEOUT/);
    intercept().reply(200, { choices: [{ finish_reason: 'stop', message: { content: '{"title":"Late"}' } }] }).delay(50);
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      assert.equal(milliseconds, 540_000);
      return controller.signal;
    });
    const pending = invoke();
    controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
    await assert.rejects(pending, /Bulk request timed out after 540000ms/);
    assert.equal(calls, 7, 'transport failures do not silently resubmit generation');
    agent.assertNoPendingInterceptors();
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
