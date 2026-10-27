import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';

process.env.DATABASE_URL = 'postgresql://isolated.invalid/model-call-control';
process.env.AZURE_OPENAI_ENDPOINT = 'https://models.fixture.invalid';
process.env.AZURE_OPENAI_API_KEY = 'fixture-not-a-secret';
process.env.AZURE_OPENAI_ENDPOINT_GPT54 = 'https://bulk.fixture.invalid';
process.env.AZURE_OPENAI_API_KEY_GPT54 = 'fixture-not-a-secret';
process.env.AZURE_OPENAI_GPT54_API = 'responses';

const { FoundryClient, AiStoppedError } = await import('../src/ai/foundryClient.js');
const { env } = await import('../src/config/env.js');
const { getDb, closeDb } = await import('../src/db/db.js');
const { embedBatch } = await import('../src/ai/embeddings.js');
const { filterImportantEmails } = await import('../src/integrations/email/emailImportanceFilter.js');
const { analyzeImageWithVision } = await import('../src/services/visionAnalyzer.js');
const { modelReadingSteps } = await import('../src/ai/knowledge/documentReading.js');
const { startAgentWorker, stopAgentWorker } = await import('../src/agents/engine.js');
const { decomposeSpec } = await import('../src/build/decompose.js');
const db = getDb();
after(closeDb);

function usage(t: TestContext): unknown[][] {
  const rows: unknown[][] = [];
  t.mock.method(db, 'query', async (_sql: string, values: unknown[]) => {
    rows.push(values);
    return { rows: [], rowCount: 0 };
  });
  return rows;
}

function completion(content = 'Done', finish_reason = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason, message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 2 } });
}

for (const api of ['chat', 'responses', 'bulk', 'stream'] as const) {
  test(`${api} cancellation aborts the provider request and is not logged as success`, async t => {
    const records = usage(t);
    const controller = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    let providerSignal: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.ok(init.signal);
      providerSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        started();
      });
    });
    const client = new FoundryClient('fixture');
    const messages = [{ role: 'user' as const, content: 'Review the source' }];
    const work = api === 'bulk' ? client.chatBulk(messages, 100, 10000, 'low', undefined, controller.signal)
      : api === 'stream' ? client.chatWithToolsStream('standard', messages, [], 100, 'auto', 10000, () => {}, controller.signal)
      : client.chat(api === 'responses' ? 'reasoning' : 'standard', messages, 100, 10000, controller.signal);
    const rejected = assert.rejects(work, AiStoppedError);
    await waiting;
    controller.abort();
    await rejected;
    assert.equal(providerSignal?.aborted, true);
    assert.equal(records.length, 1);
    assert.equal(records[0]![12], false);
    assert.match(String(records[0]![13]), /Cancelled/);
  });
}

test('pre-cancelled work never sends a model request', async t => {
  usage(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => completion());
  const signal = AbortSignal.abort();
  await assert.rejects(new FoundryClient().chat('standard', [], 100, 1000, signal), AiStoppedError);
  await assert.rejects(new FoundryClient().chatBulk([], 100, 1000, 'low', undefined, signal), AiStoppedError);
  assert.equal(fetch.mock.callCount(), 0);
});

test('bulk fallback retains the requested timeout', async t => {
  usage(t);
  const original = env.AZURE_OPENAI_ENDPOINT_GPT54;
  Object.assign(env, { AZURE_OPENAI_ENDPOINT_GPT54: undefined });
  t.after(() => { Object.assign(env, { AZURE_OPENAI_ENDPOINT_GPT54: original }); });
  const limits: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    limits.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async () => completion());
  assert.equal(await new FoundryClient().chatBulk([], 100, 1234), 'Done');
  assert.deepEqual(limits, [1234]);
});

test('truncated bulk output retains usage but is recorded as unsuccessful', async t => {
  const records = usage(t);
  t.mock.method(globalThis, 'fetch', async () => completion('Partial', 'length'));
  await assert.rejects(new FoundryClient().chatBulk([]), /limit|truncat/i);
  assert.equal(records[0]![7], 10);
  assert.equal(records[0]![12], false);
});

test('checkpoint summarisation and reduction pass their cancellation signal to the transport', async () => {
  const signal = new AbortController().signal;
  const signals: Array<AbortSignal | undefined> = [];
  const steps = modelReadingSteps({
    chatBulk: async (...args: Parameters<InstanceType<typeof FoundryClient>['chatBulk']>) => {
      signals.push(args[5]);
      return signals.length === 1 ? JSON.stringify({ summary: 'A fact', memory: 'A fact', excerpts: [] }) : 'A fact';
    },
  }, signal);
  await steps.summarise('A fact', '', 'Review');
  await steps.reduce(['A fact'], 'Review');
  assert.deepEqual(signals, [signal, signal]);
});

test('embeddings stay batched and ordered, with an explicit request deadline', async t => {
  const records = usage(t);
  const limits: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { limits.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)).input, ['first', 'second']);
    assert.ok(init.signal);
    return Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
  });
  assert.deepEqual(await embedBatch(['first', 'second']), [[1, 0], [0, 1]]);
  assert.deepEqual(limits, [60000]);
  assert.equal(records[0]![12], true);
});

test('embedding failures appear in usage telemetry', async t => {
  const records = usage(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  await assert.rejects(embedBatch(['source']), /503/);
  assert.equal(records[0]![12], false);
});

test('email classification uses completion tokens and preserves the existing threshold', async t => {
  const records = usage(t);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.max_completion_tokens, 500);
    assert.equal('max_tokens' in body, false);
    assert.equal(body.temperature, 0);
    assert.ok(init.signal);
    return completion('[{"index":1,"score":1},{"index":2,"score":2}]');
  });
  assert.deepEqual(await filterImportantEmails([
    { subject: 'Noise', from: 'sender', date: 'today' }, { subject: 'Useful', from: 'sender', date: 'today' },
  ]), [false, true]);
  assert.equal(records[0]![12], true);
});

test('incomplete email classifications retain fail-open ingestion but record a failure', async t => {
  const records = usage(t);
  t.mock.method(globalThis, 'fetch', async () => completion('[]'));
  assert.deepEqual(await filterImportantEmails([{ subject: 'A', from: 'sender', date: 'today' }]), [true]);
  assert.equal(records[0]![12], false);
  assert.match(String(records[0]![13]), /omitted/);
});

test('basic vision has a deadline and records failures before the existing fallback', async t => {
  const records = usage(t);
  const limits: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { limits.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.ok(init.signal);
    return new Response('Unavailable', { status: 503 });
  });
  assert.equal(await analyzeImageWithVision(Buffer.from('fixture'), 'image/png'), '');
  assert.deepEqual(limits, [75000]);
  assert.equal(records[0]![12], false);
});

test('specialist polling cannot overlap a pending claim, and shutdown waits for it', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let claims = 0;
  t.mock.method(db, 'query', async (sql: string) => {
    if (sql.includes("SET status = 'running', started_at")) { claims++; started(); await gate; }
    return { rows: [], rowCount: 0 };
  });
  let poll!: () => void;
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => {
    poll = callback;
    return setTimeout(() => {}, 60000);
  });
  try {
    await startAgentWorker(db);
    await waiting;
    poll();
    poll();
    await Promise.resolve();
    assert.equal(claims, 1);
    let stopped = false;
    const stopping = stopAgentWorker().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await stopping;
  } finally { release(); await stopAgentWorker(); }
});

test('failed or contradictory build reviews cannot return an unchecked plan', async t => {
  const draft = JSON.stringify({ plan_notes: '', tasks: [{ key: 'a', title: 'Implement', body: 'Do it', agent: 'copilot', size: 'S', depends_on: [] }] });
  for (const review of [new Error('review unavailable'), '{}', '{"pass":true,"issues":["Missing a requirement"]}']) {
    let calls = 0;
    const chat = t.mock.method(FoundryClient.prototype, 'chat', async () => {
      if (++calls === 1) return draft;
      if (review instanceof Error) throw review;
      return review;
    });
    try { await assert.rejects(decomposeSpec({ title: 'Spec', specMarkdown: 'Requirements', repo: 'fixture/repo' }), /review/i); }
    finally { chat.mock.restore(); }
  }
});

test('a failed build revision cannot fall back to the rejected original plan', async t => {
  let calls = 0;
  t.mock.method(FoundryClient.prototype, 'chat', async () => {
    calls++;
    if (calls === 1) return JSON.stringify({ plan_notes: '', tasks: [{ key: 'a', title: 'Implement', body: 'Do it', agent: 'copilot', size: 'S', depends_on: [] }] });
    if (calls === 2) return '{"pass":false,"issues":["Missing a requirement"]}';
    return '{}';
  });
  await assert.rejects(decomposeSpec({ title: 'Spec', specMarkdown: 'Requirements', repo: 'fixture/repo' }), /revision/i);
});
